# TrueRolls HTTP API

This is the reference for the TrueRolls HTTP API as **implemented** in the service code. It describes the live request/response shapes, status codes, and verification semantics. Where it matters, it states plainly what each endpoint proves and what it does not.

> **Source-available proprietary software, not open source.** External receipt-verifier integrations
> are covered only for the exact dependency closure and purposes defined in
> `LICENSE-VERIFYING.md`; minting, server operation, brand use, and production signing keys remain
> rights reserved.

> All example values below, UUIDs, key ids (e.g. `kd-dev-1`), `drbg_key_hex`, `draw_u64`, `signature_b64`, `receipt_hash`, `public_key`, are **illustrative placeholders**, not real or reproducible cryptographic artifacts. Actual values are produced at runtime. The signing key id is configured per deployment.

## Scope and honesty notes

Read these before integrating. They bound what the API guarantees.

- **No authentication.** None of the endpoints require or check credentials. There is no API key, token, or session.
- **Rate limiting is an abuse throttle, not a security control.** `POST /v1/roll` has the heavy mint protection stack. Verify/read routes have lighter per-IP throttles and body limits. `/livez`, `/healthz`, `/v1/drand/health`, and `/.well-known/*` stay public. `/livez` does no dependency I/O. `/healthz` and `/v1/drand/health` are unthrottled and touch backend or network dependencies, so do not treat them as free under hostile traffic. Roll, verify, and read limits are configured independently (`KD_ROLL_RL_*`, `KD_VERIFY_RL_*`, `KD_READ_RL_*`). Do not treat any throttle as access control.
- **What is proven today:**
  - **Tamper-evidence** of a signed receipt via an Ed25519 signature over the canonicalized receipt body.
  - **Drand seed provenance** for live `truerolls-drand-1` receipts: anyone with the receipt can verify the pinned drand quicknet BLS pulses and re-derive the seed from the target pulse.
  - **Deterministic replay** of the draw: anyone with the receipt can re-derive the same `face` from the disclosed seed.
  - **Bounded math**: the rolled distribution is recomputable and is held within KL-divergence and EV caps relative to uniform.
- **What is NOT implemented and is NOT claimed:** commit/reveal, VRF, Merkle anchoring, witnessed transparency-log anchoring, on-chain anything, authentication, or strict public fairness.
- **Drand provenance is not strict witnessed fairness.** `VALID` proves the roll seed came from a verified public drand beacon and the outcome replays from that seed. It does **not** prove the published outcome was unbiased: the operator can still **grind**, privately fail/suppress unfavorable attempts and publish only a favorable completed receipt (withholding/timeout is the mechanism). Binding the operator to one committed attempt requires v2 witnessed fairness.
- **The site's demo/mock verification is not cryptographic verification.** Only the receipt-mode signature + replay path described here performs real checks.

## Conventions

- **Base path:** roll/verify endpoints live under `/v1`. `/livez`, `/healthz`, and `/.well-known/*` are unversioned.
- **Content types:** request and success bodies are `application/json`. Most client-caused error bodies (400 / 404 / 409 / 422) are plain-text messages. Internal 500 responses are sanitized JSON `{ "error": "internal" }`. Protective overload/timeout responses are JSON, see `POST /v1/roll`. (The 422 legacy-verify body is a special case, see that endpoint.)
- **Dice:** the roll path accepts `d6`, `d20`, `d100`. The receipt verifier's die parser additionally accepts `d4`, `d8`, `d10`, `d12`, but only `d6` / `d20` / `d100` are reachable through `POST /v1/roll`.
- **kappa (`κ`):** a signed stance. It is validated to be **finite and in `[-1, 1]`** on `POST /v1/roll` and on the **legacy** verify paths. In **receipt** verify mode κ is *not* range-checked at the request layer. An out-of-range κ instead fails inside the math recompute and is returned as a `400` (see receipt mode below).
- **`draw_u64`** is a **stringified `u64`** everywhere it appears (JSON numbers cannot represent every `u64` exactly).

---

## GET /livez

Process liveness probe. Always returns **200** while the server is accepting requests. It performs no
database, Redis, object-store, or network work, so it is the probe for browsers and container health
checks.

**Response, `200`**

```json
{ "status": "ok" }
```

---

## GET /healthz

Dependency readiness probe for operators. Always returns **200**, including when degraded. The body
reports per-dependency status. Each call runs a database query, a Redis `PING`, and an object-store
`head_bucket`, so bound it at the deployment edge.

