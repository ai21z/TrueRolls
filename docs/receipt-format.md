# Receipt format

A TrueRolls receipt is a self-contained JSON document returned for every live roll. It carries the outcome, bounded-math metrics, seed replay material, drand proof material, and an Ed25519 signature over a canonical encoding of all of that. Given a receipt and the issuer's key set or a direct public key, anyone can recompute the outcome offline.

This page documents the current live version, `truerolls-drand-1`, and the legacy saved-receipt version, `truerolls-1`.

> This document and the TrueRolls verifier are proprietary, all rights reserved.

## What a receipt proves

For `truerolls-drand-1`, `VALID` proves:

1. **Tamper-evidence.** The signed body was produced by the holder of the key named by `sig.kid`.
2. **Drand seed provenance.** The seed re-derives from a BLS-verified drand quicknet target pulse, with `target_round = client_observed_round + 2`.
3. **Deterministic replay.** The draw replays from the seed, and the face replays from the draw and recomputed distribution.
4. **Bounded math.** `alpha`, `kl`, and `ev` match the guarded engine output.

`VALID` does not prove the published outcome was unbiased: because the operator's attempt is not publicly committed before the target round resolves, it can still **grind**, privately fail/suppress unfavorable attempts and publish only a favorable completed receipt. Strict witnessed fairness (one committed attempt per roll) is the v2 protocol.

Legacy `truerolls-1` receipts prove only tamper-evidence, deterministic replay, and bounded math. They have no `proof.drand`.

## Top-level shape

```json
{
  "v": "truerolls-drand-1",
  "id": "…",
  "die": "d20",
  "kappa": 0.6,
  "face": 10,
  "alpha": 0.32,
  "kl": 0.02,
  "ev": 11.65,
  "created_at": "2026-01-01T00:00:00Z",
  "transcript_url": "/v1/roll/<id>/transcript",
  "transcript_key": "s3://…",
  "proof": { "…" : "…" },
  "receipt_hash": "sha256:<hex>",
  "sig": { "…" : "…" }
}
```

The receipt body is everything except `receipt_hash` and `sig`. `receipt_hash` and `sig` are computed from the body and attached afterward.

## Body fields

| Field | Type | Meaning |
|---|---|---|
| `v` | string | `"truerolls-drand-1"` for live receipts; legacy `"truerolls-1"` remains accepted. |
| `id` | string (UUID) | Public roll id. |
| `die` | string | One of the supported dice. Live roll endpoint accepts `d6`, `d20`, `d100`; verifier also parses saved receipts for `d4`, `d8`, `d10`, `d12`. |
| `kappa` | number | Behavior-weighting stance in `[-1, 1]`. Out-of-range values hard-fail through the engine. |
| `face` | integer | Rolled face, 1-indexed. |
| `alpha` | number | Guard mixing weight toward uniform. |
| `kl` | number | KL divergence from uniform, in nats. |
| `ev` | number | Expected value of the weighted distribution. |
| `created_at` | string | Issue timestamp. |
| `transcript_url` | string | Informational URL for the transcript. A transcript is not a substitute for receipt verification. |
| `transcript_key` | string | Optional storage key; omitted when absent. |
| `proof` | object | Replay and drand proof block. |

## `proof`

| Field | Type | Meaning |
|---|---|---|
| `proof.math_param_version` | string | Engine parameter version, currently `"roll.math.v1"`. |
| `proof.draw_u64` | string | Decimal string containing the single 64-bit draw. |
| `proof.rng.drbg_key_hex` | string | 32-byte ChaCha20 seed, hex encoded. |
| `proof.rng.algo` | string | For live drand receipts: `"drand-quicknet+HKDF(SHA-256)->ChaCha20Rng"`. |
| `proof.drand` | object | Present on `truerolls-drand-1`; absent on legacy `truerolls-1`. |

## `proof.drand`

| Field | Type | Meaning |
|---|---|---|
| `chain_hash` | string | Pinned drand quicknet chain hash. |
| `scheme` | string | Pinned scheme: `bls-unchained-g1-rfc9380`. |
| `public_key` | string | Pinned quicknet BLS public key, hex. |
| `period_seconds` | integer | Pinned period, currently `3`. |
| `genesis_time` | integer | Pinned quicknet genesis Unix timestamp. |
| `target_delay_rounds` | integer | Must be `2`. |
| `client_nonce` | string | Client-generated 32 random bytes encoded as 64 hex characters. |
| `client_observed_round` | integer | The drand frontier round the client observed before requesting the roll. |
| `client_observed_signature_hex` | string | BLS signature for `client_observed_round`. |
| `client_observed_randomness_hex` | string | `SHA256(client_observed_signature)`. |
| `target_round` | integer | Must equal `client_observed_round + 2`. |
| `target_signature_hex` | string | BLS signature for the target round. |
| `target_randomness_hex` | string | `SHA256(target_signature)`. |
| `idem_payload_sha256_hex` | string | SHA-256 over the canonical roll request binding used as HKDF salt. |

