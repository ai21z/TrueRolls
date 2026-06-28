# kd-api Operational Security Audit

> **Provenance.** Adversarial multi-agent operational/availability audit, 2026-06-28. Findings are **code-grounded** (`file:line` read from source) and cross-referenced to external best practice (cited inline); **no load test was run** - severities are a triage starting point, not measured under load. Crypto/fairness correctness was audited separately (see [threat-model.md](threat-model.md)). The "Could not substantiate / load-bearing unknowns" section at the end lists assumptions (deployment edge config, S3 ACLs, pinned-version framework defaults) that must be confirmed before acting on the related findings.

**Scope:** Availability and operational posture of the TrueRolls `kd-api` HTTP server (Rust/Axum). All file:line references are in `crates/kd-api/src/...` unless noted. Severities are deliberately un-inflated; several items are confirmed adequate.

## Deploy-critical must-fix (before any public/internet-exposed deploy)

1. **OPS-RL-01 - X-Forwarded-For trust boundary.** The only abuse control on the expensive endpoint is a per-IP limiter that trusts a client-spoofable header. Directly exposed, it is fully bypassable. **This is the single load-bearing deploy invariant.**
2. **OPS-DOS-01 - No whole-handler timeout + tiny DB pool.** Each roll parks a task 6-20s with no global concurrency cap and only 5 DB connections; a small flood wedges all endpoints.
3. **OPS-AUTH-01 - Unauthenticated state-mutating signing endpoint.** Anonymous callers drive unbounded DB rows, S3 objects, and signatures with no quota or billing cap.
4. **OPS-KEY-01 / OPS-KEY-02 - No key rotation or revocation.** A leaked prod signing key is an unrecoverable, undetectable forgery event with no graceful response path.

The first three share one root cause: the system accepts unlimited expensive, unattributed work, and the only gate (per-IP rate limiting) is header-spoofable when not behind a header-stripping proxy.

---

## Theme A - Rate-limit / proxy-trust boundary

| ID | Sev | Title |
|----|-----|-------|
| OPS-RL-01 | **HIGH** (blocker if no XFF-stripping edge) | Per-IP rate limit bypassable via spoofed `X-Forwarded-For` |
| OPS-RL-02 | MEDIUM | Default config ships the gap open; nothing forces a trusted-proxy posture |
| OPS-RL-03 | LOW/INFO | No defense-in-depth beyond IP |

**OPS-RL-01 - HIGH (conditional blocker).**
- **Mechanism:** `routes/mod.rs:36` applies `SmartIpKeyExtractor` to POST `/v1/roll` only. That extractor reads the client IP from `x-forwarded-for` → `x-real-ip` → `forwarded` → peer IP and trusts the header value unconditionally (no trusted-proxy hop count, no rightmost selection). Because XFF is first in precedence, a direct client can send a fresh `X-Forwarded-For` per request and mint a new token bucket each time, defeating the limiter entirely. `main.rs:37-43` shows no proxy/trust layer in the stack (CORS is the only other middleware). The roll endpoint is the expensive one (drand fetch + multi-second wait + Postgres + S3 + Ed25519 sign), so an uncapped path is also resource amplification, not only a fairness issue.
- **In-repo proof:** the crate's own test `distinct_ips_have_independent_buckets` (`routes/mod.rs:146-175`, helper `post_from` at `:107-114`) sends the IP **only** via `x-forwarded-for` with no real proxy, and the limiter buckets on it. That test is exactly the attacker primitive.
- **Impact:** complete rate-limit bypass + resource-amplification DoS when not behind a proxy that overwrites forwarding headers.
- **Fix:** make the trust boundary explicit and fail-closed (see OPS-RL-02). When no trusted proxy is configured, swap `SmartIpKeyExtractor` → `PeerIpKeyExtractor` at `routes/mod.rs:36` (peer-IP only, XFF ignored). When a trusted proxy with known hop count N is configured, select the **Nth-from-right** XFF entry via a small custom `KeyExtractor`. At the edge (Fly/Cloudflare), strip client-supplied `X-Forwarded-For`/`X-Real-IP`/`Forwarded` and key on the provider's authoritative header (`CF-Connecting-IP` / `Fly-Client-IP`).
- **Citations:** docs.rs/tower_governor `SmartIpKeyExtractor` ("Only use this key extractor if you can ensure these headers are being set by a trusted provider"); https://adam-p.ca/blog/2022/03/x-forwarded-for/ ; https://owasp.org/www-community/pages/attacks/ip_spoofing_via_http_headers

