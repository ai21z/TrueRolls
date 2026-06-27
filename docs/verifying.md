# Verifying a receipt

Every live TrueRolls roll returns a signed `truerolls-drand-1` receipt: a self-contained JSON object you can verify offline, with no call back to the server that produced it. Legacy `truerolls-1` receipts remain accepted for saved receipts and goldens.

The browser verifier, the CLI (`kd verify --receipt`), and the server all run the same compiled verification code (`kd-receipt`). There is one signer-and-verifier implementation and one canonicalization rule, so they cannot disagree about what bytes a signature covers.

## TL;DR

- A drand receipt is verified by five checks: signature, drand beacon proof, seed replay, face, and metrics. All five must pass for `VALID`.
- `VALID` proves the roll seed came from a verified public drand beacon and the outcome replays from that seed.
- `VALID` does not prove the published outcome was unbiased: the operator can still **grind** — privately fail/suppress unfavorable attempts and publish only a favorable completed receipt. Strict witnessed fairness is the v2 protocol.
- Legacy `truerolls-1` receipts still verify signature, replay, face, and metrics, but they do not carry drand provenance.

## The checks

| Check | What it does | What a pass means |
|---|---|---|
| Signature | Verifies `sig.signature_b64` as Ed25519 over the JCS-canonical receipt body, using the supplied public key. | The receipt body is byte-for-byte what the key holder signed. |
| Drand | For `truerolls-drand-1`, checks pinned quicknet chain params, verifies the client-observed BLS pulse, requires `target_round = client_observed_round + 2`, verifies the target BLS pulse, checks `randomness = SHA256(signature)`, and re-derives the seed with canonical HKDF metadata. | The seed is bound to a real public drand quicknet pulse and to the client nonce/request. |
| Seed replay | Reseeds ChaCha20 from `proof.rng.drbg_key_hex`, takes one `next_u64()`, and compares it to `proof.draw_u64`. | The published draw is exactly what that seed produces. |
| Face | Recomputes the guarded distribution from `(die, kappa)` and maps `draw_u64` through prefix-CDF sampling. | The published face is the one the recomputed distribution produces. |
| Metrics | Recomputes `alpha`, `kl`, and `ev` and compares them within tolerance `1e-9`. | The bounded math matches the engine and stayed inside the KL/EV caps. |

The signature covers every signed field: `die`, `kappa`, `face`, the metrics, draw, seed, client nonce, drand rounds, drand signatures, drand randomness, transcript URL, and proof metadata. Changing any signed field breaks the signature, and most changes also fail an independent recomputation check.

## Verify in your browser

The TrueRolls site ships the verifier compiled to WebAssembly. The full verdict runs locally in the page: Ed25519 signature, drand proof, seed replay, face, and metric caps. The receipt and key are never uploaded.

1. Open the verifier page and paste or drop a receipt JSON file.
2. Provide the Ed25519 public key. The page resolves it automatically when possible from `/.well-known/truerolls-keys.json` by matching `sig.kid`; otherwise you can paste it manually.
3. Read `VALID`, `INVALID`, or `UNVERIFIABLE` and the per-check rows.

The page also lets you tamper with fields and watch the verdict break.

## Verify with the CLI

```powershell
kd verify --receipt <receipt.json> --public-key <base64>
```

- `--receipt <file>` is the receipt JSON.
- `--public-key <base64>` is the 32-byte Ed25519 public key, base64 encoded. If omitted, the CLI can fetch the key matching `sig.kid` from `<server>/.well-known/truerolls-keys.json`; that key fetch is the only network step.
- `--json` emits the machine-readable report.

## JSON report shape

For a valid drand receipt:

```json
{
  "verdict": "VALID",
  "valid_signature": true,
  "valid_drand": true,
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

`INVALID` means at least one check ran and failed. `ERROR` / `UNVERIFIABLE` means the receipt is malformed or outside the verifier's supported versions, so no meaningful pass/fail verdict can be computed.

## Failure meanings

- `valid_signature: false` means the Ed25519 signature is missing, malformed, wrong-key, or invalid.
- `valid_drand: false` means the drand chain params, BLS signature, randomness, target formula, or HKDF-derived seed did not match.
- `valid_sampling: false` means `draw_u64` does not replay from the seed.
- `face_ok: false` means the draw maps to a different face under the recomputed distribution.
- `metrics_ok: false` means `alpha`, `kl`, or `ev` differs from the recomputed value by more than `1e-9`.

Hard errors include invalid JSON, unsupported receipt version, missing `proof.drand` on `truerolls-drand-1`, bad seed hex, wrong seed length, bad draw encoding, unsupported die, math parameter mismatch, and math-engine errors such as out-of-range `kappa`.

## Test key

Goldens and the bundled sample receipt are signed by a committed public test key (`kid: test-kid-1`). It is intentionally public and never a production signer. The production boot guard refuses the published test seed and test key id under the production profile.

For production receipts, verify against the key published by that production issuer and matched by the receipt's `sig.kid`, not the bundled test key.

## What VALID proves

For `truerolls-drand-1`, `VALID` proves:

- The receipt body is exactly what the named Ed25519 key signed.
- The seed came from a verified public drand quicknet target pulse, with `target_round = client_observed_round + 2`.
- The target pulse randomness is `SHA256(signature)`, and the seed re-derives from that randomness plus the client nonce/request binding.
- The draw, face, and bounded math replay exactly.

For legacy `truerolls-1`, `VALID` proves only tamper-evidence, deterministic replay, and bounded math.

## What VALID does not prove

`VALID` does not prove the published outcome was **unbiased**. Because this per-roll drand receipt is not publicly anchored before the target round, the operator can **grind**: privately run one or many attempts (other nonces/rounds), see each outcome, fail/suppress the unfavorable ones — "drand timeout" is an indistinguishable cover — and publish only a favorable completed receipt. Each published receipt's seed is genuinely drand-derived; the *selection* across discarded attempts is what biases the result, so withholding/refusal here is the grinding mechanism, not merely an availability issue. Strict witnessed fairness — binding the operator to one committed attempt per roll — is the v2 protocol, which requires public/witnessed pre-round commitments.

Per-roll drand is implemented. Commit/reveal, transparency-log anchoring, witnessed checkpoints, on-chain anchoring, authentication, and production strict fairness are not implemented in the live product.

## Reference

| Property | Value |
|---|---|
| Receipt versions accepted | `truerolls-drand-1`; legacy `truerolls-1` |
| Signature algorithm | Ed25519 |
| Signed bytes | JCS / RFC 8785 canonicalization of the body, minus `sig` and `receipt_hash` |
| Drand network | quicknet |
| Drand chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Drand scheme | `bls-unchained-g1-rfc9380` |
| Target rule | `target_round = client_observed_round + 2` |
| Seed derivation | HKDF-SHA256 from target drand randomness, salted/bound by canonical request hash |
| DRBG | ChaCha20, seeded from the 32-byte `proof.rng.drbg_key_hex` |
| Sampling | prefix-CDF over the guarded distribution; no modulo bias |
| Metric tolerance | `1e-9` for `alpha`, `kl`, `ev` |
| Supported dice | d4, d6, d8, d10, d12, d20, d100 in verifier; live roll endpoint accepts d6, d20, d100 |

The shared verifier lives in `crates/kd-receipt`; the browser entrypoint is `verifyReceiptJson` in `crates/kd-core-wasm`; the CLI entrypoint is `kd verify --receipt` in `crates/kd-cli`.

*This repository is proprietary, all rights reserved.*
