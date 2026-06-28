#!/usr/bin/env node
// §3.2 - dev-witness frontier recorder (with the server role, on one clock).
//
// Stands up one "server" role (its best/fastest relay) and `n` "witness" roles,
// each pinned to a DISTINCT relay, and per round R records - on a SINGLE machine
// clock so the common offset cancels in the reducer's window(R) - the wall-clock
// time each role first SEES and BLS-VERIFIES round R (`t_server`, `t_w`). Every
// sample is verified against the PINNED quicknet group key (lib/drand-bls.mjs);
// a fast-but-unverified σ is recorded as blsOk:false and treated by the reducer as
// "never advanced" (it can only raise the window, never lower it).
//
// The relay's /info is trusted ONLY for genesis/period; its advertised public_key
// is asserted equal to the pinned key (fail closed) and never used for verification,
// so a hostile relay with the right chain hash but its own key cannot forge a sample.
//
// HONEST LIMIT (same as §3.1): one host varies the RELAY per witness and can add a
// deliberate per-witness delay to STRESS the skew tail, but it CANNOT manufacture
// real ASN/region/operator independence - that is operational (v2-spec §9.1), not
// measured here. This rig characterises relay-path skew, not witness independence.
//
// window(R) and exploitable_fraction are NOT computed here - that is reduce/window.mjs.
//
// Run:  node witness/witness.mjs            (Node 20+, dep: @noble/curves)
// Env:  ROUNDS=20 POLL_MS=80 DEADLINE_PERIODS=4 OUT=witness-frontier.jsonl
//       SERVER_RELAY=url  WITNESS_RELAYS=csv  WITNESS_DELAYS_MS=csv

import { appendFileSync } from 'node:fs'
import { verifyBeacon, randomnessMatches, assertPinnedKey, PINNED_PUBKEY, CHAIN } from '../lib/drand-bls.mjs'

const SERVER_RELAY = (process.env.SERVER_RELAY ?? 'https://api.drand.sh').trim().replace(/\/$/, '')
const WITNESS_RELAYS = (process.env.WITNESS_RELAYS ??
  'https://api2.drand.sh,https://api3.drand.sh,https://drand.cloudflare.com')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
const WITNESS_DELAYS_MS = (process.env.WITNESS_DELAYS_MS ?? '').split(',').map((s) => Number(s.trim()) || 0)
const ROUNDS = Number(process.env.ROUNDS ?? 20)
const POLL_MS = Number(process.env.POLL_MS ?? 80)
const DEADLINE_PERIODS = Number(process.env.DEADLINE_PERIODS ?? 4)
const OUT = process.env.OUT ?? 'witness-frontier.jsonl'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchInfo(relay) {
  const r = await fetch(`${relay}/${CHAIN}/info`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`${relay} /info returned HTTP ${r.status}`)
  return await r.json()
}

function assertRelayInfo(relay, info, expected = null) {
  if (info.hash !== CHAIN) {
    throw new Error(`${relay} /info hash ${info.hash} != pinned quicknet ${CHAIN} (missing hash fails closed)`)
  }
  assertPinnedKey(info)
  if (info.schemeID !== 'bls-unchained-g1-rfc9380') {
    throw new Error(`${relay} /info scheme ${info.schemeID} != bls-unchained-g1-rfc9380`)
  }
  if (expected && (Number(info.period) !== expected.period || Number(info.genesis_time) !== expected.genesis)) {
    throw new Error(`${relay} /info schedule mismatch: period/genesis ${info.period}/${info.genesis_time} != ${expected.period}/${expected.genesis}`)
  }
}

