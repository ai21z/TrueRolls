#!/usr/bin/env node
// §3.3 — cosign-cost rig: the attack-execution latency (the denominator of
// exploitability). Measures, per attempt: build+sign a commit (real Ed25519) →
// submit to the witness set → collect the k-th reactive cosignature.
//   cosign_cost = start → the k-th cosignature received AND verified.
//
// HONEST SCOPE of this LOCAL rig:
//  • The crypto + serialization cost is REAL (node Ed25519, timed from t0 before the
//    commit is signed, so the server-sign time is included).
//  • The per-witness network RTT is MODELLED (base + jitter + a rare per-witness
//    spike). A local rig CANNOT measure RTT to genuinely independent, geographically
//    distributed witnesses — that is the operational §9.1 unknown. The RTT parameters
//    are inputs, stated, not measured.
//  • LOAD runs attempts concurrently. It contends only in-process (Ed25519 + event
//    loop); the modelled-RTT sleeps overlap freely, so cosign_cost here is a NO-LOAD
//    floor. Real cosign-cost-under-load needs real witness endpoints (network/OS
//    queueing) — not modelled here. Treat the number as a lower bound on the denominator.
//  • The per-witness spike models ONE witness's tail. k-of-n collection with k<n
//    CORRECTLY filters it (you wait for the k-th, tolerating n−k slow witnesses), so
//    cosign_cost has no spike tail by design — and p1 (the gate's fastest attack) is
//    set by base+jitter. This is realistic, not a defect; do not read a spike tail into it.
//
// Run:  node cosign/cosign-rig.mjs -k 3 -n 5
// Env:  ATTEMPTS=500 LOAD=8 COSIGN_RTT_MS=80 COSIGN_RTT_JITTER_MS=40
//       RTT_SPIKE_P=0.01 RTT_SPIKE_MS=500 OUT=cosign.jsonl

import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { percentiles } from '../lib/schema.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const K = Number(arg('-k', 3))
const N = Number(arg('-n', 5))
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 500)
const LOAD = Math.max(1, Number(process.env.LOAD ?? 8))   // concurrent attempts — in-process crypto/event-loop only (see header)
const RTT_MS = Number(process.env.COSIGN_RTT_MS ?? 80)
const RTT_JITTER = Number(process.env.COSIGN_RTT_JITTER_MS ?? 40)
const SPIKE_P = Number(process.env.RTT_SPIKE_P ?? 0.01)
const SPIKE_MS = Number(process.env.RTT_SPIKE_MS ?? 500)
const OUT = process.env.OUT ?? 'cosign.jsonl'

if (K > N) { console.error(`FATAL: k=${K} > n=${N}`); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const canon = (o) => Buffer.from(JSON.stringify(o, Object.keys(o).sort()))   // representative canonical bytes

// Real Ed25519 keys: one server signer + n witnesses.
const serverKey = generateKeyPairSync('ed25519')
const witnessKeys = Array.from({ length: N }, () => generateKeyPairSync('ed25519'))

const modelledRtt = () => {
  const base = RTT_MS + Math.random() * RTT_JITTER
  return Math.random() < SPIKE_P ? base + SPIKE_MS : base
}

async function oneAttempt(epoch) {
  const t0 = process.hrtime.bigint()
  // server builds + signs the commit (real Ed25519) — inside the timed window
  const commit = canon({ v: 'truerolls-v2-strict', epoch, batch_root: 'b'.repeat(64), target_round: 1000 + epoch })
  const serverSig = edSign(null, commit, serverKey.privateKey)
  if (serverSig.length !== 64) throw new Error('bad server sig')
  // submit to all n witnesses; each takes a modelled RTT then really cosigns; the
  // server collects + verifies. cosign_cost is set by the k-th to complete.
  const completions = await Promise.all(witnessKeys.map(async (wk, j) => {
    await sleep(modelledRtt())
    const payload = canon({ checkpoint_hash: 'cp', commit_leaf: 'leaf', observed_drand_round: 1000 + epoch, w: j })
    const wsig = edSign(null, payload, wk.privateKey)
    if (!edVerify(null, payload, wk.publicKey, wsig)) throw new Error('cosig verify failed')
    return process.hrtime.bigint()
  }))
  const kth = completions.sort((a, b) => (a < b ? -1 : 1))[K - 1]
  return Number(kth - t0) / 1e6   // ms
}

const main = async () => {
  console.log(`cosign-cost: k=${K} of n=${N}, attempts=${ATTEMPTS}, load=${LOAD} concurrent (in-process only)`)
  console.log(`RTT model (per witness): ${RTT_MS}ms + U(0,${RTT_JITTER}) + ${(SPIKE_P * 100).toFixed(1)}%×${SPIKE_MS}ms spike  [MODELLED, not measured; spike filtered by k-of-n for k<n]`)
  console.log(`→ ${OUT}\n`)
  const costs = []
  let done = 0
  while (done < ATTEMPTS) {
    const batch = Math.min(LOAD, ATTEMPTS - done)
    const results = await Promise.all(Array.from({ length: batch }, (_, b) => oneAttempt(done + b)))
    for (let b = 0; b < results.length; b++) {
      costs.push(results[b])
      appendFileSync(OUT, JSON.stringify({ attempt: done + b, cosignCostMs: results[b] }) + '\n')
    }
    done += batch
  }
  const p = percentiles(costs, [1, 50, 95, 99, 99.9])
  console.log('cosign_cost ms:', p)
  console.log(`\nwrote ${costs.length} attempts to ${OUT}. p1=${p.p1?.toFixed(1)}ms is the FASTEST attack and a NO-LOAD floor (the gate's denominator).`)
}

main().catch((e) => { console.error(e); process.exit(1) })
