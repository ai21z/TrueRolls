# Verifying a receipt

Every TrueRolls roll returns a signed `truerolls-1` receipt — a self-contained JSON object you can verify **offline**, with no call back to the server that produced it. This document explains exactly what the verifier checks, how to run it (in the browser or from the CLI), what each failure means, and — just as important — what a `VALID` result does and does **not** prove.

The browser verifier, the CLI (`kd verify --receipt`), and the server all run the **same** compiled verification code (the `kd-receipt` crate). There is one signer-and-verifier implementation and one canonicalization, so they cannot disagree about what bytes a signature covers.

---

## TL;DR

- A receipt is verified by four independent checks: **signature**, **sampling replay**, **face**, **metrics**. All four must pass for the verdict to be `VALID`.
- Verify it two ways, both offline: **in your browser** (WebAssembly build of the verifier) or with the **CLI**: `kd verify --receipt <file> --public-key <base64>`. The receipt is never uploaded; the verdict is always computed locally.
- A `VALID` verdict proves the receipt was **not altered** and is **internally self-consistent** with the math engine. It is **tamper-evidence and deterministic replay** — **not** a fairness proof. It does **not** prove the server chose the seed honestly.

---

## The four checks

For a structurally valid receipt the verifier produces a report with four boolean checks. The verdict is `VALID` only when **all four** are true (`kd-receipt`'s `VerifyReport::is_valid`).

| Check | What it does | What a pass means |
|---|---|---|
| **Signature** | Ed25519 verify of `sig.signature_b64` over the canonical signing bytes, using the supplied public key. | The receipt body is byte-for-byte what the key holder signed. Any edit to any signed field breaks this. |
| **Sampling** | Reseed ChaCha20 from `proof.rng.drbg_key_hex` (32 bytes), take one `next_u64()`, compare to `proof.draw_u64`. | The published draw is exactly what that seed produces. |
| **Face** | Recompute the guarded distribution from `(die, kappa)` via the pure math engine, then map `draw_u64` to a face by prefix-CDF; compare to `face`. | The published face is the one the published draw lands on under the recomputed distribution. |
| **Metrics** | Recompute `alpha`, `kl`, `ev` from the engine; compare each to the receipt within tolerance `1e-9`. | The published shaping numbers match the engine, and (because the engine only ever emits guarded distributions) the roll stayed inside the KL and EV caps. |

### What the signature covers

The signature is **Ed25519** over the **JCS / RFC 8785** canonicalization of the receipt body **with the `sig` and `receipt_hash` fields removed** (both are attached after signing). This is the single canonicalization the signer and verifier both call — they cannot drift. Because every other field is inside the signed bytes, changing `die`, `kappa`, `face`, `alpha`, `kl`, `ev`, `proof.draw_u64`, the DRBG key, etc. invalidates the signature.

### How the checks reinforce each other

The checks are independent, so tampering is caught by more than one of them. For example:

- **Editing `face`** breaks the signature **and** the face check.
- **Editing `draw_u64`** breaks the signature **and** the sampling replay.
- **Editing `kappa`** breaks the signature **and** the metrics check.
- **Swapping the die** (e.g. `d20` → `d6`) breaks the signature, the face check, and the metrics check independently.

A verifier that drifts from the signer could bless a forgery, so this redundancy is deliberate.

---

## Verify in your browser

The TrueRolls site ships the verifier compiled to **WebAssembly** (the same `kd-receipt` engine). The entire verdict — Ed25519 signature, DRBG sampling replay, face, and metric caps — is computed **locally in the page**. The receipt and key are never uploaded; the verdict is computed in your browser, so there is no server to trust for the result.

To verify a receipt:

1. Open the in-browser verifier and paste (or drop a `.json` file of) the receipt.
2. Provide the Ed25519 public key (base64). The page resolves it for you: a manually pasted key wins; otherwise it picks the published key whose key-id (`sig.kid`) matches the receipt, downloaded from `/.well-known/truerolls-keys.json`; otherwise it falls back to the bundled public test key. Downloading that published key is the only step that touches the network — the verification itself runs entirely in the page.
3. Read the verdict (`VALID` / `INVALID` / `UNVERIFIABLE`) and the four per-check rows.

The page also lets you **tamper** with a field and watch the verdict break in real time — useful for confirming the verifier actually does what it claims.

> The site's signing key is published at `/.well-known/truerolls-keys.json` in the shape `{ "keys": [ { "kid": "...", "alg": "Ed25519", "public_key": "<base64>" } ] }`.

A note on scope: the site's separate **demo / mock** flows are presentational and are **not** cryptographic verification. Only the WebAssembly verifier described here performs the real Ed25519 + replay checks.

---

## Verify with the CLI

The CLI runs the identical engine offline:

```
kd verify --receipt <receipt.json> --public-key <base64>
```

- `--receipt <file>` — path to the receipt JSON.
- `--public-key <base64>` — base64 of the 32-byte Ed25519 verifying key. If omitted, the CLI fetches the key for the receipt's own `sig.kid` from `<server>/.well-known/truerolls-keys.json` (default server `http://127.0.0.1:8080`, overridable with `--server`). Fetching the key is the only step that touches the network; the verification itself is local.
- `--json` — emit the machine-readable report instead of the human summary.

A passing run prints `✅ VALID` with per-check lines (signature, sampling, face, metrics) and exits `0`. A receipt that verifies as `INVALID` prints `❌ INVALID` with the failing reasons and exits non-zero. A structurally unverifiable receipt exits non-zero with an error (see below).

### The JSON report shape

`--json` (and the browser API) return the same schema for a verifiable receipt:

```json
{
  "verdict": "VALID",
  "valid_signature": true,
  "valid_sampling": true,
  "face_ok": true,
  "metrics_ok": true,
  "details": {
    "recomputed_face": 10,
    "recomputed_alpha": 0.3213648106902838,
    "recomputed_kl": 0.02011901380257613,
    "recomputed_ev": 11.65325625845831,
    "tol": 1e-9
  },
  "errors": []
}
```

`verdict` is `"INVALID"` when any of the four checks fails (the failed reasons appear in `errors`). When the receipt is structurally unverifiable the verdict is `"ERROR"`; in the browser build that case is returned as `{ "verdict": "ERROR", "error": "<reason>" }` — a single `error` string rather than the four check booleans — and is shown on the page as `UNVERIFIABLE`.

The signature is checked with standard Ed25519, so any Ed25519 tooling can independently confirm **that one check** against the published key and signed bytes. The sampling, face, and metrics checks, however, require re-running the same math engine: recomputing `alpha`/`kl`/`ev` and the face bit-for-bit needs the same parameters and distribution code this verifier uses.

---

## Outcomes and what they mean

The verifier distinguishes **"checked and failed"** (`INVALID`) from **"could not be checked at all"** (a hard error / `ERROR`).

### `INVALID` — a check ran and failed

The receipt was structurally verifiable, but at least one of the four checks did not pass. Each failure is recorded in `errors`:

- **`valid_signature: false`** — the `sig` block is present but the Ed25519 signature does not verify under the supplied key (or the signature/key bytes are malformed, or the `sig` block is missing entirely). A wrong public key fails here softly; the other three checks are key-independent and still run.
- **`valid_sampling: false`** — `draw_u64` does not equal the value replayed from the DRBG seed.
- **`face_ok: false`** — the recomputed face (distribution + draw via prefix-CDF) does not equal the receipt's `face`.
- **`metrics_ok: false`** — at least one of `alpha`, `kl`, `ev` differs from the recomputed value by more than `1e-9`.

A missing or wrong-key signature does **not** abort the run: the report still fills in the sampling, face, and metrics checks so you can see the full picture. The verdict is still `INVALID` because not all four passed.

### `ERROR` / hard failure — the receipt could not be verified at all

These are returned as a structured `ERROR` in the browser and as a non-zero CLI exit. They mean the receipt is malformed or out of scope, so no meaningful verdict is possible:

- **ParseReceipt** — the JSON did not deserialize into a `truerolls-1` receipt.
- **UnsupportedVersion** — `v` is not `truerolls-1` (the only version this verifier accepts).
- **BadDrbgHex** — `proof.rng.drbg_key_hex` is not valid hex.
- **BadDrbgLen** — the DRBG key did not decode to exactly 32 bytes.
- **BadDraw** — `proof.draw_u64` is not a valid u64.
- **ParamVersionMismatch** — `proof.math_param_version` does not match the engine's current parameter version, so recomputation would not be apples-to-apples.
- **UnsupportedDie** — `die` is not one of `d4`, `d6`, `d8`, `d10`, `d12`, `d20`, `d100`.
- **Core** — the math engine rejected the inputs. Notably, a receipt claiming a `kappa` **outside the `[-1, 1]` contract** hard-fails here (`kappa out of range`) — it is never silently treated as `VALID`. The signer and verifier share this one engine check and cannot drift on it.

> Design choice: because these are "cannot verify," they are surfaced distinctly from `INVALID`. A malformed receipt is never reported as a clean pass.

---

## The public TEST key (read this)

Receipts in the goldens, the in-browser sample, and the bundled fallback key are signed by a **committed, public TEST key** (`kid: test-kid-1`), derived from a published test seed. It exists so anyone can verify *something* instantly, offline, with zero setup.

- **It is intentionally public and is NEVER a production signer.** Anything signed by it proves only that the test key signed it.
- A boot guard refuses to start the server under the production profile if the test seed or a known test `kid` is configured (or if no signer is configured at all), so the published test key cannot sign production receipts.
- A real production receipt is signed by a different key; to verify it, use that key's published entry from `/.well-known/truerolls-keys.json` (matched by the receipt's `sig.kid`), not the test key.

