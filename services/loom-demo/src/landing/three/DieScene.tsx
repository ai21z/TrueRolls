/**
 * DieScene — the TrueRolls hero's marquee 3D visual.
 *
 * Rendered as the children of <Canvas> (see HeroCanvas). A faceted d20-style
 * die floats, tumbles, settles, gets sealed by a glowing credential ring, and
 * — the money shot — shatters into shards when the credential is tampered.
 *
 * All per-frame motion runs in a single `useFrame` state machine that eases
 * refs toward per-phase targets, so flipping `phase` mid-animation stays smooth.
 * React never re-renders per frame; phase changes only flip target values.
 *
 * Decorative only (the literal rolled number + receipt live in HTML alongside).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';
import type { DieSceneProps, HeroPhase } from './DieScene.types';

/* ── Palette (mirrors theme/tokens.css; three.js needs real Color objects) ── */
const COL = {
  dieBase: '#1C1A16',     // accent-tinted dark fill
  dieHi: '#2A261E',       // slightly lifted facet tone
  accent: '#7E9488',      // primary iris accent (--kd-void)
  accentDeep: '#4F5F54',  // pressed accent
  danger: '#B5474D',      // tamper / fail (--kd-fail)
  keyLight: '#F2E9D6',    // cool white key
} as const;

const SHARD_COUNT = 36;

/** The pip on a face: where the number sits and how it's oriented, derived once. */
interface FacePip {
  num: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/**
 * One upright, outward-facing transform per icosahedron face. The geometry is
 * non-indexed (3 unique verts per triangle), so each consecutive triple is a face:
 * centroid for position, the triangle's outward normal for facing, world-up
 * projected into the face plane for roll (so the digits read upright).
 */
function buildFacePips(geometry: THREE.BufferGeometry): FacePip[] {
  const pos = geometry.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const worldX = new THREE.Vector3(1, 0, 0);
  const basis = new THREE.Matrix4();
  const q = new THREE.Quaternion();

  const pips: FacePip[] = [];
  const faces = pos.count / 3;
  for (let i = 0; i < faces; i++) {
    a.fromBufferAttribute(pos, i * 3);
    b.fromBufferAttribute(pos, i * 3 + 1);
    c.fromBufferAttribute(pos, i * 3 + 2);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    e1.copy(b).sub(a);
    e2.copy(c).sub(a);
    normal.copy(e1).cross(e2).normalize();
    if (normal.dot(centroid) < 0) normal.negate(); // always face outward
    // World-up projected into the face plane → upright digits (fall back near poles).
    up.copy(worldUp).addScaledVector(normal, -worldUp.dot(normal));
    if (up.lengthSq() < 1e-4) up.copy(worldX).addScaledVector(normal, -worldX.dot(normal));
    up.normalize();
    right.copy(up).cross(normal).normalize();
    basis.makeBasis(right, up, normal);
    q.setFromRotationMatrix(basis);
    const p = centroid.addScaledVector(normal, 0.018); // lift off the face to avoid z-fighting
    pips.push({ num: i + 1, position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] });
  }
  return pips;
}

