# TrueRolls

**Verifiable dice.** Every roll returns an Ed25519-signed receipt. Change a signed
value and its JCS-canonical signing bytes change, so signature verification fails. Anyone can re-verify a receipt
offline, in the browser or from the command line. Browser key discovery may fetch
the issuer's published `/.well-known` key set; the receipt bytes stay local.

Live `truerolls-drand-1` rolls are seeded from a public drand quicknet beacon
(BLS-verified), and the die is **uniform by default**. A game can opt into a signed
stance parameter `κ` that nudges the distribution, hard-capped by KL-divergence and
expected-value guards. Bounded risk, never a secret pick.

> **Honest scope.** Live rolls mint `truerolls-drand-1` receipts. `VALID`
> proves the roll seed came from a verified public drand quicknet beacon and the
> outcome replays from that seed. It also proves the receipt was signed and the
> bounded math replays. `VALID` does **not** prove the published outcome was
> unbiased: because the operator's attempt is not publicly committed before the
> target round resolves, the operator can still **grind**, privately fail/suppress
> unfavorable attempts (other nonces/rounds) and publish only a favorable completed
> receipt. (Refusing or timing out a roll is the mechanism, so this is outcome-bias,
> not just availability.) Strict witnessed fairness, binding the operator to one
> committed attempt, is the v2 protocol, not this per-roll drand receipt. Legacy
> `truerolls-1` receipts remain verifiable only
> for saved receipts and goldens. See
> [docs/threat-model.md](docs/threat-model.md) for the precise limits.

This is a **source-available proprietary repository**, not an open-source project. See
[LICENSE](LICENSE). The exact verifier dependency closure has a narrow use, modification, and
distribution grant in [LICENSE-VERIFYING.md](LICENSE-VERIFYING.md) for receipt verification
integrations. No right is granted to operate the minting service, issue TrueRolls receipts, use
production signing keys, or use the brand.

---

## Layout

```
crates/
  kd-core         pure bounded math (no I/O): die defs, softmax, guard solving, KL/EV, prefix-CDF
  kd-drand        pinned drand quicknet BLS verification + HKDF seed derivation
  kd-receipt      the single shared signer + offline verifier (one canonicalization for both)
  kd-api          Axum HTTP server: drand-backed roll, sign, verify, health; Postgres/Redis/S3
  kd-cli          local roll + local/remote verify; transcript/receipt files
  kd-core-wasm    wasm-bindgen bindings exposing kd-core math + verify to the browser
  kd-worker-wasm  non-release server-side roll+sign artifact; never shipped to the browser
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

- [docs/receipt-format.md](docs/receipt-format.md), the signed receipt JSON, field by field, and how `receipt_hash` is canonicalized.
- [docs/verifying.md](docs/verifying.md), how to verify a receipt offline (browser + CLI) and exactly what a VALID result does and does not prove.
- [docs/threat-model.md](docs/threat-model.md), what an attacker can and cannot do, what is proven vs roadmap.
- [docs/api.md](docs/api.md), the HTTP endpoints as implemented.
- [docs/how-to/public-demo-operations.md](docs/how-to/public-demo-operations.md), production-profile
  configuration, caps, proxy trust, backup/restore, alerts, rollback, and incident response for a
  budgeted anonymous demo.
- [LICENSE-VERIFYING.md](LICENSE-VERIFYING.md), scoped rights for external receipt-verifier integrations.

## Standards we use

No house crypto. TrueRolls is built from public, well-specified primitives, each checkable against its spec:

- **drand quicknet**. Public randomness beacon (BLS, scheme `bls-unchained-g1-rfc9380`). The roll seed derives from a future beacon round. The verifier checks a public drand source, not a server-made random value. (`kd-drand`)
- **Ed25519** ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)). Signs JCS-canonical receipt content. Change a signed value and verification fails. (`kd-receipt`)
- **JCS** ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)). Canonical JSON, so the signature is byte-reproducible. (`kd-receipt`)
- **HKDF-SHA256** ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)). Derives the per-roll seed from beacon randomness and client nonce. (`kd-drand`)
- **SHA-256** ([FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)). Randomness = `SHA-256(verified signature)`, and the receipt hash.
- **ChaCha20** ([RFC 8439](https://www.rfc-editor.org/rfc/rfc8439)). Deterministic DRBG, `draw_u64` replays exactly. (`kd-core`)

## Quick start

Prerequisites: Rust 1.93.1 (pinned by [rust-toolchain.toml](rust-toolchain.toml)),
Node 22.22.2 (pinned by [.node-version](.node-version)), pnpm 10.30.2 (pinned by
[package.json](package.json)), Docker (for the local API stack), and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) only if you rebuild the wasm.

### Rust, math + verifier

```powershell
cargo test --locked -p kd-core --all-features     # the bounded-math engine
cargo test --locked -p kd-drand --all-features    # drand quicknet proof + HKDF derivation
cargo test --locked -p kd-receipt --all-features  # signer/verifier + committed goldens
cargo test --locked -p kd-cli --all-features      # CLI roll + verify against the goldens
cargo test --locked --workspace --all-features    # service-free suite; live tests stay ignored
```

The ignored `kd-api` integration tests expect the live stack (Postgres/Redis/MinIO +
the server on `:8080`). Start it with `scripts/dev-up.ps1`, then run
`cargo test --locked -p kd-api --all-features -- --include-ignored`.

### The web demo

```powershell
corepack pnpm -C services/loom-demo install --frozen-lockfile
corepack pnpm -C services/loom-demo dev      # http://localhost:5173 - proxies /api -> :8080
corepack pnpm -C services/loom-demo test
corepack pnpm -C services/loom-demo build
```

With no API reachable the demo runs in **demo mode** (receipts are simulated -
that is *not* cryptographic verification). Start the API for real Ed25519
signing and drand-backed receipts.

### The local API stack

```powershell
pwsh -File scripts/dev-up.ps1       # infra containers + kd-api on http://127.0.0.1:8080
pwsh -File scripts/tamper-demo.ps1  # roll -> verify VALID -> alter a signed value -> verify INVALID
pwsh -File scripts/dev-down.ps1
```

The dev server signs with a **public test key** committed for reproducibility. It
must never be used in production, and a real deployment must reject it.

### Rebuilding the browser wasm

The prebuilt package in `packages/kd-core-wasm/` is committed, so the demo builds
without a wasm toolchain. Build a comparison package under ignored `outputs/`; do
not overwrite the committed package just to make a parity check pass:

```powershell
wasm-pack build crates/kd-core-wasm --target web --out-dir ../../outputs/manual-kd-core-wasm -- --locked
node scripts/wasm-parity.mjs packages/kd-core-wasm outputs/manual-kd-core-wasm
node scripts/wasm-receipt-parity.mjs packages/kd-core-wasm outputs/manual-kd-core-wasm
```