If you are verifying a production receipt, confirm the `sig.kid` and the key you used belong to the production key set — not `test-kid-1`.

---

## What VALID proves — and what it does not

This is the most important section. Read it before you rely on a `VALID` verdict.

**A `VALID` verdict proves, today:**

- **Tamper-evidence.** The receipt body is exactly what the holder of the named key signed (Ed25519 over the canonical bytes). Changing any signed field is detected.
- **Deterministic replay.** From the published DRBG key you reproduce the exact draw, and from the draw you reproduce the exact face — the same result anywhere, by anyone.
- **Bounded shaping.** The recomputed `alpha`/`kl`/`ev` match the receipt, and the engine only ever emits distributions that stay inside the KL-divergence cap (in nats) and the expected-value cap. So a `VALID` receipt demonstrably did not bend further from a fair die than those caps allow.

**A `VALID` verdict does NOT prove:**

- **That the server chose its seed honestly.** The server derives the seed, so a malicious operator could in principle grind seed material for favorable outcomes. Deterministic replay confirms the math was applied consistently to *that* seed — it cannot see whether the seed itself was chosen fairly.
- **Adversarial fairness.** Replay determinism is **not** the same as provable fairness, and this system does not claim it is. A receipt that verifies `VALID` is internally consistent; that is a different and weaker guarantee than "the outcome was unbiased against you."

