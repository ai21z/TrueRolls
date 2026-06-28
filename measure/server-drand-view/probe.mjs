#!/usr/bin/env node
// TrueRolls - §3.1 standalone server-drand-view probe (throwaway measurement harness).
// Measures, per drand quicknet round R: the wall-clock arrival of σ_R at each relay, the
// latency vs the scheduled round time, and the per-round RELAY SPREAD (fastest vs slowest).
//
// The relay spread is the clock-robust signal (one machine clock, so common offset cancels):
// it is the spread ACROSS THE CONFIGURED RELAYS only - an indicative LOWER bound on the server's
// advantage, NOT an upper bound. A real independent witness (§3.2) may sit on a worse path / ASN /
// region than any relay here, so the true server-vs-witness skew can EXCEED this spread; only §3.2
// pins it (see ../../docs/design/beacon-skew-measurement.md §3.1, §4).
//
// Verification scope: this probe checks drand SELF-CONSISTENCY only (randomness == SHA-256(σ)). It
// does NOT BLS-verify σ under the quicknet group key - full BLS verification + dropping unverified
// samples lands with §3.2, so σ values here are timing samples, not authenticated beacon values.
//
// Run (Node 20+, zero deps):  node probe.mjs
// Env: ROUNDS=20  POLL_MS=80  DEADLINE_PERIODS=4  OUT=server-drand-view.jsonl  RELAYS=csv
// This is TIMING ONLY: no witnesses, no fairness claim. Run from the production region for
// the real number; a local run validates the method and gives a first read.

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971' // quicknet
const RELAYS = (process.env.RELAYS
  ? process.env.RELAYS.split(',')
  : ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com']
).map((s) => s.trim().replace(/\/$/, ''))
const ROUNDS = Number(process.env.ROUNDS ?? 20)
const POLL_MS = Number(process.env.POLL_MS ?? 80)
const DEADLINE_PERIODS = Number(process.env.DEADLINE_PERIODS ?? 4)
const OUT = process.env.OUT ?? 'server-drand-view.jsonl'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex')

function stats(arr) {
  const s = [...arr].filter((x) => x != null).sort((a, b) => a - b)
  if (!s.length) return { n: 0 }
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { n: s.length, p50: pct(50), p95: pct(95), p99: pct(99), p999: pct(99.9), max: s[s.length - 1] }
}

async function getInfo() {
  for (const relay of RELAYS) {
    try {
      const res = await fetch(`${relay}/${CHAIN}/info`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) return await res.json()
    } catch { /* try next relay */ }
  }
  throw new Error('could not fetch /info from any relay - check network/relays')
}

// Poll one relay for a SPECIFIC round until it returns 200; resolve first-arrival time.
async function awaitRound(relay, round, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${relay}/${CHAIN}/public/${round}`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return { arrival: Date.now(), body: await res.json() }
    } catch { /* not published yet, or transient - keep polling */ }
    await sleep(POLL_MS)
  }
  return null
}

const main = async () => {
  const info = await getInfo()
  if (info.hash !== CHAIN) {
    console.error(`FATAL: relay /info hash ${info.hash} != pinned quicknet ${CHAIN} (missing hash fails closed)`); process.exit(1)
  }
  const period = Number(info.period)
  const genesis = Number(info.genesis_time)
  console.log(`quicknet: scheme=${info.schemeID} period=${period}s genesis=${genesis}`)
  console.log(`relays: ${RELAYS.join(', ')}`)
  console.log(`capturing ${ROUNDS} rounds (~${ROUNDS * period}s), poll=${POLL_MS}ms, deadline=${DEADLINE_PERIODS} periods → ${OUT}\n`)

  let round = Math.floor((Date.now() / 1000 - genesis) / period) + 1 // next round
  const perRelay = Object.fromEntries(RELAYS.map((r) => [r, []]))
  const spreads = []
  const censoredSpreadLowerBounds = []

  for (let i = 0; i < ROUNDS; i++, round++) {
    const schedMs = (genesis + round * period) * 1000
    const wait = schedMs - 120 - Date.now()
    if (wait > 0) await sleep(wait)
    const deadline = schedMs + DEADLINE_PERIODS * period * 1000
    const deadlineLatencyMs = deadline - schedMs

    const results = await Promise.all(RELAYS.map(async (relay) => {
      const got = await awaitRound(relay, round, deadline)
      if (!got) return { relay, latencyMs: null, sigOk: null, timedOut: true }
      const latencyMs = got.arrival - schedMs
      const sigOk = got.body.signature && got.body.randomness
        ? sha256hex(Buffer.from(got.body.signature, 'hex')) === got.body.randomness
        : null
      perRelay[relay].push(latencyMs)
      return { relay, latencyMs, sigOk, timedOut: false }
    }))

    const lat = results.map((r) => r.latencyMs).filter((x) => x != null)
    const missingRelays = results.filter((r) => r.latencyMs == null).map((r) => r.relay)
    const complete = missingRelays.length === 0
    const fastest = lat.length ? Math.min(...lat) : null
    const slowest = lat.length ? Math.max(...lat) : null
    const exactSpread = complete && fastest != null && slowest != null ? slowest - fastest : null
    const spreadLowerBound = !complete && fastest != null ? deadlineLatencyMs - fastest : exactSpread
    if (exactSpread != null) spreads.push(exactSpread)
    if (!complete && spreadLowerBound != null) censoredSpreadLowerBounds.push(spreadLowerBound)
    const badSig = results.some((r) => r.sigOk === false)

    const rec = {
      round,
      schedMs,
      deadlineLatencyMs,
      complete,
      missingRelays,
      fastestLatencyMs: fastest,
      slowestLatencyMs: slowest,
      relaySpreadMs: exactSpread,
      relaySpreadLowerBoundMs: spreadLowerBound,
      badSig,
      results
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')
    const spreadText = complete
      ? `spread=${exactSpread}ms`
      : `spread>=${spreadLowerBound}ms CENSORED missing=${missingRelays.length}`
    console.log(`round ${round}: fastest=${fastest}ms slowest=${slowest}ms ${spreadText}${badSig ? '  SIG MISMATCH' : ''}`)
  }

  console.log('\n=== per-relay σ-arrival latency vs scheduled (ms) - has local clock offset; NTP-sync for absolute accuracy ===')
  for (const r of RELAYS) console.log(`  ${r}`, stats(perRelay[r]))
  console.log('\n=== EXACT RELAY SPREAD per complete round (ms) - clock-robust; configured-relay spread only ===')
  console.log(' ', stats(spreads))
  if (censoredSpreadLowerBounds.length) {
    console.log('\n=== CENSORED relay-spread lower bounds for incomplete rounds (ms) - actual tail is >= this ===')
    console.log(' ', stats(censoredSpreadLowerBounds))
  }
  console.log(`\nwrote ${spreads.length}/${ROUNDS} complete rounds to ${OUT}; censored=${censoredSpreadLowerBounds.length}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
