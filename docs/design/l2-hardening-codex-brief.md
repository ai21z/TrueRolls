# L2 Hardening Bundle - Codex Implementation Brief (v2)

> **Provenance.** Implementation brief, 2026-06-28, for the operational-security "L2 hardening
> bundle" from [`../operational-security-audit.md`](../operational-security-audit.md) (OPS-RL-01/02,
> OPS-DOS-01/02/03). Design is code-grounded (file:line read from source) + version-cited research;
> NOT compiled. Items tagged `[VERIFY]` are research-derived API specifics Codex must confirm at
> build time (a wrong feature name / field name fails to resolve immediately). The router-scoping
> behaviour is confirmed against the axum 0.7 docs and is stated as fact, not `[VERIFY]`.
>
> v2 changes vs v1: (1) timeout returns **504 via the existing HandleErrorLayer** using
> `tower::timeout` instead of `tower-http`'s 408 (semantically correct + avoids 408 retry-storms);
> (2) **Retry-After** on 503/504; (3) **DB pool sized with the concurrency cap** (the connection is
> NOT held during the drand wait - the real point is max_inflight 32 vs a 5-conn pool); (4)
> **observability** (tracing on shed/timeout). The critique invitation is intact.

---

## Analysis (for the human)

Two holes gate a public deploy of `kd-api`:

1. **Rate-limit IP-key spoof** (`routes/mod.rs:36`). The governor on POST /v1/roll keys on
   `SmartIpKeyExtractor`, which trusts `X-Forwarded-For` and takes the leftmost (client-controlled)
   entry. Rotate the header per request -> unbounded distinct keys -> the per-IP limiter is fully
   bypassed.
2. **No per-request protective stack.** `post_roll` makes sequential drand relay fetches + a future-
   round wait + 4 DB/S3 writes; there is no concurrency ceiling, no whole-handler timeout, only the
   default 2 MB body limit. A flood of slow rolls saturates the worker pool and the 5-connection DB
   pool.

Target stack on POST /v1/roll only:

```
governor (existing) -> HandleError -> LoadShed -> GlobalConcurrencyLimit -> Timeout -> BodyLimit -> handler
```

Three decisions are load-bearing and easy to get wrong: (a) `HandleErrorLayer` is mandatory because
LoadShed/timeout make the sub-stack `Error = BoxError` and axum's `Router` requires `Infallible`;
(b) use `GlobalConcurrencyLimitLayer` (shared `Arc<Semaphore>`) not `ConcurrencyLimitLayer` (fresh
per-clone semaphore -> unbounded, since axum clones the service per request); (c) the timeout default
must be COMPUTED above the legitimate-roll worst case (~34 s from default drand config), not a 15 s
literal that kills honest rolls under relay degradation.

---

## CODEX IMPLEMENTATION PROMPT (self-contained, paste-ready)

