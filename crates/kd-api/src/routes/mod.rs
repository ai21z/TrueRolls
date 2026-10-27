use crate::{config::TrustedProxy, state::AppState};
use axum::{
    Json, Router,
    error_handling::HandleErrorLayer,
    extract::{ConnectInfo, DefaultBodyLimit},
    http::{
        HeaderMap, Method, StatusCode,
        header::{HeaderName, HeaderValue, RETRY_AFTER},
    },
    response::{IntoResponse, Response},
    routing::{MethodRouter, get, post},
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tower::{BoxError, ServiceBuilder};
use tower_governor::{
    GovernorError, GovernorLayer, governor::GovernorConfigBuilder, key_extractor::KeyExtractor,
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
    // TrustedProxyKeyExtractor is fail-closed: peer IP by default, or an explicit trusted
    // proxy/header mode configured by KD_TRUSTED_PROXY. ConnectInfo is provided by main.rs via
    // into_make_service_with_connect_info.
    //
    // On 429 the layer sets `x-ratelimit-after` (seconds), tower_governor's header, not
    // `Retry-After`.
    // Build a per-IP rate limiter AND spawn its idle-bucket evictor together, so a
    // limiter can never be added without the reaper that keeps its map bounded.
    // A macro (not a fn) sidesteps naming tower_governor's opaque layer type. Runs
    // on the ambient Tokio runtime (router() is called from async main).
    macro_rules! governor {
        ($method:expr, $burst:expr) => {{
            let conf = Arc::new(
                GovernorConfigBuilder::default()
                    .per_second(state.cfg.roll_rl_period_secs)
                    .burst_size($burst)
                    .methods(vec![$method])
                    .key_extractor(TrustedProxyKeyExtractor(state.cfg.trusted_proxy))
                    .finish()
                    .expect(
                        "rate-limit config: period and burst are non-zero (Config clamps both >= 1)",
                    ),
            );
            let limiter = conf.limiter().clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
                loop {
                    tick.tick().await;
                    limiter.retain_recent();
                }
            });
            GovernorLayer { config: conf }
        }};
    }

    let roll_governor = governor!(Method::POST, state.cfg.roll_rl_burst);
    let verify_post_governor = governor!(
        Method::POST,
        state.cfg.roll_rl_burst.saturating_mul(2).max(1)
    );
    let read_governor = governor!(
        Method::GET,
        state.cfg.roll_rl_burst.saturating_mul(4).max(1)
    );

    Router::new()
        .route("/livez", get(health::livez))
        .route("/healthz", get(health::healthz))
        .route("/v1/drand/health", get(drand::drand_healthz))
        .route(
            "/v1/roll",
            protect_roll_post(
                post(roll::post_roll),
                state.cfg.roll_max_inflight,
                Duration::from_millis(state.cfg.roll_timeout_ms),
                16 * 1024,
            )
            .get(roll::get_roll_by_idem)
            .layer(roll_governor), // limits POST only (methods=[POST]), GET passes through
        )
        .route(
            "/v1/roll/:id",
            get(roll::get_roll_by_id).layer::<_, std::convert::Infallible>(read_governor.clone()),
        )
        .route(
            "/v1/roll/:id/transcript",
            get(roll::get_transcript_by_id)
                .layer::<_, std::convert::Infallible>(read_governor.clone()),
        )
        .route(
            "/v1/verify",
            post(verify::post_verify)
                .layer::<_, std::convert::Infallible>(verify_post_governor)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/v1/verify/:id",
            get(verify::get_verify_by_id).layer::<_, std::convert::Infallible>(read_governor),
        )
        .route(
            "/.well-known/truerolls-keys.json",
            get(well_known::get_keys),
        )
        .with_state(state)
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TrustedProxyKeyExtractor(pub TrustedProxy);