**Response, `200`**

```json
{ "status": "ok", "db": true, "redis": true, "s3": true }
```

| Field | Type | Notes |
|---|---|---|
| `status` | string | `"ok"` when `db`, `redis`, and `s3` are all reachable; otherwise `"degraded"`. |
| `db` | bool | Postgres `SELECT 1` succeeded. |
| `redis` | bool | Redis `PING` succeeded. |
| `s3` | bool | Object-store `head_bucket` succeeded. |

---

## POST /v1/roll

Compute a karma-weighted roll and return a **signed receipt** (when a signing key is configured).

### First roll with curl

`/v1/drand/health` proves the API can reach and verify quicknet, but it does not return the observed BLS signature a client needs for `POST /v1/roll`. A client constructs the first roll by fetching the latest quicknet pulse directly, then sending that pulse and `target_round = round + 2` to the API. The API verifies the pulse again and fails closed if anything is wrong. Production clients should query multiple official quicknet relays concurrently and choose the highest structurally valid round before submission; a lagging relay can otherwise make `round + 2` no longer future by the time the API checks it. This freshest-frontier selection improves liveness only and does not replace the API's pinned BLS verification.

```bash
CHAIN_HASH="52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
PULSE="$(curl -fsS "https://api.drand.sh/${CHAIN_HASH}/public/latest")"
ROUND="$(printf '%s' "$PULSE" | jq -r '.round')"
SIG="$(printf '%s' "$PULSE" | jq -r '.signature')"
RANDOMNESS="$(printf '%s' "$PULSE" | jq -r '.randomness')"
NONCE="$(openssl rand -hex 32)"

curl -fsS http://127.0.0.1:8080/v1/roll \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo-${NONCE}" \
  -d "{
    \"die\": \"d20\",
    \"kappa\": 0,
    \"client_nonce\": \"${NONCE}\",
    \"drand\": {
      \"client_observed_round\": ${ROUND},
      \"client_observed_signature_hex\": \"${SIG}\",
      \"client_observed_randomness_hex\": \"${RANDOMNESS}\",
      \"target_round\": $((ROUND + 2))
    }
  }"
```

Field mapping from the drand response:

| drand latest field | `POST /v1/roll` field |
|---|---|
| `round` | `drand.client_observed_round` |
| `signature` | `drand.client_observed_signature_hex` |
| `randomness` | `drand.client_observed_randomness_hex` |
| `round + 2` | `drand.target_round` |

Clients that need independent client-side assurance should verify the observed pulse against the pinned quicknet parameters before sending it. The API still verifies it again fail-closed.

**Request body, `RollRequest`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `die` | string | yes | `d6` \| `d20` \| `d100`. Anything else → 400. |
| `kappa` | number | yes | Finite, in `[-1, 1]`. Otherwise → 400. |
| `client_nonce` | string | yes | Client-generated 32 random bytes encoded as 64 hex chars. Server-generated nonce is forbidden. |
| `drand` | object | yes | Client-observed quicknet frontier and target round. |
| `seed` | string \| null | no | Legacy field. Rejected on live drand rolls. |
| `idempotency_key` | string \| null | no | Optional. May also be supplied as the `Idempotency-Key` header. |

`drand` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `client_observed_round` | integer | yes | Quicknet round the browser observed. |
| `client_observed_signature_hex` | string | yes | BLS signature for that round. |
| `client_observed_randomness_hex` | string | yes | Must equal `SHA256(client_observed_signature)`. |
| `target_round` | integer | yes | Must equal `client_observed_round + 2`. |

**Idempotency**

- The key may come from the `Idempotency-Key` **header** or the `idempotency_key` **body field**. If both are present and differ → **400**. The header is preferred.
- If neither is present, the server generates a random key (so retries do not dedup).
- Reusing a key whose recorded canonical payload hash, over `(die, kappa, client_nonce, drand)`, differs from the new request → **409**.
- A concurrent in-flight request holding the same key → **202** with a retry hint. Once completed, the same key returns the stored final receipt with the same target/result, not a fresh target.

**Responses**

