import { getTruerollsKeys, type TruerollsKey } from './client';

/** Issuer key lookup gives up after this long instead of leaving a verifier page waiting. */
export const KEY_DISCOVERY_TIMEOUT_MS = 6000;

export type KeyDiscoveryState =
  | { status: 'loading' }
  | { status: 'ready'; keys: TruerollsKey[]; revision: number }
  | { status: 'unavailable'; reason: string; revision: number };

let revisionCounter = 0;
let cached: { keys: TruerollsKey[]; revision: number } | null = null;

/** The last successfully fetched key set, if any. A cache only: callers still
 * bind every verdict to the revision it was computed with. */
export function cachedIssuerKeys(): { keys: TruerollsKey[]; revision: number } | null {
  return cached;
}

/**
 * Fetch the issuer's published key set with a bounded wait. Aborting `signal`
 * (unmount, StrictMode replay) rejects with the abort reason and never updates
 * the cache. A timeout or transport failure resolves as 'unavailable', so the
 * page can say so instead of hanging.
 */
export async function discoverIssuerKeys(
  signal: AbortSignal,
  timeoutMs: number = KEY_DISCOVERY_TIMEOUT_MS,
): Promise<Exclude<KeyDiscoveryState, { status: 'loading' }>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const { keys } = await getTruerollsKeys({ signal: combined });
    if (signal.aborted) throw signal.reason;
    // An unchanged key set keeps its revision, so a refetch does not invalidate
    // verdicts that were computed against identical keys and statuses.
    if (!cached || JSON.stringify(cached.keys) !== JSON.stringify(keys)) {
      revisionCounter += 1;
      cached = { keys, revision: revisionCounter };
    }
    return { status: 'ready', keys: cached.keys, revision: cached.revision };
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    revisionCounter += 1;
    const reason = timeout.aborted
      ? 'The issuer key set did not answer in time.'
      : 'The issuer key set could not be fetched.';
    if (!timeout.aborted) console.warn('[kd] issuer key discovery failed:', err);
    return { status: 'unavailable', reason, revision: revisionCounter };
  }
}
