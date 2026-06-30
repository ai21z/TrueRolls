use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Serialize;
use serde_json::{self};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, info_span, warn};
use uuid::Uuid;

use crate::error::{AppError, bad_request, conflict, internal, not_found};
use crate::models::dto::{
    ReceiptDrandProof, ReceiptProof, ReceiptRng, ReceiptV2, ReceiptV2Response,
    RollPayloadCanonical, RollRequest, RollResponse,
};
use crate::services::drand::{quicknet_wall_clock_frontier_round, validate_roll_drand_request};
use crate::services::roll_math::compute_roll_with_rng_labeled;
use crate::services::{db, idempotency, quota, s3};
use crate::state::AppState;
use rand_core::SeedableRng;

#[derive(Debug, serde::Deserialize)]
pub struct IdemQuery {
    pub idem_key: String,
}

/// GET /v1/roll/:id
#[tracing::instrument(name = "roll.get_by_id", skip(state), fields(id = %public_id))]
pub async fn get_roll_by_id(
    State(state): State<Arc<AppState>>,
    Path(public_id): Path<Uuid>,
) -> Result<Json<RollResponse>, AppError> {
    let row = db::select_roll_by_public_id(&state.pg, public_id)
        .await
        .map_err(internal)?;

    match row {
        Some(row) => {
            info!(event = "roll.get_by_id.found");
            Ok(Json(to_api_response(&state.s3_bucket, row)))
        }
        None => {
            warn!(event = "roll.get_by_id.not_found");
            Err(not_found("roll not found"))
        }
    }
}

/// GET /v1/roll?idem_key=...
#[tracing::instrument(name = "roll.get_by_idem", skip(state, q), fields(idem_key = %q.idem_key))]
pub async fn get_roll_by_idem(
    State(state): State<Arc<AppState>>,
    Query(q): Query<IdemQuery>,
) -> Result<Json<RollResponse>, AppError> {
    if q.idem_key.trim().is_empty() {
        return Err(bad_request("idem_key is required"));
    }

    let row = db::select_roll_by_idem_key(&state.pg, &q.idem_key)
        .await
        .map_err(internal)?;

    match row {
        Some(row) => {
            info!(event = "roll.get_by_idem.found");
            Ok(Json(to_api_response(&state.s3_bucket, row)))
        }
        None => {
            warn!(event = "roll.get_by_idem.not_found");
            Err(not_found("roll not found"))
        }
    }
}