- **`201`, new roll.** Body is the flattened receipt envelope (`ReceiptV2` fields at top level) plus `deduplicated: false`. When a signer is configured the receipt includes `receipt_hash` and `sig`. When no signer is configured **both fields are absent** and the receipt is unsigned.

  ```json
  {
    "v": "truerolls-drand-1",
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "die": "d20",
    "kappa": -0.4,
    "face": 7,
    "alpha": 0.5803,
    "kl": 0.0204,
    "ev": 9.4471,
    "created_at": "2026-06-11T12:00:00Z",
    "transcript_url": "/v1/roll/a1b2c3d4-.../transcript",
    "transcript_key": "s3://<bucket>/rolls/a1b2c3d4-....json",
    "proof": {
      "math_param_version": "roll.math.v1",
      "rng": {
        "drbg_key_hex": "<hex of the 32-byte HKDF-derived key>",
        "algo": "drand-quicknet+HKDF(SHA-256)->ChaCha20Rng"
      },
      "draw_u64": "12345678901234567890",
      "drand": {
        "chain_hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
        "scheme": "bls-unchained-g1-rfc9380",
        "public_key": "<pinned quicknet public key hex>",
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
      "kid": "kd-dev-1",
      "signature_b64": "<base64 of the 64-byte Ed25519 signature>",
      "canon": "JCS/RFC8785"
    },
    "deduplicated": false
  }
  ```

  Receipt fields:

  | Field | Type | Notes |
  |---|---|---|
  | `v` | string | Version discriminator, `"truerolls-drand-1"` for live rolls. Legacy `"truerolls-1"` remains verifiable. |
  | `id` | uuid | Public roll id. |
  | `die`, `kappa` | string, number | Echoed inputs. |
  | `face` | int | Rolled face, 1-indexed. |
  | `alpha`, `kl`, `ev` | number | Guarded-distribution metrics: mixing weight toward uniform, KL from uniform (nats), expected value. |
  | `created_at` | date-time | |
  | `transcript_url` | string | API-relative path to the stored transcript. |
  | `transcript_key` | string | Object-store URI of the transcript. Optional in the schema (omitted when unset); present in practice on the 201 path. |
  | `proof.math_param_version` | string | Math parameter set the roll ran under (currently `"roll.math.v1"`). |
  | `proof.rng.drbg_key_hex` | string | Hex of the 32-byte HKDF-derived ChaCha20 key. Enables replay and is re-derived from `proof.drand`. |
  | `proof.rng.algo` | string | `"drand-quicknet+HKDF(SHA-256)->ChaCha20Rng"`. |
  | `proof.draw_u64` | string | Stringified `u64` drawn from the DRBG. |
  | `proof.drand` | object | Pinned quicknet proof: chain info, client nonce/frontier, target round/signature/randomness, and canonical request hash. |
  | `receipt_hash` | string | `"sha256:<hex>"` of the canonical receipt body (sig + receipt_hash excluded). Absent when unsigned. |
  | `sig` | object | Ed25519 signature block. Absent when unsigned. The `sig.kid` is set per deployment (configured via the signing key id). |

  The signature and `receipt_hash` are computed over the **JCS / RFC 8785** canonicalization of the receipt body **with the `sig` and `receipt_hash` fields removed**.

- **`200`, deduplicated.** The idempotency key already resolved to a completed roll with a matching payload. The body is the stored receipt envelope with `deduplicated: true`. It is the same target/result as the original request.

- **`202`, processing.** Another request with the same key is still computing.

  ```json
  { "status": "processing", "idem_key": "<key>", "retry_hint_ms": 150 }
  ```

- **`400`**, invalid `die`, `kappa` non-finite or outside `[-1, 1]`, missing/invalid `client_nonce`, missing/invalid drand proof, stale client drand frontier, target round not equal to observed+2, target round not future versus the API's freshness frontier, legacy `seed` present, or header/body idempotency keys both present and different. Plain text.
- **`409`**, idempotency key reused with a different payload. Plain text.
- **`413`**, POST body exceeds the `POST /v1/roll` body cap.
- **`429`**, per-client-IP token bucket exhausted. Carries `x-ratelimit-after` from `tower_governor`.
- **`503`**, global in-flight roll limit is saturated. JSON: `{ "error": "overloaded" }`, includes `Retry-After: 1`.
- **`504`**, whole-roll handler timeout. JSON: `{ "error": "timeout" }`, includes `Retry-After: 1`.
- **`500`**, DB / Redis / object-store / drand dependency failure. Sanitized JSON: `{ "error": "internal" }`.

**Drand derivation note.** The browser observes a quicknet frontier and sends a client nonce plus `target_round = observed_round + 2`. The API verifies the observed pulse, rejects targets that are not future versus `max(server latest relay round, local wall-clock quicknet schedule round)`, waits for the target pulse, verifies the target BLS signature, computes `randomness = SHA256(signature)`, and derives the 32-byte ChaCha20 seed with HKDF-SHA256 bound to the canonical request hash. There is no production fallback to local server RNG in drand mode.