In short: `VALID` means **not altered, and self-consistent with the engine** — strong tamper-evidence, not a fairness proof.

### Roadmap, not implemented

Binding the seed to something the server cannot grind — for example a client-supplied seed with a commit-reveal step, and/or binding rolls to a future public randomness beacon — is the path toward provable fairness. **None of that is implemented today**, and nothing in the current verifier should be read as a claim of commit/reveal, an external randomness beacon, Merkle anchoring, on-chain anchoring, authentication, or production fairness.

---

## Reference

| Property | Value |
|---|---|
| Receipt version accepted | `truerolls-1` |
| Signature algorithm | Ed25519 |
| Signed bytes | JCS / RFC 8785 canonicalization of the body, minus `sig` and `receipt_hash` |
| DRBG | ChaCha20, seeded from the 32-byte `proof.rng.drbg_key_hex` |
| Sampling | prefix-CDF (inverse-CDF) over the guarded distribution — no modulo bias |
| Metric tolerance | `1e-9` (absolute) for `alpha`, `kl`, `ev` |
| Supported dice | d4, d6, d8, d10, d12, d20, d100 |
| Public key source | `/.well-known/truerolls-keys.json`, matched by `sig.kid` |

The single shared verifier lives in `crates/kd-receipt` (`verify_receipt` / `verify_receipt_str`); the browser entrypoint is `verifyReceiptJson` in `crates/kd-core-wasm`; the CLI entrypoint is `kd verify --receipt` in `crates/kd-cli`. These are referenced only so you can independently confirm the claims above.

*This repository is proprietary, all rights reserved.*