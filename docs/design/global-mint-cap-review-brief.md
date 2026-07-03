# Global Mint Cap and Idempotency, Review Outcome and Follow-up Brief

> **What this is.** A current review brief for the uncommitted global mint-cap work on
> `freature/drand-per-roll`. It replaces the earlier byte-exact diff brief, which became stale after
> the ownership-safe lock release and documentation corrections. Generate fresh diffs from the current
> working tree when reviewing.

---

## Review outcome

**Code verdict.** The mint cap design enforces no over-delivery at the reservation gate: at most `cap`
requests per window are admitted beyond `quota::reserve_mint`. Redis is a concurrency fence only. The
durable idempotency source is Postgres: the handler checks for an existing same-key receipt before and
after acquiring the Redis lock, then persists the completed signed receipt with `ON CONFLICT
(idempotency_key) DO NOTHING`. Idempotency lock release is ownership-safe, so a stale handler cannot
blindly delete a newer same-key lock after TTL expiry.

**Docs verdict.** The original auth/key lifecycle note overstated drand `target_round` as a receipt
signing timestamp. That is false. The note now distinguishes drand seed provenance from issuance-time
evidence. Revocation after key compromise requires independent receipt-existence evidence, such as an
RFC 3161 timestamp token, witnessed transparency-log inclusion, Rekor/CT-style evidence, on-chain
anchor, or equivalent.

---

## Context

`POST /v1/roll` is unauthenticated and mints a signed receipt, Postgres row, S3 transcript, Redis
state, and drand relay work. Per-IP rate limiting bounds one apparent client, not total volume across
rotated source IPs. The global mint cap is an L2 cost ceiling, not an authorization system.

Trust-spine invariants:

- No change to `kd-core` sampling, guards, KL/EV, or prefix-CDF.
- The global cap itself does not require a receipt schema change.
- No drand target-rule or seed-derivation change in this pass.
- No fairness overclaim. Drand-backed receipts prove seed provenance and replay, not strict
  anti-withholding fairness.
- `.env.example` contains placeholders only.
- Production still rejects the published test signing seeds, test kids, and derived test public keys.

---

## Tickets to verify

### T-CAP-1, `quota::reserve_mint`

**What.** `crates/kd-api/src/services/quota.rs` exposes:

```rust
pub enum MintReservation {
    Allowed { window_count: u64 },
    Rejected { window_count: u64, retry_after_secs: u64 },
}
```

`reserve_mint(pool, cap, window_secs, now_unix)` short-circuits when `cap == 0`. Otherwise it runs one
Redis Lua `EVAL`: `INCR` the fixed-window key, `EXPIRE` it only when the post-increment count is 1,
and rejects when `window_count > cap`.

**Verify.**

- `cap = N` allows the Nth reservation and rejects the N+1st.
- Redis script execution is atomic and cannot leave an incremented key without TTL.
- `window_bounds` clamps `window_secs` to at least 1 and returns `Retry-After >= 1`.
- The counter is monotonic. It records validated reservation attempts in the window, including
  rejected over-cap attempts. Rejected attempts are not minted receipts.

### T-CAP-2, Config and prod gate

**What.** `Config` adds:

- `roll_global_cap`,
- `roll_global_cap_window_secs`,
- `allow_uncapped_roll_in_prod`.

Under `KD_ENV=prod`, `Config::validate()` refuses `roll_global_cap == 0` unless
`KD_ALLOW_UNCAPPED_ROLL` is truthy.

**Verify.**

- Dev remains uncapped by default.
- Prod requires a finite cap or explicit opt-out.
- `build_state` still calls `cfg.validate()?` before DB, Redis, S3, or signer setup.

### T-CAP-3, Handler placement and durable idempotency

**What.** `post_roll` first calculates the canonical payload hash and checks Postgres for an existing
completed receipt under the idempotency key. It then acquires the Redis lock and checks Postgres
again. Only a new, non-deduplicated request reaches the mint gate.

The handler reserves mint budget after:

- request shape validation,
- idempotency acquisition,
- drand client-frontier validation.

It reserves before target-round wait, signing, DB insert, and S3 upload.

**Verify.**

