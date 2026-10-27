//! GET /.well-known/truerolls-keys.json, public key discovery

use axum::{Json, extract::State};
use kd_receipt::PublicKeySet;
use std::sync::Arc;

use crate::error::{AppError, not_found};
use crate::state::AppState;

pub async fn get_keys(State(state): State<Arc<AppState>>) -> Result<Json<PublicKeySet>, AppError> {
    if state.public_keys.is_empty() {
        Err(not_found("no signing keys configured"))
    } else {
        // The published document uses kd_receipt's single envelope type, the same
        // shape the CLI and wasm verifiers parse, so the wire contract has one owner.
        Ok(Json(PublicKeySet {
            keys: state.public_keys.clone(),
        }))
    }
}