```
You are implementing the "L2 hardening bundle" for the TrueRolls kd-api crate (Rust/Axum). This
prompt is self-contained; you have no memory of prior discussion. Verify every claimed file:line and
API signature against the actual code and docs.rs before relying on it - items marked [VERIFY] are
from research, not a compiler, so confirm them. You are explicitly invited to CRITIQUE AND IMPROVE
this plan: if a step is wrong/unsafe or there is a cleaner version-exact idiom, do the better thing
and note what you changed and why. Flag any version/API mismatch you hit; do not silently paper over
a conflict between this plan and the code - report it.

1. MISSION & SCOPE - ship two changes in crates/kd-api/ only:
  (A) TRUSTED-PROXY ENFORCEMENT for the rate-limit IP key. The governor on POST /v1/roll keys on
      SmartIpKeyExtractor, which trusts X-Forwarded-For/X-Real-IP/Forwarded and takes the LEFTMOST
      (client-controlled) XFF entry -> an attacker rotates X-Forwarded-For per request -> unbounded
      distinct keys -> the per-IP limiter is fully bypassed. Replace with a config-driven trust
      boundary defaulting to the unspoofable peer IP, failing closed in prod.
  (B) A per-request PROTECTIVE STACK on POST /v1/roll, atop the existing governor, effective order:
      governor -> HandleError -> LoadShed -> GlobalConcurrencyLimit -> Timeout -> BodyLimit -> handler.
  DO NOT TOUCH: kd-core (keep it pure) or any non-kd-api crate; the drand roll flow / client / relay
  timing; signing/verify/receipt/goldens/transcript format; the GET arm of /v1/roll and /healthz,
  /v1/drand/health, /v1/verify(:id), /v1/roll/:id(/transcript), /.well-known/* (must stay
  UNTHROTTLED); the existing governor's burst/period semantics and methods=[POST] filter; the
  router() and post_roll() signatures. The heavy stack applies to POST /v1/roll ONLY.

2. CURRENT-STATE FACTS (verify each [VERIFY] anchor) - paths under crates/kd-api/:
  routes/mod.rs: pub fn router(state: Arc<AppState>) -> Router ~18; imports tower_governor
   {GovernorLayer,GovernorConfigBuilder,SmartIpKeyExtractor} ~8-10; Method imported ~4; governor
   built ~31-39 (.per_second(cfg.roll_rl_period_secs).burst_size(cfg.roll_rl_burst)
   .methods(vec![Method::POST]).key_extractor(SmartIpKeyExtractor).finish(), Arc-wrapped);
   SmartIpKeyExtractor ~36 = the spoof bug; idle-bucket eviction spawn ~42-49 (leave as-is);
   let roll_governor = GovernorLayer{config:governor_conf} ~50-52; /v1/roll ~57-62:
   .route("/v1/roll", post(roll::post_roll).get(roll::get_roll_by_idem).layer(roll_governor)).
   Existing rate-limit unit tests ~74-197 spoof via x-forwarded-for (~111) and WILL need updating
   once the default extractor stops trusting XFF.
  CONFIRMED (axum 0.7 docs, MethodRouter::layer): ".layer()" applies ONLY to routes present at the
   time of the call - "routes added after layer is called will not have the middleware added." So
   `post(h).layer(heavy).get(h2).layer(governor)` wraps `heavy` around POST only (GET added after),
   and `governor` around both (added last; it self-filters to POST via methods=[POST]). This is the
   intended POST-only scoping - use exactly this shape. Do NOT use route_layer (it changes 405/404
   semantics and still won't retroactively wrap GET).
  main.rs: CORS ~37-40 (allow_origin(Any)) applied GLOBALLY ~43 (router(state).layer(cors)) - the
   heavy stack must NOT be global; serve ~54-56 into_make_service_with_connect_info::<SocketAddr>()
   -> peer IP available as ConnectInfo<SocketAddr> in extensions (prereq for peer-IP key);
   Config::from_env() ~34, build_state(&cfg) ~35 (validate() runs first).
  config.rs: AppError import ~3 [VERIFY]; EnvProfile ~9-29, from_env_str fails closed to Prod for
   unknown ~21-28, KD_ENV parsed ~90; Config struct ~31-65 (roll_rl_period_secs 53-54, roll_rl_burst
   55-56, drand_relays:Vec<String> 57-58, drand_timeout_ms:u64 59-60, drand_target_wait_ms:u64
   63-64); from_env ~67-147 (KD_ROLL_RL_PERIOD_SECS default 1 .max(1) ~91-95; KD_ROLL_RL_BURST
   default 60 .max(1) ~96-100; DRAND_RELAYS default 3 ~101-108; DRAND_TIMEOUT_MS default 2500
   .max(250) ~109-113; DRAND_TARGET_WAIT_MS default 12000 .max(1000) ~118-122); validate() ~153-165
   = SIG-2 fail-closed (if env_profile==Prod { reject_test_signer_in_prod(...) }; relays non-empty),
   no I/O, first line of build_state (state.rs:29) - the new prod proxy check goes INSIDE the Prod
   block. TWO fixtures build Config{...} field-by-field and WILL FAIL TO COMPILE on a new field:
   config.rs::cfg_with ~200-224 and state.rs::prod_test_seed_cfg ~94-118 - update BOTH.
  routes/roll.rs: post_roll ~135-465; signature (preserve): pub async fn post_roll(State(state):
   State<Arc<AppState>>, headers: HeaderMap, Json(req): Json<RollRequest>) -> Result<impl
   IntoResponse, AppError>. Json is the LAST extractor and consumes the body, so a body limit must
   wrap the service (DefaultBodyLimit sets the extension Json honors). The handler does NOT hold a DB
   connection across the drand wait: it waits for the future round (~277-295) and only then runs the
   4 DB/S3 writes (insert_roll ~375, put_transcript ~395, insert_transcript_meta ~406,
   update_roll_receipt_json ~449), each acquiring a pool connection per query.
  state.rs: PgPoolOptions max_connections(5) ~35.

3. Cargo.toml (crates/kd-api/Cargo.toml):
  - Promote tower from [dev-dependencies] (~52) to [dependencies], WITH the timeout feature:
      tower = { version = "0.5", features = ["util","limit","load-shed","timeout"] }   [VERIFY names]
  - tower-http stays features=["cors"] (~24). Do NOT add "timeout" - this plan uses tower::timeout
    (which yields a BoxError -> 504 via the HandleError you already need), NOT tower-http's 408.
  - axum needs no new feature (DefaultBodyLimit + HandleErrorLayer are core). edition = "2024".

4. CONFIG ADDITIONS (config.rs + the two fixtures):
  4A. enum TrustedProxy { Peer, Xff(u8), Cloudflare, Fly } with fail-closed from_env_str:
      unset/""/"none"/"peer"->Peer; "xff:<n>" (n>=1)->Xff(n); "cloudflare"/"cf"->Cloudflare; "fly"->Fly;
      unrecognized or "xff:0"->Err (refuse boot). fn ignores_xff(self)->bool = matches!(self,Peer).
  4B. New Config fields (struct + from_env):
      trusted_proxy: TrustedProxy = TrustedProxy::from_env_str(env::var("KD_TRUSTED_PROXY").ok()...)?;
      allow_peer_ip_in_prod: bool  = KD_ALLOW_PEER_IP truthy, default false;
      roll_max_inflight: usize     = KD_ROLL_MAX_INFLIGHT, default 32, .max(1);  // global permits
      db_max_connections: u32      = KD_DB_MAX_CONNECTIONS, default 5, .max(1);  // see note below
      roll_timeout_ms: u64         = KD_ROLL_TIMEOUT_MS, default = COMPUTED, .max(1000).
      COMPUTED default timeout (do NOT hardcode 15s - legit worst case is far above it). Derive from
      drand config so it tracks relay count and budgets:
        let computed = drand_target_wait_ms
          + (drand_relays.len() as u64)*2*drand_timeout_ms   // worst fetch_latest fan-out
          + 2*drand_timeout_ms                               // one trailing fetch in the wait loop
          + 2_000;                                           // DB/S3 write budget
        // with defaults: 12000 + 15000 + 5000 + 2000 = 34000 ms
        let roll_timeout_ms = env_u64("KD_ROLL_TIMEOUT_MS").unwrap_or(computed).max(1_000);
      Compute AFTER drand_relays/drand_timeout_ms/drand_target_wait_ms are parsed.
      Wire db_max_connections into state.rs PgPoolOptions::max_connections (replace the literal 5 at
      state.rs:35 with cfg.db_max_connections as u32). See constraint on sizing it vs roll_max_inflight.
  4C. validate() addition INSIDE the existing `if self.env_profile==EnvProfile::Prod {` block, after
      the SIG-2 call:
        if self.trusted_proxy.ignores_xff() && !self.allow_peer_ip_in_prod {
          return Err(internal("KD_TRUSTED_PROXY is unset/peer in prod. Set the real trust boundary \
            (peer | xff:<hops> | cloudflare | fly). To intentionally run peer-IP-keyed (internet-facing,
            no proxy) set KD_ALLOW_PEER_IP=1."));
        }
      Match the file's existing error constructor style. Dev skips this (like SIG-2).
  4D. Update config.rs::cfg_with (~200-224) and state.rs::prod_test_seed_cfg (~94-118) with the new
      fields, choosing values that keep existing tests' intent (e.g. trusted_proxy: Peer +
      allow_peer_ip_in_prod: true OR Xff(1) so a prod fixture still boots; db_max_connections: 5;
      roll_max_inflight: 32; roll_timeout_ms: any >=1000).

5. ROUTER CHANGES (routes/mod.rs):
  5A. One enum-dispatch KeyExtractor (avoids boxing the GovernorLayer):
      #[derive(Clone, Copy, Debug)]
      pub struct TrustedProxyKeyExtractor(pub crate::config::TrustedProxy);
      impl tower_governor::key_extractor::KeyExtractor for TrustedProxyKeyExtractor {
        type Key = std::net::IpAddr;
        // [VERIFY] tower_governor 0.4 gates name()/key_name() behind #[cfg(feature="tracing")]
        // (tracing is a DEFAULT feature) - implement both gated.
        #[cfg(feature="tracing")] fn name(&self)->&'static str { "TrustedProxyKeyExtractor" }
        fn extract<T>(&self, req:&axum::http::Request<T>) -> Result<Self::Key, tower_governor::GovernorError> {
          use crate::config::TrustedProxy::*;
          let headers = req.headers();
          let reject = || tower_governor::GovernorError::Other {
            code: axum::http::StatusCode::BAD_REQUEST, msg: Some("bad_proxy_headers".into()), headers: None };
          match self.0 {
            Peer => req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                       .map(|c| c.0.ip()).ok_or(tower_governor::GovernorError::UnableToExtractKey),
            Xff(n) => {
              // merge ALL x-forwarded-for header instances (attackers can split across headers),
              // split ',', trim, parse, take Nth-FROM-THE-RIGHT (the trusted-proxy-inserted hop).
              let name = axum::http::HeaderName::from_static("x-forwarded-for");
              let ips: Vec<std::net::IpAddr> = headers.get_all(&name).iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|s| s.split(',')).filter_map(|s| s.trim().parse().ok()).collect();
              let n = n as usize;
              if ips.len() < n { return Err(reject()); }
              Ok(ips[ips.len()-n])
            }
            Cloudflare => single_header_ip(headers,"cf-connecting-ip").ok_or_else(reject),
            Fly        => single_header_ip(headers,"fly-client-ip").ok_or_else(reject),
          }
        }
        #[cfg(feature="tracing")] fn key_name(&self, key:&Self::Key)->Option<String>{ Some(key.to_string()) }
      }
      fn single_header_ip(h:&axum::http::HeaderMap, name:&'static str)->Option<std::net::IpAddr>{
        h.get(name)?.to_str().ok()?.trim().parse().ok()
      }
      IMPORTANT: the reject paths return GovernorError::Other -> 400, NOT UnableToExtractKey (which
      tower_governor maps to 500, mislabeling a forged/short XFF as a server error).
      [VERIFY] KeyExtractor::extract signature, GovernorError::Other field names/types, and the
      cfg("tracing") gating against tower_governor 0.4 source.
  5B. Build the governor with .key_extractor(TrustedProxyKeyExtractor(state.cfg.trusted_proxy))
      (replaces SmartIpKeyExtractor ~36). One concrete type -> GovernorLayer type unchanged, no
      boxing. Keep methods=[POST], burst/period, and the idle-bucket eviction spawn as-is.
  5C. Heavy stack on the POST handler ONLY, with ONE error handler for both shed (503) and timeout (504):
      async fn handle_protective_error(err: tower::BoxError) -> axum::response::Response {
        use axum::response::IntoResponse;
        use axum::http::{StatusCode, HeaderValue, header::RETRY_AFTER};
        if err.is::<tower::load_shed::error::Overloaded>() {
          tracing::warn!(event="roll.shed");
          let mut r = (StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"error":"overloaded"}))).into_response();
          r.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static("1"));
          r
        } else if err.is::<tower::timeout::error::Elapsed>() {
          tracing::warn!(event="roll.timeout");
          let mut r = (StatusCode::GATEWAY_TIMEOUT,
            axum::Json(serde_json::json!({"error":"timeout"}))).into_response();
          r.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static("1"));
          r
        } else {
          tracing::error!(event="roll.protective_error", error=%err);
          (StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"error":"internal"}))).into_response()
        }
      }
      let heavy = tower::ServiceBuilder::new()
        .layer(axum::error_handling::HandleErrorLayer::new(handle_protective_error)) // BoxError -> Response
        .layer(tower::load_shed::LoadShedLayer::new())                                // shed 503 when no permit
        .layer(tower::limit::GlobalConcurrencyLimitLayer::new(state.cfg.roll_max_inflight)) // shared Arc<Semaphore>
        .layer(tower::timeout::TimeoutLayer::new(                                     // Elapsed(BoxError) -> 504
            std::time::Duration::from_millis(state.cfg.roll_timeout_ms)))
        .layer(axum::extract::DefaultBodyLimit::max(16*1024));                        // 413; confirm cap vs DTO
      Apply to POST only (relies on the CONFIRMED axum 0.7 MethodRouter::layer scoping above):
        .route("/v1/roll",
           post(roll::post_roll).layer(heavy).get(roll::get_roll_by_idem).layer(roll_governor))
      Net per-request order on POST: governor -> HandleError -> LoadShed -> GlobalConcurrencyLimit ->
      Timeout -> BodyLimit -> handler. GET gets the governor (which passes it through) but NOT heavy.
      [VERIFY] tower 0.5 paths: tower::limit::GlobalConcurrencyLimitLayer, tower::load_shed::LoadShedLayer
      + tower::load_shed::error::Overloaded, tower::timeout::TimeoutLayer + tower::timeout::error::Elapsed,
      tower::BoxError. Confirm the Elapsed/Overloaded downcasts work (both are boxed into BoxError and
      LoadShed passes inner errors through to HandleError).
      Pick the body cap from the real RollRequest size (die + kappa + 64-hex nonce + drand proof with
      two 96-hex sigs is well under 1 KB; 16 KB is ample headroom - do not set below a legit request).

6. CRITICAL CONSTRAINTS (MUST / MUST-NOT):
  MUST: timeout default COMPUTED from drand config (not a literal); legit roll worst case ~34s, a
        too-low ceiling kills honest rolls. Allow KD_ROLL_TIMEOUT_MS override.
  MUST: timeout return 504 Gateway Timeout (server-side), NOT 408 Request Timeout. 408 is
        semantically "client too slow to send" and is auto-retried by some clients/proxies, which
        AMPLIFIES load under saturation. Route it through the existing HandleErrorLayer.
  MUST: use GlobalConcurrencyLimitLayer (shared Arc<Semaphore>), NOT ConcurrencyLimitLayer (per-clone
        -> unbounded; axum clones the service per request). Load-bearing.
  MUST: LoadShed immediately OUTSIDE GlobalConcurrencyLimit (sheds 503 instead of queueing).
  MUST: include HandleErrorLayer (outermost) - LoadShed and tower::timeout make Error=BoxError and
        axum's Router requires Infallible; without it the router will NOT compile.
  MUST: apply the heavy stack to POST /v1/roll ONLY; GET and verify/health stay unthrottled and fast.
  MUST: fail closed under KD_ENV=prod when trusted_proxy ignores XFF and KD_ALLOW_PEER_IP unset.
  MUST: default trusted_proxy to Peer (unspoofable); in xff mode merge get_all and take Nth-from-RIGHT,
        reject(400) if the chain is shorter than N; never trust the leftmost entry.
  MUST: keep db_max_connections >= a sensible fraction of roll_max_inflight, OR document that the DB
        pool is the secondary limiter. Under saturation, up to roll_max_inflight rolls finish their
        drand wait together and contend for db_max_connections connections for their write phase
        (bounded by sqlx's acquire_timeout). With the defaults (32 inflight / 5 conns) the write phase
        serializes through 5; that is acceptable and bounded, but size the two together deliberately
        rather than by accident. (The connection is NOT held during the drand wait, so no change to
        acquisition timing is needed.)
  MUST-NOT: change the drand flow/client/relay timing; alter the governor's burst/period or
        methods=[POST]; throttle GET/healthz/verify/well-known; touch kd-core/signer/verifier/goldens;
        apply the heavy stack globally in main.rs.

7. ERROR-RESPONSE SHAPES (small JSON; match the existing AppError/error.rs/dto.rs field names [VERIFY]):
  429 {"error":"rate_limited",...} (governor; sets x-ratelimit-after)
  503 {"error":"overloaded"}        + Retry-After: 1   (LoadShed via HandleError; tracing::warn)
  504 {"error":"timeout"}           + Retry-After: 1   (tower::timeout via HandleError; tracing::warn)
  413 {"error":"payload_too_large"} (DefaultBodyLimit; bare 413 body acceptable)
  400 {"error":"bad_proxy_headers"} (custom extractor reject; NOT the default 500)
  STATUS CODES are mandatory. If matching the JSON envelope for 413 needs extra wrapping, a bare
  correct status is acceptable; the 503/504 JSON + Retry-After above ARE specified.

8. ACCEPTANCE + TESTS (mirror routes/mod.rs:74-197; tower::ServiceExt::oneshot; set ConnectInfo via
   request extensions + headers explicitly):
  (1) PEER MODE: spoofed x-forwarded-for:9.9.9.9 with peer 1.2.3.4 keys on 1.2.3.4, not 9.9.9.9.
  (2) XFF MODE (xff:1): "client, proxy" keys on the Nth-from-right; chain shorter than N -> 400 (not 500).
  (3) XFF multi-header: two x-forwarded-for headers merged before indexing.
  (4) CLOUDFLARE/FLY: keys on CF-Connecting-IP/Fly-Client-IP; missing header -> 400.
  (5) CONCURRENCY/LOAD-SHED: with roll_max_inflight=K saturated by K slow in-flight requests, the
      (K+1)th POST returns 503 (+Retry-After), not a hang.
  (6) TIMEOUT: a handler exceeding roll_timeout_ms returns 504 (+Retry-After) and releases its permit.
  (7) BODY LIMIT: oversized POST body -> 413.
  (8) GET/verify/health NOT subject to the heavy stack - fast under conditions that would shed a POST.
  (9) PROD FAIL-CLOSED: env_profile=Prod + trusted_proxy=Peer + KD_ALLOW_PEER_IP unset -> validate()
      Err; with KD_ALLOW_PEER_IP=1 OR trusted_proxy=Xff(1) -> Ok.
  (10) Update existing rate-limit tests for the new default extractor (drive via ConnectInfo peer IPs).

9. VERIFICATION (Windows PowerShell, no &&):
  cargo fmt --all --check
  cargo clippy -p kd-api --all-targets --all-features -- -D warnings
  cargo test -p kd-api
  Live curl (only if Postgres/Redis/MinIO + kd-api up on :8080; if not, say so - never fake success):
  spoofed-XFF POST shows peer-keying; oversized body -> 413; GET /v1/roll/<idem> stays cheap; rapid
  valid POSTs eventually 429; a normal roll still succeeds end-to-end and a golden verify still passes.

10. CRITIQUE INVITATION - before/while implementing, verify and report: the tower 0.5 feature names
   ("limit","load-shed","timeout") and the tower::limit::GlobalConcurrencyLimitLayer /
   tower::timeout::error::Elapsed / tower::load_shed::error::Overloaded paths; that LoadShed passes
   the inner Elapsed BoxError through to HandleError (so the 504 branch is reachable) and that the
   permit is released on timeout; tower_governor 0.4 KeyExtractor signature, the cfg("tracing")
   gating, and GovernorError::Other field names; whether the computed timeout is right (keep it ABOVE
   the legit worst case - do not regress to 15s); whether roll_max_inflight (32) / db_max_connections
   (5) are sensible for the deployment, and propose better defaults if you can justify them; a cleaner
   JSON-error idiom consistent with AppError. If you find a better, correct, version-exact approach,
   implement it and document the delta.
```
