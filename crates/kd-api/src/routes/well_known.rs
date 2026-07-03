//! GET /.well-known/truerolls-keys.json, public key discovery

use axum::{Json, extract::State};
use serde::Serialize;
use std::sync::Arc;

use crate::error::{AppError, not_found};
use crate::state::AppState;

#[derive(Serialize)]
pub(crate) struct KeysResponse {
    keys: Vec<crate::services::signing::PublicKeyEntry>,
}

pub async fn get_keys(State(state): State<Arc<AppState>>) -> Result<Json<KeysResponse>, AppError> {
    if state.public_keys.is_empty() {
        Err(not_found("no signing keys configured"))
    } else {
        Ok(Json(KeysResponse {
            keys: state.public_keys.clone(),
        }))
    }
}