**OPS-RL-02 - MEDIUM.**
- **Mechanism:** `config.rs` (`from_env` / `validate`) has no `trusted_proxy` / `trust_xff` / hop-count setting. `validate()` (`config.rs:153-165`) enforces SIG-2 and non-empty drand relays under `KD_ENV=prod` but does **not** require an XFF policy. A `KD_ENV=prod` deploy that is directly internet-exposed boots cleanly with a spoofable limiter; the secure-deployment assumption lives only in a code comment (`routes/mod.rs:23-27`), enforced nowhere.
- **Impact:** the secure posture is opt-in by deployment convention, not by config; nothing fails closed if it is unmet.
- **Fix:** add `KD_TRUSTED_PROXY` (bool/hop-count), default false/0. Under `EnvProfile::Prod`, if unset, either refuse to boot or force peer-IP mode with a loud warning - mirroring the existing SIG-2 fail-closed pattern at `config.rs:154-160`.

**OPS-RL-03 - LOW/INFO.** No auth on any endpoint (CORS `allow_origin(Any)` is the only other middleware, `main.rs:37-40`), so the per-IP limiter is the *sole* abuse control on POST `/v1/roll`. When that single control is header-spoofable there is no second layer. OWASP advises not relying solely on client IP for rate limiting.

---

## Theme B - DDoS / resource exhaustion

| ID | Sev | Title |
|----|-----|-------|
| OPS-DOS-01 | **HIGH** | No whole-handler timeout; each POST holds a task ~6-20s by design |
| OPS-DOS-02 | **HIGH** | No concurrency cap; DB pool (max 5) is the worst-possible de-facto limiter |
| OPS-DOS-03 | MEDIUM | No explicit request body-size limit on POST `/v1/roll` |
| OPS-DOS-04 | MEDIUM | Idempotency key churn + dedup busy-poll ties up tasks/connections |
| OPS-DOS-05 | LOW-MED | Redis pool unbounded by default; outbound drand fan-out is an amplifier |

The entire protective chain is two pieces: `GovernorLayer` on POST `/v1/roll` (`routes/mod.rs:50-61`) and a global `CorsLayer` (`main.rs:37-43`). There is **no** global concurrency cap, inflight/load-shed layer, whole-handler timeout, or request body-size override anywhere - confirmed by absence (`grep Timeout|ConcurrencyLimit|LoadShed` is empty).

**OPS-DOS-01 - HIGH.**
- **Mechanism:** every accepted roll parks a Tokio task waiting for a *future* drand round (`roll.rs:276-311`, `wait_for_round_verified`), bounded only per-step by `drand_target_wait_ms` (default 12_000, `config.rs:118-122`) and per-relay `drand_timeout_ms` (default 2_500, `config.rs:109-113`), while fanning out sequential outbound GETs across 3 relays (`drand.rs:72-123`). Attacker cost ≈ one TCP write; server cost ≈ seconds of a held task plus DB/Redis/S3/outbound budget. **Worst case:** 2.5s × 3 relays for one failing `fetch_latest_verified` (≈7.5s) *plus* up to 12s in `wait_for_round_verified` ⇒ a single request can occupy a task ~20s under relay distress. No outer bound caps the sum.
- **Impact:** asymmetric slow-hold amplification; combined with OPS-RL-01 a spoofing client or botnet multiplies held tasks freely.
- **Fix:** wrap the handler in `tower_http::timeout::TimeoutLayer` (hard ceiling ~15s → 504/503) and add `GlobalConcurrencyLimitLayer` + `LoadShedLayer` on POST `/v1/roll` so excess requests shed fast as 503 rather than queuing.
- **Citation:** https://github.com/tokio-rs/axum/discussions/242 (load-shed so requests "are dropped quickly and don't keep piling up").