---

## GET /v1/roll?idem_key=...

Look up a roll by its idempotency key.

- **`200`**, `RollResponse` (legacy shape, `deduplicated: true`).
- **`400`**, `idem_key` missing/empty. Plain text.
- **`404`**, no roll for that key. Plain text.

This endpoint does **not** return the signed receipt. The receipt is emitted only once, by `POST /v1/roll` on 201.

---

## GET /v1/roll/:id

Fetch a stored roll by its public UUID.

- **`200`**, `RollResponse` (legacy shape, `deduplicated: true`).
- **`400`**, malformed UUID. Plain text.
- **`404`**, roll not found. Plain text.

Like the idem lookup, this returns the legacy shape, not the receipt.

### `RollResponse` (legacy shape)

Returned by the `POST /v1/roll` dedup path (200) and both roll GETs. Not signed, carries no RNG proof material.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `die`, `kappa` | string, number | |
| `seed` | string \| null | User seed if one was supplied, else null. |
| `face` | int | 1-indexed. |
| `ev`, `alpha`, `kl` | number | Same metrics as the receipt. |
| `created_at` | date-time | |
| `transcript_key` | string | Object-store URI of the transcript; empty string if not uploaded. |
| `deduplicated` | bool | `true` on the dedup path and on all GETs (signals an existing roll). |

---

## GET /v1/roll/:id/transcript

Return the stored transcript JSON for a roll, served verbatim over HTTP so a verifier needs no object-store credentials.

- **`200`**, `application/json`, the transcript bytes exactly as stored.
- **`400`**, malformed UUID. Plain text.
- **`404`**, roll not found, or transcript not yet uploaded. Plain text.
- **`429`**, per-client-IP read throttle exhausted.
- **`500`**, object-store fetch failure. Sanitized JSON: `{ "error": "internal" }`.

The transcript holds the flat math fields the legacy verify path consumes (`die`, `kappa`, `face`, `draw_u64`, `alpha`, `kl`, `ev`, `probs`) plus `sampling` and `rng` provenance metadata. **The derived DRBG key is not in the transcript**, it appears only in the receipt's `proof.rng.drbg_key_hex`. Provenance inputs in the transcript are redacted hashes (first 12 hex chars of SHA-256 over the respective input), not raw values.

> **Transcript availability:** this endpoint exposes the stored transcript over plain HTTP with no authentication. Treat any transcript reachable through it as readable by anyone who has the roll id.

---

## GET /v1/drand/health

Fetch and verify the latest drand quicknet pulse through the server's configured relays. This is an operational/provenance health endpoint, not a roll.

**Response, `200`**

```json
{
  "source": "drand-quicknet",
  "chain_hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  "scheme": "bls-unchained-g1-rfc9380",
  "public_key": "<pinned quicknet public key hex>",
  "period_seconds": 3,
  "genesis_time": 1692803367,
  "latest_round": 123456,
  "latest_randomness_hex": "<64 hex chars>",
  "target_delay_rounds": 2
}
```

If the configured relays fail, return mismatched `/info`, or serve an invalid BLS pulse, the endpoint fails closed with sanitized `500` JSON.

---

## POST /v1/verify

Verify a receipt or a legacy transcript body. The handler **auto-detects** the format by the presence of `"v": "truerolls-drand-1"` or `"v": "truerolls-1"`.

### Receipt mode (`v` == `"truerolls-drand-1"` or `"truerolls-1"`)

The raw body is passed to the shared offline verifier (the same code path used by the CLI and the WASM verifier, so the signer and verifier cannot drift). The verifier:

1. for `truerolls-drand-1`, verifies the pinned quicknet drand proof and re-derives the receipt seed,
2. checks the Ed25519 signature over the JCS/RFC8785-canonicalized body (sig + receipt_hash excluded), using the server's **own published key set**,
3. replays ChaCha20 from `proof.rng.drbg_key_hex` (one `next_u64`) and confirms it reproduces `proof.draw_u64`,
4. recomputes the guarded distribution and face from `(die, kappa)` and checks the face,
5. checks recomputed `alpha`, `kl`, `ev` against the receipt within a fixed tolerance (`1e-9`).

**Failed checks still return `200`**, the outcome is reported via boolean flags and `errors`, not via HTTP status. `400` is reserved for input the verifier cannot process at all (see below).

