use crate::state::AppState;
use axum::{
    Router,
    http::Method,
    routing::{get, post},
};
use std::sync::Arc;
use tower_governor::{
    GovernorLayer, governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor,
};

mod drand;
mod health;
mod roll;
pub mod verify;
mod well_known;

pub fn router(state: Arc<AppState>) -> Router {
    // KD-036: per-IP rate limit, scoped to **POST /v1/roll only** (the unauthenticated,
    // key-signing, DB+S3-writing endpoint). The config's `methods=[POST]` filter passes
    // everything else through, so GET /v1/roll and all verify/read routes are unaffected.
    //
    // SmartIpKeyExtractor reads X-Forwarded-For / X-Real-IP / Forwarded (set by Fly /
    // Cloudflare), falling back to the peer IP. It must therefore run **behind a trusted
    // proxy** in production - a direct client could spoof X-Forwarded-For. The peer-IP
    // fallback needs ConnectInfo, which `main.rs` wires via
    // `into_make_service_with_connect_info`. Limits are config-driven (KD_ROLL_RL_*).
    //
    // On 429 the layer sets `x-ratelimit-after` (seconds) - tower_governor's header, not
    // `Retry-After`.
    let governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(state.cfg.roll_rl_period_secs)
            .burst_size(state.cfg.roll_rl_burst)
            .methods(vec![Method::POST])
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("rate-limit config: period and burst are non-zero (Config clamps both >= 1)"),
    );
    // Evict idle IP buckets periodically so the limiter map stays bounded. Runs on the
    // ambient Tokio runtime (router() is called from the async main).
    let limiter = governor_conf.limiter().clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
        loop {
            tick.tick().await;
            limiter.retain_recent();
        }
    });
    let roll_governor = GovernorLayer {
        config: governor_conf,
    };

    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/v1/drand/health", get(drand::drand_healthz))
        .route(
            "/v1/roll",
            post(roll::post_roll)
                .get(roll::get_roll_by_idem)
                .layer(roll_governor), // limits POST only (methods=[POST]); GET passes through
        )
        .route("/v1/roll/:id", get(roll::get_roll_by_id))
        .route("/v1/roll/:id/transcript", get(roll::get_transcript_by_id))
        .route("/v1/verify", post(verify::post_verify))
        .route("/v1/verify/:id", get(verify::get_verify_by_id))
        .route(
            "/.well-known/truerolls-keys.json",
            get(well_known::get_keys),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::routing::post;
    use std::sync::Arc;
    use tower::ServiceExt; // for `oneshot`
    use tower_governor::{
        GovernorLayer, governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor,
    };

    // A /v1/roll route limited exactly like the real router (methods=[POST],
    // SmartIpKeyExtractor), but with a tiny burst so the cap is hit immediately.
    // per_second(60) ⇒ ~no replenish within a millisecond-scale test, so burst is the cap.
    fn limited_app(burst: u32) -> Router {
        let conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(60)
                .burst_size(burst)
                .methods(vec![Method::POST])
                .key_extractor(SmartIpKeyExtractor)
                .finish()
                .unwrap(),
        );
        Router::new()
            .route(
                "/v1/roll",
                post(|| async { StatusCode::OK }).get(|| async { StatusCode::OK }),
            )
            .layer(GovernorLayer { config: conf })
    }

    fn post_from(ip: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/roll")
            .header("x-forwarded-for", ip)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn post_roll_rate_limited_after_burst() {
        let app = limited_app(2);
        // burst 2 ⇒ first two OK, third 429 (no replenish within the test window).
        assert_eq!(
            app.clone()
                .oneshot(post_from("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(post_from("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(post_from("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn distinct_ips_have_independent_buckets() {
        let app = limited_app(1);
        assert_eq!(
            app.clone()
                .oneshot(post_from("1.1.1.1"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // A different IP is independent - its first request still passes.
        assert_eq!(
            app.clone()
                .oneshot(post_from("2.2.2.2"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // The first IP again, over its burst of 1 ⇒ 429.
        assert_eq!(
            app.clone()
                .oneshot(post_from("1.1.1.1"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn get_roll_is_never_rate_limited() {
        let app = limited_app(1);
        let get = || {
            Request::builder()
                .method("GET")
                .uri("/v1/roll")
                .header("x-forwarded-for", "5.5.5.5")
                .body(Body::empty())
                .unwrap()
        };
        // methods=[POST] ⇒ GET passes through unthrottled even past the burst.
        for _ in 0..5 {
            assert_eq!(
                app.clone().oneshot(get()).await.unwrap().status(),
                StatusCode::OK,
                "GET /v1/roll must never be rate-limited"
            );
        }
    }
}
