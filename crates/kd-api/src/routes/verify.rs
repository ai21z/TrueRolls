//! POST /v1/verify — receipt + legacy transcript verification
//! GET  /v1/verify/:id — verify a roll by fetching its transcript from S3
//!
//! POST now auto-detects the body format:
//!   • ReceiptV2 (has `"v": "truerolls-1"` or `"truerolls-drand-1"`) — signature + proof verification
//!   • Legacy VerifyRequest (has `math_param_version`, `probs`) — recompute only
//!
//! GET fetches the transcript from S3 and runs legacy verification.

use axum::{
    Json,
    extract::{Path, State},
};
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::error::{AppError, bad_request, internal, not_found, unprocessable};
use crate::models::dto::{
    ReceiptVerifyDetails, ReceiptVerifyResponse, VerifyRecomputed, VerifyRequest, VerifyResponse,
};
use crate::services::{db, s3};
use crate::state::AppState;

use kd_core::{
    PARAM_VERSION, die::Die, distribution::compute_distribution, params::default_for_die,
    sample::prefix_cdf_index_from_u64,
};

/// GET /v1/verify/:id
///
/// Fetches the roll from DB, retrieves the transcript from S3,
/// deserializes it into a VerifyRequest, and runs verification.
#[tracing::instrument(name = "verify.by_id", skip(state), fields(id = %public_id))]
pub async fn get_verify_by_id(
    State(state): State<Arc<AppState>>,
    Path(public_id): Path<Uuid>,
) -> Result<Json<VerifyResponse>, AppError> {
    // 1. Look up roll in DB to get s3_key
    let row = db::select_roll_by_public_id(&state.pg, public_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("roll not found"))?;

    let s3_key = row
        .s3_key
        .ok_or_else(|| not_found("transcript not yet uploaded for this roll"))?;

    // 2. Fetch transcript JSON from S3
    let transcript_bytes = s3::get_transcript(&state.s3, &state.s3_bucket, &s3_key)
        .await
        .map_err(|e| internal(format!("failed to fetch transcript from S3: {e}")))?;

    // 3. Deserialize into VerifyRequest
    let req: VerifyRequest = serde_json::from_slice(&transcript_bytes)
        .map_err(|e| internal(format!("failed to parse transcript JSON: {e}")))?;

    info!(event = "verify.by_id.transcript_loaded", die = %req.die, kappa = req.kappa);

    // 4. Run the shared verification logic
    run_verification(req)
}

/// POST /v1/verify
///
/// Auto-detects body format:
/// - ReceiptV2 (v == "truerolls-1" or "truerolls-drand-1"): signature + drand when present + replay + face/metrics
/// - Legacy VerifyRequest (math_param_version + probs): recompute only
#[tracing::instrument(name = "verify", skip_all)]
pub async fn post_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;

    // Detect receipt format by version discriminator.
    if matches!(
        body.get("v").and_then(|v| v.as_str()),
        Some("truerolls-1") | Some(kd_drand::DRAND_RECEIPT_VERSION)
    ) {
        // Delegate to the shared verifier with the RAW body (identical to the CLI / wasm path).
        let resp = run_receipt_verification(&state, &body)?;
        return Ok(Json(resp).into_response());
    }

    // Legacy transcript verification
    let req: VerifyRequest = serde_json::from_value(body)
        .map_err(|e| bad_request(format!("invalid verify request: {e}")))?;

    match run_verification(req) {
        Ok(json) => Ok(json.into_response()),
        Err(e) => Err(e),
    }
}

