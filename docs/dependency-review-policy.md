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

Any vulnerability finding in shipped code, at any severity, blocks the candidate unless it is fixed or
explicitly accepted by the owner with a written security rationale in this document and a matching
per-advisory exception in CI. Registry or advisory-database outages are recorded as external
blockers, never converted to PASS.

## Pinned Commands

```powershell
cargo update --dry-run
cargo tree --locked --workspace --all-features
cargo audit --json
corepack pnpm -C services/loom-demo audit --prod --json
corepack pnpm -C services/loom-demo audit --json
corepack pnpm -C services/loom-demo install --frozen-lockfile
corepack pnpm -C services/loom-demo dependency:check
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

The check fails closed. An unreachable `rsa` makes `cargo tree` exit 0 with "nothing to print"; any
non-zero exit fails the job, because reachability was not established. That includes `rsa` leaving
`Cargo.lock` entirely (exit 101, "did not match any packages"), which means the exception is stale
and should be removed.

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
corepack pnpm -C services/loom-demo audit
```

Any new vulnerability or unsoundness advisory fails the job, at any severity: cargo-audit has no
severity floor, and pnpm audit runs at its default level (`low`). Yanked lockfile-only crates are
reported but do not fail it. An advisory-database or registry outage fails the job and is recorded
as an external blocker, never converted to PASS.

The pnpm gate covers production and development dependencies. Production-only audit remains a
useful exposure check, but it cannot replace the full gate: build/test tools run on developer
machines and CI. A pnpm exception requires a per-CVE `--ignore` plus owner-approved written
rationale here. Prefer a compatible patched release or reviewed override to an exception.

## UI Tooling Compatibility Guards

Vite stays on the patched 7.3 line and Vitest on 4.1; this is not a migration to their newer major
versions. ESLint 10 removes the legacy ESLint 9 dependency paths through `@eslint/eslintrc`,
`js-yaml` and callable minimatch 3. The compatible React Hooks plugin retains the previous
`rules-of-hooks: error` and `exhaustive-deps: warn` checks. Enabling React Compiler's additional
rules is separate work, not an implicit change to the project's lint policy.

`pnpm-workspace.yaml` overrides minimatch 10 requests to 11.0.3 for
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
This crosses a major version and is not assumed universally compatible. The installed callers
use the named/class API; CI checks each consumer's resolution, glob behavior, source/generated
file coverage, and lint-violation canaries with `dependency:check`. Do not apply the override to
callable minimatch 3. Re-evaluate or remove it when upstream packages accept a patched release.

A second narrow override refreshes Babel's compatible Browserslist 4 dependency, covering
[GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and
[GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g). Its transitive baseline
mapping database is refreshed with it. The existing fflate security override remains unchanged.

These packages are build/test tooling, not minting, sampling or receipt-verification primitives.
Passing their audit does not certify the application or remove the need for receipt/browser gates.

## Current UI Dependency Notice

Three.js r183 deprecated `Clock` in favor of `Timer`. TrueRolls does not call `Clock`, but the current
React Three Fiber 9.6.1 runtime constructs it internally. Version 9.6.1 is the current compatible
React 19 release in this candidate, so TrueRolls records the warning instead of patching vendor code
or downgrading Three.js. Re-evaluate when React Three Fiber ships the upstream migration. Reference:
<https://github.com/mrdoob/three.js/wiki/Migration-Guide#182--183>.
