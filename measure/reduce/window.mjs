#!/usr/bin/env node
// §4/§5 reducer - joins the §3.2 frontier recording with the §3.3 cosign-cost
// samples and computes the decision:
//   per round R (server sample must be verified; otherwise the round is dropped):
//     t_server        = server.arrivalMs
//     a witness "advances to R" ONLY if it observed AND BLS-verified R. A witness
//     that is unverified (blsOk===false) or timed-out (arrivalMs==null) has NOT
//     legitimately advanced -> its advance time is +Infinity (unbounded above).
//     t_quorum_lost   = (n − k + 1)-th order stat of witness advance times (§1)
//     window(R)       = max(0, t_quorum_lost − t_server)   (Infinity if quorum never advanced)
//   exploitable(R)    ⟺ window(R) ≥ cosign_cost.   exploitable_fraction = P[…] + Clopper-Pearson upper CI.
//   Strict-Fast gate (§5): exploitable_fraction CP-upper < threshold AND p99.9 window < p1 cosign_cost.
//
// SAFETY DIRECTION (this is a trust instrument): every uncertainty pushes the window
// UP, never down. A censored/unverified witness can only DELAY t_quorum_lost (more
// exploitable), never advance it. Censored-dominated rounds (≥k witnesses never
// legitimately advanced) get window=+Infinity, count as exploitable, and dominate the
// tail - they are reported, never silently dropped (dropping them would remove exactly
// the slow-witness rounds that are the MOST exploitable).
//
// Run:  node reduce/window.mjs --frontier witness-frontier.jsonl --cosign cosign.jsonl -k 3
// Env:  CP_ALPHA=0.001  EXPLOIT_THRESHOLD=1e-4

import { readFileSync } from 'node:fs'
import { quorumLostTime, percentiles, combinedTail } from '../lib/schema.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const FRONTIER = arg('--frontier')
const COSIGN = arg('--cosign')
const K = Number(arg('-k', 3))
const CP_ALPHA = Number(process.env.CP_ALPHA ?? 0.001)        // 99.9% one-sided
const THRESH = Number(process.env.EXPLOIT_THRESHOLD ?? 1e-4)
if (!FRONTIER) { console.error('usage: --frontier <jsonl> [--cosign <jsonl>] -k <k>'); process.exit(1) }

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const fmt = (v) => (v == null ? 'n/a' : v === Infinity ? '∞' : typeof v === 'number' ? v.toFixed(1) : String(v))

// --- stats helpers (Lanczos logΓ → binomial CDF → Clopper-Pearson upper) ------
function logGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  z -= 1; let x = c[0]; for (let i = 1; i < 9; i++) x += c[i] / (z + i)
  const t = z + 7 + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
// Clopper-Pearson one-sided upper bound for x successes in n trials at conf 1−alpha.
function cpUpper(x, n, alpha = CP_ALPHA) {
  if (n === 0) return 1
  if (x >= n) return 1
  if (x === 0) return 1 - Math.pow(alpha, 1 / n)                 // closed form
  const cdf = (p) => { let s = 0; for (let i = 0; i <= x; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return s }
  let lo = x / n, hi = 1
  for (let it = 0; it < 200; it++) { const mid = (lo + hi) / 2; if (cdf(mid) > alpha) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

// --- reduce frontier → window(R) ---------------------------------------------
const frontier = readJsonl(FRONTIER)
const exact = []            // finite window(R)
const censoredLB = []       // +Infinity windows (quorum never legitimately advanced)
let droppedServer = 0       // server sample missing/unverified → cannot measure
let skippedNoQuorum = 0     // fewer than k witnesses configured
let censoredDominated = 0   // ≥k witnesses never legitimately advanced (window=∞)
let roundsWithWitnessBls = 0

for (const rec of frontier) {
  const server = rec.server
  if (!server || server.arrivalMs == null || server.blsOk === false) { droppedServer++; continue }
  if (rec.witnesses.some((w) => w.blsOk === false)) roundsWithWitnessBls++
  const arrivals = rec.witnesses.map((w) =>
    (w.blsOk === false || w.arrivalMs == null) ? Infinity : w.arrivalMs) // not-advanced → upper bound
  if (arrivals.length < K) { skippedNoQuorum++; continue }
  const tQuorumLost = quorumLostTime(arrivals, K)              // (n−k+1)-th order stat; may be Infinity
  if (tQuorumLost == null) { skippedNoQuorum++; continue }
  if (tQuorumLost === Infinity) { censoredLB.push(Infinity); censoredDominated++ }
  else exact.push(Math.max(0, tQuorumLost - server.arrivalMs))
}

const allWindows = [...exact, ...censoredLB]
const wTail = combinedTail(exact, censoredLB, 99.9)

// --- cosign cost --------------------------------------------------------------
const cosignCosts = COSIGN ? readJsonl(COSIGN).map((r) => r.cosignCostMs) : null
const cgP = cosignCosts ? percentiles(cosignCosts, [1, 50, 95, 99, 99.9]) : null

// --- report -------------------------------------------------------------------
console.log(`=== window(R) (ms)  [k=${K}, ${exact.length} finite + ${censoredLB.length} censored-dominated (∞) rounds] ===`)
console.log('  finite :', percentiles(exact))
if (censoredLB.length) console.log(`  censored-dominated rounds (window=∞): ${censoredLB.length}  ← ≥k witnesses never BLS-verified-advanced (real last-look OR witness slowness - investigate)`)
console.log(`  combined p99.9 (the tail that decides it): ${fmt(wTail.value)}ms  [#10 rule: max(finite, censored)]`)
console.log(`  dropped (server unverified/missing): ${droppedServer}; skipped (n<k): ${skippedNoQuorum}; rounds with a witness BLS-fail: ${roundsWithWitnessBls}`)

if (cgP) {
  console.log(`\n=== cosign_cost (ms) ===`)
  console.log(' ', cgP)
  const fastestAttack = cgP.p1
  const exploitCount = allWindows.filter((w) => w >= fastestAttack).length   // ∞ ≥ x → exploitable
  const n = allWindows.length
  const cpU = cpUpper(exploitCount, n)
  console.log(`\n=== exploitable_fraction = P[ window(R) ≥ cosign_cost ] ===`)
  console.log(`  vs fastest attack (cosign p1=${fmt(fastestAttack)}ms): ${exploitCount}/${n} = ${n ? (100 * exploitCount / n).toFixed(3) : '0'}%`)
  console.log(`  Clopper-Pearson upper ${((1 - CP_ALPHA) * 100).toFixed(1)}% bound: ${cpU.toExponential(2)}`)

  const gate1 = cpU < THRESH
  const gate2 = wTail.value != null && fastestAttack != null && wTail.value < fastestAttack
  console.log(`\n=== Strict-Fast gate (§5) ===`)
  console.log(`  (1) exploitable_fraction CP-upper < ${THRESH}:   ${gate1 ? 'PASS' : 'FAIL'}  (${cpU.toExponential(2)})`)
  console.log(`  (2) p99.9 window < p1 cosign_cost:               ${gate2 ? 'PASS' : 'FAIL'}  (${fmt(wTail.value)}ms vs ${fmt(fastestAttack)}ms)`)
  console.log(`  VERDICT: ${gate1 && gate2 ? 'Strict Fast viable on this sample' : 'Strict Fast NOT supported → Conservative'}`)
}

console.log(`\n⚠ SMOKE/indicative unless this is a long, production-region, real-independent-witness run.`)
console.log(`  A few local rounds cannot pin a p99.9 tail or an exploitable_fraction CI; this proves the pipeline, not the deployment.`)