impl KeyExtractor for TrustedProxyKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        let headers = req.headers();
        match self.0 {
            TrustedProxy::Peer => peer_ip(req).ok_or(GovernorError::UnableToExtractKey),
            TrustedProxy::Xff(hops) => {
                xff_nth_from_right(headers, hops).ok_or_else(bad_proxy_headers)
            }
            TrustedProxy::Cloudflare => {
                single_header_ip(headers, "cf-connecting-ip").ok_or_else(bad_proxy_headers)
            }
            TrustedProxy::Fly => {
                single_header_ip(headers, "fly-client-ip").ok_or_else(bad_proxy_headers)
            }
        }
    }
}

fn peer_ip<T>(req: &axum::http::Request<T>) -> Option<IpAddr> {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|connect_info| connect_info.0.ip())
}

fn single_header_ip(headers: &HeaderMap, name: &'static str) -> Option<IpAddr> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn xff_nth_from_right(headers: &HeaderMap, hops: u8) -> Option<IpAddr> {
    let name = HeaderName::from_static("x-forwarded-for");
    let ips = headers
        .get_all(&name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|part| part.trim().parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    let hops = hops as usize;
    ips.len()
        .checked_sub(hops)
        .and_then(|index| ips.get(index).copied())
}

fn bad_proxy_headers() -> GovernorError {
    GovernorError::Other {
        code: StatusCode::BAD_REQUEST,
        msg: Some("bad_proxy_headers".to_string()),
        headers: None,
    }
}

fn protect_roll_post<S>(
    route: MethodRouter<S>,
    max_inflight: usize,
    timeout: Duration,
    body_limit: usize,
) -> axum::routing::MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    route.layer(
        ServiceBuilder::new()
            .layer(HandleErrorLayer::new(handle_protective_error))
            .layer(tower::load_shed::LoadShedLayer::new())
            .layer(tower::limit::GlobalConcurrencyLimitLayer::new(max_inflight))
            .layer(tower::timeout::TimeoutLayer::new(timeout))
            .layer(DefaultBodyLimit::max(body_limit)),
    )
}

async fn handle_protective_error(err: BoxError) -> Response {
    if err.is::<tower::load_shed::error::Overloaded>() {
        tracing::warn!(event = "roll.shed");
        retry_after_response(StatusCode::SERVICE_UNAVAILABLE, "overloaded")
    } else if err.is::<tower::timeout::error::Elapsed>() {
        tracing::warn!(event = "roll.timeout");
        retry_after_response(StatusCode::GATEWAY_TIMEOUT, "timeout")
    } else {
        tracing::error!(event = "roll.protective_error", error = %err);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"internal"})),
        )
            .into_response()
    }
}

