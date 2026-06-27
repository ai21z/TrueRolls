# TrueRolls

**Verifiable dice.** Every roll returns an Ed25519-signed receipt. Change a single
byte of that receipt and the signature breaks. Anyone can re-verify a receipt
offline — in the browser or from the command line — without trusting the server
that produced it.

The dice are *behavior-weighted but bounded*: a stance parameter `κ` nudges the
outcome distribution, and the nudge is hard-capped by KL-divergence and
expected-value guards. Karma shapes **bounded** risk; it does not secretly pick
winners.

> **Honest scope.** Live rolls mint `truerolls-drand-1` receipts. `VALID`
> proves the roll seed came from a verified public drand quicknet beacon and the
> outcome replays from that seed; it also proves the receipt was signed and the
> bounded math replays. `VALID` does **not** prove the published outcome was
> unbiased: because the operator's attempt is not publicly committed before the
> target round resolves, the operator can still **grind** — privately fail/suppress
> unfavorable attempts (other nonces/rounds) and publish only a favorable completed
> receipt. (Refusing or timing out a roll is the mechanism, so this is outcome-bias,
> not just availability.) Strict witnessed fairness — binding the operator to one
> committed attempt — is the v2 protocol, not this per-roll drand receipt. Legacy
> `truerolls-1` receipts remain verifiable only
> for saved receipts and goldens. See
> [docs/threat-model.md](docs/threat-model.md) for the precise limits.

This repository is **proprietary** — see [LICENSE](LICENSE). No license is granted.

---

## Layout

```
crates/
  kd-core         pure bounded math (no I/O): die defs, softmax, guard solving, KL/EV, prefix-CDF
  kd-drand        pinned drand quicknet BLS verification + HKDF seed derivation
  kd-receipt      the single shared signer + offline verifier (one canonicalization for both)
  kd-api          Axum HTTP server: drand-backed roll, sign, verify, health; Postgres/Redis/S3
  kd-cli          local + remote roll and verify; transcript/receipt files
  kd-core-wasm    wasm-bindgen bindings exposing kd-core math + verify to the browser
  kd-worker-wasm  wasm roll+sign over the shared signer (server-side; never shipped to the browser)
services/
  loom-demo       the public web demo (React + Vite + Three.js)
packages/
  kd-core-wasm    prebuilt wasm-pack output consumed by loom-demo (committed so the site builds without a wasm toolchain)
goldens/          committed test fixtures (transcripts + receipts) that pin the verifier's behavior
infra/            docker-compose for Postgres / Redis / MinIO
scripts/          dev-up / dev-down / tamper-demo (Windows PowerShell)
docs/             this reference set
```

## Docs

- [docs/receipt-format.md](docs/receipt-format.md) — the signed receipt JSON, field by field, and how `receipt_hash` is canonicalized.
- [docs/verifying.md](docs/verifying.md) — how to verify a receipt offline (browser + CLI) and exactly what a VALID result does and does not prove.
- [docs/threat-model.md](docs/threat-model.md) — what an attacker can and cannot do; what is proven vs roadmap.
- [docs/api.md](docs/api.md) — the HTTP endpoints as implemented.

## Quick start

Prerequisites: Rust (stable, pinned by [rust-toolchain.toml](rust-toolchain.toml)),
Node ≥ 20.19 with pnpm 10, Docker (for the local API stack), and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) only if you rebuild the wasm.

### Rust — math + verifier

```powershell
cargo test -p kd-core          # the bounded-math engine
cargo test -p kd-drand         # drand quicknet proof + HKDF derivation
cargo test -p kd-receipt       # the signer/verifier (checks the committed goldens)
cargo test -p kd-cli           # CLI roll + verify against the goldens
cargo test --workspace         # everything; the kd-api integration tests need the live stack*
```

\* The `kd-api` integration tests expect the live stack (Postgres/Redis/MinIO + the
server on `:8080`) and fail without it. Start it first with `scripts/dev-up.ps1`.

### The web demo

```powershell
pnpm install
pnpm -C services/loom-demo dev      # http://localhost:5173 — proxies /api -> :8080
pnpm -C services/loom-demo build
```

With no API reachable the demo runs in **demo mode** (receipts are simulated —
that is *not* cryptographic verification). Start the API for real Ed25519
signing and drand-backed receipts.

### The local API stack

```powershell
pwsh -File scripts/dev-up.ps1       # infra containers + kd-api on http://127.0.0.1:8080
pwsh -File scripts/tamper-demo.ps1  # roll -> verify VALID -> flip a byte -> verify INVALID
pwsh -File scripts/dev-down.ps1
```

The dev server signs with a **public test key** committed for reproducibility. It
must never be used in production, and a real deployment must reject it.

### Rebuilding the browser wasm

The prebuilt package in `packages/kd-core-wasm/` is committed, so the demo builds
without a wasm toolchain. To rebuild it from `crates/kd-core-wasm`:

```powershell
wasm-pack build crates/kd-core-wasm --target web --out-dir ../../packages/kd-core-wasm
```