// Poll one relay for round R; on first 200, BLS-verify σ under the PINNED group key.
async function awaitRoundVerified(relay, round, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${relay}/${CHAIN}/public/${round}`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const arrival = Date.now()
        const body = await res.json()
        return {
          arrival,
          blsOk: verifyBeacon(round, body.signature),          // pinned key (default)
          randOk: randomnessMatches(body.signature, body.randomness),
        }
      }
    } catch { /* not published yet / transient */ }
    await sleep(POLL_MS)
  }
  return null
}

const main = async () => {
  const configuredRelays = [SERVER_RELAY, ...WITNESS_RELAYS]
  const duplicateRelays = configuredRelays.filter((relay, i) => configuredRelays.indexOf(relay) !== i)
  if (duplicateRelays.length) {
    console.error(`FATAL: server/witness relays must be distinct; duplicates: ${[...new Set(duplicateRelays)].join(', ')}`)
    process.exit(1)
  }

  let info
  try {
    info = await fetchInfo(SERVER_RELAY)
    assertRelayInfo(SERVER_RELAY, info)
    const expected = { period: Number(info.period), genesis: Number(info.genesis_time) }
    for (const relay of WITNESS_RELAYS) assertRelayInfo(relay, await fetchInfo(relay), expected)
  } catch (e) {
    console.error(`FATAL: ${e.message}`)
    process.exit(1)
  }
  const period = Number(info.period)
  const genesis = Number(info.genesis_time)
  const roles = [
    { id: 'server', relay: SERVER_RELAY, delayMs: 0, isServer: true },
    ...WITNESS_RELAYS.map((relay, i) => ({ id: `w${i + 1}`, relay, delayMs: WITNESS_DELAYS_MS[i] || 0, isServer: false })),
  ]

  console.log(`quicknet pinned: scheme=${info.schemeID} period=${period}s pubkey=${PINNED_PUBKEY.slice(0, 16)}… (pinned, BLS-verified)`)
  console.log(`server  : ${SERVER_RELAY}`)
  roles.filter((r) => !r.isServer).forEach((r) => console.log(`witness ${r.id}: ${r.relay}${r.delayMs ? `  +${r.delayMs}ms (modelled lag)` : ''}`))
  console.log(`capturing ${ROUNDS} rounds (~${ROUNDS * period}s) → ${OUT}\n`)

  let round = Math.floor((Date.now() / 1000 - genesis) / period) + 1
  let badBlsRounds = 0
  for (let i = 0; i < ROUNDS; i++, round++) {
    const schedMs = (genesis + round * period) * 1000
    const wait = schedMs - 120 - Date.now()
    if (wait > 0) await sleep(wait)
    const deadline = schedMs + DEADLINE_PERIODS * period * 1000

    const got = await Promise.all(roles.map(async (role) => {
      const r = await awaitRoundVerified(role.relay, round, deadline)
      const meta = { id: role.id, relay: role.relay, delayMs: role.delayMs }
      if (!r) return { ...meta, arrivalMs: null, blsOk: null, randOk: null, timedOut: true }
      return { ...meta, arrivalMs: (r.arrival - schedMs) + role.delayMs, blsOk: r.blsOk, randOk: r.randOk, timedOut: false }
    }))

    const server = got.find((g) => g.id === 'server')
    const witnesses = got.filter((g) => g.id !== 'server')
    const badBls = got.some((g) => g.blsOk === false)
    if (badBls) badBlsRounds++

    appendFileSync(OUT, JSON.stringify({ round, schedMs, deadlineLatencyMs: deadline - schedMs, server, witnesses, badBls }) + '\n')
    const wsum = witnesses.map((w) => (w.arrivalMs == null ? '∅' : `${w.arrivalMs}ms`)).join(' ')
    console.log(`round ${round}: server=${server.arrivalMs == null ? '∅' : server.arrivalMs + 'ms'} witnesses=[${wsum}]${badBls ? '  ⚠ BLS-FAIL' : ''}`)
  }

  console.log(`\nwrote ${ROUNDS} rounds to ${OUT}; rounds with a BLS failure: ${badBlsRounds}`)
  console.log(`next: node reduce/window.mjs --frontier ${OUT} --cosign <cosign.jsonl> -k <k>  → window(R) + exploitable_fraction`)
}

main().catch((e) => { console.error(e); process.exit(1) })
