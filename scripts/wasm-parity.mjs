#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWasmPackagePair } from './wasm-package-paths.mjs';

const ROOT = process.cwd();

const cleanGoldens = [
  'golden_01_d6_k06.json',
  'golden_02_d20_k06.json',
  'golden_03_d100_k06.json',
  'golden_07_d6_kneg05.json',
];

function fail(message) {
  console.error(`[wasm-parity] FAIL: ${message}`);
  process.exitCode = 1;
}

function stable(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function assertEqual(label, left, right) {
  if (stable(left) !== stable(right)) {
    fail(`${label} mismatch\ncommitted=${stable(left)}\nrebuilt=${stable(right)}`);
  }
}

function assertClose(label, actual, expected, tolerance = 1e-14) {
  if (typeof actual !== 'number' || typeof expected !== 'number') {
    fail(`${label} is not numeric`);
    return;
  }
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${label} expected ${expected}, got ${actual}`);
  }
}

function assertGolden(label, got, golden) {
  if (got.engine !== 'kd-core-wasm-roll.math.v1') {
    fail(`${label} wrong engine ${got.engine}`);
  }
  if (got.param_version !== golden.math_param_version) {
    fail(`${label} wrong param version ${got.param_version}`);
  }
  if (got.face !== golden.face) {
    fail(`${label} expected face ${golden.face}, got ${got.face}`);
  }
  if (got.draw_u64 !== golden.draw_u64) {
    fail(`${label} expected draw ${golden.draw_u64}, got ${got.draw_u64}`);
  }
  assertClose(`${label} alpha`, got.alpha, golden.alpha);
  assertClose(`${label} kl`, got.kl, golden.kl);
  assertClose(`${label} ev`, got.ev, golden.ev);
  if (!Array.isArray(got.probs) || got.probs.length !== golden.probs.length) {
    fail(`${label} probability length mismatch`);
    return;
  }
  for (let i = 0; i < got.probs.length; i += 1) {
    assertClose(`${label} probs[${i}]`, got.probs[i], golden.probs[i]);
  }
}

async function loadPackage(dir, tag) {
  const jsPath = path.join(dir, 'kd_core_wasm.js');
  const wasmPath = path.join(dir, 'kd_core_wasm_bg.wasm');
  const href = `${pathToFileURL(jsPath).href}?${tag}=${Date.now()}`;
  const mod = await import(href);
  const wasmBytes = await readFile(wasmPath);
  await mod.default({ module_or_path: wasmBytes });
  return mod;
}

async function loadGolden(name) {
  const text = await readFile(path.join(ROOT, 'goldens', name), 'utf8');
  return JSON.parse(text);
}

let packageDirs;
try {
  packageDirs = await resolveWasmPackagePair(ROOT, process.argv.slice(2), 'wasm-parity');
} catch (error) {
  console.error(`[wasm-parity] FAIL: ${error.message}`);
  process.exit(1);
}
const { committedDir, rebuiltDir } = packageDirs;

const committed = await loadPackage(committedDir, 'committed');
const rebuilt = await loadPackage(rebuiltDir, 'rebuilt');

for (const name of cleanGoldens) {
  const golden = await loadGolden(name);
  const draw = BigInt(golden.draw_u64);
  const committedReplay = JSON.parse(
    committed.computeRollReplayJson(golden.die, golden.kappa, draw),
  );
  const rebuiltReplay = JSON.parse(rebuilt.computeRollReplayJson(golden.die, golden.kappa, draw));

  assertGolden(`${name} committed package`, committedReplay, golden);
  assertGolden(`${name} rebuilt package`, rebuiltReplay, golden);
  assertEqual(`${name} runtime output`, committedReplay, rebuiltReplay);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `[wasm-parity] OK: committed and rebuilt WASM math agree on ${cleanGoldens.length} clean golden transcripts.`,
);
console.log(
  '[wasm-parity] Scope: runtime math parity only. This does not verify Ed25519 receipt signatures.',
);
