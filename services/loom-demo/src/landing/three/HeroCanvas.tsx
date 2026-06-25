/**
 * HeroCanvas — public host for the TrueRolls hero's marquee 3D visual.
 *
 * The landing hero mounts <HeroCanvas phase={...} /> inside a sized container;
 * the canvas fills that parent (100% × 100%) and is purely decorative
 * (`aria-hidden`) — the literal rolled number + receipt live in the HTML next
 * to it. The wrapper is `pointer-events: none` so it never blocks the hero UI.
 *
 * Responsibilities kept here (out of the scene):
 *  - lazy-safe <Canvas> host with a capped DPR ([1, 1.75]),
 *  - transparent rendering (the page's near-black shows through),
 *  - automatic resize (R3F observes the filled parent),
 *  - dispose on unmount (R3F auto-disposes the scene graph + memoized resources),
 *  - prefers-reduced-motion fallback: a single static composed frame, no loop.
 */

import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { DieScene } from './DieScene';
import type { HeroCanvasProps } from './DieScene.types';

export type { HeroPhase, HeroCanvasProps } from './DieScene.types';

/**
 * SSR/no-window-safe reduced-motion detector. Returns `true` when the user has
 * requested reduced motion, and updates live if they toggle the OS setting.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addEventListener is the modern API; guard for older Safari (addListener).
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  return reduced;
}

/** Fill-the-parent wrapper styles. Inline so we touch no shared CSS. */
const wrapperStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none', // decorative — never intercept the hero UI
};

export function HeroCanvas({ phase, kappa = 0, face = null, className }: HeroCanvasProps) {
  const reducedMotion = usePrefersReducedMotion();
  const k = Math.min(1, Math.max(0, kappa)); // clamp κ stance to 0..1
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  // Park the render loop (frameloop 'never' stops rAF) once the hero scrolls
  // off-screen, so the WebGL canvas costs nothing while the user reads on.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.01,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={wrapperStyle}
      aria-hidden="true"
    >
      <Canvas
        dpr={[1, 1.75]}
        // Off-screen → 'never' (no rAF). Reduced motion → 'demand' (one frame).
        // Otherwise drive the idle float / roll / shatter continuously.
        frameloop={!visible ? 'never' : reducedMotion ? 'demand' : 'always'}
        gl={{
          alpha: true,            // transparent — page near-black shows through
          antialias: true,
          powerPreference: 'high-performance',
        }}
        camera={{ position: [0, 0, 6], fov: 38 }}
        // No clear colour: keep the canvas transparent.
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <DieScene phase={phase} kappa={k} face={face} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}

export default HeroCanvas;
