# kd-api Operational Security Audit

> **Review snapshot, 2026-06-28; status updated through release hardening.** Findings are
> code-grounded and cross-referenced to external best practice. No production load test was run, so
> severities are triage, not measured capacity. Historical mechanisms are retained only where they
> explain a control that is now implemented. Current deployment requirements live in
> [public-demo-operations.md](how-to/public-demo-operations.md). Crypto and fairness boundaries live
> in [threat-model.md](threat-model.md).

**Scope:** Availability and operational posture of the TrueRolls `kd-api` HTTP server (Rust/Axum). All file:line references are in `crates/kd-api/src/...` unless noted. Severities are deliberately un-inflated; several items are confirmed adequate.

## Deploy-critical must-fix (before any public/internet-exposed deploy)

> **Status update through 2026-07-11 candidate hardening.** The original audit findings below are kept for
> traceability, but several deploy gates have since been implemented: trusted-proxy configuration is
> fail-closed in prod, POST `/v1/roll` has a bounded load-shed/concurrency/timeout/body-limit stack,
> the global mint cap is enforced before mint commit, and idempotency is durable in Postgres with
> ownership-safe Redis lock release, including best-effort cancellation cleanup. Internal 500 bodies
> are sanitized, and verify/read routes have lighter limits. Remaining public-deploy work includes
> operator policy plus the low residuals called out below. Phase 3 also adds status-aware multi-kid key publication,
> retired-key verification, and blunt revoked-kid invalidation. Time-scoped revocation still requires
> independent issuance evidence and remains future work.

1. **OPS-RL-01 - X-Forwarded-For trust boundary.** Hardened in code through explicit trusted-proxy modes and prod fail-closed checks. Production still must set the correct mode for the real edge.
2. **OPS-DOS-01/02/03 - Long roll work, concurrency, and body size.** Hardened for POST `/v1/roll` through load-shed, concurrency, timeout, and body-limit middleware. Production still must size the caps to the deployed DB/Redis/S3 budget.
3. **OPS-AUTH-01 - Unauthenticated state-mutating signing endpoint.** Partly bounded by the global mint cap and production uncapped boot guard. Still a product-policy risk until auth, bot challenge, partner keys, or billing quotas exist.
4. **OPS-KEY-01 / OPS-KEY-02 - Key lifecycle.** Multi-kid rotation and blunt revoked-kid invalidation are implemented. A leaked prod signing key is still an incident that can invalidate all receipts under that kid, because time-scoped revocation requires independent issuance evidence.

The first three originally shared one root cause: the system accepted expensive, unattributed work with weak admission control. The release-hardening line now bounds that work. It does not make anonymous public minting a mature production business control.

---

## Theme A - Rate-limit / proxy-trust boundary

| ID | Sev | Title |
|----|-----|-------|
| OPS-RL-01 | **HIGH** (blocker if no XFF-stripping edge) | Per-IP rate limit bypassable via spoofed `X-Forwarded-For` |
| OPS-RL-02 | MEDIUM | Default config ships the gap open; nothing forces a trusted-proxy posture |
| OPS-RL-03 | LOW/INFO | No defense-in-depth beyond IP |

**OPS-RL-01 - HIGH (conditional blocker, code-hardened).**
- **Historical mechanism (fixed):** the route previously used `SmartIpKeyExtractor`, which trusted
  caller-supplied forwarding headers. Current code selects peer, XFF hop-count, Cloudflare, or Fly
  extraction explicitly and tests spoofed and short-header cases.
- **Impact:** complete rate-limit bypass + resource-amplification DoS when not behind a proxy that overwrites forwarding headers.
- **Fix:** make the trust boundary explicit and fail-closed (see OPS-RL-02). When no trusted proxy is configured, swap `SmartIpKeyExtractor` → `PeerIpKeyExtractor` at `routes/mod.rs:36` (peer-IP only, XFF ignored). When a trusted proxy with known hop count N is configured, select the **Nth-from-right** XFF entry via a small custom `KeyExtractor`. At the edge (Fly/Cloudflare), strip client-supplied `X-Forwarded-For`/`X-Real-IP`/`Forwarded` and key on the provider's authoritative header (`CF-Connecting-IP` / `Fly-Client-IP`).
- **Citations:** docs.rs/tower_governor `SmartIpKeyExtractor` ("Only use this key extractor if you can ensure these headers are being set by a trusted provider"); https://adam-p.ca/blog/2022/03/x-forwarded-for/ ; https://owasp.org/www-community/pages/attacks/ip_spoofing_via_http_headers
- **Status after hardening:** code now supports explicit trusted-proxy modes and peer-IP fallback, and prod rejects unsafe peer mode unless explicitly allowed. The remaining release check is deployment configuration, not missing route code.