/// Verify a signed ReceiptV2 by delegating to the shared offline verifier,
/// `kd_receipt::verify_receipt` — the SAME code the CLI (`kd verify --receipt`)
/// and the browser (wasm) run, so the signer and the verifier cannot drift
/// (SIG-1). All receipt checks (signature · drand when present · sampling replay · face · metrics)
/// and the math_param_version gate live in `kd_receipt`; it covers d4..d100 (the
/// inline path this replaced only handled d6/d20/d100).
///
/// We verify against the server's OWN published key (the one served at
/// /.well-known); a receipt signed by any other kid fails the (soft) signature
/// check and the verdict is INVALID. Structural problems — bad version, bad
/// DRBG key, unparseable draw, unknown die — are hard errors mapped to 400,
/// matching the prior inline behavior.
fn run_receipt_verification(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<ReceiptVerifyResponse, AppError> {
    // The server verifies with the key it publishes. If no signer is configured
    // (unsigned dev mode), pass an empty key: the signature check then fails
    // softly while sampling/face/metrics still run.
    let public_key_b64 = state
        .signer
        .as_ref()
        .map(|s| s.public_key_entry().public_key)
        .unwrap_or_default();

    // Every VerifyError is a "cannot verify at all" case (malformed / unsupported
    // version / unknown die) → 400, mirroring the inline path this replaced.
    let report = kd_receipt::verify_receipt(body, &public_key_b64)
        .map_err(|e| bad_request(e.to_string()))?;

    info!(
        event = "verify.receipt",
        valid_signature = report.valid_signature,
        valid_drand = report.valid_drand,
        valid_sampling = report.valid_sampling,
        face_ok = report.face_ok,
        metrics_ok = report.metrics_ok,
    );

    Ok(ReceiptVerifyResponse {
        valid_signature: report.valid_signature,
        valid_drand: report.valid_drand,
        valid_sampling: report.valid_sampling,
        face_ok: report.face_ok,
        metrics_ok: report.metrics_ok,
        details: ReceiptVerifyDetails {
            sig: if report.valid_signature {
                "valid"
            } else {
                "invalid"
            }
            .to_string(),
            recomputed_face: report.recomputed_face as i32,
            recomputed_ev: report.recomputed_ev,
            recomputed_kl: report.recomputed_kl,
            recomputed_alpha: report.recomputed_alpha,
            tol: report.tol,
        },
        errors: report.errors,
    })
}

/// Shared verification logic used by both GET and POST handlers.
fn run_verification(req: VerifyRequest) -> Result<Json<VerifyResponse>, AppError> {
    // ---- validate version ---------------------------------------------------
    if req.math_param_version != PARAM_VERSION {
        return Err(bad_request(format!(
            "Unsupported math_param_version '{}'; expected '{}'",
            req.math_param_version, PARAM_VERSION
        )));
    }

    // ---- validate die -------------------------------------------------------
    let n: usize = match req.die.as_str() {
        "d6" => 6,
        "d20" => 20,
        "d100" => 100,
        _ => return Err(bad_request(format!("Unsupported die '{}'", req.die))),
    };

    // ---- validate kappa -----------------------------------------------------
    if !req.kappa.is_finite() || req.kappa < -1.0 || req.kappa > 1.0 {
        return Err(bad_request("kappa must be finite and in [-1, 1]"));
    }

    // ---- parse draw_u64 -----------------------------------------------------
    let draw_u64: u64 = req
        .draw_u64
        .parse::<u64>()
        .map_err(|_| bad_request(format!("draw_u64 '{}' is not a valid u64", req.draw_u64)))?;

    // ---- validate probs length ----------------------------------------------
    if req.probs.len() != n {
        return Err(bad_request(format!(
            "probs length {} does not match die {} (expected {})",
            req.probs.len(),
            req.die,
            n
        )));
    }

    // ---- recompute distribution + face --------------------------------------
    let (recomp_face, recomp_alpha, recomp_kl, recomp_ev, recomp_probs) = match n {
        6 => recompute::<6>(req.kappa, draw_u64),
        20 => recompute::<20>(req.kappa, draw_u64),
        100 => recompute::<100>(req.kappa, draw_u64),
        _ => unreachable!(),
    }
    .map_err(|e| bad_request(format!("recomputation failed: {e}")))?;

    // ---- compare bit-identically -------------------------------------------
    let mut mismatches = Vec::new();

    if recomp_face != req.face {
        mismatches.push(format!(
            "face: transcript={} recomputed={}",
            req.face, recomp_face
        ));
    }

    let mut warnings: Vec<String> = Vec::new();

    for (label, recomp, transcript) in [
        ("alpha", recomp_alpha, req.alpha),
        ("kl", recomp_kl, req.kl),
        ("ev", recomp_ev, req.ev),
    ] {
        let diff = (recomp - transcript).abs();
        if diff > 1e-12 {
            mismatches.push(format!(
                "{label}: transcript={transcript} recomputed={recomp} diff={diff:.2e}"
            ));
        } else if recomp.to_bits() != transcript.to_bits() {
            warnings.push(format!("{label}: minor float round-trip diff={diff:.2e}"));
        }
    }

    if recomp_probs.len() != req.probs.len() {
        mismatches.push(format!(
            "probs length: transcript={} recomputed={}",
            req.probs.len(),
            recomp_probs.len()
        ));
    } else {
        for (i, (t, r)) in req.probs.iter().zip(recomp_probs.iter()).enumerate() {
            let diff = (t - r).abs();
            if diff > 1e-12 {
                mismatches.push(format!(
                    "probs[{}]: transcript={} recomputed={} diff={:.2e}",
                    i, t, r, diff
                ));
                if mismatches.len() >= 6 {
                    mismatches.push("... (more prob mismatches omitted)".to_string());
                    break;
                }
            } else if t.to_bits() != r.to_bits() {
                warnings.push(format!(
                    "probs[{}]: minor float round-trip diff={:.2e}",
                    i, diff
                ));
            }
        }
    }

    let recomputed = VerifyRecomputed {
        face: recomp_face,
        alpha: recomp_alpha,
        kl: recomp_kl,
        ev: recomp_ev,
    };

    if mismatches.is_empty() {
        info!(event = "verify.ok", warnings = warnings.len());
        Ok(Json(VerifyResponse {
            verdict: "OK",
            mismatches,
            warnings,
            recomputed,
        }))
    } else {
        warn!(event = "verify.mismatch", count = mismatches.len());
        Err(unprocessable(
            serde_json::to_string(&VerifyResponse {
                verdict: "MISMATCH",
                mismatches,
                warnings,
                recomputed,
            })
            .unwrap_or_else(|_| "verification mismatch".to_string()),
        ))
    }
}

/// Recompute distribution + face from (kappa, draw_u64) using kd-core.
fn recompute<const N: usize>(
    kappa: f64,
    draw_u64: u64,
) -> Result<(u32, f64, f64, f64, Vec<f64>), kd_core::errors::CoreError> {
    let params = default_for_die(N);
    let out = compute_distribution::<N>(Die::<N>, kappa, &params)?;
    let idx = prefix_cdf_index_from_u64::<N>(&out.probs, draw_u64);
    let face = (idx + 1) as u32;
    let probs_vec: Vec<f64> = out.probs.into_iter().collect();
    Ok((face, out.alpha, out.kl, out.ev, probs_vec))
}
