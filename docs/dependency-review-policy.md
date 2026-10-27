# Dependency Review Policy

TrueRolls dependency changes are owner-reviewed. Automated services may report advisories, but they
must not create commits or pull requests under a bot identity.

## Required Review

Before accepting a Rust or JavaScript dependency change, the owner reviews:

1. why the dependency or version change is needed,
2. the direct and transitive lockfile diff,
3. upstream release notes and security advisories,
4. license compatibility with the proprietary repository and scoped verifier grant,
5. build scripts, native code, network behavior, and newly enabled features,
6. deterministic tests, receipt goldens, fresh WASM parity, and browser gates,
7. cargo-audit, pnpm audit, gitleaks, and actionlint results.

Cargo's tracked resolver policy keeps manual updates on versions compatible with the pinned Rust
toolchain. An update that requires a newer compiler is a separate toolchain decision, not an implicit
dependency refresh.

High or critical findings block the candidate unless fixed or explicitly accepted by the owner with
a written security rationale. Registry or advisory-database outages are recorded as external
blockers, never converted to PASS.

## Pinned Commands

```powershell
cargo update --dry-run
cargo tree --locked --workspace --all-features
cargo audit --json
corepack pnpm audit --prod --audit-level high --json
corepack pnpm -C services/loom-demo install --frozen-lockfile
```

Dependency updates must preserve `Cargo.lock` and `pnpm-lock.yaml` reviewability. Goldens and
committed WASM are never regenerated merely to hide a dependency-induced behavior change.

## Current Lockfile-Only Advisory

The candidate's raw `cargo audit` report includes `RUSTSEC-2023-0071` for `rsa 0.9.10`. The crate is
listed by SQLx's optional MySQL dependency in `Cargo.lock`, but it is not present in the compiled
TrueRolls graph. TrueRolls enables only SQLx's Postgres features, and this reachability check returns
no dependency path:

```powershell
cargo tree --locked --workspace --all-features --target all -i rsa@0.9.10
```

CI accepts this one advisory through a narrow exception (`--ignore RUSTSEC-2023-0071`) and fails
the same job if `cargo tree --locked --workspace --all-features --target all -i rsa` ever prints an
`rsa` dependency path. Enabling SQLx MySQL support, or any future change that makes `rsa` reachable,
therefore blocks the candidate until the advisory is resolved or the owner records an explicit
security decision.

## Current Unsoundness Exception

`RUSTSEC-2026-0253` reports `lru 0.16.4` as unsound: if a stored key's `Drop` implementation panics
inside `LruCache::pop()` and the panic is caught with `catch_unwind`, later evictions can write to
freed memory. The fix is `lru >= 0.18.2`, which `aws-sdk-s3 1.123.0` does not accept.

`lru` is compiled into kd-api only through `aws-sdk-s3`. Its single use is the S3 Express identity
cache (`s3_express.rs`), keyed by `CacheKey(String)`. `String`'s `Drop` cannot panic, so the trigger
condition is not reachable. The cache also serves only S3 Express directory buckets (`--x-s3`), which
R2 and MinIO never use. CI ignores this one advisory while still denying every other unsound
finding. Re-evaluate on each `aws-sdk-s3` upgrade and remove the exception once `lru >= 0.18.2`
resolves.

## CI Audit Gate

The `[X] Supply-chain advisories` job runs nightly and on every push:

```bash
cargo audit --deny unsound --ignore RUSTSEC-2023-0071 --ignore RUSTSEC-2026-0253
corepack pnpm -C services/loom-demo audit --prod --audit-level high
```

Any new vulnerability or unsoundness advisory fails the job. Yanked lockfile-only crates are reported
but do not fail it. An advisory-database or registry outage fails the job and is recorded as an
external blocker, never converted to PASS.

## Current UI Dependency Notice

Three.js r183 deprecated `Clock` in favor of `Timer`. TrueRolls does not call `Clock`, but the current
React Three Fiber 9.6.1 runtime constructs it internally. Version 9.6.1 is the current compatible
React 19 release in this candidate, so TrueRolls records the warning instead of patching vendor code
or downgrading Three.js. Re-evaluate when React Three Fiber ships the upstream migration. Reference:
<https://github.com/mrdoob/three.js/wiki/Migration-Guide#182--183>.