**OPS-RL-02 - MEDIUM (code-hardened).**
- **Historical mechanism (fixed):** trusted-proxy posture was once deployment convention only.
  Current `Config` parses explicit proxy modes and production refuses peer mode unless the operator
  deliberately enables direct peer-IP operation.
- **Status after hardening:** implemented as explicit trusted-proxy parsing plus prod guard tests.

**OPS-RL-03 - LOW/INFO.** The API remains anonymous. Per-IP rate limiting, bounded concurrency, and
the global mint cap are abuse controls, not authentication or partner attribution. Production must
configure the real proxy boundary and a finite shared budget.

---

## Theme B - DDoS / resource exhaustion

| ID | Sev | Title |
|----|-----|-------|
| OPS-DOS-01 | **HIGH** (code-hardened) | Whole-handler timeout required for each long POST |
| OPS-DOS-02 | **HIGH** (code-hardened) | Explicit concurrency cap required before DB/S3/drand work |
| OPS-DOS-03 | MEDIUM (code-hardened) | Explicit request body-size limit required on POST `/v1/roll` |
| OPS-DOS-04 | MEDIUM | Idempotency key churn + dedup busy-poll ties up tasks/connections |
| OPS-DOS-05 | LOW-MED | Redis pool unbounded by default; outbound drand fan-out is an amplifier |

The original protective chain was only `GovernorLayer` on POST `/v1/roll` and global CORS. Release hardening has since added the intended bounded stack for POST `/v1/roll`: load shedding, global in-flight limiting, whole-handler timeout, and an explicit small body limit. The original mechanism notes below explain why those layers exist.

**OPS-DOS-01 - HIGH.**
- **Historical mechanism (fixed):** every accepted roll waits for a future drand round and can spend
  several seconds on relay work. Before L2 hardening, only the per-step drand timeouts bounded that
  work; no whole-handler deadline bounded their sum.
- **Impact:** without admission control, cheap inbound requests could hold many tasks and amplify
  outbound relay traffic.
- **Implemented control:** POST `/v1/roll` is now wrapped by load shedding, a global in-flight limit,
  a whole-handler timeout, and an explicit body cap. The default whole-roll timeout is derived from
  the configured drand wait and relay budget; timeout returns sanitized 504.
- **Citation:** https://github.com/tokio-rs/axum/discussions/242 (load-shed so requests "are dropped quickly and don't keep piling up").
- **Status after hardening:** implemented. Tests cover timeout status, permit release, and load shedding.

**OPS-DOS-02 - HIGH.**
- **Historical mechanism (fixed):** the handler previously had no global concurrency limit and the
  Postgres pool defaulted to five connections, so admitted work could greatly exceed downstream
  capacity.
- **Impact:** that design could exhaust the shared pool and delay health/read traffic.
- **Implemented control:** `KD_ROLL_MAX_INFLIGHT` bounds POST roll work before the handler and
  `KD_DB_MAX_CONNECTIONS` makes pool sizing explicit. Operators must size both against the actual
  DB, Redis, S3, and relay budget; no production capacity number is claimed without load evidence.
- **Citation:** https://docs.rs/tower/latest/tower/limit/index.html
- **Status after hardening:** implemented as an explicit global in-flight cap for POST `/v1/roll`; `KD_DB_MAX_CONNECTIONS` is configurable so the pool can be sized with the admission cap.

**OPS-DOS-03 - MEDIUM (code-hardened).** `roll.rs:139` originally extracted `Json(req): Json<RollRequest>` with only Axum's implicit default body cap. Release hardening added an explicit small body limit to POST `/v1/roll`; route tests cover the cap and confirm GET routes remain unwrapped.

