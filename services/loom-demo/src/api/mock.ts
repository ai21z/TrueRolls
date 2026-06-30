import type { Die, RollResponse, VerifyResponse } from '../types/kd';
import { computeRollReplayWasm, initKdCoreWasm, isKdCoreWasmReady } from './wasmEngine';

let mockSeq = 0;

/** Random 64-bit draw from the browser CSPRNG, as a stringifiable BigInt. */
function randomDrawU64(): bigint {
  const arr = new BigUint64Array(1);
  crypto.getRandomValues(arr);
  return arr[0];
}

export async function mockRoll(die: Die, kappa: number): Promise<RollResponse> {
  if (!isKdCoreWasmReady()) await initKdCoreWasm();
  await delay(150 + Math.random() * 200);

  // Single engine: guarded distribution + prefix-CDF face replay all come
  // from kd-core (wasm). The draw is a real random u64 and is recorded in
  // proof.draw_u64 so the sampling step is honestly reproducible, but the
  // receipt stays clearly mock: zeroed drbg_key_hex, algo "mock", no sig.
  const draw = randomDrawU64();
  const { face, alpha, kl, ev, drawU64 } = computeRollReplayWasm(die, kappa, draw);

  mockSeq++;
  const id = `mock-${Date.now()}-${mockSeq}`;
  return {
    v: 'truerolls-1',
    id,
    die,
    kappa,
    face,
    alpha,
    kl,
    ev,
    created_at: new Date().toISOString(),
    transcript_url: `mock://transcript/${mockSeq}`,
    transcript_key: `mock://transcript/${mockSeq}`,
    proof: {
      math_param_version: 'roll.math.v1',
      rng: { drbg_key_hex: '0'.repeat(64), algo: 'mock' },
      draw_u64: drawU64,
    },
    sig: null,
    deduplicated: false,
  };
}

export async function mockVerify(): Promise<VerifyResponse> {
  await delay(200 + Math.random() * 300);
  return {
    verdict: 'OK',
    mismatches: [],
    warnings: ['mock mode, no real verification performed'],
    recomputed: { face: 0, alpha: 0, kl: 0, ev: 0 },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
