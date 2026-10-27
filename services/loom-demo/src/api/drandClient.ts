export const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';

export const DRAND_RELAYS = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
] as const;

export interface DrandApiPulse {
  round: number;
  signature: string;
  randomness: string;
}

function isHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/i.test(value);
}

export function parseDrandApiPulse(value: unknown): DrandApiPulse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('drand latest response was malformed');
  }
  const pulse = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(pulse.round) ||
    (pulse.round as number) <= 0 ||
    typeof pulse.signature !== 'string' ||
    !isHex(pulse.signature, 96) ||
    typeof pulse.randomness !== 'string' ||
    !isHex(pulse.randomness, 64)
  ) {
    throw new Error('drand latest response was malformed');
  }
  return {
    round: pulse.round as number,
    signature: pulse.signature,
    randomness: pulse.randomness,
  };
}

export function selectFreshestDrandPulse(pulses: readonly DrandApiPulse[]): DrandApiPulse {
  if (pulses.length === 0) throw new Error('no valid drand relay response');
  return pulses.reduce((freshest, pulse) => (pulse.round > freshest.round ? pulse : freshest));
}

async function fetchRelayPulse(relay: string): Promise<DrandApiPulse> {
  const res = await fetch(`${relay}/${DRAND_CHAIN}/public/latest`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`${relay} returned ${res.status}`);
  return parseDrandApiPulse(await res.json());
}

/**
 * Fetch all configured public relays concurrently and use the highest valid
 * frontier. This is a liveness choice only: kd-api independently verifies the
 * selected pulse against the pinned quicknet BLS key before minting.
 */
export async function fetchLatestDrandPulse(): Promise<DrandApiPulse> {
  const results = await Promise.allSettled(DRAND_RELAYS.map(fetchRelayPulse));
  const pulses = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  if (pulses.length === 0) {
    const failures = results
      .flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []))
      .join('; ');
    throw new Error(`all drand relays failed${failures ? `: ${failures}` : ''}`);
  }
  return selectFreshestDrandPulse(pulses);
}