**OPS-DOS-04 - MEDIUM.**
- **Mechanism (Redis churn):** if no idempotency key is supplied the server mints one (`Uuid::new_v4()`, `roll.rs:191`) and writes `idem:roll:{key}` via SET NX EX (`idempotency.rs:14-24`, TTL 300s, `config.rs:132`). Attackers can also supply unbounded distinct keys. TTL caps total growth to ~roll-rate × 300s - a cost/load concern, not unbounded (hence MEDIUM).
- **Mechanism (busy-poll):** on a lock-held dedup, the task polls Postgres up to
  `idem_poll_max * idem_poll_ms`, acquiring from the configurable shared DB pool on each poll.
  Same-key request swarms can therefore consume part of the bounded roll budget and increase DB
  traffic.
- **Residual hardening:** the poll path is now inside the global roll concurrency cap. Redis pub/sub
  or a single delayed DB read would reduce amplification further; production monitoring must verify
  that the configured poll, pool, and in-flight values fit together.

**OPS-DOS-05 - LOW-MEDIUM.**
- **Redis:** `state.rs` builds the pool from its default configuration without an explicit application
  `max_size` or wait timeout. A contended `pool.get()` therefore has no TrueRolls-specific bounded-wait
  contract. Set and test explicit pool sizing and wait limits for the deployment budget.
- **Outbound amplification:** `drand.rs:72-123` issues `/info` + a pulse per relay with sequential failover; `wait_for_round_verified` retries every 200ms up to 12s. N inbound rolls → many×N outbound requests to public drand relays. Beyond self-DoS this risks drand throttling the server's IP (fail-closed → all rolls 500, `roll.rs:277-281`), turning an inbound flood into total outage. Mitigate with a single-flight/shared cache for `/info` and `latest` (identical across concurrent rolls), a circuit breaker, and a cap on concurrent outbound drand calls.
- **Citation:** https://docs.rs/deadpool/latest/deadpool/managed/struct.PoolConfig.html

**Cross-cutting highest-leverage change:** implemented for POST `/v1/roll`. The remaining production work is choosing the actual cap values and monitoring whether they fit the deployed DB/Redis/S3 budget.

---

## Theme C - Auth / exposure

| ID | Sev | Title |
|----|-----|-------|
| OPS-AUTH-01 | **HIGH** (conditional blocker) | Unauthenticated state-mutating signing endpoint (POST `/v1/roll`) |
| OPS-AUTH-02 | MEDIUM | Signing oracle over partially attacker-chosen content |
| OPS-AUTH-03 | LOW | Unauthenticated transcript/roll enumeration; `?idem_key` lookup |
| OPS-AUTH-04 | LOW | `GET /v1/verify/:id` is an unauthenticated S3-fetch amplifier |
| OPS-AUTH-05 | INFO | CORS `allow_origin(Any)` - correct as-is while credential-less |

No auth layer is wired in `router()` (`routes/mod.rs:18-72`). Current abuse controls are the per-IP
governor on POST `/v1/roll`, the L2 global mint cap, and the bounded in-flight/timeout stack.

**OPS-AUTH-01 - HIGH (conditional blocker).**
- **Status after hardening:** the anonymous endpoint still exists, but the original "no global cap" claim is no longer current. POST `/v1/roll` now has a global fixed-window mint cap (`quota::reserve_mint`), a bounded in-flight/timeout/body-limit stack, and production boot refuses an uncapped roll endpoint unless explicitly opted out. The remaining risk is product-policy and attribution: without auth, API keys, or a bot challenge, a caller can still spend the public mint budget anonymously until the cap is reached.
- **Current mechanism:** a successful request produces one signed receipt, one Postgres row, one transcript object, Redis state, and drand relay work. This is still **OWASP API4:2023 Unrestricted Resource Consumption** if the public cap is set too high or explicitly disabled. Per-IP limiting alone is not sufficient mitigation; the L2 global cap is the release hardening layer that bounds total volume.
- **Remaining fix:** choose a production `KD_ROLL_GLOBAL_CAP` sized to budget, keep the trusted-proxy invariant enforced, add partner/API-key quotas or a bot challenge for higher public volume, and configure S3/DB billing alerts.
- **Citation:** https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/