/** Draw (or redraw, once the webfont loads) one number into a face canvas. */
function drawNumberGlyph(cv: HTMLCanvasElement, n: number, color: string): void {
  const s = cv.width;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = color;
  // 500 is the heaviest JetBrains Mono weight the page actually loads (index.html).
  ctx.font = `500 ${Math.round(s * 0.62)}px 'JetBrains Mono', ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Optical centring: the monospace baseline sits a hair low.
  ctx.fillText(String(n), s / 2, s / 2 + s * 0.02);
}

/** A transparent canvas glyph of one number in the accent colour, for a face plane. */
function makeNumberTexture(n: number, color: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  drawNumberGlyph(cv, n, color);
  const tex = new THREE.CanvasTexture(cv);
  // The canvas is authored in sRGB; tag it so the accent renders as the exact
  // #7E9488 of the Roll button (untagged it would be treated as linear → washed out).
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** A single shard's ballistic state, integrated in useFrame. */
interface Shard {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;   // tumble axis
  spin: number;          // rad/s
  quat: THREE.Quaternion;
  scale: number;
}

function makeShards(): Shard[] {
  const shards: Shard[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    // Outward direction on a slightly flattened sphere for a disc-ish burst.
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      (Math.random() * 2 - 1) * 0.85,
      Math.random() * 2 - 1,
    ).normalize();
    shards.push({
      pos: new THREE.Vector3(),
      vel: dir,
      axis: new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      ).normalize(),
      spin: 4 + Math.random() * 8,
      quat: new THREE.Quaternion(),
      scale: 0.12 + Math.random() * 0.16,
    });
  }
  return shards;
}

/* Eased lerp helpers — frame-rate independent via exponential smoothing. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

/* A calm, slightly-off-axis resting orientation for `settled`. */
const SETTLED_EULER = new THREE.Euler(-0.35, 0.62, 0.12);

export function DieScene({ phase, kappa, face, reducedMotion }: DieSceneProps) {
  const { invalidate } = useThree();

  /* ── Memoized geometry / materials (created once, auto-disposed by R3F) ── */
  const dieGeometry = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const shardGeometry = useMemo(() => new THREE.TetrahedronGeometry(1, 0), []);

  // The d20 face numbers: per-face transforms + accent-coloured glyph textures
  // (same #7E9488 as the Roll button), built once and disposed on unmount.
  const facePips = useMemo(() => buildFacePips(dieGeometry), [dieGeometry]);
  const numberGeometry = useMemo(() => new THREE.PlaneGeometry(0.52, 0.52), []);
  const numberTextures = useMemo(
    () => facePips.map((p) => makeNumberTexture(p.num, COL.accent)),
    [facePips],
  );
  useEffect(
    () => () => {
      numberTextures.forEach((t) => t.dispose());
      numberGeometry.dispose();
    },
    [numberTextures, numberGeometry],
  );

  // JetBrains Mono loads async (display=swap); if the glyphs baked in the fallback
  // monospace face, re-rasterise them once the real font is ready and ask for one
  // redraw (frameloop may be 'demand'/'never', so invalidate is required).
  useEffect(() => {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled) return;
      facePips.forEach((p, i) => {
        drawNumberGlyph(numberTextures[i].image as HTMLCanvasElement, p.num, COL.accent);
        numberTextures[i].needsUpdate = true;
      });
      invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [facePips, numberTextures, invalidate]);

  // Where the die settles: showing the rolled face toward the camera, with a gentle
  // presentation tilt for dimensionality. Falls back to a generic pose when there's
  // no roll yet, or the face can't sit on this 20-sided die (e.g. a d100 result > 20).
  const landTarget = useRef(new THREE.Quaternion().setFromEuler(SETTLED_EULER));
  useEffect(() => {
    const t = new THREE.Quaternion();
    if (face != null && face >= 1 && face <= facePips.length) {
      // The inverse of the face's frame brings that face dead-on to the camera; the
      // tilt then angles the whole die so the number reads as the dominant front face.
      const q = facePips[face - 1].quaternion;
      const inv = new THREE.Quaternion(q[0], q[1], q[2], q[3]).invert();
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.22, 0.18, 0.04));
      t.copy(tilt).multiply(inv);
    } else {
      t.setFromEuler(SETTLED_EULER);
    }
    landTarget.current.copy(t);
    invalidate();
  }, [face, facePips, invalidate]);

  // The Cooling Cast: the die's emissive is a thermal field. A single uCool uniform
  // (0 = cast-hot ember, 1 = cooled char) drives an ember→char anneal with a bright
  // front that sweeps across the geometry. Injected via onBeforeCompile so the rest
  // of the MeshStandardMaterial lighting (metalness/roughness/lights) is preserved.
  const dieMaterial = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COL.dieBase),
      metalness: 0.32,
      roughness: 0.34,
      emissive: new THREE.Color('#000000'),
      emissiveIntensity: 1,
      flatShading: true,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uCool = { value: 1 };
      shader.uniforms.uEmber = { value: new THREE.Color('#B87242') };
      shader.uniforms.uChar = { value: new THREE.Color('#15110d') };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vNecLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vNecLocal = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uCool;\nuniform vec3 uEmber;\nuniform vec3 uChar;\nvarying vec3 vNecLocal;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  float necFront = mix(-1.3, 1.3, uCool);                // hot below the front; the seam sweeps up as it cools
  float necD = vNecLocal.y - necFront;
  float necHot = smoothstep(-0.15, 0.30, necD);          // still-warm fraction (ahead of the front)
  float necSeam = smoothstep(0.0, 0.12, necD) * (1.0 - smoothstep(0.12, 0.45, necD)); // bright seam
  vec3 necThermal = mix(uChar, uEmber, necHot) + uEmber * necSeam * 1.5;
  float necHeat = 1.0 - uCool;                           // light is the thing dying
  totalEmissiveRadiance = necThermal * (0.05 + necHeat * 1.45);`,
        );
      m.userData.shader = shader;
    };
    return m;
  }, []);

  const sealMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#B87242'),
        emissive: new THREE.Color('#B87242'),
        emissiveIntensity: 1.4,
        metalness: 0.1,
        roughness: 0.5,
        transparent: true,
        opacity: 0,
      }),
    [],
  );

  const shardMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(COL.dieHi),
        emissive: new THREE.Color(COL.danger),
        emissiveIntensity: 1.0,
        metalness: 0.3,
        roughness: 0.4,
        transparent: true,
        opacity: 1,
        flatShading: true,
      }),
    [],
  );

  /* ── Refs into the scene graph ── */
  const dieGroup = useRef<THREE.Group>(null);      // outer (tumble) group
  const dieMesh = useRef<THREE.Mesh>(null);
  const dieEdges = useRef<THREE.LineSegments>(null); // hairline edge overlay
  const numbersGroup = useRef<THREE.Group>(null);  // the face numbers (track the die)
  const sealGroup = useRef<THREE.Group>(null);
  const shardInst = useRef<THREE.InstancedMesh>(null);
  const rimLight = useRef<THREE.PointLight>(null);

  /* ── Per-frame state machine memory (never triggers re-render) ── */
  const sm = useRef({
    prevPhase: phase as HeroPhase,
    tumble: 0,          // 0..1 tumble energy
    spinY: 0,           // accumulated freewheel spin
    seal: 0,            // 0..1 seal form-in
    sealSpin: 0,
    dieScale: 1,
    sealRed: 0,         // 0..1 accent → danger blend
    cool: 1,           // 0 = cast-hot (ember), 1 = cooled to char
    shatter: 0,         // 0..1 shatter life (1 = fresh, decays to 0)
    shardsArmed: false, // ensures one-shot spawn per tamper entry
    shards: makeShards(),
  });

  /* Reusable scratch objects (avoid per-frame allocation in useFrame). */
  const scratch = useRef({
    mat: new THREE.Matrix4(),
    quat: new THREE.Quaternion(),
    scaleV: new THREE.Vector3(),
    col: new THREE.Color(),
    accentCol: new THREE.Color(COL.accent),
    dangerCol: new THREE.Color(COL.danger),
  });

  /**
   * Compose a single static frame for reduced-motion. Pure target values, no
   * easing — die settled, seal present, tamper shows a static red-cracked die.
   */
  function composeStatic() {
    const s = sm.current;
    const sc = scratch.current;
    const tampered = phase === 'tampered';

    if (dieGroup.current) {
      dieGroup.current.quaternion.copy(landTarget.current);
      dieGroup.current.scale.setScalar(1);
    }
    // Restore die visibility (the animated path may have hidden it mid-shatter
    // before the user toggled reduced-motion on).
    if (dieMesh.current) dieMesh.current.visible = true;
    if (numbersGroup.current) numbersGroup.current.visible = true;
    if (dieEdges.current) dieEdges.current.visible = true;
    // Seal present for sealed + tampered (cracked but visible).
    const sealOn = phase === 'sealed' || phase === 'tampered';
    if (sealGroup.current) {
      const k = sealOn ? 1 : 0;
      sealGroup.current.scale.setScalar(k);
      sealGroup.current.visible = sealOn;
    }
    sealMaterial.opacity = sealOn ? 0.9 : 0;
    const accent = tampered ? sc.dangerCol : sc.accentCol;
    sealMaterial.emissive.copy(accent);
    sealMaterial.color.copy(accent);
    dieMaterial.emissive.copy(tampered ? sc.dangerCol : sc.accentCol);
    dieMaterial.emissiveIntensity = tampered ? 0.5 : 0.18 + kappa * 0.22;
    if (rimLight.current) {
      rimLight.current.color.copy(accent);
      rimLight.current.intensity = 7 + kappa * 3;
    }
    // Park the shards out of sight; in reduced motion we never animate them.
    if (shardInst.current) shardInst.current.visible = false;
    s.shatter = 0;

    // Thermal: cooled char for settled/sealed/idle, the anneal is motion so it
    // never plays under reduced motion — we render its resting (cooled) frame.
    s.cool = phase === 'rolling' ? 0 : 1;
    const dieShader = dieMaterial.userData.shader as
      | { uniforms: { uCool: { value: number } } }
      | undefined;
    if (dieShader) dieShader.uniforms.uCool.value = s.cool;
  }

  useFrame((_, rawDelta) => {
    const s = sm.current;
    const sc = scratch.current;
    const dt = Math.min(rawDelta, 1 / 30); // clamp big tab-restore deltas

    /* ── Reduced motion: render one static frame, then idle the loop ── */
    if (reducedMotion) {
      composeStatic();
      return;
    }

    /* ── Phase entry transitions (one-shot side effects) ── */
    if (phase !== s.prevPhase) {
      if (phase === 'rolling') {
        s.tumble = 1;
        s.cool = 0; // the cast reheats the die to ember
      }
      // Landing is the death: snap hot, then the cool target eases it to char.
      if (phase === 'settled') s.cool = 0;
      if (phase === 'tampered') {
        // Arm a fresh shatter burst.
        s.shatter = 1;
        s.shardsArmed = true;
        for (const sh of s.shards) {
          sh.pos.set(0, 0, 0);
          const speed = 2.4 + Math.random() * 2.6;
          sh.vel
            .set(
              Math.random() * 2 - 1,
              (Math.random() * 2 - 1) * 0.9 + 0.4,
              Math.random() * 2 - 1,
            )
            .normalize()
            .multiplyScalar(speed);
          sh.quat.identity();
        }
      }
      s.prevPhase = phase;
    }

    /* ── Resolve per-phase targets ── */
    const isTumbling = phase === 'rolling';
    const wantsSeal = phase === 'sealed' || phase === 'tampered';
    const tampered = phase === 'tampered';

    // Tumble energy: spikes to 1 on roll, decays once settled/idle.
    const tumbleTarget = isTumbling ? 1 : 0;
    s.tumble = damp(s.tumble, tumbleTarget, 5, dt);

    // Die scale: a touch larger while rolling (energy), tiny pop on seal.
    let scaleTarget = 1;
    if (isTumbling) scaleTarget = 1.06;
    if (tampered) scaleTarget = 1 - s.shatter * 1; // collapse as it shatters
    s.dieScale = damp(s.dieScale, scaleTarget, 8, dt);

    // Seal form-in.
    s.seal = damp(s.seal, wantsSeal ? 1 : 0, 6, dt);

    // Accent → danger blend.
    s.sealRed = damp(s.sealRed, tampered ? 1 : 0, 8, dt);

    // Thermal anneal: hot while casting, cools to char once it lands (~1.1s).
    const coolTarget = isTumbling ? 0 : 1;
    s.cool = damp(s.cool, coolTarget, 4, dt);
    const dieShader = dieMaterial.userData.shader as
      | { uniforms: { uCool: { value: number } } }
      | undefined;
    if (dieShader) dieShader.uniforms.uCool.value = s.cool;

    /* ── Drive the die group ── */
    if (dieGroup.current) {
      const g = dieGroup.current;
      if (isTumbling || s.tumble > 0.02) {
        // Fast multi-axis tumble; magnitude scales with tumble energy.
        const e = s.tumble;
        g.rotation.x += dt * (1.2 + 7.5 * e);
        g.rotation.y += dt * (1.6 + 9.0 * e);
        g.rotation.z += dt * (0.6 + 4.0 * e);
      } else if (phase === 'idle') {
        // Gentle freewheel (Float adds the bob/sway on the parent).
        s.spinY += dt * 0.35;
        g.rotation.y = s.spinY;
        g.rotation.x = Math.sin(s.spinY * 0.6) * 0.12;
        g.rotation.z = 0;
      } else {
        // settled / sealed / (pre-shatter): ease to the rolled face, toward camera.
        g.quaternion.slerp(landTarget.current, 1 - Math.exp(-6 * dt));
      }
      // Hide the die once it has fully shattered; reveal as it re-forms.
      const dieVisible = !(tampered && s.shatter > 0.6);
      if (dieMesh.current) dieMesh.current.visible = dieVisible;
      if (numbersGroup.current) numbersGroup.current.visible = dieVisible;
      if (dieEdges.current) dieEdges.current.visible = dieVisible;
      g.scale.setScalar(Math.max(0.0001, s.dieScale));
    }

    /* ── Seal rings ── */
    if (sealGroup.current) {
      const sg = sealGroup.current;
      sg.visible = s.seal > 0.001;
      // Overshoot-free form-in with a subtle settle.
      const k = THREE.MathUtils.smoothstep(s.seal, 0, 1);
      sg.scale.setScalar(k);
      s.sealSpin += dt * (tampered ? 1.4 : 0.5);
      sg.rotation.z = s.sealSpin;
      sg.rotation.x = -0.5; // tilt to read as orbiting the die
    }

    // Seal + die material colour/emissive blend toward danger on tamper.
    sc.col.copy(sc.accentCol).lerp(sc.dangerCol, s.sealRed);
    sealMaterial.color.copy(sc.col);
    sealMaterial.emissive.copy(sc.col);
    // Seal opacity: fade in with form, flash down as it shatters.
    sealMaterial.opacity = s.seal * (1 - s.shatter * 0.9) * 0.95;
    sealMaterial.emissiveIntensity = 1.2 + s.seal * 0.6 + s.shatter * 1.5;

    dieMaterial.emissive.copy(sc.col);
    dieMaterial.emissiveIntensity =
      0.18 + kappa * 0.22 + s.seal * 0.25 + s.sealRed * 0.4;

    /* ── Rim light tracks the accent / danger blend + κ stance ── */
    if (rimLight.current) {
      rimLight.current.color.copy(sc.col);
      rimLight.current.intensity = 7 + kappa * 3 + s.shatter * 6;
    }

    /* ── Shatter: integrate shards, write instance matrices ── */
    if (shardInst.current) {
      const inst = shardInst.current;
      if (s.shatter > 0.001 && s.shardsArmed) {
        inst.visible = true;
        // Decay the shatter life; gravity + drag on each shard.
        s.shatter = Math.max(0, s.shatter - dt * 0.85);
        for (let i = 0; i < s.shards.length; i++) {
          const sh = s.shards[i];
          sh.vel.y -= dt * 4.2;          // gravity
          sh.vel.multiplyScalar(1 - dt * 0.6); // drag
          sh.pos.addScaledVector(sh.vel, dt);
          sc.quat.setFromAxisAngle(sh.axis, sh.spin * dt);
          sh.quat.multiplyQuaternions(sc.quat, sh.quat);
          const fade = THREE.MathUtils.smoothstep(s.shatter, 0, 0.5);
          sc.scaleV.setScalar(sh.scale * (0.4 + fade));
          sc.mat.compose(sh.pos, sh.quat, sc.scaleV);
          inst.setMatrixAt(i, sc.mat);
        }
        inst.instanceMatrix.needsUpdate = true;
        // Shards glow hot then fade with shatter life.
        shardMaterial.opacity = THREE.MathUtils.smoothstep(s.shatter, 0, 0.4);
        shardMaterial.emissiveIntensity = 0.8 + s.shatter * 1.4;
        if (s.shatter <= 0.001) s.shardsArmed = false;
      } else if (inst.visible) {
        inst.visible = false;
      }
    }

    /* On-demand frameloops: keep ticking while anything is in motion. */
    const busy =
      s.tumble > 0.02 ||
      s.seal > 0.001 ||
      s.shatter > 0.001 ||
      Math.abs(s.cool - coolTarget) > 0.01 ||
      phase === 'idle' ||
      phase === 'rolling';
    if (busy) invalidate();
  });

  return (
    <>
      {/* ── Lighting: low ambient + cool key + accent rim ── */}
      <ambientLight intensity={0.35} color={COL.keyLight} />
      <directionalLight
        position={[3.5, 5, 4]}
        intensity={2.1}
        color={COL.keyLight}
      />
      {/* Accent rim from behind for the premium edge glow. */}
      <pointLight
        ref={rimLight}
        position={[-3, 1.5, -4]}
        intensity={7}
        distance={18}
        color={COL.accent}
      />
      {/* A soft fill so the dark facets never go fully black. */}
      <pointLight position={[2, -3, 3]} intensity={0.8} color={COL.accentDeep} distance={14} />

      {/* ── The die. Float adds the elegant idle bob/sway (disabled in
          reduced motion via `enabled`); the inner group does all rotation. ── */}
      <Float
        enabled={!reducedMotion && (phase === 'idle')}
        speed={1.4}
        rotationIntensity={0.15}
        floatIntensity={0.7}
        floatingRange={[-0.08, 0.08]}
      >
        <group ref={dieGroup}>
          <mesh ref={dieMesh} geometry={dieGeometry} material={dieMaterial} />
          {/* Hairline edge accent — reads premium without neon. Hidden with the
              die on shatter so it doesn't ghost as a wireframe. */}
          <lineSegments ref={dieEdges}>
            <edgesGeometry args={[dieGeometry]} />
            <lineBasicMaterial color="#6e8478" transparent opacity={0.32} />
          </lineSegments>
          {/* d20 face numbers — accent glyphs lifted just off each face, tumbling
              and scaling with the die, hidden with it on shatter. */}
          <group ref={numbersGroup}>
            {facePips.map((p) => (
              <mesh
                key={p.num}
                geometry={numberGeometry}
                position={p.position}
                quaternion={p.quaternion}
              >
                <meshBasicMaterial
                  map={numberTextures[p.num - 1]}
                  transparent
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            ))}
          </group>
        </group>
      </Float>

      {/* ── The seal: two concentric accent rings forming the credential. ── */}
      <group ref={sealGroup} visible={false}>
        <mesh material={sealMaterial}>
          <torusGeometry args={[1.55, 0.025, 16, 96]} />
        </mesh>
        <mesh material={sealMaterial} scale={1.22}>
          <torusGeometry args={[1.55, 0.012, 12, 96]} />
        </mesh>
      </group>

      {/* ── The shards: instanced shatter fragments (hidden until tamper). ── */}
      <instancedMesh
        ref={shardInst}
        args={[shardGeometry, shardMaterial, SHARD_COUNT]}
        visible={false}
        frustumCulled={false}
      />
    </>
  );
}

export default DieScene;