The verifier BLS-verifies both drand pulses, checks both randomness fields, checks the target formula, recomputes the HKDF seed, and requires it to equal `proof.rng.drbg_key_hex`.

## Integrity fields

| Field | Type | Meaning |
|---|---|---|
| `receipt_hash` | string | `"sha256:<hex>"` over the canonical receipt body. |
| `sig.alg` | string | `"Ed25519"`. |
| `sig.kid` | string | Key id naming which published key verifies this receipt. |
| `sig.signature_b64` | string | Base64 Ed25519 signature over the canonical body bytes. |
| `sig.canon` | string | `"JCS/RFC8785"`. |

Both `receipt_hash` and `sig` cover the same canonical bytes and are never part of the bytes they protect.

## Canonicalization

Both the SHA-256 receipt hash and the Ed25519 signature are computed over the RFC 8785 JSON Canonicalization Scheme serialization of the body with `sig` and `receipt_hash` removed.

To reproduce:

1. Parse the receipt JSON into an object.
2. Remove `sig` and `receipt_hash`.
3. JCS-canonicalize the remaining object.
4. `receipt_hash` is `"sha256:" + hex(SHA256(canonical_bytes))`.
5. Signature verification is `Ed25519_verify(public_key, canonical_bytes, base64_decode(sig.signature_b64))`.

## Drand seed derivation

For live receipts:

- IKM: target drand randomness (`SHA256(target_signature)`).
- Salt: `idem_payload_sha256_hex`.
- Info: canonical JCS array containing the receipt version, quicknet chain hash, target round, die, kappa, client nonce, and canonical payload hash.
- Output: 32 bytes used as the ChaCha20 seed and published as `proof.rng.drbg_key_hex`.

The verifier recomputes this derivation. Tampering with nonce, target round, target signature, target randomness, die, kappa, or request binding changes the derived seed and invalidates the drand check.

## Key discovery

The issuer publishes Ed25519 verifying keys at:

```text
GET /.well-known/truerolls-keys.json
```

Shape:

```json
{ "keys": [ { "kid": "issuer-key-1", "alg": "Ed25519", "public_key": "<base64 32-byte key>", "status": "active" } ] }
```

The shared verifier selects the key whose `kid` matches `sig.kid`. `active` and `retired` keys can verify receipts. `revoked` keys make every receipt under that `kid` invalid. Offline verifiers may instead be handed one public key directly, but that bypasses key-status semantics.

## Verification order

1. Parse and version-gate the receipt.
2. Verify drand proof for `truerolls-drand-1`.
3. Verify Ed25519 signature.
4. Replay `proof.draw_u64` from `proof.rng.drbg_key_hex`.
5. Recompute face.
6. Recompute `alpha`, `kl`, and `ev`.

A valid receipt requires all reported checks to pass. Structural problems such as unsupported version, missing drand proof on a drand receipt, malformed hex, unsupported die, bad draw, math-parameter mismatch, or out-of-range `kappa` are hard errors.

## Example skeleton

```json
{
  "v": "truerolls-drand-1",
  "id": "00000000-0000-0000-0000-000000000001",
  "die": "d20",
  "kappa": 0.6,
  "face": 10,
  "alpha": 0.3213648106902838,
  "kl": 0.02011901380257613,
  "ev": 11.65325625845831,
  "created_at": "2026-01-01T00:00:00Z",
  "transcript_url": "/v1/roll/00000000-0000-0000-0000-000000000001/transcript",
  "proof": {
    "math_param_version": "roll.math.v1",
    "rng": {
      "algo": "drand-quicknet+HKDF(SHA-256)->ChaCha20Rng",
      "drbg_key_hex": "<64 hex chars>"
    },
    "draw_u64": "12345678901234567890",
    "drand": {
      "chain_hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
      "scheme": "bls-unchained-g1-rfc9380",
      "public_key": "<quicknet public key hex>",
      "period_seconds": 3,
      "genesis_time": 1692803367,
      "target_delay_rounds": 2,
      "client_nonce": "<64 hex chars>",
      "client_observed_round": 100,
      "client_observed_signature_hex": "<96 hex chars>",
      "client_observed_randomness_hex": "<64 hex chars>",
      "target_round": 102,
      "target_signature_hex": "<96 hex chars>",
      "target_randomness_hex": "<64 hex chars>",
      "idem_payload_sha256_hex": "<64 hex chars>"
    }
  },
  "receipt_hash": "sha256:<hex>",
  "sig": {
    "alg": "Ed25519",
    "kid": "issuer-key-1",
    "signature_b64": "<base64 signature>",
    "canon": "JCS/RFC8785"
  }
}
```

*This repository is proprietary, all rights reserved.*