**OPS-AUTH-02 - MEDIUM.** The signed receipt includes attacker-supplied `die`, `kappa`, `client_nonce` plus `drbg_key_hex` and the full drand proof (`roll.rs:413/430`, `:416-447`). An unauthenticated caller can compel valid signatures over chosen `(die, kappa, nonce)` tuples at will (within rate limits). Not a fairness break today (kd-core guards + drand wait still bound outcomes), but it is a free anonymous signed-statement generator; if receipt semantics ever embed identity/claims, this becomes a forgery/impersonation vector. **Fix:** gate signing behind auth so signatures are attributable; never let the signed body carry a field a downstream consumer treats as an authenticated assertion without binding it to an authenticated principal; version receipts so semantics can't silently broaden.

**OPS-AUTH-03 - LOW.** All reads are unauthenticated and the GET arm of `/v1/roll` is explicitly excluded from the limiter (`methods=[POST]`; test `get_roll_is_never_rate_limited`, `mod.rs:177-196`). `:id` is a v4 UUID (`roll.rs:374`), so blind transcript enumeration is infeasible (122-bit). **However** `GET /v1/roll?idem_key=...` (`roll.rs:55-77`) looks up by the *client-supplied* idempotency key - if any caller uses guessable/sequential keys those rolls become enumerable+readable by anyone. Transcript fetch (`roll.rs:81-103`) also makes each read a server-side S3 GET (cost amplification). **Release-hardening status:** transcript and verify reads now have lightweight throttles; `GET /v1/roll?idem_key=...` remains public and must use high-entropy keys or be treated as a capability URL. **Fix still open:** require high-entropy server-validated idem keys or don't expose lookup-by-idem-key unauthenticated; document transcript availability posture (currently public-by-UUID-capability).

**OPS-AUTH-04 - LOW.** `GET /v1/verify/:id` (`verify.rs:35-62`) does a DB lookup then an S3 GET then kd-core recompute. `POST /v1/verify` (`verify.rs:70-94`) verifies a caller-supplied body and does **not** fetch S3 (so it is a pure-compute DoS surface only, no storage/cost side effect, no signing). **Release-hardening status:** verify routes now have lightweight per-IP throttles and `POST /v1/verify` has a smaller body cap. **Residual:** this is still unauthenticated abuse control, not access control.

**OPS-AUTH-05 - INFO (adequate).** `allow_origin(Any)` (`main.rs:37-43`) is acceptable precisely because the API is credential-less (no auth, no cookies, no `Access-Control-Allow-Credentials`). Per MDN, the `*` wildcard is valid only for non-credentialed requests and is intended for public APIs. **Caveat:** if auth with credentials is ever added, replace `Any` with an explicit origin allowlist + `Vary: Origin`, or it becomes a cross-origin data-exposure bug. **Fix:** add a deploy-time test that fails if credentialed CORS is combined with `Any`.
- **Citation:** https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin

---

## Theme D - Key / secret management

| ID | Sev | Title |
|----|-----|-------|
| OPS-KEY-01 | **HIGH** (implemented) | Multi-kid verification and retired-key rotation |
| OPS-KEY-02 | **HIGH** (partly implemented) | Blunt revoked-kid invalidation; no time-scoped revocation without issuance evidence |
| OPS-KEY-03 | MEDIUM | Signing seed in clear-text env/process memory; no KMS/HSM/zeroization |
| OPS-KEY-04 | LOW | `Config` derives `Debug` while holding the clear-text secret |
| OPS-KEY-05 | LOW/INFO | Unsigned-mode fallback if env vars absent (dev-only; prod-guarded) |

**Already solid (info, not findings):** the secret is never logged - signer log lines emit `kid` only; SIG-2 error strings never interpolate seed bytes; `from_hex_seed` reports only length/hex-validity. `.env.example` carries no real secret and not even a `KD_SIGNING_ED25519_SECRET` line. The published TEST seeds and kids (`test-kid-1`, `test-kid-2`) are public-by-design for dev, goldens, and rotation fixtures, not leaks. The SIG-2 boot guard is correctly fail-closed: `EnvProfile::from_env_str` maps unset/dev/test to Dev and everything else including typos to Prod; `cfg.validate()` runs first in `build_state` before any I/O; the blocklist compares decoded bytes so hex case and whitespace cannot bypass it.

**OPS-KEY-01 - HIGH (implemented).** Phase 3 implements a key set with `active`, `retired`, and `revoked` statuses, publishes all configured public keys at `/.well-known/truerolls-keys.json`, and makes the shared verifier select by `receipt.sig.kid`. Exactly one active key signs new receipts. Retired uncompromised keys verify historical receipts. Removing an uncompromised retired key is still history deletion, not rotation. **Residual:** production still needs an operator runbook, real key custody, and deployment evidence. **Citation:** OWASP Cryptographic Storage Cheat Sheet (rotation capability must exist before it is needed) - https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html

