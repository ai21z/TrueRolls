# Receipt format

A TrueRolls **receipt** is a self-contained JSON document returned for every roll. It carries the rolled outcome, the bounded-math metrics behind it, the RNG material needed to replay the draw, and an Ed25519 signature over a canonical encoding of all of that. Given a receipt and the issuer's public key, anyone can recompute the outcome offline and confirm the signature — no call back to the server required.

This page is a field-by-field reference for the current schema, version string `"truerolls-1"` (internally, `ReceiptV2`). It also specifies the canonicalization precisely enough that you can recompute `receipt_hash` yourself.

> This document and the TrueRolls verifier are **proprietary, all rights reserved** — not open source.

## What a receipt proves (and what it does not)

A receipt that verifies VALID establishes three things, and only these three:

1. **Tamper-evidence.** The body was signed by the holder of the private key for the stated `kid`. Any change to a signed field invalidates the Ed25519 signature.
2. **Deterministic replay of the draw.** Reseeding ChaCha20 from `proof.rng.drbg_key_hex` and taking one `next_u64()` reproduces `proof.draw_u64` exactly, and mapping that draw through the recomputed distribution reproduces `face`.
3. **Bounded math.** The distribution is recomputed from `(die, kappa)` using the same engine the issuer used, and the published `alpha`/`kl`/`ev` match it. The behavior weighting `kappa` is held within KL and EV caps; it shifts a *bounded* distribution and cannot force a specific face.

A receipt does **not** prove the issuer chose its seed material honestly. Replay determinism is reproducibility, not adversarial fairness: a server free to pick favorable `drbg_key_hex` before publishing is **not** prevented by this format. There is no commit/reveal, VRF, external randomness beacon, Merkle anchoring, or on-chain anchoring in this scheme today — do not read those properties into a VALID verdict. Any "verification" shown in a demo/mock UI is illustrative, not the cryptographic check described here.

## Top-level shape

```json
{
  "v": "truerolls-1",
  "id": "…",
  "die": "d20",
  "kappa": 0.6,
  "face": 10,
  "alpha": 0.32…, "kl": 0.02…, "ev": 11.65…,
  "created_at": "2026-01-01T00:00:00Z",
  "transcript_url": "…",
  "proof": { … },
  "receipt_hash": "sha256:…",
  "sig": { … }
}
```

The receipt splits into a **body** (everything except `sig` and `receipt_hash`) and two **integrity fields** (`receipt_hash`, `sig`) that are computed from the body and attached afterward.

### Body fields

