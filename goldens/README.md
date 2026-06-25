# Goldens Data Pack v2 (KD-026)

Reference fixtures for regression-testing the verify pipeline:

- 9 **transcript goldens** in the CLI `kd.local.v2` schema (4 clean, 5 tampered/broken)
- 2 **receipt goldens** in the signed `truerolls-1` `ReceiptV2` schema (1 valid, 1 tampered)

Supersedes the KD-022 v1 pack. The six v1 filenames are kept and their contents
regenerated in the v2 schema (the v1 files lacked `draw_u64`, so after the
KD-023 face policy they all failed local verification as `face: unverifiable`).

**Policy:** every `expected_local` verdict in `goldens.csv` is enforced by
`crates/kd-cli/tests/goldens.rs` (runs in CI, never ignored); `expected_server`
is enforced by the Phase-1 live smoke run.

## Files

| # | File | Die | κ | Seed | Kind | Expected local (CLI) | Expected server (`POST /v1/verify`) |
|---|------|-----|---|------|------|----------------------|--------------------------------------|
| 1 | `golden_01_d6_k06.json` | d6 | 0.6 | 1001 | Clean | `verdict: OK`, exit 0 | 200 OK |
| 2 | `golden_02_d20_k06.json` | d20 | 0.6 | 2002 | Clean | `verdict: OK`, exit 0 | 200 OK |
| 3 | `golden_03_d100_k06.json` | d100 | 0.6 | 3003 | Clean | `verdict: OK`, exit 0 | 200 OK |
| 4 | `golden_04_d6_tampered_face.json` | d6 | 0.6 | 1001 | Tampered face | `MISMATCH`, exit 1 | 422 MISMATCH |
| 5 | `golden_05_d6_tampered_kappa.json` | d6 | -0.9* | 1001 | Tampered κ | `MISMATCH`, exit 1 | 422 MISMATCH |
| 6 | `golden_06_d6_bad_version.json` | d6 | 0.6 | 1001 | Bad math_param_version | hard error, exit 1 | 400 ERROR |
| 7 | `golden_07_d6_kneg05.json` | d6 | -0.5 | 4004 | Clean (negative κ) | `verdict: OK`, exit 0 | 200 OK |
| 8 | `golden_08_d6_tampered_draw.json` | d6 | 0.6 | 1001 | Tampered draw_u64 | `MISMATCH`, exit 1 | 422 MISMATCH |
| 9 | `golden_09_d6_missing_draw.json` | d6 | 0.6 | 1001 | Missing draw_u64 | `MISMATCH` (`face: unverifiable`), exit 1 | 400 (missing draw_u64) |
| R1 | `golden_receipt_01_d20.json` | d20 | 0.6 | n/a | Valid signed receipt | `VALID`, exit 0 | 200 via receipt mode when server kid matches test key |
| R2 | `golden_receipt_02_d20_tampered_face.json` | d20 | 0.6 | n/a | Tampered receipt face | `INVALID`, exit 1 | n/a (offline CLI fixture) |

\* κ was changed from 0.6 to -0.9 after generation; all other fields still
reflect the honest κ=0.6 computation.

## Tamper rationale

Files 4–6, 8, 9 are derived programmatically from `golden_01` by the generator
(`crates/kd-cli/tests/gen_goldens.rs`); each changes exactly one thing:

| # | What was changed | Why it must fail |
|---|------------------|------------------|
| 4 | `face: 3 → 4` (`(face % 6) + 1`) | Claimed face no longer matches the prefix-CDF replay of `draw_u64` over the honest probs |
| 5 | `kappa: 0.6 → -0.9` | Recomputation from κ=-0.9 yields different probs/alpha/kl/ev (and a different replayed face) than the recorded ones |
| 6 | `math_param_version: "roll.math.v1" → "roll.math.v2_FAKE"` | The version gate must hard-error before any recomputation (no false OK/MISMATCH against the wrong math) |
| 8 | `draw_u64 → "0"` (claimed face kept) | draw 0 replays to face 1 ≠ claimed face 3 — a forged draw cannot back an honest-looking face |
| 9 | `draw_u64` key removed | A face claim without a replayable draw is unverifiable; the KD-023 policy treats that as MISMATCH, never a silent pass |

Receipt R2 takes the valid R1, bumps `face` 10 → 11 (`(face % 20) + 1`), and
keeps the ORIGINAL signature — so both the Ed25519 check and the face
recompute fail.

## Regeneration

Everything in this directory is regenerated deterministically by one command
(byte-identical output on every run — fixed seeds, fixed receipt id/timestamp,
deterministic Ed25519):