/// GET /v1/roll/:id/transcript, return transcript JSON via HTTP (not s3://)
#[tracing::instrument(name = "roll.transcript", skip(state), fields(id = %public_id))]
pub async fn get_transcript_by_id(
    State(state): State<Arc<AppState>>,
    Path(public_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let row = db::select_roll_by_public_id(&state.pg, public_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("roll not found"))?;

    let s3_key = row
        .s3_key
        .ok_or_else(|| not_found("transcript not yet uploaded for this roll"))?;

    let transcript_bytes = s3::get_transcript(&state.s3, &state.s3_bucket, &s3_key)
        .await
        .map_err(|e| internal(format!("failed to fetch transcript from S3: {e}")))?;

    Ok((
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        transcript_bytes,
    ))
}

/// Convert a DB row into the public API response JSON.
fn to_api_response(bucket: &str, row: crate::models::db::RollRow) -> RollResponse {
    let transcript_key = row
        .s3_key
        .as_ref()
        .map(|k| s3::s3_uri(bucket, k))
        .unwrap_or_default();

    RollResponse {
        id: row.public_id,
        die: row.die,
        kappa: row.kappa,
        seed: row.seed,
        face: row.face,
        ev: row.ev,
        alpha: row.alpha,
        kl: row.kl,
        created_at: row.created_at,
        transcript_key,
        // For GETs, mark as deduplicated=true to signal "this is an existing roll"
        deduplicated: true,
    }
}

/// POST /v1/roll
///
/// Returns:
/// - 201 + JSON (new roll)
/// - 200 + JSON (deduplicated result)
/// - 202 + JSON { status: "processing", idem_key, retry_hint_ms }
#[axum::debug_handler]
pub async fn post_roll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RollRequest>,
) -> Result<impl IntoResponse, AppError> {
    // ---- span & timer -------------------------------------------------------
    let started = Instant::now();
    let span = info_span!(
        "roll.request",
        die = %req.die,
        kappa = req.kappa,
        has_seed = %req.seed.is_some(),
        has_client_nonce = %req.client_nonce.is_some()
    );
    let _g = span.enter();

    // ---- validate input -----------------------------------------------------
    match req.die.as_str() {
        "d6" | "d20" | "d100" => {}
        _ => return Err(bad_request("Invalid die; use d6|d20|d100")),
    }
    if !req.kappa.is_finite() || req.kappa < -1.0 || req.kappa > 1.0 {
        return Err(bad_request("Invalid kappa; must be finite and in [-1, 1]"));
    }
    if req.seed.is_some() {
        return Err(bad_request(
            "seed is legacy and disabled for drand-backed rolls; send client_nonce + drand proof",
        ));
    }
    let client_nonce = req
        .client_nonce
        .as_deref()
        .ok_or_else(|| bad_request("client_nonce is required for drand-backed rolls"))?;
    validate_client_nonce(client_nonce)?;
    let drand_req = req
        .drand
        .as_ref()
        .ok_or_else(|| bad_request("drand proof is required for drand-backed rolls"))?;

    // ---- idempotency: header preferred, if both present and differ -> 400 ---
    let header_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_owned());

    if let (Some(h), Some(b)) = (header_key.as_deref(), req.idempotency_key.as_deref())
        && h != b
    {
        return Err(bad_request(
            "Idempotency-Key header and body.idempotency_key differ",
        ));
    }

    let idem_key = header_key
        .or(req.idempotency_key.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let redis_key = format!("idem:roll:{idem_key}");
    let key_hash = short_hash_hex(&redis_key);

    // ---- canonical payload hash (strict binding of key -> body) ------------
    let canonical = RollPayloadCanonical {
        die: &req.die,
        kappa: req.kappa,
        client_nonce,
        drand: drand_req,
    };
    let payload_bytes = serde_jcs::to_vec(&serde_json::to_value(&canonical).map_err(internal)?)
        .map_err(internal)?;
    let payload_sha = sha256_bytes(&payload_bytes);
    let payload_sha_hex = hex::encode(&payload_sha);

    // ---- acquire lock (SET NX EX) -------------------------------------------
    let idem_lock = idempotency::acquire_lock(&state.redis, &redis_key, state.cfg.idem_ttl_secs)
        .await
        .map_err(internal)?;
    let acquired = idem_lock.is_some();
    info!(event = "idem.lock", acquired, key_hash = %key_hash);

    // ---- dedup path ----------------------------------------------------------
    let Some(idem_lock) = idem_lock else {
        let pg_for_poll = state.pg.clone();
        let key_for_poll = idem_key.clone();

        let row_opt = idempotency::poll_for_row(
            move || {
                let pg = pg_for_poll.clone();
                let key = key_for_poll.clone();
                Box::pin(async move {
                    db::select_receipt_by_idem_key(&pg, &key)
                        .await
                        .ok()
                        .flatten()
                })
            },
            state.cfg.idem_poll_ms,
            state.cfg.idem_poll_max,
        )
        .await;

        if let Some(row) = row_opt {
            info!(event = "idem.dedup.hit", key_hash = %key_hash);

            if let Some(stored) = row.idem_payload_sha256
                && stored != payload_sha
            {
                warn!(event = "idem.dedup.mismatch", key_hash = %key_hash);
                return Err(conflict("Idempotency-Key was used with a different body"));
            }

            let mut receipt = row.receipt_json;
            if let Some(obj) = receipt.as_object_mut() {
                obj.insert("deduplicated".to_string(), serde_json::json!(true));
            }

            info!(
                event = "roll.done",
                status = 200u16,
                dedup = true,
                ms = started.elapsed().as_millis() as u64
            );
            return Ok((StatusCode::OK, Json(receipt)).into_response());
        }

        // 202 Accepted: request with this idempotency key is still being computed
        #[derive(Serialize)]
        struct ProcessingResponse<'a> {
            status: &'static str,
            idem_key: &'a str,
            retry_hint_ms: u64,
        }

        info!(event = "idem.dedup.timeout", key_hash = %key_hash);
        let processing = ProcessingResponse {
            status: "processing",
            idem_key: &idem_key,
            retry_hint_ms: state.cfg.idem_poll_ms,
        };
        return Ok((StatusCode::ACCEPTED, Json(processing)).into_response());
    };

    // ---- drand: verify client frontier, wait for target, derive RNG ---------
    let server_latest = state
        .drand
        .fetch_latest_verified()
        .await
        .map_err(|e| internal(format!("drand latest fetch failed: {e}")))?;
    let wall_clock_frontier_round = quicknet_wall_clock_frontier_round()
        .map_err(|e| internal(format!("drand wall-clock frontier failed: {e}")))?;
    let client_observed = validate_roll_drand_request(
        drand_req,
        server_latest.round,
        wall_clock_frontier_round,
        state.cfg.drand_client_max_lag_rounds,
    )
    .map_err(bad_request)?;

    // ---- global mint cap: bound TOTAL receipts minted per window (OPS-AUTH-01) ----
    // The drand proof is now validated and we hold the idempotency lock, so we are committed to a
    // *new* mint. Reserve global budget here, AFTER validation (an invalid proof has already 400'd
    // above without spending budget) and BEFORE the expensive target-round wait + signing + DB + S3,
    // so the counter tracks validated reservation attempts at the mint-commit point, an over-cap
    // request is rejected before the ~6s wait, and a legitimate idempotent retry (which dedups)
    // never charges.
    // Fail-closed: a Redis error -> 500 (the roll path already requires Redis for the idem lock).
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(internal)?
        .as_secs();
    match quota::reserve_mint(
        &state.redis,
        state.cfg.roll_global_cap,
        state.cfg.roll_global_cap_window_secs,
        now_unix,
    )
    .await
    .map_err(internal)?
    {
        quota::MintReservation::Allowed { window_count } => {
            info!(
                event = "roll.mintcap.ok",
                window_count,
                cap = state.cfg.roll_global_cap
            );
        }
        quota::MintReservation::Rejected {
            window_count,
            retry_after_secs,
        } => {
            warn!(
                event = "roll.mintcap.exceeded",
                window_count,
                cap = state.cfg.roll_global_cap,
                retry_after_secs
            );
            // No mint happened, so release the idempotency lock (unlike the normal post-mint
            // flow, which keeps it to fence concurrent duplicates). This lets a retry of the SAME
            // idem key succeed once the window resets, instead of polling to a 202 until TTL.
            match idempotency::release_lock(&state.redis, &idem_lock).await {
                Ok(true) => {
                    info!(event = "idem.lock_released", key_hash = %key_hash);
                }
                Ok(false) => {
                    warn!(
                        event = "idem.lock_release_failed",
                        key_hash = %key_hash,
                        reason = "missing_or_owned_by_another_request"
                    );
                }
                Err(err) => {
                    warn!(
                        event = "idem.lock_release_failed",
                        key_hash = %key_hash,
                        error = %err
                    );
                }
            }
            return Ok(mint_cap_response(retry_after_secs));
        }
    }

    let target_pulse = state
        .drand
        .wait_for_round_verified(drand_req.target_round, state.cfg.drand_target_wait_ms)
        .await
        .map_err(|e| internal(format!("drand target fetch failed: {e}")))?;

    let seed_input = kd_drand::DrandSeedInput {
        target_pulse: target_pulse.clone(),
        client_nonce: client_nonce.to_string(),
        die: req.die.clone(),
        kappa: req.kappa,
        idem_payload_sha256_hex: payload_sha_hex.clone(),
    };
    let drbg_key = kd_drand::derive_roll_seed(&seed_input)
        .map_err(|e| internal(format!("drand seed derivation failed: {e}")))?;
    let result = {
        let mut rng = rand_chacha::ChaCha20Rng::from_seed(drbg_key);
        compute_roll_with_rng_labeled(&req.die, req.kappa, &mut rng, None, kd_drand::RNG_ALGO)
            .map_err(internal)?
    };

    // ---- attach RNG provenance into transcript ------------------------------
    // Ensure both:
    //  - top-level "rng": { ...full provenance... }
    //  - "sampling": { method: "prefix_cdf", rng: <actual algo> }  (force overwrite)
    let mut transcript_json = result.transcript_json; // take ownership
    let drand_proof = ReceiptDrandProof {
        chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
        scheme: kd_drand::QUICKNET_SCHEME.to_string(),
        public_key: kd_drand::QUICKNET_PUBLIC_KEY_HEX.to_string(),
        period_seconds: kd_drand::QUICKNET_PERIOD_SECONDS,
        genesis_time: kd_drand::QUICKNET_GENESIS_TIME,
        target_delay_rounds: kd_drand::DEFAULT_TARGET_DELAY_ROUNDS,
        client_nonce: client_nonce.to_string(),
        client_observed_round: client_observed.round,
        client_observed_signature_hex: client_observed.signature_hex.clone(),
        client_observed_randomness_hex: client_observed.randomness_hex.clone(),
        target_round: target_pulse.round,
        target_signature_hex: target_pulse.signature_hex.clone(),
        target_randomness_hex: target_pulse.randomness_hex.clone(),
        idem_payload_sha256_hex: payload_sha_hex.clone(),
    };
    let rng_val = serde_json::json!({
        "algo": kd_drand::RNG_ALGO,
        "source": "drand-quicknet",
        "chain_hash": kd_drand::QUICKNET_CHAIN_HASH,
        "client_observed_round": client_observed.round,
        "target_round": target_pulse.round,
        "target_delay_rounds": kd_drand::DEFAULT_TARGET_DELAY_ROUNDS,
    });

    use serde_json::Value as JsonValue;

    if let Some(map) = transcript_json.as_object_mut() {
        // Set/overwrite top-level rng provenance
        map.insert("rng".to_string(), rng_val.clone());

        // Force sampling to the correct rng label
        map.insert(
            "sampling".to_string(),
            serde_json::json!({
                "method": "prefix_cdf",
                "rng": kd_drand::RNG_ALGO,
            }),
        );
    } else {
        // If transcript isn't an object, wrap it so we can still attach provenance.
        let inner = std::mem::replace(&mut transcript_json, JsonValue::Null);
        transcript_json = serde_json::json!({
            "rng": rng_val,
            "sampling": { "method": "prefix_cdf", "rng": kd_drand::RNG_ALGO },
            "inner": inner
        });
    }

    // Map to DB/API types while we're still in this short scope (before awaits)
    let face: i32 = result.face.try_into().expect("face fits i32 (<= 100)");
    let ev = result.ev;
    let alpha = result.alpha;
    let kl = result.kl;

    // ---- persist roll --------------------------------------------------------
    let public_id = Uuid::new_v4();
    let row = db::insert_roll(
        &state.pg,
        public_id,
        &req.die,
        req.kappa,
        None,
        &idem_key,
        &payload_sha,
        face,
        ev,
        alpha,
        kl,
    )
    .await
    .map_err(internal)?;
    info!(event = "roll.inserted", %public_id, key_hash = %key_hash);

    // ---- upload transcript to S3 --------------------------------------------
    let s3_key = format!("rolls/{public_id}.json");
    let bytes = serde_json::to_vec(&transcript_json).map_err(internal)?;
    s3::put_transcript(&state.s3, &state.s3_bucket, &s3_key, bytes.clone())
        .await
        .map_err(internal)?;
    info!(event = "s3.transcript.put", %public_id, bytes = bytes.len(), %s3_key);

    // ---- store transcript meta ----------------------------------------------
    let sha = {
        let mut h = Sha256::new();
        h.update(&bytes);
        h.finalize().to_vec()
    };
    db::insert_transcript_meta(&state.pg, row.id, &s3_key, &sha, bytes.len() as i64)
        .await
        .map_err(internal)?;

    // ---- build response ------------------------------------------------------
    let transcript_url = format!("/v1/roll/{}/transcript", public_id);
    let transcript_key_s3 = s3::s3_uri(&state.s3_bucket, &s3_key);
    let drbg_key_hex = hex::encode(drbg_key);

    // Build the receipt body (everything except sig and receipt_hash) for signing
    let mut receipt = ReceiptV2 {
        v: kd_drand::DRAND_RECEIPT_VERSION.to_string(),
        id: public_id,
        die: req.die,
        kappa: req.kappa,
        face,
        alpha,
        kl,
        ev,
        created_at: row.created_at,
        transcript_url,
        transcript_key: Some(transcript_key_s3),
        proof: ReceiptProof {
            math_param_version: kd_core::PARAM_VERSION.to_string(),
            rng: ReceiptRng {
                drbg_key_hex,
                algo: kd_drand::RNG_ALGO.to_string(),
            },
            draw_u64: result.draw_u64.to_string(),
            drand: Some(drand_proof),
        },
        receipt_hash: None,
        sig: None,
    };

    // Sign the receipt (sig covers everything except the sig block itself)
    if let Some(ref signer) = state.signer {
        let body_for_signing = serde_json::to_value(&receipt).map_err(internal)?;
        let (sig_block, receipt_hash) = signer.sign_receipt(&body_for_signing).map_err(internal)?;
        receipt.receipt_hash = Some(receipt_hash);
        receipt.sig = Some(sig_block);
    }
    let receipt_json = serde_json::to_value(&receipt).map_err(internal)?;
    db::update_roll_receipt_json(&state.pg, row.id, &receipt_json)
        .await
        .map_err(internal)?;

    let resp = ReceiptV2Response {
        receipt,
        deduplicated: false,
    };

    info!(
        event = "roll.done",
        status = 201u16,
        dedup = false,
        ms = started.elapsed().as_millis() as u64
    );
    Ok((StatusCode::CREATED, Json(resp)).into_response())
}

// -------------------- helpers ----------------------

/// 429 Too Many Requests for a global-mint-cap rejection, with a `Retry-After` (seconds) pointing
/// at the next window. Built inline (not via `AppError`) so it can carry the header, matching how
/// the dedup path returns custom status codes directly.
fn mint_cap_response(retry_after_secs: u64) -> axum::response::Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({ "error": "global_roll_cap_exceeded" })),
    )
        .into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&retry_after_secs.to_string()) {
        resp.headers_mut()
            .insert(axum::http::header::RETRY_AFTER, value);
    }
    resp
}

fn sha256_bytes(data: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().to_vec()
}

fn validate_client_nonce(client_nonce: &str) -> Result<(), AppError> {
    if client_nonce.len() != 64 || !client_nonce.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(bad_request(
            "client_nonce must be 32 random bytes encoded as 64 hex characters",
        ));
    }
    Ok(())
}

/// Short redacted hex hash (12 chars) for logging keys safely.
fn short_hash_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let digest = h.finalize();
    // first 6 bytes -> 12 hex chars
    let mut out = String::with_capacity(12);
    for b in digest.iter().take(6) {
        use std::fmt::Write;
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}