**OPS-DOS-02 - HIGH.**
- **Mechanism:** no concurrency limit in front of the handler, so unbounded rolls all perform their ~6s drand wait concurrently; the squeeze appears only at the end when they contend for **5** Postgres connections (`state.rs:31-32`, `max_connections(5)`; used at `roll.rs:375`, `:406`, `:449`, and the dedup poll `:224`). sqlx's default `acquire_timeout` (30s - framework default, confirm against the pinned version) means tasks block up to 30s for a connection *after* already spending 6-12s on drand. Effective capacity is gated by 5 connections with no admission control, so the server accepts far more work than it can drain. The same 5-connection pool also serves `/healthz`, reads, and verify, so write-path saturation wedges all endpoints.
- **Impact:** pool exhaustion → all endpoints 500/time out under modest concurrency.
- **Fix:** admission control at the edge sized to downstream capacity (concurrency-limit POST `/v1/roll` to ~DB-pool-size × small factor) paired with LoadShed → 503; deliberately raise/justify the pool size rather than letting 5 be an accidental limiter; consider acquiring the DB connection *after* the drand wait, and a separate read pool so reads/health survive.
- **Citation:** https://docs.rs/tower/latest/tower/limit/index.html

**OPS-DOS-03 - MEDIUM.** `roll.rs:139` extracts `Json(req): Json<RollRequest>` with no `DefaultBodyLimit` override anywhere. Axum's default 2 MiB limit still applies (confirm against pinned axum version), but it is implicit and far larger than the tiny fixed-shape body needs; 2 MiB × unbounded concurrency (OPS-DOS-01/02) is needless memory amplification. **Fix:** apply explicit `DefaultBodyLimit::max(8 * 1024)` (or similar) to POST `/v1/roll`.

**OPS-DOS-04 - MEDIUM.**
- **Mechanism (Redis churn):** if no idempotency key is supplied the server mints one (`Uuid::new_v4()`, `roll.rs:191`) and writes `idem:roll:{key}` via SET NX EX (`idempotency.rs:14-24`, TTL 300s, `config.rs:132`). Attackers can also supply unbounded distinct keys. TTL caps total growth to ~roll-rate × 300s - a cost/load concern, not unbounded (hence MEDIUM).
- **Mechanism (busy-poll):** on a lock-held dedup, the task polls Postgres up to `idem_poll_max=200` × `idem_poll_ms=50` = **~10s**, one DB-pool acquisition per iteration (`roll.rs:215-274`, `roll.rs:224`, `idempotency.rs:41-53`). Many same-key requests spawn a swarm of 10s-looping tasks each repeatedly grabbing one of the 5 DB connections - a concurrency amplifier that starves real rolls.
- **Fix:** require a client-supplied Idempotency-Key for caching rather than auto-minting throwaway keys; replace the 200×50ms busy-poll with Redis pub/sub or a single short DB read; include the poll path under the OPS-DOS-02 concurrency cap.

**OPS-DOS-05 - LOW-MEDIUM.**
- **Redis:** `state.rs:38-41` uses `deadpool_redis::Config::from_url` with no `max_size`/timeouts. deadpool default `max_size` = cpu×2 with **no default timeout**, so `pool.get()` (`idempotency.rs:13`) can wait indefinitely under contention - another silent hold path. Set explicit `max_size` + `wait` timeout.
- **Outbound amplification:** `drand.rs:72-123` issues `/info` + a pulse per relay with sequential failover; `wait_for_round_verified` retries every 200ms up to 12s. N inbound rolls → many×N outbound requests to public drand relays. Beyond self-DoS this risks drand throttling the server's IP (fail-closed → all rolls 500, `roll.rs:277-281`), turning an inbound flood into total outage. Mitigate with a single-flight/shared cache for `/info` and `latest` (identical across concurrent rolls), a circuit breaker, and a cap on concurrent outbound drand calls.
- **Citation:** https://docs.rs/deadpool/latest/deadpool/managed/struct.PoolConfig.html