```powershell
cargo test -p kd-cli --test gen_goldens -- --ignored
```

The clean transcripts (1–3, 7) are produced by the real `kd` binary; the
manual equivalents are:

```powershell
kd roll --kappa 0.6  --die d6   --seed 1001 --output golden_01_d6_k06.json
kd roll --kappa 0.6  --die d20  --seed 2002 --output golden_02_d20_k06.json
kd roll --kappa 0.6  --die d100 --seed 3003 --output golden_03_d100_k06.json
kd roll --kappa -0.5 --die d6   --seed 4004 --output golden_07_d6_kneg05.json
```

(The generator then rewrites them pretty-printed with sorted keys and a
trailing newline; tampered files and receipts are derived in code.)

## Verification

### Local CLI

```powershell
# Clean — verdict: OK, exit 0
kd verify --input goldens/golden_01_d6_k06.json
kd verify --input goldens/golden_02_d20_k06.json
kd verify --input goldens/golden_03_d100_k06.json
kd verify --input goldens/golden_07_d6_kneg05.json

# Tampered/broken — exit 1
kd verify --input goldens/golden_04_d6_tampered_face.json   # MISMATCH (face)
kd verify --input goldens/golden_05_d6_tampered_kappa.json  # MISMATCH (alpha/kl/ev/probs/face)
kd verify --input goldens/golden_06_d6_bad_version.json     # hard error: param_version
kd verify --input goldens/golden_08_d6_tampered_draw.json   # MISMATCH (face from draw)
kd verify --input goldens/golden_09_d6_missing_draw.json    # MISMATCH (face: unverifiable)
```

### Remote CLI (requires a running kd-api)

```powershell
kd verify --input goldens/golden_01_d6_k06.json --remote --server http://127.0.0.1:8080
```

The CLI maps the transcript to the flat `VerifyRequest` body (KD-025) before
POSTing.

### Raw POST

A v2 transcript file can also be POSTed **directly** as the request body:
the server's `VerifyRequest` (kd-api `src/models/dto.rs`) has no
`deny_unknown_fields`, so serde ignores the CLI-only keys
(`transcript_version`, `lambda`, `seed`, `sampling`) and deserializes only the
flat fields. This works for these goldens because they all use the server's
fixed default λ=0.5 — a transcript rolled with a different λ would falsely
MISMATCH server-side.

```powershell
$body = Get-Content goldens/golden_01_d6_k06.json -Raw
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/v1/verify -ContentType 'application/json' -Body $body
# clean    -> 200 + verdict OK
# tampered -> 422 (response body is the MISMATCH VerifyResponse)
# golden_06 -> 400 (unsupported math_param_version)
# golden_09 -> 400 (body fails VerifyRequest deserialization: draw_u64 missing)
```

## Receipt goldens

> **⚠ TEST KEY ONLY.** The receipts are signed with the Ed25519 key derived
> from the seed `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
> (kid `test-kid-1`) — the same PUBLIC seed used by kd-api's `signing.rs`
> unit tests. It is committed to the repo on purpose so the fixtures are
> reproducible by anyone. **It must NEVER be used in production**, and a real
> deployment must reject it.

Shape: `truerolls-1` `ReceiptV2` — fixed id
`00000000-0000-0000-0000-00000000d201`, fixed
`created_at: 2026-01-01T00:00:00Z`, no `transcript_key`,
`proof.rng.drbg_key_hex` = `"42"` × 32 (so the draw replays as the first
`next_u64()` of `ChaCha20Rng::from_seed([0x42; 32])`), face/alpha/kl/ev
recomputed from kd-core at κ=0.6 d20 defaults. `receipt_hash` is
`sha256:<hex>` over the JCS (RFC 8785) canonical bytes of the body without
`sig`/`receipt_hash`; the Ed25519 signature covers the same bytes.

Offline verification (test public key, derived from the public test seed):

```powershell
kd verify --receipt goldens/golden_receipt_01_d20.json --public-key "IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY="   # VALID, exit 0
kd verify --receipt goldens/golden_receipt_02_d20_tampered_face.json --public-key "IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY="   # INVALID, exit 1
```

`crates/kd-cli/tests/goldens.rs` derives this public key in code from the test
seed, so the fixtures and the tests cannot drift apart.

## Parameters

All transcript goldens use the v1.3.1 defaults:

- λ = 0.50 (matches the server's fixed default — required for server parity)
- ε = 1e-12
- KL cap: d6=0.060, d20=0.035, d100=0.025 (nats)
- EV cap: 0.20 × SD_uniform
- `math_param_version: "roll.math.v1"`, `transcript_version: "kd.local.v2"`
