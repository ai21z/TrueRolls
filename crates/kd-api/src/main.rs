// bootstrap only

mod config;
mod error;
mod models {
    pub mod db;
    pub mod dto;
}
mod services {
    pub mod db;
    pub mod drand;
    pub mod idempotency;
    pub mod quota;
    pub mod roll_math;
    pub mod s3;
    pub mod signing;
}
mod routes;
mod state;

use axum::http::Method;
use dotenvy::dotenv;
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::config::Config;
use crate::state::{AppState, build_state};

#[tokio::main]
async fn main() -> Result<(), String> {
    let _ = dotenv();
    init_tracing();

    let cfg = Config::from_env().map_err(|e| e.to_string())?;
    let state: Arc<AppState> = build_state(&cfg).await.map_err(|e| e.to_string())?;

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_origin(Any)
        .allow_headers(Any);

    // NOTE: no explicit type annotation here.
    let app = routes::router(state).layer(cors);

    let addr = SocketAddr::from((cfg.host, cfg.port));
    info!("kd-api listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| e.to_string())?;

    // ConnectInfo carries the peer IP - the SmartIpKeyExtractor rate limiter (KD-036) uses
    // it as the fallback when no X-Forwarded-For / X-Real-IP header is present (local/dev).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};
    tracing_subscriber::registry()
        .with(EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();
}
