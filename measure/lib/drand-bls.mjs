#!/usr/bin/env node
// Shared drand quicknet BLS verification - scheme bls-unchained-g1-rfc9380.
//
// Signatures live in G1 (48-byte compressed); the group public key lives in G2
// (96-byte compressed). "Unchained" means the signed message is the round alone:
//   m = SHA-256( uint64_be(round) )  -> hashed onto G1 with the RFC 9380 DST.
// Verification is one pairing check against the PINNED quicknet group key (the
// constant below - NEVER a key a relay hands back at runtime). This is the
// authenticity gate the §3.1/§3.2 timing samples are filtered through: a
// fast-but-bogus σ that does not verify is not a measurement and must be dropped.
//
// Self-test against a LIVE quicknet round (the oracle for DST + message encoding,
// and the proof that a WRONG key rejects a real σ):
//   node lib/drand-bls.mjs --selftest

import { bls12_381 } from '@noble/curves/bls12-381.js'
import { createHash } from 'node:crypto'

// quicknet chain (pinned).
export const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
// quicknet group public key (G2, 96B), PINNED. Cross-checked byte-identical across
// api/api2/api3.drand.sh + drand.cloudflare.com; an auditor should also confirm it
// against drand's published value (drand.love). verifyBeacon defaults to THIS key so
// a hostile/MITM relay returning the right chain hash but its own key cannot make a
// forged σ verify. Re-pin only on a real, externally-confirmed group re-share.
export const PINNED_PUBKEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a'
// RFC 9380 basic-scheme DST for G1 signatures (drand quicknet / tlock).
export const DRAND_G1_DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'

const sha256 = (buf) => createHash('sha256').update(buf).digest()
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'))

function roundToBE8(round) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(round))
  return b
}

// The message drand unchained signs for `round`: SHA-256(8-byte BE round).
export function unchainedMessage(round) {
  return sha256(roundToBE8(round))
}

// Fail closed if a relay's /info advertises a different group key than the pinned
// one (group re-share, or a hostile/MITM relay). Callers MUST gate on this before
// trusting any round from that relay.
export function assertPinnedKey(info) {
  if (info?.public_key !== PINNED_PUBKEY) {
    throw new Error(
      `group public key mismatch: /info=${String(info?.public_key).slice(0, 16)}… != pinned ${PINNED_PUBKEY.slice(0, 16)}… (re-share or hostile relay) - refusing to measure`,
    )
  }
}

// True iff `signatureHex` is a valid quicknet G1 signature for `round` under the
// G2 group key (DEFAULTS to the pinned key; an explicit key is for testing only).
// Never throws - malformed input -> false.
export function verifyBeacon(round, signatureHex, groupPublicKeyHex = PINNED_PUBKEY) {
  try {
    const msgPoint = bls12_381.shortSignatures.hash(unchainedMessage(round), DRAND_G1_DST)
    return bls12_381.shortSignatures.verify(hexToBytes(signatureHex), msgPoint, hexToBytes(groupPublicKeyHex))
  } catch {
    return false
  }
}

// Cheap self-consistency: drand publishes randomness = SHA-256(signature). This is
// NOT authenticity (any relay can fabricate a consistent pair) - use verifyBeacon.
export function randomnessMatches(signatureHex, randomnessHex) {
  return sha256(hexToBytes(signatureHex)).toString('hex') === randomnessHex
}

// --- live self-test (DST/encoding oracle + wrong-key rejection) ---------------
function diagnose(round, signatureHex, pkHex) {
  const sig = hexToBytes(signatureHex)
  const pk = hexToBytes(pkHex)
  const variants = [
    ['sha256(roundBE) + NUL_DST', () => bls12_381.shortSignatures.hash(sha256(roundToBE8(round)), DRAND_G1_DST)],
    ['roundBE (no sha256) + NUL_DST', () => bls12_381.shortSignatures.hash(roundToBE8(round), DRAND_G1_DST)],
    ['sha256(roundBE) + noble-default DST', () => bls12_381.shortSignatures.hash(sha256(roundToBE8(round)))],
  ]
  for (const [name, mk] of variants) {
    try { if (bls12_381.shortSignatures.verify(sig, mk(), pk)) return name } catch { /* invalid encoding */ }
  }
  return null
}

async function selftest() {
  const relay = (process.env.RELAYS?.split(',')[0] ?? 'https://api.drand.sh').trim().replace(/\/$/, '')
  const info = await (await fetch(`${relay}/${CHAIN}/info`)).json()
  if (info.hash !== CHAIN) { console.error(`FATAL: /info hash ${info.hash} != pinned ${CHAIN}`); process.exit(1) }
  let pinnedKeyOk = true
  try { assertPinnedKey(info) } catch { pinnedKeyOk = false }
  const { round, signature, randomness } = await (await fetch(`${relay}/${CHAIN}/public/latest`)).json()

  const okValid = verifyBeacon(round, signature)                       // pinned key (default)
  const okRand = randomnessMatches(signature, randomness)
  const flipped = signature.slice(0, -2) + ((parseInt(signature.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0'))
  const okTamperFails = verifyBeacon(round, flipped) === false
  const okWrongRound = verifyBeacon(round + 1, signature) === false
  // A valid but WRONG G2 key must reject the REAL σ (this is the pinning guarantee).
  const wrongPk = Buffer.from(bls12_381.shortSignatures.getPublicKey(bls12_381.utils.randomSecretKey()).toBytes()).toString('hex')
  const okWrongKeyRejects = verifyBeacon(round, signature, wrongPk) === false

  console.log(`relay        : ${relay}`)
  console.log(`pinned pubkey: ${PINNED_PUBKEY.slice(0, 24)}… (${PINNED_PUBKEY.length / 2}B, G2)`)
  console.log(`round        : ${round}   sig=${signature.length / 2}B (G1)`)
  console.log(`/info key == pinned         : ${pinnedKeyOk ? 'ok ✓' : 'MISMATCH ✗'}`)
  console.log(`verifyBeacon (real round)   : ${okValid ? 'VALID ✓' : 'FAIL ✗'}`)
  if (!okValid) console.log(`  diagnose -> matching variant: ${diagnose(round, signature, PINNED_PUBKEY) ?? 'NONE (DST/encoding still wrong)'}`)
  console.log(`randomness == SHA-256(sig)  : ${okRand ? 'ok ✓' : 'MISMATCH ✗'}`)
  console.log(`tampered signature rejected : ${okTamperFails ? 'ok ✓' : 'ACCEPTED A FORGERY ✗'}`)
  console.log(`wrong round rejected        : ${okWrongRound ? 'ok ✓' : 'ACCEPTED WRONG ROUND ✗'}`)
  console.log(`WRONG KEY rejects real σ    : ${okWrongKeyRejects ? 'ok ✓' : 'ACCEPTED UNDER WRONG KEY ✗'}`)
  const pass = pinnedKeyOk && okValid && okRand && okTamperFails && okWrongRound && okWrongKeyRejects
  console.log(`\n${pass ? 'SELFTEST PASS - BLS verify correct + pinned against live quicknet' : 'SELFTEST FAIL'}`)
  process.exit(pass ? 0 : 1)
}

if (process.argv.includes('--selftest')) selftest().catch((e) => { console.error(e); process.exit(1) })