**Cross-cutting highest-leverage change:** a `ServiceBuilder` stack on POST `/v1/roll` - `LoadShedLayer` → `GlobalConcurrencyLimitLayer(N)` → `TimeoutLayer(~15s)` → `DefaultBodyLimit::max(small)`, atop the existing governor. This converts "accept everything, hold 6-20s, contend on 5 DB conns" into "admit N, shed the rest as 503 instantly, hard-cap each request lifetime."

---

## Theme C - Auth / exposure

| ID | Sev | Title |
|----|-----|-------|
| OPS-AUTH-01 | **HIGH** (conditional blocker) | Unauthenticated state-mutating signing endpoint (POST `/v1/roll`) |
| OPS-AUTH-02 | MEDIUM | Signing oracle over partially attacker-chosen content |
| OPS-AUTH-03 | LOW | Unauthenticated transcript/roll enumeration; `?idem_key` lookup |
| OPS-AUTH-04 | LOW | `GET /v1/verify/:id` is an unauthenticated S3-fetch amplifier |
| OPS-AUTH-05 | INFO | CORS `allow_origin(Any)` - correct as-is while credential-less |

No auth layer is wired in `router()` (`routes/mod.rs:18-72`); the only abuse control is the per-IP governor on POST `/v1/roll`.

**OPS-AUTH-01 - HIGH (conditional blocker).**
- **Mechanism:** an anonymous caller with a valid drand proof + 64-hex nonce + valid die/kappa triggers, per request: `db::insert_roll` (`roll.rs:375`), `insert_transcript_meta` (`:406`), `s3::put_transcript` (`:395`), `db::update_roll_receipt_json` (`:449`), and an Ed25519 signature (`signer.sign_receipt`, `:442-447`). Each success = unbounded monotonic DB-row growth + one S3 object + one signing op, with no per-caller quota, global cap, or auth to attribute/bill load. This is **OWASP API4:2023 Unrestricted Resource Consumption**. The per-IP limiter is not sufficient mitigation (OPS-RL-01): spoofed XFF defeats it entirely; even behind a correct proxy a botnet/cloud IP pool multiplies the 60-burst+1/s allowance with no global ceiling on rows or objects.
- **Fix:** put POST `/v1/roll` behind an API-key/token with per-key quota + budget, or a bot challenge (Turnstile/CAPTCHA) for a public tier; add a global concurrency/volume cap independent of per-IP keying; configure S3/MinIO + DB storage spending limits and billing alerts; document and enforce the trusted-proxy invariant.
- **Citation:** https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/

**OPS-AUTH-02 - MEDIUM.** The signed receipt includes attacker-supplied `die`, `kappa`, `client_nonce` plus `drbg_key_hex` and the full drand proof (`roll.rs:413/430`, `:416-447`). An unauthenticated caller can compel valid signatures over chosen `(die, kappa, nonce)` tuples at will (within rate limits). Not a fairness break today (kd-core guards + drand wait still bound outcomes), but it is a free anonymous signed-statement generator; if receipt semantics ever embed identity/claims, this becomes a forgery/impersonation vector. **Fix:** gate signing behind auth so signatures are attributable; never let the signed body carry a field a downstream consumer treats as an authenticated assertion without binding it to an authenticated principal; version receipts so semantics can't silently broaden.