- Same key plus same body returns the stored receipt even after Redis TTL expiry, restart, or flush.
- Same key plus different body returns 409.
- No fresh 201 mint bypasses `reserve_mint`.
- Dedup and 202 paths do not reserve.
- Invalid drand proofs 400 before reserve.
- Failure after reserve consumes budget intentionally, because the costly attempt already started.

### T-CAP-4, Ownership-safe idempotency release

**What.** `acquire_lock` returns an `IdempotencyLock { key, token }`. Redis stores the token with:

```text
SET key token NX EX ttl
```

`release_lock(pool, &lock)` uses compare-and-delete Lua:

```text
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
```

**Verify.**

- A stale owner cannot delete a newer same-key owner after TTL expiry.
- Cap rejection and other pre-mint failures try to release the owned lock.
- Release errors or false returns are logged with `idem.lock_release_failed` and do not replace the
  original response with a cleanup failure.
- The normal successful mint path still does not release the lock.

### T-CAP-5, 429 response

**What.** Over-cap requests return `429 Too Many Requests`, `Retry-After: <seconds>`, and body:

```json
{"error":"global_roll_cap_exceeded"}
```

**Verify.**

- `Retry-After` is derived from fixed-window math and is at least 1.
- Response is built inline so the header is preserved.

### T-CAP-6, Redis-gated tests

**What.** Optional Redis-backed tests are gated by `KD_REDIS_TEST_URL` and return early when absent.

**Verify.**

- Idempotency test proves stale-owner release returns false.
- Quota test proves cap 2 gives allowed counts 1 and 2, then rejected count 3.
- Normal local tests do not require Redis.

### T-CAP-7, Truthfulness of `auth-and-key-lifecycle.md`

**Verify the note says all of the following.**

- The global mint cap is implemented.
- Multi-kid rotation is implemented with exactly one active signing key and retired verify-only keys.
- `kd-receipt` has a status-aware key-set verifier that selects by `sig.kid`, plus a manual
  single-public-key verifier that bypasses status semantics.
- The well-known key endpoint returns a list shape with `active`, `retired`, and `revoked` status,
  but no validity-window metadata.
- Drand `target_round` is seed provenance, not a receipt signing timestamp.
- Revocation after signing-key compromise requires issuance/existence evidence for the receipt hash.
- Correct drand round time is `genesis + (round - 1) * period`.

---

## Security properties to cite against source

| Property | Expected result |
|----------|-----------------|
| P-1 No over-delivery | At most `cap` reservations per window are admitted past the cap gate. |
| P-2 Fail closed | Redis errors on lock or quota path produce non-mints, except explicit uncapped mode. |
| P-3 Invalid requests not charged | Invalid drand proof fails before quota reservation. |
| P-4 Prod not accidentally uncapped | Prod boot fails with `KD_ROLL_GLOBAL_CAP=0` unless opted out. |
| P-5 Trust-spine isolation | No kd-core, receipt schema, verifier, drand derivation, or golden mutation in this pass. |
| P-6 Documentation honesty | No drand-round-only revocation claim remains. |

---

## Commands for review

```powershell
$env:SQLX_OFFLINE = "true"
git diff -- .env.example crates/kd-api/src/config.rs crates/kd-api/src/main.rs crates/kd-api/src/routes/roll.rs crates/kd-api/src/services/idempotency.rs crates/kd-api/src/services/quota.rs crates/kd-api/src/state.rs
Get-Content -Raw crates/kd-api/src/services/quota.rs
Get-Content -Raw docs/design/auth-and-key-lifecycle.md
Get-Content -Raw docs/design/global-mint-cap-review-brief.md
cargo fmt --all --check
cargo clippy -p kd-api --all-targets --all-features -- -D warnings
cargo test -p kd-api --bin kd-api
```

Optional live Redis tests:

```powershell
$env:SQLX_OFFLINE = "true"
$env:KD_REDIS_TEST_URL = "redis://:kd_dev_only@127.0.0.1:6379"
cargo test -p kd-api --bin kd-api redis_
```

Full package test:

```powershell
$env:SQLX_OFFLINE = "true"
cargo test -p kd-api
```

If no external kd-api server is running, the expected outcome is that unit tests pass and
`tests/health.rs` fails with the known "API not reachable at http://127.0.0.1:8080" message.

Hygiene:

```powershell
git diff --check
git status --short --branch
```
