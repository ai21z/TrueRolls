// Health, RollRequest/Response, RollPayloadCanonical, ReceiptV2

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize)]
pub struct Live {
    pub status: &'static str,
}

#[derive(Serialize)]
pub struct Health {
    pub status: &'static str,
    pub db: bool,
    pub redis: bool,
    pub s3: bool,
}

#[derive(Debug, Deserialize)]
pub struct RollRequest {
    pub die: String, // "d6" | "d20" | "d100"
    pub kappa: f64,  // signed stance in [-1, 1]
    pub client_nonce: Option<String>,
    pub drand: Option<RollDrandRequest>,
    pub seed: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollDrandRequest {
    pub client_observed_round: u64,
    pub client_observed_signature_hex: String,
    pub client_observed_randomness_hex: String,
    pub target_round: u64,
}

/// Legacy response (kept for GET endpoints and backward compat).
#[derive(Debug, Serialize)]
pub struct RollResponse {
    pub id: Uuid,
    pub die: String,
    pub kappa: f64,
    pub seed: Option<String>,
    pub face: i32,
    pub ev: f64,
    pub alpha: f64,
    pub kl: f64,
    pub created_at: DateTime<Utc>,
    pub transcript_key: String,
    pub deduplicated: bool,
}

#[derive(Serialize)]
pub struct RollPayloadCanonical<'a> {
    pub die: &'a str,
    pub kappa: f64,
    pub client_nonce: &'a str,
    pub drand: &'a RollDrandRequest,
}

// ---- Receipt V2 (signed, independently verifiable) ----

/// The signed receipt returned by POST /v1/roll (201).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptV2 {
    pub v: String, // "truerolls-1" | "truerolls-drand-1"
    pub id: Uuid,
    pub die: String,
    pub kappa: f64,
    pub face: i32,
    pub alpha: f64,
    pub kl: f64,
    pub ev: f64,
    pub created_at: DateTime<Utc>,
    pub transcript_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_key: Option<String>,
    pub proof: ReceiptProof,
    /// sha256 hash of the JCS-canonicalized receipt body (before signing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<crate::services::signing::ReceiptSignature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptProof {
    pub math_param_version: String,
    pub rng: ReceiptRng,
    pub draw_u64: String, // stringified u64
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drand: Option<ReceiptDrandProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptRng {
    pub drbg_key_hex: String, // 32-byte HKDF output, hex-encoded
    pub algo: String,         // "HKDF(SHA-256)->ChaCha20Rng"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptDrandProof {
    pub chain_hash: String,
    pub scheme: String,
    pub public_key: String,
    pub period_seconds: u64,
    pub genesis_time: u64,
    pub target_delay_rounds: u64,
    pub client_nonce: String,
    pub client_observed_round: u64,
    pub client_observed_signature_hex: String,
    pub client_observed_randomness_hex: String,
    pub target_round: u64,
    pub target_signature_hex: String,
    pub target_randomness_hex: String,
    pub idem_payload_sha256_hex: String,
}

/// POST /v1/roll 201 response envelope.
#[derive(Debug, Serialize)]
pub struct ReceiptV2Response {
    #[serde(flatten)]
    pub receipt: ReceiptV2,
    pub deduplicated: bool,
}

// ---- Verify DTOs ----

/// Legacy transcript-based verification request (kept for backward compat).
#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    pub math_param_version: String,
    pub die: String,
    pub kappa: f64,
    pub face: u32,
    pub draw_u64: String, // stringified u64
    pub alpha: f64,
    pub kl: f64,
    pub ev: f64,
    pub probs: Vec<f64>,
}

/// New receipt-based verification response.
#[derive(Debug, Serialize)]
pub struct ReceiptVerifyResponse {
    pub valid_signature: bool,
    pub valid_drand: bool,
    pub valid_sampling: bool,
    pub face_ok: bool,
    pub metrics_ok: bool,
    pub details: ReceiptVerifyDetails,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ReceiptVerifyDetails {
    pub sig: String,
    pub recomputed_face: i32,
    pub recomputed_ev: f64,
    pub recomputed_kl: f64,
    pub recomputed_alpha: f64,
    pub tol: f64,
}

/// Legacy verify response (kept for backward compat POST /v1/verify with transcript body).
#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub verdict: &'static str, // "OK" | "MISMATCH"
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mismatches: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub recomputed: VerifyRecomputed,
}

#[derive(Debug, Serialize)]
pub struct VerifyRecomputed {
    pub face: u32,
    pub alpha: f64,
    pub kl: f64,
    pub ev: f64,
}