**OPS-AUTH-03 - LOW.** All reads are unauthenticated and the GET arm of `/v1/roll` is explicitly excluded from the limiter (`methods=[POST]`; test `get_roll_is_never_rate_limited`, `mod.rs:177-196`). `:id` is a v4 UUID (`roll.rs:374`), so blind transcript enumeration is infeasible (122-bit). **However** `GET /v1/roll?idem_key=...` (`roll.rs:55-77`) looks up by the *client-supplied* idempotency key - if any caller uses guessable/sequential keys those rolls become enumerable+readable by anyone via an unthrottled oracle. Transcript fetch (`roll.rs:81-103`) also makes each read a server-side S3 GET (cost amplification). **Fix:** rate-limit GET routes; require high-entropy server-validated idem keys or don't expose lookup-by-idem-key unauthenticated; document transcript availability posture (currently public-by-UUID-capability).

**OPS-AUTH-04 - LOW.** `GET /v1/verify/:id` (`verify.rs:35-62`) does a DB lookup then an S3 GET then kd-core recompute - unauthenticated and unthrottled (`mod.rs:65-66`). `POST /v1/verify` (`verify.rs:70-94`) verifies a caller-supplied body and does **not** fetch S3 (so it is a pure-compute DoS surface only, no storage/cost side effect, no signing). **Fix:** rate-limit verify routes, especially the GET-by-id path that triggers a backend S3 GET; cap `POST /v1/verify` body size.

**OPS-AUTH-05 - INFO (adequate).** `allow_origin(Any)` (`main.rs:37-43`) is acceptable precisely because the API is credential-less (no auth, no cookies, no `Access-Control-Allow-Credentials`). Per MDN, the `*` wildcard is valid only for non-credentialed requests and is intended for public APIs. **Caveat:** if auth with credentials is ever added, replace `Any` with an explicit origin allowlist + `Vary: Origin`, or it becomes a cross-origin data-exposure bug. **Fix:** add a deploy-time test that fails if credentialed CORS is combined with `Any`.
- **Citation:** https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin

---

## Theme D - Key / secret management

| ID | Sev | Title |
|----|-----|-------|
| OPS-KEY-01 | **HIGH** | No key rotation / multi-kid verification (single hardcoded kid) |
| OPS-KEY-02 | **HIGH** | No revocation path; a leaked prod key = silent unbounded forgery |
| OPS-KEY-03 | MEDIUM | Signing seed in clear-text env/process memory; no KMS/HSM/zeroization |
| OPS-KEY-04 | LOW | `Config` derives `Debug` while holding the clear-text secret |
| OPS-KEY-05 | LOW/INFO | Unsigned-mode fallback if env vars absent (dev-only; prod-guarded) |

**Already solid (info, not findings):** the secret is never logged - signer log lines emit `kid` only (`state.rs:59/64`); SIG-2 error strings never interpolate seed bytes (test `sign.rs:263-266`); `from_hex_seed` reports only length/hex-validity (`sign.rs:94-99`). `.env.example` carries no real secret and not even a `KD_SIGNING_ED25519_SECRET` line; the published TEST seed appears only in `dev-up.ps1:95` / `scripts/README.md:73`, both annotated "TEST KEY - never production" (public-by-design for goldens, not a leak). The SIG-2 boot guard is correctly fail-closed: `EnvProfile::from_env_str` maps unset/dev/test → Dev and everything else incl. typos → Prod (`config.rs:21-28`); `cfg.validate()` runs first in `build_state` before any I/O (`state.rs:29`); the blocklist compares *decoded* bytes so hex-case/whitespace can't bypass (`sign.rs:38-49`).

**OPS-KEY-01 - HIGH.** No rotation path and no kid allow-list. `/.well-known` publishes exactly one key (`well_known.rs:15-22`, `keys: vec![entry]`); server-side verify trusts exactly one key (`verify.rs:115-119`); one signer from one `(secret,kid)` (`state.rs:56`). Rotating means swapping env + restarting, which instantly invalidates every previously-issued receipt (old kid no longer matches the single published key → INVALID) and removes the old key from well-known. Rotation is **destructive, not graceful**. **Fix (load-bearing):** support a *set* of signers - one ACTIVE signing kid + N retired verify-only keys; publish all at `/.well-known/truerolls-keys.json` (the wire shape is already `keys: Vec`; only the construction is hardcoded to one); make `verify_receipt` select the public key by the receipt's `sig.kid` so prior-kid receipts still verify VALID during overlap. Drive from config (e.g. `KD_SIGNING_KEYS`). **Citation:** OWASP Cryptographic Storage Cheat Sheet (rotation capability must exist before it is needed) - https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html