The signature is verified against the server's currently published key set. A receipt signed by an unknown, revoked, or mismatched key fails the signature check softly: `valid_signature: false`, verdict reported in flags, still **200**. If the server has no signing key configured, the signature check fails softly (recorded in `errors`) while sampling/face/metrics still run.

**Response, `200`, `ReceiptVerifyResponse`**

```json
{
  "valid_signature": true,
  "valid_drand": true,
  "valid_sampling": true,
  "face_ok": true,
  "metrics_ok": true,
  "details": {
    "sig": "valid",
    "recomputed_face": 7,
    "recomputed_ev": 9.4471,
    "recomputed_kl": 0.0204,
    "recomputed_alpha": 0.5803,
    "tol": 1e-9
  },
  "errors": []
}
```

| Field | Type | Notes |
|---|---|---|
| `valid_signature` | bool | Ed25519 signature verified. `false` for invalid signature, missing `sig`, or no server key to verify with (see `errors`). |
| `valid_drand` | bool | For `truerolls-drand-1`, quicknet proof + target binding + seed derivation verified. For legacy `truerolls-1`, this is `true` because no drand proof is expected. |
| `valid_sampling` | bool | ChaCha20 replay of `drbg_key_hex` reproduced `draw_u64`. |
| `face_ok` | bool | Recomputed face matches the receipt. |
| `metrics_ok` | bool | Recomputed `alpha`, `kl`, `ev` each within `tol`. |
| `details.sig` | string | `"valid"` or `"invalid"`. |
| `details.recomputed_*` | int/number | Server-recomputed face and metrics. |
| `details.tol` | number | Absolute tolerance for metric comparisons (currently `1e-9`). |
| `errors` | string[] | Human-readable failures. Omitted from the JSON when all checks pass. |

(There is no top-level `verdict` field on this response, derive the overall outcome from all boolean flags.)

**`400` (receipt mode)**, body that cannot be verified at all. The verifier maps every hard error to `400`: undeserializable receipt, unsupported `proof.math_param_version`, invalid or wrong-length `drbg_key_hex`, unparsable `draw_u64`, unsupported die, **and any math-recompute error, including a `kappa` outside `[-1, 1]`** (out-of-range κ hard-fails the recompute rather than returning a soft INVALID). Plain text.

**`413`**, POST body exceeds the verify body cap.

**`429`**, per-client-IP verify throttle exhausted.

### Legacy transcript mode (no `v` discriminator)

The body is parsed as a flat `VerifyRequest`. The server recomputes the distribution from `(die, kappa)`, replays sampling with `draw_u64`, and compares `face`, `alpha`, `kl`, `ev`, and `probs` against the submitted values.

**Request, `VerifyRequest`**

| Field | Type | Notes |
|---|---|---|
| `math_param_version` | string | Must equal the server's current version (`"roll.math.v1"`); 400 otherwise. |
| `die` | string | `d6` \| `d20` \| `d100`. |
| `kappa` | number | Finite, `[-1, 1]`. |
| `face` | int | Claimed face. |
| `draw_u64` | string | Stringified `u64`. |
| `alpha`, `kl`, `ev` | number | Claimed metrics. |
| `probs` | number[] | Claimed probability vector; length must match the die. |

**Response, `200`, `VerifyResponse`** (verdict `OK`)

```json
{
  "verdict": "OK",
  "warnings": ["alpha: minor float round-trip diff=6.94e-18"],
  "recomputed": { "face": 5, "alpha": 0.4119, "kl": 0.0418, "ev": 3.9183 }
}
```

`mismatches` and `warnings` are omitted when empty. A diff over `1e-12` is a hard mismatch. A difference visible only at the bit level is a harmless `warnings` entry.

- **`422`, MISMATCH (quirk).** On mismatch the response is the `VerifyResponse` JSON **serialized as a plain-text string** (Content-Type `text/plain`). Parse the text body as JSON to recover the structured verdict.
- **`400`**, unsupported `math_param_version`, unsupported die, `kappa` non-finite/out of range, unparsable `draw_u64`, or `probs` length mismatch. Plain text.

**Verification scope (both modes):** drand receipt mode proves verified public-beacon seed provenance plus replay. It does not prove the published outcome was unbiased, the operator can still grind by failing/suppressing unfavorable attempts and publishing only favorable completed receipts (closing that is v2 witnessed fairness). Legacy transcript mode proves deterministic replay consistency only.

