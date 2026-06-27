use axum::{Json, extract::State};
use serde::Serialize;
use std::sync::Arc;

use crate::error::{AppError, internal};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct DrandHealth {
    pub source: &'static str,
    pub chain_hash: &'static str,
    pub scheme: &'static str,
    pub public_key: &'static str,
    pub period_seconds: u64,
    pub genesis_time: u64,
    pub latest_round: u64,
    pub latest_randomness_hex: String,
    pub target_delay_rounds: u64,
}

pub async fn drand_healthz(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DrandHealth>, AppError> {
    let latest = state
        .drand
        .fetch_latest_verified()
        .await
        .map_err(|e| internal(format!("drand health failed: {e}")))?;
    Ok(Json(DrandHealth {
        source: "drand-quicknet",
        chain_hash: kd_drand::QUICKNET_CHAIN_HASH,
        scheme: kd_drand::QUICKNET_SCHEME,
        public_key: kd_drand::QUICKNET_PUBLIC_KEY_HEX,
        period_seconds: kd_drand::QUICKNET_PERIOD_SECONDS,
        genesis_time: kd_drand::QUICKNET_GENESIS_TIME,
        latest_round: latest.round,
        latest_randomness_hex: latest.randomness_hex,
        target_delay_rounds: kd_drand::DEFAULT_TARGET_DELAY_ROUNDS,
    }))
}
