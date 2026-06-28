// Shared measurement helpers used by the §3.2 frontier recorder and the §4 reducer:
// round<->time, order statistics, the t_quorum_lost definition (§1), nearest-rank
// percentiles, and the combined censored-tail rule (audit finding #10). One source
// of truth so the recorder and reducer cannot disagree on the math.

import { CHAIN } from './drand-bls.mjs'

// Pinned quicknet schedule constants (verify against /info at runtime before use).
export const QUICKNET = { CHAIN, PERIOD_S: 3, GENESIS: 1692803367 }

export const roundAt = (ms, genesis = QUICKNET.GENESIS, period = QUICKNET.PERIOD_S) =>
  Math.floor((ms / 1000 - genesis) / period)
export const schedMsForRound = (round, genesis = QUICKNET.GENESIS, period = QUICKNET.PERIOD_S) =>
  (genesis + round * period) * 1000

// k-th smallest (1-indexed) of a numeric array (nulls dropped); null if out of range.
export function orderStat(arr, k) {
  const s = [...arr].filter((x) => x != null).sort((a, b) => a - b)
  return k >= 1 && k <= s.length ? s[k - 1] : null
}

// t_quorum_lost(R): the (n − k + 1)-th order statistic of witness frontier-advance
// times. After this instant fewer than k witnesses still observe frontier < R, so a
// server can no longer assemble k cosignatures with observed_round < R (§1). Returns
// null if fewer than k witnesses ever advanced (no quorum -> no last-look path).
export function quorumLostTime(witnessTimes, k) {
  const present = witnessTimes.filter((x) => x != null)
  if (present.length < k) return null
  return orderStat(present, present.length - k + 1)
}

// Nearest-rank percentiles (documented crude estimator; adequate at large n - the
// audit-flagged §8 limitation, made explicit here rather than hidden).
export function percentiles(arr, ps = [50, 95, 99, 99.9]) {
  const s = [...arr].filter((x) => x != null).sort((a, b) => a - b)
  const out = { n: s.length }
  if (!s.length) return out
  for (const p of ps) out[`p${p}`] = s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
  out.max = s[s.length - 1]
  return out
}

// Combined censored tail (audit finding #10): the tail must fold in censored lower
// bounds, never the exact bucket alone. Returns max(exact pX, censored pX) so the
// worst (censored) rounds cannot silently drop out and understate the tail.
export function combinedTail(exact, censoredLowerBounds, p = 99.9) {
  const e = percentiles(exact, [p])[`p${p}`] ?? -Infinity
  const c = percentiles(censoredLowerBounds, [p])[`p${p}`] ?? -Infinity
  const v = Math.max(e, c)   // +Infinity is meaningful (censored-dominated tail); only -Infinity means "no data"
  return { p, value: v === -Infinity ? null : v, exact: exact.length, censored: censoredLowerBounds.length }
}