---

## GET /v1/verify/:id

Convenience endpoint. The server looks up the roll, fetches its stored transcript from object storage, parses the flat math fields, and runs the **same legacy verification** as `POST /v1/verify` legacy mode.

- **`200`**, `VerifyResponse`, verdict `OK`.
- **`400`**, malformed UUID, or the stored transcript fails validation (e.g. written under a different `math_param_version` than the server now runs). Plain text.
- **`404`**, roll not found, or transcript not yet uploaded. Plain text.
- **`422`**, MISMATCH, same plain-text-JSON-string quirk as legacy POST.
- **`429`**, per-client-IP read throttle exhausted.
- **`500`**, object-store fetch failure, or a stored transcript that does not parse. Sanitized JSON: `{ "error": "internal" }`.

This checks the server's **own** stored transcript against the server's **own** math, a consistency check, not an independent audit. For an independent check, verify the receipt (and transcript) with your own verifier rather than trusting this endpoint.

---

## GET /.well-known/truerolls-keys.json

Publishes the server's Ed25519 verifying key set so receipts can be verified by `sig.kid`.

**Response, `200`, `KeysResponse`**

```json
{
  "keys": [
    { "kid": "kd-dev-1", "alg": "Ed25519", "public_key": "<base64 32-byte key>", "status": "active" },
    { "kid": "kd-old-1", "alg": "Ed25519", "public_key": "<base64 32-byte key>", "status": "retired" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `keys[].kid` | string | Key id; matches a receipt's `sig.kid`. Configured per deployment. |
| `keys[].alg` | string | `"Ed25519"`. |
| `keys[].public_key` | string | Base64 of the 32-byte verifying key. |
| `keys[].status` | string | `"active"`, `"retired"`, or `"revoked"`. Active signs new receipts. Retired verifies historical receipts. Revoked makes every receipt under that `kid` invalid. |

- **`404`**, no signing key configured. In that mode receipts are emitted unsigned (without `sig`/`receipt_hash`). Plain text.

To verify a receipt with status semantics: pass the whole key set to the shared verifier. It selects by `sig.kid`, verifies active and retired keys, and rejects revoked or unknown kids. Supplying a single public key manually is an override for manual audits and does not carry key-status semantics.

---

## Endpoint summary

| Method | Path | Success | Body shape |
|---|---|---|---|
| GET | `/livez` | 200 | `{ "status": "ok" }` |
| GET | `/healthz` | 200 | `Health` |
| POST | `/v1/roll` | 201 / 200 / 202 | `ReceiptV2Response` / deduplicated receipt / processing |
| GET | `/v1/roll?idem_key=` | 200 | `RollResponse` |
| GET | `/v1/roll/:id` | 200 | `RollResponse` |
| GET | `/v1/roll/:id/transcript` | 200 | stored transcript JSON (verbatim) |
| GET | `/v1/drand/health` | 200 | verified latest quicknet pulse |
| POST | `/v1/verify` | 200 (or 422 legacy) | `ReceiptVerifyResponse` / `VerifyResponse` |
| GET | `/v1/verify/:id` | 200 (or 422) | `VerifyResponse` |
| GET | `/.well-known/truerolls-keys.json` | 200 | `KeysResponse` |

---

## Current Reference Status

No OpenAPI artifact is currently committed in this repository. This file is the implemented HTTP
reference.

`POST /v1/roll` has a per-client-IP token bucket (`tower_governor`) plus a bounded heavy path:
body cap, global in-flight cap, and whole-handler timeout. The rate limiter keys the client IP
through `KD_TRUSTED_PROXY`: default `peer` ignores forwarded headers, `xff:<hops>` takes the Nth IP
from the right, and `cloudflare` / `fly` read the provider's authoritative client-IP header. Under
`KD_ENV=prod`, `peer` mode fails closed unless `KD_ALLOW_PEER_IP=1` is set deliberately. When the
token bucket is exceeded the request gets **`429 Too Many Requests`** with `x-ratelimit-after`.
Overload returns **503 + `Retry-After: 1`**, timeout returns **504 + `Retry-After: 1`**. A timeout
may consume a validated mint reservation attempt, but it cannot mint a receipt. Verify/read routes
have lighter throttles and a verify body limit. GET roll lookup, health, drand health, and well-known
routes are not wrapped in the heavy stack. Treat all of this as abuse/load protection, not
authentication.

Example key ids and crypto values in this document are placeholders, not code constants.