fn retry_after_response(status: StatusCode, error: &'static str) -> Response {
    let mut response = (status, Json(serde_json::json!({ "error": error }))).into_response();
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

#[cfg(test)]
mod tests {
    use super::{TrustedProxyKeyExtractor, protect_roll_post};
    use crate::config::TrustedProxy;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request, StatusCode, header};
    use axum::routing::post;
    use std::net::{IpAddr, SocketAddr};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::time::Duration;
    use tower::ServiceExt; // for `oneshot`
    use tower_governor::{
        GovernorError, GovernorLayer, governor::GovernorConfigBuilder, key_extractor::KeyExtractor,
    };

    // A /v1/roll route limited exactly like the real router (methods=[POST],
    // trusted-proxy extractor), but with a tiny burst so the cap is hit immediately.
    // per_second(60) ⇒ ~no replenish within a millisecond-scale test, so burst is the cap.
    fn limited_app(burst: u32, trusted_proxy: TrustedProxy) -> Router {
        let conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(60)
                .burst_size(burst)
                .methods(vec![Method::POST])
                .key_extractor(TrustedProxyKeyExtractor(trusted_proxy))
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

    fn request_with_peer(method: Method, uri: &str, peer_ip: &str) -> Request<Body> {
        let peer = SocketAddr::new(peer_ip.parse().unwrap(), 12345);
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(peer));
        req
    }

    fn post_from_peer(peer_ip: &str) -> Request<Body> {
        request_with_peer(Method::POST, "/v1/roll", peer_ip)
    }

    fn post_from_peer_with_xff(peer_ip: &str, xff: &str) -> Request<Body> {
        let mut req = post_from_peer(peer_ip);
        req.headers_mut()
            .insert("x-forwarded-for", xff.parse().unwrap());
        req
    }

    fn extract_ip(proxy: TrustedProxy, req: &Request<Body>) -> Result<IpAddr, StatusCode> {
        TrustedProxyKeyExtractor(proxy)
            .extract(req)
            .map_err(|e| match e {
                GovernorError::Other { code, .. } => code,
                GovernorError::UnableToExtractKey => StatusCode::INTERNAL_SERVER_ERROR,
                GovernorError::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            })
    }

    #[test]
    fn peer_extractor_ignores_spoofed_forwarded_headers() {
        let req = post_from_peer_with_xff("1.2.3.4", "9.9.9.9");
        assert_eq!(
            extract_ip(TrustedProxy::Peer, &req).unwrap(),
            "1.2.3.4".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn xff_extractor_uses_nth_from_right_and_rejects_short_chain() {
        let req = post_from_peer_with_xff("10.0.0.1", "1.1.1.1, 2.2.2.2");
        assert_eq!(
            extract_ip(TrustedProxy::Xff(1), &req).unwrap(),
            "2.2.2.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            extract_ip(TrustedProxy::Xff(2), &req).unwrap(),
            "1.1.1.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            extract_ip(TrustedProxy::Xff(3), &req).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn xff_extractor_merges_multiple_header_instances() {
        let mut req = post_from_peer("10.0.0.1");
        req.headers_mut()
            .append("x-forwarded-for", "1.1.1.1".parse().unwrap());
        req.headers_mut()
            .append("x-forwarded-for", "2.2.2.2".parse().unwrap());
        assert_eq!(
            extract_ip(TrustedProxy::Xff(1), &req).unwrap(),
            "2.2.2.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            extract_ip(TrustedProxy::Xff(2), &req).unwrap(),
            "1.1.1.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn provider_extractors_use_authoritative_headers() {
        let mut cf = post_from_peer_with_xff("10.0.0.1", "9.9.9.9");
        cf.headers_mut()
            .insert("cf-connecting-ip", "3.3.3.3".parse().unwrap());
        assert_eq!(
            extract_ip(TrustedProxy::Cloudflare, &cf).unwrap(),
            "3.3.3.3".parse::<IpAddr>().unwrap()
        );

        let mut fly = post_from_peer_with_xff("10.0.0.1", "9.9.9.9");
        fly.headers_mut()
            .insert("fly-client-ip", "4.4.4.4".parse().unwrap());
        assert_eq!(
            extract_ip(TrustedProxy::Fly, &fly).unwrap(),
            "4.4.4.4".parse::<IpAddr>().unwrap()
        );

        let missing = post_from_peer("10.0.0.1");
        assert_eq!(
            extract_ip(TrustedProxy::Cloudflare, &missing).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn post_roll_rate_limited_after_burst() {
        let app = limited_app(2, TrustedProxy::Peer);
        // burst 2 ⇒ first two OK, third 429 (no replenish within the test window).
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn distinct_ips_have_independent_buckets() {
        let app = limited_app(1, TrustedProxy::Peer);
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("1.1.1.1"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // A different IP is independent, its first request still passes.
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("2.2.2.2"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // The first IP again, over its burst of 1 ⇒ 429.
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer("1.1.1.1"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn spoofed_xff_does_not_create_independent_buckets_in_peer_mode() {
        let app = limited_app(1, TrustedProxy::Peer);
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer_with_xff("1.1.1.1", "9.9.9.9"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(post_from_peer_with_xff("1.1.1.1", "8.8.8.8"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn get_roll_is_never_rate_limited() {
        let app = limited_app(1, TrustedProxy::Peer);
        let get = || {
            let mut req = request_with_peer(Method::GET, "/v1/roll", "5.5.5.5");
            req.headers_mut()
                .insert("x-forwarded-for", "9.9.9.9".parse().unwrap());
            req
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

    fn protected_app(
        max_inflight: usize,
        timeout: Duration,
        body_limit: usize,
        entered: Arc<AtomicUsize>,
        can_finish: Arc<AtomicBool>,
    ) -> Router {
        let post_handler = move |body: String| {
            let entered = Arc::clone(&entered);
            let can_finish = Arc::clone(&can_finish);
            async move {
                entered.fetch_add(1, Ordering::SeqCst);
                while !can_finish.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                (StatusCode::OK, body)
            }
        };
        Router::new().route(
            "/v1/roll",
            protect_roll_post(post(post_handler), max_inflight, timeout, body_limit)
                .get(|| async { StatusCode::OK }),
        )
    }

    fn protected_verify_read_app(burst: u32, body_limit: usize) -> Router {
        let verify_conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(60)
                .burst_size(burst)
                .methods(vec![Method::POST])
                .key_extractor(TrustedProxyKeyExtractor(TrustedProxy::Peer))
                .finish()
                .unwrap(),
        );
        let read_conf = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(60)
                .burst_size(burst)
                .methods(vec![Method::GET])
                .key_extractor(TrustedProxyKeyExtractor(TrustedProxy::Peer))
                .finish()
                .unwrap(),
        );
        Router::new()
            .route(
                "/v1/verify",
                post(|body: String| async move { (StatusCode::OK, body) })
                    .layer::<_, std::convert::Infallible>(GovernorLayer {
                        config: verify_conf,
                    })
                    .layer(axum::extract::DefaultBodyLimit::max(body_limit)),
            )
            .route(
                "/v1/verify/:id",
                axum::routing::get(|| async { StatusCode::OK })
                    .layer::<_, std::convert::Infallible>(GovernorLayer { config: read_conf }),
            )
            .route(
                "/.well-known/truerolls-keys.json",
                axum::routing::get(|| async { StatusCode::OK }),
            )
    }

    #[tokio::test]
    async fn protective_stack_sheds_when_global_inflight_is_full() {
        let entered = Arc::new(AtomicUsize::new(0));
        let can_finish = Arc::new(AtomicBool::new(false));
        let app = protected_app(
            1,
            Duration::from_secs(5),
            1024,
            Arc::clone(&entered),
            Arc::clone(&can_finish),
        );

        let first = tokio::spawn(
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/roll")
                    .body(Body::from("ok"))
                    .unwrap(),
            ),
        );

        while entered.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/roll")
                    .body(Body::from("ok"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");

        can_finish.store(true, Ordering::SeqCst);
        let _ = first.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn protective_stack_times_out_and_releases_permit() {
        let entered = Arc::new(AtomicUsize::new(0));
        let can_finish = Arc::new(AtomicBool::new(false));
        let app = protected_app(
            1,
            Duration::from_millis(30),
            1024,
            Arc::clone(&entered),
            Arc::clone(&can_finish),
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/roll")
                    .body(Body::from("ok"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");

        can_finish.store(true, Ordering::SeqCst);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/roll")
                    .body(Body::from("ok"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn protective_stack_limits_body_size_and_leaves_get_unwrapped() {
        let app = protected_app(
            1,
            Duration::from_secs(1),
            4,
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(true)),
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/roll")
                    .body(Body::from("too large"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/roll")
                    .body(Body::from("too large but GET has no heavy stack"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn verify_post_has_light_rate_limit() {
        let app = protected_verify_read_app(1, 1024);
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/verify")
                        .extension(ConnectInfo(SocketAddr::new(
                            "6.6.6.6".parse().unwrap(),
                            12345
                        )))
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/verify")
                    .extension(ConnectInfo(SocketAddr::new(
                        "6.6.6.6".parse().unwrap(),
                        12345
                    )))
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn verify_post_body_limit_returns_413() {
        let app = protected_verify_read_app(10, 4);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/verify")
                    .extension(ConnectInfo(SocketAddr::new(
                        "7.7.7.7".parse().unwrap(),
                        12345,
                    )))
                    .body(Body::from("too large"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn well_known_stays_unthrottled() {
        let app = protected_verify_read_app(1, 4);
        for _ in 0..3 {
            let response = app
                .clone()
                .oneshot(request_with_peer(
                    Method::GET,
                    "/.well-known/truerolls-keys.json",
                    "8.8.8.8",
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
}