**OPS-KEY-02 - HIGH.** Ed25519 + JCS canonicalization means anyone holding the 32-byte seed can mint receipts that verify VALID under the published kid, indistinguishable from genuine ones. There is no revocation list, no verify-time kid blocklist (`TEST_KIDS` is a *boot-time* refusal, not a verify-time reject), no enforced timestamp/serial/expiry. A leaked prod seed makes every past and future receipt under that kid forgeable and indistinguishable - a P0-class unrecoverable event. **Fix:** build the multi-kid set (OPS-KEY-01) so a kid can be retired and rejected at verify time; add a verify-time kid allow/deny check in `kd_receipt::verify_receipt`; document a revocation runbook; consider a signed `created_at` (already in the roundtrip test body, `sign.rs:225`) + per-kid validity window so a revoked kid's receipts are time-bounded.

**OPS-KEY-03 - MEDIUM.** The seed is read from env (`config.rs:86`), stored as `signing_secret: Option<String>` on `Config` (`config.rs:46`), decoded into `SigningKey` at `state.rs:56-58`. OWASP advises against storing keys in environment variables (leak via `/proc/<pid>/environ`, crash dumps, child processes, container inspect). No KMS/HSM/envelope encryption. `zeroize` is present only **transitively** in `Cargo.lock` (ed25519/curve25519-dalek zero their internal types); the hex `String` secret is never zeroized, and because `Config` is `Clone` (`config.rs:31`) and cloned into `AppState.cfg` (`state.rs:76`), the raw seed persists in multiple heap locations indefinitely. **Fix:** prefer KMS/HSM signing or an envelope-encrypted seed; at minimum drop+zeroize the hex `String` after constructing `SigningKey` (add `zeroize` as a direct dep / `Zeroizing<String>`); do not keep `signing_secret` on the long-lived `Config`/`AppState`; prefer a secrets manager injected at boot. **Citations:** OWASP Cryptographic Storage + Secrets Management Cheat Sheets - https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html

**OPS-KEY-04 - LOW.** `#[derive(Clone, Debug)]` over `Config` (`config.rs:31`) whose `signing_secret`/`database_url`/`redis_url`/`rng_salt` are sensitive. No call site dumps `Config` today (so no current leak), but the derive removes the guardrail - any future `tracing::debug!(?cfg)`, `dbg!`, or panic printing `Config` dumps the raw seed and credentialed URLs. **Fix:** hand-write a redacting `Debug` for `Config` (or wrap secrets in a redacting newtype).

**OPS-KEY-05 - LOW/INFO (adequate).** If either signing env var is absent the signer is `None` and the server serves UNSIGNED receipts after a warn (`state.rs:62-67`); verify then checks against an empty key (soft-fail). SIG-2 (`config.rs:153-160`) rejects an absent signer under Prod, so a true prod boot cannot run unsigned. Residual risk only if `KD_ENV` is mis-set to a dev value in production - an operator mistake the fail-closed default already pushes toward Prod. Acceptable; noted for completeness.

---

## Theme E - Code-robustness sweep

| ID | Sev | Title |
|----|-----|-------|
| OPS-CODE-01 | **HIGH** | Internal error strings leak dependency/infra detail to clients (500 body = raw error) |
| OPS-CODE-02 | MEDIUM | `GET /v1/verify/:id` re-parses S3 transcript with 500 (not 404/502) and surfaces parse errors |
| OPS-CODE-03 | MEDIUM | `POST /v1/verify` materializes a 2 MB `Value` before the cheap die check; verify is unthrottled |
| OPS-CODE-04 | LOW | `expect()` in the request hot path |
| OPS-CODE-05 | LOW | `release_lock` disabled ⇒ failed roll holds idempotency lock for full TTL, returns 202 to retries |
| OPS-CODE-06 | LOW | `/healthz` unauthenticated, probes DB/Redis/S3 on every call |
| OPS-CODE-07 | INFO | Dedup tolerates a corrupt stored receipt by silently substituting `{}` |

