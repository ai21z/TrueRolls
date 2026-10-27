# TrueRolls Claim Library

This is the claim boundary for new TrueRolls copy, docs, UI text, and release notes.
It is a floor, not a replacement for richer disclosures in
[threat-model.md](threat-model.md), [verifying.md](verifying.md), and
[api.md](api.md).

## Canonical Short Claims

Use these when space is tight. Do not strengthen them.

### Fairness Boundary

The request is bound to a future drand round before that round is known, and the
receipt proves the published result came from that verified beacon. It still does
not prove the operator could not privately refuse or withhold an unfavorable
attempt.

### Valid Receipt

For `truerolls-drand-1`, `VALID` proves the receipt was signed by the named
Ed25519 key, the roll seed came from a BLS-verified public drand quicknet pulse,
the seed and draw replay, the face replays through prefix-CDF sampling, and the
bounded math replays.

### Honest Limit

`VALID` does not prove the published outcome was unbiased. The live product has
no public pre-target commitment to one attempt, so the operator can still grind
by failing, suppressing, or refusing unfavorable attempts and publishing only a
favorable completed receipt. Strict witnessed fairness is the v2 protocol.

### Latency

Typical quicknet delay is target-round dependent. The live per-roll product uses
`target_round = client_observed_round + 2`, so users should expect a short beacon
wait plus network and signing time. There is no committed production measurement
artifact yet.

### Comparison

TrueRolls' current advantage is not an on-chain speed claim. It is a no-chain,
no-token, portable receipt that verifies offline in a browser or CLI. Do not
claim it is faster than a specific VRF system unless a committed benchmark and
official source support the comparison.

## What Current TrueRolls Proves

The live product mints `truerolls-drand-1` receipts.

- **Tamper-evidence:** the receipt's JCS / RFC 8785 canonical signed content
  matches what the named Ed25519 key signed.
- **Drand seed provenance:** the verifier checks pinned quicknet parameters,
  BLS-verifies the client-observed and target pulses, checks
  `target_round = client_observed_round + 2`, checks
  `randomness = SHA256(signature)`, and re-derives the seed with HKDF-SHA256.
- **Deterministic replay:** ChaCha20 replays the draw, prefix-CDF replays the
  face, and the verifier recomputes the published result.
- **Bounded math:** `kappa` is public, signed, range-checked, and the
  distribution is guarded by KL and expected-value caps.

## What Current TrueRolls Does Not Prove

- It does not prove the operator could not refuse a request.
- It does not prove the operator could not time out or suppress an unfavorable
  attempt.
- It does not prove the published outcome was unbiased across unpublished
  attempts.
- It does not implement commit/reveal, VRF, witnessed transparency-log
  anchoring, on-chain settlement, or strict witnessed fairness.
- It does not turn demo/mock verification into cryptographic verification.

## Words That Need Care

- **Provably fair:** only use with the explicit per-roll scope. Prefer
  "verifiable drand-backed receipt" unless the sentence also states the
  withholding/grinding limit.
- **Cryptographic:** qualify the object being checked, for example
  "cryptographic receipt verification" or "cryptographic drand proof." Do not
  use it as a blanket product guarantee.
- **Trustless:** do not use for the live product.
- **Cannot cheat / impossible / always fair / 100% fair:** do not use for the
  live product.
- **Tamper-proof:** use "tamper-evident" instead.

## Approved References

- drand quicknet: public randomness beacon, scheme `bls-unchained-g1-rfc9380`.
- Ed25519: RFC 8032 receipt signatures.
- JCS: RFC 8785 canonical JSON for signed bytes.
- HKDF-SHA256: RFC 5869 seed derivation.
- SHA-256: randomness and receipt hashing.
- ChaCha20: deterministic DRBG for replay.
- Sampling: prefix-CDF, no modulo sampling.

## Existing Richer Disclosures Must Stay

Do not simplify away the stronger explanations already present in the docs:

- grind / outcome-shopping language,
- "outcome-bias, not just availability",
- UKGC RTS 7 no-discard mapping,
- v2 witnessed fairness as the path to closing the withholding gap.