| Field | Type | Meaning |
|---|---|---|
| `v` | string | Schema version. Must be exactly `"truerolls-1"`; the verifier hard-rejects any other value. |
| `id` | string (UUID) | Unique roll identifier. |
| `die` | string | The die: one of `d4`, `d6`, `d8`, `d10`, `d12`, `d20`, `d100`. Anything else is rejected. |
| `kappa` | number | The behavior-weighting stance, contractually in `[-1, 1]`. The verifier recomputes through the engine, which rejects an out-of-range `kappa` as a hard error (so an out-of-contract receipt cannot verify VALID). |
| `face` | integer | The rolled face (1-indexed). Re-derived during verification from the draw and the recomputed distribution. |
| `alpha` | number | The mixing weight the guard solver selected for this `(die, kappa)`. Recomputed and compared. |
| `kl` | number | KL divergence (nats) of the weighted distribution from uniform — held under the per-die KL cap. Recomputed and compared. |
| `ev` | number | Expected value of the weighted distribution — held under the EV cap (measured against uniform's standard deviation). Recomputed and compared. |
| `created_at` | string (RFC 3339) | Issue timestamp. |
| `transcript_url` | string | Path to the roll's transcript (e.g. `/v1/roll/<id>/transcript`). Informational. A transcript is **not** a substitute for signature verification. |
| `transcript_key` | string | Optional storage key. Omitted entirely when absent (not serialized as `null`). |
| `proof` | object | The replay block — see below. |

`alpha`, `kl`, and `ev` are recomputed and compared with an absolute tolerance of `1e-9`.

### `proof` — the replay block

| Field | Type | Meaning |
|---|---|---|
| `proof.math_param_version` | string | The engine parameter version the metrics were computed under, currently `"roll.math.v1"`. The verifier gates on this: a receipt computed under a different version is a hard error, not a silent mismatch. |
| `proof.draw_u64` | string | The single 64-bit draw, encoded as a **decimal string** (not a JSON number). |
| `proof.rng.drbg_key_hex` | string | The 32-byte DRBG seed, hex-encoded (64 hex chars). Reseeding ChaCha20 from these bytes and taking one `next_u64()` must reproduce `draw_u64`. |
| `proof.rng.algo` | string | Label for the seed-derivation/RNG pipeline: `"HKDF(SHA-256)->ChaCha20Rng"`. Descriptive — the verifier reseeds ChaCha20 directly from `drbg_key_hex`; the HKDF step that produced those 32 bytes is the issuer's, upstream of the receipt, and is not re-checked by the verifier. |

The `face` is obtained by mapping `draw_u64` through the recomputed distribution with an inverse / prefix-CDF lookup (no modulo). The same `draw_u64` and distribution always yield the same face.

### Integrity fields

| Field | Type | Meaning |
|---|---|---|
| `receipt_hash` | string | `"sha256:<hex>"` — SHA-256 over the canonical bytes of the body (see below). A content fingerprint; it is **not** itself a signature. |
| `sig` | object | The Ed25519 signature block. Omitted entirely if the receipt is unsigned (in which case it can never verify VALID). |
| `sig.alg` | string | `"Ed25519"`. |
| `sig.kid` | string | Key id naming which published key verifies this receipt. A caller fetches that key out-of-band (see key discovery); the verifier itself is handed the public key and does not resolve `kid`. |
| `sig.signature_b64` | string | Base64 of the 64-byte Ed25519 signature over the canonical body bytes. |
| `sig.canon` | string | `"JCS/RFC8785"` — the canonicalization the signature commits to. |

Both `receipt_hash` and `sig` cover the **same** canonical bytes, and both are computed *after* the body is finalized, then attached. They are never part of the bytes they protect.

## Canonicalization — how to recompute `receipt_hash`

Both the SHA-256 `receipt_hash` and the Ed25519 signature are taken over one byte string: the **RFC 8785 JSON Canonicalization Scheme (JCS)** serialization of the receipt **body with `sig` and `receipt_hash` removed**.

To reproduce it from a full receipt:

1. **Parse** the receipt JSON into an object.
2. **Remove** the `sig` and `receipt_hash` keys. (Removing both is the rule even if one is already absent — an unsigned, hashless body canonicalizes to the same bytes, which is why a body matches whether you hash it before or after signing.)
3. **JCS-canonicalize** the remaining object per RFC 8785:
   - object keys sorted lexicographically by UTF-16 code unit,
   - no insignificant whitespace,
   - strings minimally escaped,
   - numbers emitted in RFC 8785 / ECMAScript shortest-round-trip form.
   Note that `draw_u64` and the `kid`/hex strings are JSON **strings**, so they pass through verbatim; only the genuine JSON numbers (`kappa`, `face`, `alpha`, `kl`, `ev`) go through numeric canonicalization.
4. **`receipt_hash`** is `"sha256:" + hex(SHA-256(canonical_bytes))`.
5. **Signature check** is `Ed25519_verify(public_key, canonical_bytes, base64_decode(sig.signature_b64))`.

The canonicalization is the single shared rule used by both the signer and the verifier (file `crates/kd-receipt/src/lib.rs`, `canonical_signing_bytes`), so the bytes a signature commits to cannot drift between producing and checking a receipt.

## Key discovery

To verify `sig`, you need the 32-byte Ed25519 public key that matches `sig.kid`. A running issuer that has a signer configured publishes its key(s) at:

```
GET /.well-known/truerolls-keys.json
```

which returns `{ "keys": [ { "kid", "alg": "Ed25519", "public_key": "<base64 of the 32-byte key>" } ] }`. (An issuer with no signer configured returns 404; a dev/test deployment may serve a published test key here.) Offline verifiers can instead be handed the base64 public key directly — the verifier takes the key as input and does not itself look `kid` up.

## Verification order

A conforming verifier runs four checks; the verdict is **VALID** only if all four pass:

1. **Signature** — Ed25519 over the canonical bytes. A wrong or missing signature is recorded but does not abort the remaining checks (so you still get a full report).
2. **Sampling** — reseed ChaCha20 from `drbg_key_hex`, take one `next_u64()`, and require it to equal `draw_u64`.
3. **Face** — recompute the guarded distribution from `(die, kappa)`, map `draw_u64` through the prefix-CDF, and require the result to equal `face`.
4. **Metrics** — recompute `alpha`, `kl`, `ev` and require each to match within `1e-9`.

Structural problems short-circuit to a hard error (never a VALID verdict): unsupported `v`, an unknown `die`, a `drbg_key_hex` that is not 32 bytes of valid hex, a non-numeric `draw_u64`, a `math_param_version` mismatch, or a `kappa` outside the engine's accepted range.

Because every signed field — `die`, `kappa`, `face`, `draw_u64`, the metrics — is inside the canonical bytes, tampering with any one of them breaks the signature **and** is independently caught by the recompute. For example, editing `face` fails both the signature check and the face recompute; editing `draw_u64` fails both the signature check and the sampling replay.

## Annotated example

A real, signed `truerolls-1` receipt (d20, κ=0.6). It is signed with a **published test key** (kid `test-kid-1`) that exists only so this fixture is reproducible; a production issuer refuses to boot with that key (it rejects both the published test seed and the test kid under the production profile). The matching base64 public key is `IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=`.

```json
{
  "alpha": 0.3213648106902838,                                  // recomputed; matched within 1e-9
  "created_at": "2026-01-01T00:00:00Z",
  "die": "d20",                                                 // supported die
  "ev": 11.65325625845831,                                      // recomputed EV, under the cap
  "face": 10,                                                   // re-derived from draw + distribution
  "id": "00000000-0000-0000-0000-00000000d201",
  "kappa": 0.6,                                                 // in [-1, 1]
  "kl": 0.02011901380257613,                                    // recomputed KL (nats), under the cap
  "proof": {
    "draw_u64": "7618457241228926372",                         // decimal string; replays from drbg_key_hex
    "math_param_version": "roll.math.v1",                       // version gate
    "rng": {
      "algo": "HKDF(SHA-256)->ChaCha20Rng",                     // descriptive label
      "drbg_key_hex": "4242…4242"                               // 32 bytes hex (0x42 × 32); seeds ChaCha20
    }
  },
  "receipt_hash": "sha256:a1dc5db031880eed1b20ef0042dedfae74df895b2bbe88a12a79221413bb350c",
                                                                // SHA-256 over the JCS body (no sig/receipt_hash)
  "sig": {
    "alg": "Ed25519",
    "canon": "JCS/RFC8785",                                     // canonicalization committed to
    "kid": "test-kid-1",                                        // TEST key — never valid in production
    "signature_b64": "vsBiCDnNYIx0DduzM/rC3ogH9bOXbqN74khtHPMCvHAGr5/JlwgRjgu8kotUUM8fHSYc2TXue/k+TQqmIEuSDg=="
  },
  "transcript_url": "/v1/roll/00000000-0000-0000-0000-00000000d201/transcript",
  "v": "truerolls-1"
}
```

To reproduce `receipt_hash` for this document: drop `sig` and `receipt_hash`, JCS-canonicalize the remaining object (the example is already shown key-sorted), and SHA-256 the result — you get `a1dc5db031880eed1b20ef0042dedfae74df895b2bbe88a12a79221413bb350c`. Verifying `signature_b64` against the public key above over those same bytes returns true; recomputing the d20 distribution at κ=0.6 reproduces `face` 10 and the three metrics within `1e-9`; and reseeding ChaCha20 with `0x42 × 32` reproduces `draw_u64`. All four checks pass — verdict VALID.

(`drbg_key_hex` is abbreviated above for readability; the on-wire value is the full 64-hex-char string `4242…4242`.)