**OPS-CODE-01 - HIGH.** `AppError::Internal(msg) => (500, msg)` (`error.rs:41`); the `From<sqlx::Error>`/`From<anyhow::Error>` impls capture `e.to_string()` (`error.rs:26-35`). The 500 body is the raw `Display` of the underlying error. Call sites: `roll.rs:281` (`drand latest fetch failed: {e}`), `roll.rs:295`, `roll.rs:96`/`verify.rs:52` (S3 fetch), `verify.rs:56` (parse), and every `.map_err(internal)?` on `db::*`/`s3::*`/`serde_json`. sqlx errors can include SQL fragments/column/constraint names; S3 errors include endpoint URLs and bucket names; drand errors include relay URLs and upstream status. A remote caller can deliberately trigger these (malformed transcript at `verify/:id`, or any dependency hiccup) to enumerate internal topology. **Fix:** in `IntoResponse for AppError`, return a generic body for `Internal` (e.g. `"internal error"` + correlation id) and `tracing::error!` the full detail server-side only.

**OPS-CODE-02 - MEDIUM.** `verify.rs:50-56`: a missing/truncated/non-JSON S3 object makes both `get_transcript` failure and `serde_json::from_slice` failure map to `internal(...)` → 500 with the raw error string. Miscategorizes an upstream failure as a server fault and (with OPS-CODE-01) reveals transcript structure. **Fix:** map S3-object-missing → 404, S3-unreachable → 502, parse failure → generic 500; log detail server-side.

**OPS-CODE-03 - MEDIUM.** `verify.rs:70-94` → `run_verification` (`verify.rs:159-287`). `probs: Vec<f64>` length is checked against the die (capped at 100, `verify.rs:188-195`), but the body is a `serde_json::Value` (`verify.rs:72`) fully materialized first, so a 2 MB deeply-nested/huge-array body is parsed and allocated before the cheap die check rejects it. Verify is **unrate-limited** (only POST `/v1/roll` is governed, `mod.rs:57-62`), so an attacker can sustain max-size parse load on every core for free. Bounded by the 2 MB cap, hence MEDIUM. **Fix:** apply rate limiting (or a cheaper limiter) to `/v1/verify`; lower `DefaultBodyLimit` for verify routes to a few KB; reject by `v`/die discriminator before fully materializing where possible.

**OPS-CODE-04 - LOW.** `roll.rs:368` `result.face.try_into().expect("face fits i32 (<= 100)")` and `services/rng.rs:56` `.expect("HKDF expand")`. Neither is remotely reachable today (face ≤ 100; HKDF expand of 32 bytes never fails), and a panic only drops the one task (tokio catches it). Flagged because they are `expect`s on the request path that would become live if the die set or OKM length changed. Note: `services/rng.rs` is **dead/legacy** (the shipping seed path is `kd_drand::derive_roll_seed`, `roll.rs:301`) - confirm and delete. **Fix:** convert remaining hot-path `expect`s to `?`/`internal(...)`.

**OPS-CODE-05 - LOW.** `release_lock` is `#[allow(dead_code)]` and never called (`idempotency.rs:27-39`); the lock is `SET NX EX idem_ttl_secs` (300s, `config.rs:132`) and never released on error paths (`roll.rs:209-274`). If a roll acquires the lock then fails (drand/DB/S3 error), no receipt row is written, so every same-key retry finds lock-held + no-row → polls ~10s then returns 202 "processing" - for up to 300s, though nothing is processing. A client reusing a key (the intended idempotency use) is locked out for 5 minutes after any transient failure. **Fix:** best-effort `release_lock` on the error paths, or shorten the lock TTL; document that 202 can mean "previous attempt failed and is still TTL-locked."