**OPS-KEY-02 - HIGH (partly implemented).** Ed25519 + JCS canonicalization still means anyone holding a production seed can mint receipts under that kid. Phase 3 adds a verify-time `revoked` status, but it is deliberately blunt: every receipt under that kid becomes INVALID, honest ones included. The system still cannot distinguish a receipt that existed before compromise from one forged after compromise, because drand target rounds are seed provenance, not signing timestamps. Time-scoped revocation requires independent issuance evidence such as RFC 3161 timestamping, a witnessed transparency-log inclusion checkpoint, an on-chain anchor, or equivalent proof over the receipt hash.

**OPS-KEY-03 - MEDIUM.** The seed is read from env (`config.rs:86`), stored as `signing_secret: Option<String>` on `Config` (`config.rs:46`), decoded into `SigningKey` at `state.rs:56-58`. OWASP advises against storing keys in environment variables (leak via `/proc/<pid>/environ`, crash dumps, child processes, container inspect). No KMS/HSM/envelope encryption. `zeroize` is present only **transitively** in `Cargo.lock` (ed25519/curve25519-dalek zero their internal types); the hex `String` secret is never zeroized, and because `Config` is `Clone` (`config.rs:31`) and cloned into `AppState.cfg` (`state.rs:76`), the raw seed persists in multiple heap locations indefinitely. **Fix:** prefer KMS/HSM signing or an envelope-encrypted seed; at minimum drop+zeroize the hex `String` after constructing `SigningKey` (add `zeroize` as a direct dep / `Zeroizing<String>`); do not keep `signing_secret` on the long-lived `Config`/`AppState`; prefer a secrets manager injected at boot. **Citations:** OWASP Cryptographic Storage + Secrets Management Cheat Sheets - https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html

**OPS-KEY-04 - LOW.** `#[derive(Clone, Debug)]` over `Config` (`config.rs:31`) whose `signing_secret`/`database_url`/`redis_url`/`rng_salt` are sensitive. No call site dumps `Config` today (so no current leak), but the derive removes the guardrail - any future `tracing::debug!(?cfg)`, `dbg!`, or panic printing `Config` dumps the raw seed and credentialed URLs. **Fix:** hand-write a redacting `Debug` for `Config` (or wrap secrets in a redacting newtype).

**OPS-KEY-05 - LOW/INFO (adequate).** If either signing env var is absent the signer is `None` and the server serves UNSIGNED receipts after a warn (`state.rs:62-67`); verify then checks against an empty key (soft-fail). SIG-2 (`config.rs:153-160`) rejects an absent signer under Prod, so a true prod boot cannot run unsigned. Residual risk only if `KD_ENV` is mis-set to a dev value in production - an operator mistake the fail-closed default already pushes toward Prod. Acceptable; noted for completeness.

---

## Theme E - Code-robustness sweep

| ID | Sev | Title |
|----|-----|-------|
| OPS-CODE-01 | **HIGH** (fixed) | Internal error strings previously leaked dependency detail |
| OPS-CODE-02 | MEDIUM | `GET /v1/verify/:id` collapses missing/unreachable/malformed S3 transcripts to a sanitized 500 |
| OPS-CODE-03 | MEDIUM (code-hardened) | Verify JSON is materialized, now behind a smaller body cap and throttle |
| OPS-CODE-04 | LOW (fixed) | Request-path face conversion and dead local-RNG wrappers |
| OPS-CODE-05 | LOW (fixed) | Failed/cancelled rolls previously held idempotency locks until TTL |
| OPS-CODE-06 | LOW | Public health probes are unthrottled and touch dependencies/network |
| OPS-CODE-07 | INFO (fixed) | Dedup previously tolerated a corrupt stored receipt by substituting `{}` |

**OPS-CODE-01 - HIGH.** Historical finding: `AppError::Internal(msg) => (500, msg)` exposed raw internal error strings. **Release-hardening status:** `IntoResponse for AppError::Internal` now logs the detail server-side and returns sanitized JSON `{ "error": "internal" }`.