**OPS-CODE-06 - LOW.** `/healthz` (`health.rs:9-38`) runs a real `SELECT 1`, Redis `PING`, and S3 `head_bucket` per request with no rate limit (each check is `.is_ok()`-guarded → returns `"degraded"`, which is correct). One cheap GET → three backend round-trips = unauthenticated amplification. **Fix:** rate-limit or cache health results for a few seconds.

**OPS-CODE-07 - INFO.** `db.rs:66-71`: `receipt_json` `try_get(...).unwrap_or_else(|_| json!({}))`. On the dedup-hit path (`roll.rs:245-256`) a row whose `receipt_json` failed to decode yields an empty-object "receipt" with `deduplicated:true` + HTTP 200 - a successful-looking response containing no receipt. Integrity, not availability; hard to trigger remotely. **Fix:** treat a decode failure as `internal(...)` (500), not a silent empty success.

**Checked and found OK (no finding):** attacker-controlled drand hex (`client_observed_signature_hex`/`randomness_hex`) is length-checked via `decode_hex_exact(...)` in `verify_quicknet` (kd-drand `lib.rs:107,117,180`) - no unbounded alloc/index panic; `validate_target_round` uses `checked_add` (kd-drand `lib.rs:157`); `quicknet_wall_clock_frontier_round` has a pre-genesis guard; round/draw parsing uses `.parse::<u64>()` with error mapping (`verify.rs:182-185`); kappa/die validated before heavy work (`roll.rs:153-159`, `verify.rs:161-179`) and the `_ => unreachable!()` at `verify.rs:202` is guarded by the prior die check; all roll dependencies fail-closed (the thread-rng fallbacks in `rng_for_roll`/`compute_roll` are dead `#[allow(dead_code)]`, not wired into `post_roll`).

---

## Could not substantiate / load-bearing unknowns

- **Whether the real deployment (Fly/Cloudflare) strips client-supplied XFF at the edge.** This is the single load-bearing unknown for OPS-RL-01: if the edge strips/overwrites forwarding headers, the limiter is sound and OPS-RL-01 drops to LOW; if not, it is a live blocker. No deploy manifest was read for this.
- **S3/MinIO bucket ACLs (public vs private) and any object-count/size caps**, and DB/Redis storage limits - assumptions behind OPS-AUTH-01/03; `services/s3.rs`, `services/db.rs`, `state.rs` not read for ACLs.
- **Framework defaults inferred, not read from the lockfile:** axum default body limit (stated 2 MiB) and sqlx default `acquire_timeout` (stated 30s) - confirm against pinned versions.
- **`zeroize` is transitive-only** - confirm with `cargo tree -i zeroize`. The "no verify-time kid allow-list" claim is grounded in the single-key plumbing at `verify.rs:115-119`/`well_known.rs:19`; confirm there is no kid filtering inside `kd_receipt::verify_receipt`.
- Pool-exhaustion severity (OPS-DOS-02) is a code-grounded inference, not load-tested.

---

## Recommended remediation order

1. **Before any public deploy:** enforce the trusted-proxy invariant (OPS-RL-01/02) - `KD_TRUSTED_PROXY` config + peer-IP fallback fail-closed under Prod; add the edge `ServiceBuilder` stack (OPS-DOS-01/02/03): `LoadShed → ConcurrencyLimit(N) → Timeout(~15s) → DefaultBodyLimit(small)`; generic-ify internal error bodies (OPS-CODE-01).
2. **Before production trust:** add auth/quota to POST `/v1/roll` (OPS-AUTH-01) and the multi-kid rotation/revocation path (OPS-KEY-01/02); move the signing seed off plain env toward KMS/HSM + zeroize (OPS-KEY-03).
3. **Hardening:** rate-limit verify/health routes (OPS-AUTH-04, OPS-CODE-03/06), single-flight the drand `/info`/`latest` fetches (OPS-DOS-05), release idempotency locks on failure (OPS-CODE-05), redacting `Debug` for `Config` (OPS-KEY-04), delete dead `rng.rs` (OPS-CODE-04).