**OPS-CODE-02 - MEDIUM.** A missing, unreachable, truncated, or non-JSON S3 transcript maps to
`internal(...)`. The public body is now sanitized by OPS-CODE-01, so transcript or dependency detail
does not leak. The remaining issue is coarse failure classification: map object-missing to 404,
dependency-unreachable to 502, and parse failure to a generic 500 while logging detail server-side.

**OPS-CODE-03 - MEDIUM (code-hardened).** `POST /v1/verify` still materializes a
`serde_json::Value` before semantic validation. It is now bounded by a 64 KiB route body limit and a
dedicated lightweight per-IP throttle. A streaming/discriminator-first parser would reduce the
remaining allocation cost but is no longer a deploy blocker at the current cap.

**OPS-CODE-04 - LOW (fixed).** The request-path face conversion now returns a sanitized internal
error rather than panicking. The unused API-local wrappers around `rand::rng()` were removed, along
with kd-api's direct `rand` dependency. The live seed and sampling path remains verified drand plus
ChaCha20 only; no server-local RNG fallback remains in kd-api.

**OPS-CODE-05 - LOW (fixed for the roll mint path).** `release_lock` is now ownership-token based and
uses compare-and-delete Lua. `post_roll` releases the owned lock on cap rejection and other pre-mint
failures, while keeping the lock on successful mints. An armed Drop guard schedules the same
owner-checked cleanup when Tower timeout or task cancellation drops the handler. Redis is now only the concurrency fence:
Postgres is checked before and after lock acquisition, and the final insert uses `ON CONFLICT
(idempotency_key) DO NOTHING` with a fallback select. Same key plus same body returns the stored
receipt after Redis TTL expiry; same key plus different body returns 409. Residual: a process that
dies mid-flight can still leave a Redis lock until TTL, but the durable DB check prevents a completed
receipt from being re-minted after Redis loss.

**OPS-CODE-06 - LOW.** `/healthz` runs a real database query, Redis `PING`, and S3 bucket check per
request with no application rate limit. `/v1/drand/health` also remains public and performs drand
relay/network verification. These are unauthenticated amplification surfaces. Bound them at the
deployment edge and consider a short cache or dedicated low-rate application policy.

**OPS-CODE-07 - INFO (fixed).** Idempotency-row decoding now propagates a malformed `receipt_json`
as an internal error. It no longer substitutes `{}` or returns a successful-looking empty receipt.

**Checked and found OK (no finding):** attacker-controlled drand hex is exact-length decoded before
BLS verification; target-round arithmetic uses checked addition; the wall-clock frontier has a
pre-genesis guard; round/draw parsing maps errors; kappa and die are validated before heavy work;
and all roll dependencies fail closed. The API's unused server-local RNG wrappers have been removed.

---

## Could not substantiate / load-bearing unknowns

- **Whether the real deployment (Fly/Cloudflare) strips client-supplied XFF at the edge.** This is the single load-bearing unknown for OPS-RL-01: if the edge strips/overwrites forwarding headers, the limiter is sound and OPS-RL-01 drops to LOW; if not, it is a live blocker. No deploy manifest was read for this.
- **S3/MinIO bucket ACLs (public vs private) and any object-count/size caps**, and DB/Redis storage limits - assumptions behind OPS-AUTH-01/03; `services/s3.rs`, `services/db.rs`, `state.rs` not read for ACLs.
- **Pool wait behavior:** Postgres connection count is explicit, but acquire-timeout behavior is not
  configured separately. Confirm it against the locked SQLx version before publishing capacity or
  latency claims.
- **`zeroize` is transitive-only** - confirm with `cargo tree --locked -i zeroize`. The old single-key plumbing has been replaced by key-set verification, but production key custody and zeroization remain separate work.
- Pool-exhaustion severity (OPS-DOS-02) is a code-grounded inference, not load-tested.

---

## Recommended remediation order

1. **Before a public demo:** choose and test the real trusted-proxy mode, finite mint cap, DB/in-flight
   sizing, timeout, CORS, storage posture, and alerts from the public-demo operations runbook.
2. **Before production trust:** add auth/partner quotas, exercise multi-kid rotation with real key
   custody, and move the signing seed from plain environment storage toward KMS/HSM-backed custody.
3. **Further hardening:** bound Redis pool waits, single-flight shared drand fetches, cache or throttle
   health checks, reduce idempotency polling, and classify upstream transcript failures precisely.
