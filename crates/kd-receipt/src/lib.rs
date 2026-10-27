//! kd-receipt, the shared offline ReceiptV2 signer + verifier.
//!
//! This is the *single* implementation of TrueRolls receipt signing AND
//! verification. The CLI (`kd verify --receipt`), the browser (via
//! `kd-core-wasm`), and the server (`kd-api`) all run this same compiled code,
//! bit-for-bit. A verifier that drifts from the signer is worse than no verifier
//! (it can bless a forgery), so sign and verify live in one crate and both go
//! through the single [`canonical_signing_bytes`], they cannot disagree on what
//! bytes a signature covers. The signer lives in [`mod@sign`].
//!
//! Verification, in order (mirrors the server's `run_receipt_verification`):
//!   1. **Signature**, Ed25519 over the JCS/RFC8785 canonicalization of the
//!      receipt body with `sig` and `receipt_hash` removed (soft: a bad/missing
//!      signature is recorded, not fatal, so the rest of the report still fills).
//!   2. **Drand**, for `truerolls-drand-1`, verify pinned quicknet BLS pulses,
//!      target binding, randomness, and HKDF seed derivation.
//!   3. **Sampling**, reseed `ChaCha20Rng` from `proof.rng.drbg_key_hex`, take
//!      one `next_u64()`, and compare against `proof.draw_u64`.
//!   4. **Face**, recompute the guarded distribution from `(die, kappa)` via
//!      `kd_core`, map the draw with `prefix_cdf_index_from_u64`, compare to
//!      `face`.
//!   5. **Metrics**, recompute `alpha`/`kl`/`ev` and compare within `1e-9`.
//!
//! All math comes from `kd_core`, this crate adds no math of its own.
//!
//! Honest scope: `truerolls-drand-1` proves verified drand seed provenance and
//! deterministic replay for a completed receipt. It does **not** prove the
//! published outcome was unbiased: the operator can still grind by failing/
//! suppressing unfavorable attempts and publishing only favorable completed
//! receipts. Strict witnessed fairness (one committed attempt per roll) is v2.

use kd_core::die::Die;
use kd_core::distribution::compute_distribution;
use kd_core::params::default_for_die;
use kd_core::sample::prefix_cdf_index_from_u64;
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt;

mod sign;
pub use sign::{
    KeyStatus, PUBLISHED_TEST_PUBLIC_KEY_2_B64, PUBLISHED_TEST_PUBLIC_KEY_B64,
    PUBLISHED_TEST_SEED_2_HEX, PUBLISHED_TEST_SEED_HEX, PublicKeyEntry, PublicKeySet,
    ReceiptSignature, ReceiptSigner, TEST_KIDS, reject_test_public_key_in_prod,
    reject_test_signer_in_prod,
};

/// Legacy receipt schema version.
pub const RECEIPT_VERSION: &str = "truerolls-1";
/// Drand-backed receipt schema version.
pub const DRAND_RECEIPT_VERSION: &str = kd_drand::DRAND_RECEIPT_VERSION;

/// Absolute tolerance for the recomputed `alpha`/`kl`/`ev` comparison.
pub const METRIC_TOL: f64 = 1e-9;

/// The exact bytes a receipt signature covers: the JCS (RFC 8785) serialization
/// of the receipt body with `sig` and `receipt_hash` removed (both are attached
/// *after* signing, so they are not part of the signed bytes). This is the single
/// canonicalization, both [`ReceiptSigner::sign_receipt`] and signature
/// verification call it, so the signer and verifier can never disagree on what
/// was signed. Stripping is defensive: callers that pass a pre-`sig` body get an
/// identical result, so existing goldens and newly-signed receipts match. The
/// API may wrap a receipt with envelope-only metadata such as `deduplicated`;
/// those fields are not signed receipt content and are stripped here too.
pub fn canonical_signing_bytes(receipt_body: &Value) -> Result<Vec<u8>, String> {
    let mut body = receipt_body.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.remove("sig");
        obj.remove("receipt_hash");
        obj.remove("deduplicated");
    }
    serde_jcs::to_vec(&body).map_err(|e| format!("JCS canonicalization failed: {e}"))
}

// ---------------------------------------------------------------------------
// ReceiptV2 (deserialization mirror of kd-api's dto::ReceiptV2)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ReceiptV2 {
    v: String,
    #[allow(dead_code)]
    id: String,
    die: String,
    kappa: f64,
    face: i32,
    alpha: f64,
    kl: f64,
    ev: f64,
    proof: ReceiptProof,
    receipt_hash: Option<String>,
    sig: Option<ReceiptSig>,
}

#[derive(Debug, Deserialize)]
struct ReceiptProof {
    math_param_version: String,
    rng: ReceiptRng,
    draw_u64: String,
    drand: Option<ReceiptDrandProof>,
}

#[derive(Debug, Deserialize)]
struct ReceiptRng {
    drbg_key_hex: String,
    algo: String,
}

#[derive(Debug, Deserialize)]
struct ReceiptDrandProof {
    chain_hash: String,
    scheme: String,
    public_key: String,
    period_seconds: u64,
    genesis_time: u64,
    target_delay_rounds: u64,
    client_nonce: String,
    client_observed_round: u64,
    client_observed_signature_hex: String,
    client_observed_randomness_hex: String,
    target_round: u64,
    target_signature_hex: String,
    target_randomness_hex: String,
    idem_payload_sha256_hex: String,
}

#[derive(Debug, Deserialize)]
struct ReceiptSig {
    #[allow(dead_code)]
    alg: String,
    #[allow(dead_code)]
    kid: String,
    signature_b64: String,
    #[allow(dead_code)]
    canon: String,
}

// ---------------------------------------------------------------------------
// Errors, the "cannot even attempt verification" cases (hard failures).
// Signature problems are NOT here. They are recorded softly in VerifyReport.
// ---------------------------------------------------------------------------

/// A receipt that is structurally unverifiable (malformed or out-of-scope).
/// These mirror the CLI's hard-`bail!` paths so behavior is identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// JSON did not deserialize into a ReceiptV2.
    ParseReceipt(String),
    /// `v` is not a supported receipt version.
    UnsupportedVersion(String),
    /// A drand receipt did not carry its required drand proof block.
    MissingDrandProof,
    /// `proof.rng.drbg_key_hex` is not valid hex.
    BadDrbgHex(String),
    /// `proof.rng.drbg_key_hex` did not decode to exactly 32 bytes.
    BadDrbgLen(usize),
    /// `proof.draw_u64` is not a u64.
    BadDraw,
    /// `proof.math_param_version` does not match the engine's `PARAM_VERSION`.
    ParamVersionMismatch { got: String, current: String },
    /// `die` is not one of d4/d6/d8/d10/d12/d20/d100.
    UnsupportedDie(String),
    /// kd-core returned a compute error.
    Core(String),
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerifyError::ParseReceipt(e) => write!(f, "failed to parse ReceiptV2: {e}"),
            VerifyError::UnsupportedVersion(v) => write!(f, "unsupported receipt version: '{v}'"),
            VerifyError::MissingDrandProof => write!(f, "drand receipt is missing proof.drand"),
            VerifyError::BadDrbgHex(e) => write!(f, "invalid drbg_key_hex: {e}"),
            VerifyError::BadDrbgLen(n) => {
                write!(f, "drbg_key_hex must decode to 32 bytes, got {n}")
            }
            VerifyError::BadDraw => write!(f, "draw_u64 is not a valid u64"),
            VerifyError::ParamVersionMismatch { got, current } => {
                write!(
                    f,
                    "receipt math_param_version '{got}' != current '{current}'"
                )
            }
            VerifyError::UnsupportedDie(d) => write!(
                f,
                "unsupported die size: {d}. Supported: d4, d6, d8, d10, d12, d20, d100"
            ),
            VerifyError::Core(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VerifyError {}

// ---------------------------------------------------------------------------
// VerifyReport, the check result of a verifiable receipt.
// ---------------------------------------------------------------------------

/// The outcome of verifying a (structurally valid) signed receipt. `verdict`
/// is VALID only when every reported check passes.
#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub valid_signature: bool,
    pub valid_drand: bool,
    pub valid_sampling: bool,
    pub face_ok: bool,
    pub metrics_ok: bool,
    pub recomputed_face: u32,
    pub recomputed_alpha: f64,
    pub recomputed_kl: f64,
    pub recomputed_ev: f64,
    pub tol: f64,
    /// Human-readable reasons for any failed check (empty when VALID).
    pub errors: Vec<String>,
}

impl VerifyReport {
    /// True only when signature, drand, sampling, face, and metrics all pass.
    pub fn is_valid(&self) -> bool {
        self.valid_signature
            && self.valid_drand
            && self.valid_sampling
            && self.face_ok
            && self.metrics_ok
    }

    /// The CLI/`--json` and WASM result shape, one schema everywhere.
    pub fn to_result_json(&self) -> Value {
        json!({
            "verdict": if self.is_valid() { "VALID" } else { "INVALID" },
            "valid_signature": self.valid_signature,
            "valid_drand": self.valid_drand,
            "valid_sampling": self.valid_sampling,
            "face_ok": self.face_ok,
            "metrics_ok": self.metrics_ok,
            "details": {
                "recomputed_face": self.recomputed_face,
                "recomputed_alpha": self.recomputed_alpha,
                "recomputed_kl": self.recomputed_kl,
                "recomputed_ev": self.recomputed_ev,
                "tol": self.tol,
            },
            "errors": self.errors,
        })
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse `receipt_json` and verify it against `public_key_b64` (base64 of the
/// 32-byte Ed25519 verifying key). Convenience wrapper over [`verify_receipt`].
pub fn verify_receipt_str(
    receipt_json: &str,
    public_key_b64: &str,
) -> Result<VerifyReport, VerifyError> {
    let value: Value =
        serde_json::from_str(receipt_json).map_err(|e| VerifyError::ParseReceipt(e.to_string()))?;
    verify_receipt(&value, public_key_b64)
}

/// Parse `receipt_json` and verify it against a published key set. The verifier
/// selects the key by `sig.kid` and applies key status semantics internally.
pub fn verify_receipt_str_with_key_set(
    receipt_json: &str,
    key_set: &[PublicKeyEntry],
) -> Result<VerifyReport, VerifyError> {
    let value: Value =
        serde_json::from_str(receipt_json).map_err(|e| VerifyError::ParseReceipt(e.to_string()))?;
    verify_receipt_with_key_set(&value, key_set)
}

/// Verify a signed ReceiptV2 (`receipt_value`) against `public_key_b64`.
///
/// Returns a [`VerifyReport`] for any *structurally valid* receipt (even if the
/// signature is missing or wrong, those are recorded in the report). Returns a
/// [`VerifyError`] only when the receipt cannot be verified at all (malformed,
/// wrong version, bad DRBG key, unparseable draw, version-gated, unknown die).
pub fn verify_receipt(
    receipt_value: &Value,
    public_key_b64: &str,
) -> Result<VerifyReport, VerifyError> {
    verify_receipt_inner(receipt_value, VerificationKeys::Direct(public_key_b64))
}

/// Verify a signed ReceiptV2 against a key set. The receipt's `sig.kid` chooses
/// the key. Active and retired keys may verify old receipts. Revoked keys always
/// produce an INVALID report with an explicit revoked-key reason.
pub fn verify_receipt_with_key_set(
    receipt_value: &Value,
    key_set: &[PublicKeyEntry],
) -> Result<VerifyReport, VerifyError> {
    verify_receipt_inner(receipt_value, VerificationKeys::KeySet(key_set))
}

/// Parse a `/.well-known/truerolls-keys.json` document leniently. A single
/// malformed entry is dropped (its error collected as a warning) instead of
/// failing the whole set, so one bad entry cannot black-hole verification of
/// every other receipt sitewide. A dropped entry makes its kid resolve as
/// unknown -> INVALID (fail closed), never valid. The envelope itself
/// (`{ "keys": [...] }`) must still be well-formed.
pub fn parse_public_key_set(json: &str) -> Result<(Vec<PublicKeyEntry>, Vec<String>), String> {
    #[derive(serde::Deserialize)]
    struct RawSet {
        keys: Vec<Value>,
    }
    let raw: RawSet =
        serde_json::from_str(json).map_err(|e| format!("failed to parse key set envelope: {e}"))?;
    let mut entries = Vec::with_capacity(raw.keys.len());
    let mut warnings = Vec::new();
    for (i, value) in raw.keys.into_iter().enumerate() {
        match serde_json::from_value::<PublicKeyEntry>(value) {
            Ok(entry) => entries.push(entry),
            Err(e) => warnings.push(format!("key set entry {i} skipped (unparseable): {e}")),
        }
    }
    Ok((entries, warnings))
}

enum VerificationKeys<'a> {
    Direct(&'a str),
    KeySet(&'a [PublicKeyEntry]),
}

impl<'a> VerificationKeys<'a> {
    fn public_key_for_sig(&self, sig: &ReceiptSig, errors: &mut Vec<String>) -> Option<&'a str> {
        match self {
            VerificationKeys::Direct(public_key_b64) => Some(public_key_b64),
            VerificationKeys::KeySet(keys) => {
                let mut matches = keys.iter().filter(|key| key.kid == sig.kid);
                let Some(key) = matches.next() else {
                    errors.push(format!("unknown signing kid '{}'", sig.kid));
                    return None;
                };
                if matches.next().is_some() {
                    errors.push(format!("duplicate signing kid '{}' in key set", sig.kid));
                    return None;
                }
                if key.alg != "Ed25519" {
                    errors.push(format!("key '{}' alg '{}' != 'Ed25519'", key.kid, key.alg));
                    return None;
                }
                match key.status {
                    KeyStatus::Active | KeyStatus::Retired => Some(key.public_key.as_str()),
                    KeyStatus::Revoked => {
                        errors.push(format!("signing key '{}' is revoked", sig.kid));
                        None
                    }
                    KeyStatus::Unknown => {
                        errors.push(format!(
                            "signing key '{}' has a missing or unrecognized status; refusing to verify",
                            sig.kid
                        ));
                        None
                    }
                }
            }
        }
    }
}

fn verify_receipt_inner(
    receipt_value: &Value,
    verification_keys: VerificationKeys<'_>,
) -> Result<VerifyReport, VerifyError> {
    let receipt: ReceiptV2 = serde_json::from_value(receipt_value.clone())
        .map_err(|e| VerifyError::ParseReceipt(e.to_string()))?;

    if receipt.v != RECEIPT_VERSION && receipt.v != DRAND_RECEIPT_VERSION {
        return Err(VerifyError::UnsupportedVersion(receipt.v));
    }

    let mut errors: Vec<String> = Vec::new();

    // ---- 1. Receipt hash + signature metadata + signature (soft) -----------
    let mut valid_signature = false;
    match &receipt.sig {
        Some(sig_block) => {
            let mut metadata_ok = true;
            if sig_block.alg != "Ed25519" {
                metadata_ok = false;
                errors.push(format!("sig.alg '{}' != 'Ed25519'", sig_block.alg));
            }
            if sig_block.canon != "JCS/RFC8785" {
                metadata_ok = false;
                errors.push(format!("sig.canon '{}' != 'JCS/RFC8785'", sig_block.canon));
            }
            // Decision (intentional, not version-scoped): every signed receipt of
            // BOTH current versions (`truerolls-1` and `truerolls-drand-1`) is emitted
            // with a `receipt_hash` by every signer (kd-api, kd-worker-wasm, sign.rs),
            // so a signed receipt without one is rejected by design. Hashless signed
            // receipts are treated as deprecated, not accepted-for-compatibility. This
            // is strictly stricter: it can only reject, never bless a forgery.
            match expected_receipt_hash(receipt_value) {
                Ok(expected_hash) => match receipt.receipt_hash.as_deref() {
                    Some(claimed) if claimed == expected_hash => {}
                    Some(claimed) => {
                        metadata_ok = false;
                        errors.push(format!(
                            "receipt_hash mismatch: expected {expected_hash}, claimed {claimed}"
                        ));
                    }
                    None => {
                        metadata_ok = false;
                        errors.push(
                            "receipt_hash is required for signed receipts (both current versions emit it)".to_string(),
                        );
                    }
                },
                Err(e) => {
                    metadata_ok = false;
                    errors.push(format!("receipt_hash error: {e}"));
                }
            }
            if metadata_ok
                && let Some(public_key_b64) =
                    verification_keys.public_key_for_sig(sig_block, &mut errors)
            {
                match verify_ed25519_sig(receipt_value, &sig_block.signature_b64, public_key_b64) {
                    Ok(true) => valid_signature = true,
                    Ok(false) => errors.push("Ed25519 signature verification FAILED".to_string()),
                    Err(e) => errors.push(format!("signature error: {e}")),
                }
            }
        }
        None => errors.push("receipt has no signature block".to_string()),
    }

    // ---- 2. Drand proof / sampling seed -------------------------------------
    let drbg_bytes = hex::decode(&receipt.proof.rng.drbg_key_hex)
        .map_err(|e| VerifyError::BadDrbgHex(e.to_string()))?;
    if drbg_bytes.len() != 32 {
        return Err(VerifyError::BadDrbgLen(drbg_bytes.len()));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&drbg_bytes);

    let mut valid_drand = true;
    if receipt.v == DRAND_RECEIPT_VERSION {
        match verify_drand_seed(&receipt) {
            Ok(derived_seed) => {
                if derived_seed == seed {
                    seed = derived_seed;
                } else {
                    valid_drand = false;
                    errors.push(
                        "drand-derived seed does not match proof.rng.drbg_key_hex".to_string(),
                    );
                    seed = derived_seed;
                }
            }
            Err(e) => {
                valid_drand = false;
                errors.push(format!("drand proof FAILED: {e}"));
            }
        }
    }

    // ---- 3. Sampling: seed -> ChaCha20 -> next_u64 --------------------------
    let mut rng = ChaCha20Rng::from_seed(seed);
    let replayed_draw = rng.next_u64();

    let claimed_draw: u64 = receipt
        .proof
        .draw_u64
        .parse()
        .map_err(|_| VerifyError::BadDraw)?;

    let valid_sampling = replayed_draw == claimed_draw;
    if !valid_sampling {
        errors.push(format!(
            "draw_u64 mismatch: replayed={replayed_draw}, claimed={claimed_draw}"
        ));
    }

    // ---- 4. Version gate + recompute distribution/face ----------------------
    if receipt.proof.math_param_version != kd_core::PARAM_VERSION {
        return Err(VerifyError::ParamVersionMismatch {
            got: receipt.proof.math_param_version.clone(),
            current: kd_core::PARAM_VERSION.to_string(),
        });
    }

    let faces = parse_die(&receipt.die)?;
    let (recomp_face, recomp_alpha, recomp_kl, recomp_ev) =
        recompute(faces, receipt.kappa, claimed_draw)?;

    let face_ok = recomp_face as i32 == receipt.face;
    if !face_ok {
        errors.push(format!(
            "face mismatch: recomputed={recomp_face}, receipt={}",
            receipt.face
        ));
    }

    // ---- 5. Metrics ---------------------------------------------------------
    let tol = METRIC_TOL;
    let metrics_ok = (recomp_alpha - receipt.alpha).abs() <= tol
        && (recomp_kl - receipt.kl).abs() <= tol
        && (recomp_ev - receipt.ev).abs() <= tol;
    if !metrics_ok {
        if (recomp_alpha - receipt.alpha).abs() > tol {
            errors.push(format!(
                "alpha: recomputed={recomp_alpha}, receipt={}",
                receipt.alpha
            ));
        }
        if (recomp_kl - receipt.kl).abs() > tol {
            errors.push(format!(
                "kl: recomputed={recomp_kl}, receipt={}",
                receipt.kl
            ));
        }
        if (recomp_ev - receipt.ev).abs() > tol {
            errors.push(format!(
                "ev: recomputed={recomp_ev}, receipt={}",
                receipt.ev
            ));
        }
    }

    Ok(VerifyReport {
        valid_signature,
        valid_drand,
        valid_sampling,
        face_ok,
        metrics_ok,
        recomputed_face: recomp_face,
        recomputed_alpha: recomp_alpha,
        recomputed_kl: recomp_kl,
        recomputed_ev: recomp_ev,
        tol,
        errors,
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Verify the Ed25519 signature over the JCS-canonicalized receipt body with
/// `sig` and `receipt_hash` removed. `Err` is a usage error (bad key/sig
/// encoding); `Ok(false)` is a genuine signature mismatch.
fn verify_ed25519_sig(
    receipt_value: &Value,
    sig_b64: &str,
    public_key_b64: &str,
) -> Result<bool, String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};

    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("public key is not valid base64: {e}"))?;
    if pk_bytes.len() != 32 {
        return Err(format!(
            "public key must be 32 bytes, got {}",
            pk_bytes.len()
        ));
    }
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().unwrap();
    let vk = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| format!("invalid Ed25519 public key: {e}"))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(sig_b64)
        .map_err(|e| format!("sig is not valid base64: {e}"))?;
    if sig_bytes.len() != 64 {
        return Err(format!("sig must be 64 bytes, got {}", sig_bytes.len()));
    }
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().unwrap();
    let signature = Signature::from_bytes(&sig_arr);

    // The signature covers the shared canonicalization (body WITHOUT sig and
    // receipt_hash), the exact bytes `ReceiptSigner::sign_receipt` signed.
    let canonical_bytes = canonical_signing_bytes(receipt_value)?;

    match vk.verify_strict(&canonical_bytes, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

fn expected_receipt_hash(receipt_value: &Value) -> Result<String, String> {
    let canonical_bytes = canonical_signing_bytes(receipt_value)?;
    let digest = Sha256::digest(&canonical_bytes);
    Ok(format!("sha256:{}", hex::encode(digest)))
}

fn verify_drand_seed(receipt: &ReceiptV2) -> Result<[u8; 32], VerifyError> {
    let proof = receipt
        .proof
        .drand
        .as_ref()
        .ok_or(VerifyError::MissingDrandProof)?;

    if proof.chain_hash != kd_drand::QUICKNET_CHAIN_HASH {
        return Err(VerifyError::Core(format!(
            "drand chain_hash '{}' != pinned '{}'",
            proof.chain_hash,
            kd_drand::QUICKNET_CHAIN_HASH
        )));
    }
    if proof.scheme != kd_drand::QUICKNET_SCHEME {
        return Err(VerifyError::Core(format!(
            "drand scheme '{}' != pinned '{}'",
            proof.scheme,
            kd_drand::QUICKNET_SCHEME
        )));
    }
    if proof.public_key != kd_drand::QUICKNET_PUBLIC_KEY_HEX {
        return Err(VerifyError::Core(
            "drand public key does not match pinned quicknet key".to_string(),
        ));
    }
    if proof.period_seconds != kd_drand::QUICKNET_PERIOD_SECONDS {
        return Err(VerifyError::Core(
            "drand period_seconds does not match pinned quicknet period".to_string(),
        ));
    }
    if proof.genesis_time != kd_drand::QUICKNET_GENESIS_TIME {
        return Err(VerifyError::Core(
            "drand genesis_time does not match pinned quicknet genesis".to_string(),
        ));
    }
    if proof.target_delay_rounds != kd_drand::DEFAULT_TARGET_DELAY_ROUNDS {
        return Err(VerifyError::Core(format!(
            "target_delay_rounds {} != {}",
            proof.target_delay_rounds,
            kd_drand::DEFAULT_TARGET_DELAY_ROUNDS
        )));
    }
    if receipt.proof.rng.algo != kd_drand::RNG_ALGO {
        return Err(VerifyError::Core(format!(
            "rng algo '{}' != '{}'",
            receipt.proof.rng.algo,
            kd_drand::RNG_ALGO
        )));
    }
    if proof.client_nonce.len() != 64
        || !proof
            .client_nonce
            .as_bytes()
            .iter()
            .all(u8::is_ascii_hexdigit)
    {
        return Err(VerifyError::Core(
            "client_nonce must be 32 random bytes encoded as 64 hex characters".to_string(),
        ));
    }

    kd_drand::validate_target_round(proof.client_observed_round, proof.target_round)
        .map_err(|e| VerifyError::Core(e.to_string()))?;

    let client_observed = kd_drand::DrandPulse {
        chain_hash: proof.chain_hash.clone(),
        round: proof.client_observed_round,
        signature_hex: proof.client_observed_signature_hex.clone(),
        randomness_hex: proof.client_observed_randomness_hex.clone(),
    };
    client_observed
        .verify_quicknet()
        .map_err(|e| VerifyError::Core(e.to_string()))?;

    let target = kd_drand::DrandPulse {
        chain_hash: proof.chain_hash.clone(),
        round: proof.target_round,
        signature_hex: proof.target_signature_hex.clone(),
        randomness_hex: proof.target_randomness_hex.clone(),
    };
    target
        .verify_quicknet()
        .map_err(|e| VerifyError::Core(e.to_string()))?;

    let input = kd_drand::DrandSeedInput {
        target_pulse: target,
        client_nonce: proof.client_nonce.clone(),
        die: receipt.die.clone(),
        kappa: receipt.kappa,
        idem_payload_sha256_hex: proof.idem_payload_sha256_hex.clone(),
    };
    kd_drand::derive_roll_seed(&input).map_err(|e| VerifyError::Core(e.to_string()))
}

/// Parse a die string ("d4".."d100") to its face count.
fn parse_die(s: &str) -> Result<u32, VerifyError> {
    let s = s.trim().to_lowercase();
    let stripped = s.strip_prefix('d').unwrap_or(&s);
    let n: u32 = stripped
        .parse()
        .map_err(|_| VerifyError::UnsupportedDie(format!("d{stripped}")))?;
    match n {
        4 | 6 | 8 | 10 | 12 | 20 | 100 => Ok(n),
        _ => Err(VerifyError::UnsupportedDie(format!("d{n}"))),
    }
}

/// Recompute `(face, alpha, kl, ev)` from `kd_core` for the given die.
fn recompute(faces: u32, kappa: f64, draw: u64) -> Result<(u32, f64, f64, f64), VerifyError> {
    macro_rules! go {
        ($n:literal) => {{
            let params = default_for_die($n);
            let out = compute_distribution::<$n>(Die::<$n>, kappa, &params)
                .map_err(|e| VerifyError::Core(e.to_string()))?;
            let idx = prefix_cdf_index_from_u64::<$n>(&out.probs, draw);
            Ok(((idx + 1) as u32, out.alpha, out.kl, out.ev))
        }};
    }
    match faces {
        4 => go!(4),
        6 => go!(6),
        8 => go!(8),
        10 => go!(10),
        12 => go!(12),
        20 => go!(20),
        100 => go!(100),
        _ => Err(VerifyError::UnsupportedDie(format!("d{faces}"))),
    }
}

// ---------------------------------------------------------------------------
// Tests, exercised against the committed receipt goldens (bit-for-bit proof).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::path::Path;

    fn test_public_key_b64() -> String {
        // The shared PUBLIC test seed ([`PUBLISHED_TEST_SEED_HEX`]), one source of
        // truth across the signer, kd-cli's gen_goldens, and these tests.
        let seed_bytes = hex::decode(PUBLISHED_TEST_SEED_HEX).unwrap();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes())
    }

    fn golden(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("goldens")
            .join(name);
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&content).unwrap()
    }

    #[test]
    fn clean_receipt_golden_verifies_valid() {
        let report = verify_receipt(
            &golden("golden_receipt_01_d20.json"),
            &test_public_key_b64(),
        )
        .expect("clean receipt is verifiable");
        assert!(report.valid_signature, "signature: {:?}", report.errors);
        assert!(report.valid_sampling, "sampling: {:?}", report.errors);
        assert!(report.face_ok, "face: {:?}", report.errors);
        assert!(report.metrics_ok, "metrics: {:?}", report.errors);
        assert!(report.is_valid());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.to_result_json()["verdict"], "VALID");
    }

    #[test]
    fn tampered_face_golden_verifies_invalid() {
        let report = verify_receipt(
            &golden("golden_receipt_02_d20_tampered_face.json"),
            &test_public_key_b64(),
        )
        .expect("tampered receipt is still structurally verifiable");
        // Tampering the face changes the signed body AND the face check.
        assert!(
            !report.valid_signature,
            "tampered body must break the signature"
        );
        assert!(
            !report.face_ok,
            "recomputed face must not match the tampered face"
        );
        assert!(!report.is_valid());
        assert_eq!(report.to_result_json()["verdict"], "INVALID");
    }

    #[test]
    fn tampered_draw_breaks_sampling() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["proof"]["draw_u64"] = json!("123456789");
        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();
        assert!(
            !report.valid_sampling,
            "draw no longer matches the DRBG replay"
        );
        // Signature also breaks because draw_u64 is part of the signed body.
        assert!(!report.valid_signature);
        assert!(!report.is_valid());
    }

    #[test]
    fn tampered_kappa_breaks_metrics() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["kappa"] = json!(-0.9);
        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();
        assert!(
            !report.metrics_ok,
            "recomputed metrics must differ at the new kappa"
        );
        assert!(!report.valid_signature, "kappa is part of the signed body");
        assert!(!report.is_valid());
    }

    #[test]
    fn missing_signature_block_is_invalid_not_error() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt.as_object_mut().unwrap().remove("sig");
        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();
        assert!(!report.valid_signature);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("no signature block"))
        );
        // Sampling/face/metrics still verified on the unsigned body.
        assert!(report.valid_sampling);
        assert!(report.face_ok);
        assert!(!report.is_valid());
    }

    #[test]
    fn wrong_public_key_fails_signature_softly() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        // A valid but different key (all-zero is a valid Ed25519 point encoding).
        let wrong_key = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        receipt["kappa"] = receipt["kappa"].clone(); // no body change
        let report = verify_receipt(&receipt, &wrong_key).unwrap();
        assert!(
            !report.valid_signature,
            "signature must not verify under the wrong key"
        );
        // The non-signature checks are independent of the key and still pass.
        assert!(report.valid_sampling);
        assert!(report.face_ok);
        assert!(report.metrics_ok);
    }

    #[test]
    fn forged_receipt_hash_is_invalid() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["receipt_hash"] = json!("sha256:".to_string() + &"00".repeat(32));

        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();

        assert!(!report.valid_signature);
        assert!(!report.is_valid());
        assert!(
            report.errors.iter().any(|e| e.contains("receipt_hash")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn missing_receipt_hash_is_invalid_for_current_receipts() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt.as_object_mut().unwrap().remove("receipt_hash");

        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();

        assert!(!report.valid_signature);
        assert!(!report.is_valid());
        assert!(
            report.errors.iter().any(|e| e.contains("receipt_hash")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn wrong_signature_metadata_is_invalid() {
        let mut wrong_alg = golden("golden_receipt_01_d20.json");
        wrong_alg["sig"]["alg"] = json!("Ed25519ph");
        let alg_report = verify_receipt(&wrong_alg, &test_public_key_b64()).unwrap();
        assert!(!alg_report.valid_signature);
        assert!(
            alg_report.errors.iter().any(|e| e.contains("sig.alg")),
            "{:?}",
            alg_report.errors
        );

        let mut wrong_canon = golden("golden_receipt_01_d20.json");
        wrong_canon["sig"]["canon"] = json!("serde_json");
        let canon_report = verify_receipt(&wrong_canon, &test_public_key_b64()).unwrap();
        assert!(!canon_report.valid_signature);
        assert!(
            canon_report.errors.iter().any(|e| e.contains("sig.canon")),
            "{:?}",
            canon_report.errors
        );
    }

    #[test]
    fn unsupported_version_is_hard_error() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["v"] = json!("truerolls-0");
        let err = verify_receipt(&receipt, &test_public_key_b64()).unwrap_err();
        assert_eq!(
            err,
            VerifyError::UnsupportedVersion("truerolls-0".to_string())
        );
        assert!(err.to_string().contains("unsupported receipt version"));
    }

    #[test]
    fn bad_param_version_is_hard_error() {
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["proof"]["math_param_version"] = json!("roll.math.v0");
        let err = verify_receipt(&receipt, &test_public_key_b64()).unwrap_err();
        assert!(matches!(err, VerifyError::ParamVersionMismatch { .. }));
    }

    #[test]
    fn str_wrapper_round_trips() {
        let json = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("goldens")
                .join("golden_receipt_01_d20.json"),
        )
        .unwrap();
        let report = verify_receipt_str(&json, &test_public_key_b64()).unwrap();
        assert!(report.is_valid());
    }

    #[test]
    fn kappa_out_of_range_receipt_is_refused_not_valid() {
        // A receipt claiming κ outside the [-1, 1] contract must NOT verify VALID.
        // The verifier recomputes via kd_core, which now rejects out-of-range κ,
        // so the receipt is structurally unverifiable (a hard error), the signer
        // (kd-api) and verifier share this one kd_core check and cannot drift.
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["kappa"] = json!(50.0);
        let err = verify_receipt(&receipt, &test_public_key_b64()).unwrap_err();
        assert!(
            matches!(err, VerifyError::Core(_)),
            "out-of-range κ must hard-fail recompute; got {err:?}"
        );
        assert!(err.to_string().contains("kappa out of range"));
    }

    #[test]
    fn tampered_die_breaks_face_and_metrics_independently() {
        // Swapping the die (a signed field, κ in range) breaks the signature
        // AND the recomputed face/metrics for the wrong die independently
        // disagree, three layers reject the swap. Verdict INVALID (not a hard
        // error, since κ stays within the contract).
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["die"] = json!("d6");
        let report = verify_receipt(&receipt, &test_public_key_b64()).unwrap();
        assert!(!report.valid_signature, "die is part of the signed body");
        assert!(!report.face_ok, "a d20 face (10) is unreachable on a d6");
        assert!(!report.metrics_ok, "d6 caps/metrics differ from d20");
        assert!(!report.is_valid());
        assert_eq!(report.to_result_json()["verdict"], "INVALID");
    }

    #[test]
    fn structurally_broken_receipts_hard_error_never_valid() {
        let pk = test_public_key_b64();
        // (a) non-hex DRBG key
        let mut bad_hex = golden("golden_receipt_01_d20.json");
        bad_hex["proof"]["rng"]["drbg_key_hex"] = json!("zz".repeat(32));
        assert!(matches!(
            verify_receipt(&bad_hex, &pk),
            Err(VerifyError::BadDrbgHex(_))
        ));
        // (b) wrong-length DRBG key (30 bytes, not 32), guards a seed-length
        // mishandling that would change the ChaCha20 replay.
        let mut bad_len = golden("golden_receipt_01_d20.json");
        bad_len["proof"]["rng"]["drbg_key_hex"] = json!("ab".repeat(30));
        assert!(matches!(
            verify_receipt(&bad_len, &pk),
            Err(VerifyError::BadDrbgLen(30))
        ));
        // (c) non-numeric draw
        let mut bad_draw = golden("golden_receipt_01_d20.json");
        bad_draw["proof"]["draw_u64"] = json!("not-a-number");
        assert!(matches!(
            verify_receipt(&bad_draw, &pk),
            Err(VerifyError::BadDraw)
        ));
    }

    #[test]
    fn malformed_die_token_reports_cleanly_without_doubled_d() {
        // A non-numeric die token hard-errors with a single-'d' label.
        let mut receipt = golden("golden_receipt_01_d20.json");
        receipt["die"] = json!("dx");
        let err = verify_receipt(&receipt, &test_public_key_b64()).unwrap_err();
        assert!(matches!(err, VerifyError::UnsupportedDie(_)));
        let msg = err.to_string();
        assert!(msg.contains("dx") && !msg.contains("ddx"), "got: {msg}");
    }

    fn quicknet_pulse(round: u64) -> kd_drand::DrandPulse {
        match round {
            121 => kd_drand::DrandPulse {
                chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
                round,
                signature_hex: "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd".to_string(),
                randomness_hex: "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f".to_string(),
            },
            123 => kd_drand::DrandPulse {
                chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
                round,
                signature_hex: "b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92".to_string(),
                randomness_hex: "fb8f7bc29bf24db51871ec8c79f3a1e4bd0557bc0dfcee9ed1d924e69d1c60dc".to_string(),
            },
            _ => panic!("no fixture for round {round}"),
        }
    }

    fn signed_drand_receipt() -> Value {
        use kd_core::{
            die::Die, distribution::compute_distribution, params::default_for_die,
            sample::prefix_cdf_index_from_u64,
        };
        use rand_chacha::ChaCha20Rng;
        use rand_core::{RngCore, SeedableRng};

        let client_observed = quicknet_pulse(121);
        let target = quicknet_pulse(123);
        let seed_input = kd_drand::DrandSeedInput {
            target_pulse: target.clone(),
            client_nonce: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(),
            die: "d20".to_string(),
            kappa: 0.6,
            idem_payload_sha256_hex: "11".repeat(32),
        };
        let drbg = kd_drand::derive_roll_seed(&seed_input).unwrap();
        let draw = ChaCha20Rng::from_seed(drbg).next_u64();
        let params = default_for_die(20);
        let out = compute_distribution::<20>(Die::<20>, 0.6, &params).unwrap();
        let face = (prefix_cdf_index_from_u64::<20>(&out.probs, draw) + 1) as u64;

        let body = json!({
            "v": kd_drand::DRAND_RECEIPT_VERSION,
            "id": "00000000-0000-0000-0000-00000000d123",
            "die": "d20",
            "kappa": 0.6,
            "face": face,
            "alpha": out.alpha,
            "kl": out.kl,
            "ev": out.ev,
            "created_at": "2026-01-01T00:00:00Z",
            "transcript_url": "/v1/roll/x/transcript",
            "proof": {
                "math_param_version": kd_core::PARAM_VERSION,
                "rng": {
                    "drbg_key_hex": hex::encode(drbg),
                    "algo": kd_drand::RNG_ALGO
                },
                "draw_u64": draw.to_string(),
                "drand": {
                    "chain_hash": kd_drand::QUICKNET_CHAIN_HASH,
                    "scheme": kd_drand::QUICKNET_SCHEME,
                    "public_key": kd_drand::QUICKNET_PUBLIC_KEY_HEX,
                    "period_seconds": kd_drand::QUICKNET_PERIOD_SECONDS,
                    "genesis_time": kd_drand::QUICKNET_GENESIS_TIME,
                    "target_delay_rounds": kd_drand::DEFAULT_TARGET_DELAY_ROUNDS,
                    "client_nonce": seed_input.client_nonce,
                    "client_observed_round": client_observed.round,
                    "client_observed_signature_hex": client_observed.signature_hex,
                    "client_observed_randomness_hex": client_observed.randomness_hex,
                    "target_round": target.round,
                    "target_signature_hex": target.signature_hex,
                    "target_randomness_hex": target.randomness_hex,
                    "idem_payload_sha256_hex": seed_input.idem_payload_sha256_hex
                }
            },
        });

        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_HEX, "test-kid-1".to_string())
                .unwrap();
        let (sig, receipt_hash) = signer.sign_receipt(&body).unwrap();
        let mut receipt = body;
        let obj = receipt.as_object_mut().unwrap();
        obj.insert("receipt_hash".into(), json!(receipt_hash));
        obj.insert("sig".into(), serde_json::to_value(&sig).unwrap());
        receipt
    }

    fn resign_receipt_with(mut receipt: Value, signer: &ReceiptSigner) -> Value {
        let obj = receipt.as_object_mut().expect("receipt object");
        obj.remove("receipt_hash");
        obj.remove("sig");
        let (sig, receipt_hash) = signer.sign_receipt(&receipt).unwrap();
        let obj = receipt.as_object_mut().expect("receipt object");
        obj.insert("receipt_hash".into(), json!(receipt_hash));
        obj.insert("sig".into(), serde_json::to_value(&sig).unwrap());
        receipt
    }

    #[test]
    fn key_set_verifier_accepts_retired_kid() {
        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_2_HEX, "test-kid-2".to_string())
                .unwrap();
        let receipt = resign_receipt_with(signed_drand_receipt(), &signer);
        let mut key = signer.public_key_entry();
        key.status = KeyStatus::Retired;

        let report =
            verify_receipt_with_key_set(&receipt, &[key]).expect("retired receipt is verifiable");

        assert!(report.is_valid(), "{:?}", report.errors);
        assert!(report.valid_signature, "{:?}", report.errors);
    }

    #[test]
    fn key_set_verifier_rejects_revoked_kid_with_reason() {
        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_2_HEX, "test-kid-2".to_string())
                .unwrap();
        let receipt = resign_receipt_with(signed_drand_receipt(), &signer);
        let mut key = signer.public_key_entry();
        key.status = KeyStatus::Revoked;

        let report =
            verify_receipt_with_key_set(&receipt, &[key]).expect("revoked receipt is structural");

        assert!(!report.is_valid());
        assert!(!report.valid_signature);
        assert!(
            report.errors.iter().any(|e| e.contains("revoked")),
            "expected explicit revoked-key reason, got {:?}",
            report.errors
        );
    }

    #[test]
    fn key_set_verifier_fails_closed_on_missing_status() {
        // A revoked key that loses its `status` field (older serializer, hand-edited
        // static /.well-known, tooling that strips optional fields) must NOT silently
        // re-activate: a status-less entry deserializes to KeyStatus::Unknown and
        // refuses to verify, distinct from a known Revoked entry.
        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_2_HEX, "test-kid-2".to_string())
                .unwrap();
        let receipt = resign_receipt_with(signed_drand_receipt(), &signer);
        let entry = signer.public_key_entry();
        let mut without_status =
            serde_json::to_value(&entry).expect("entry serializes to an object");
        without_status.as_object_mut().unwrap().remove("status");
        let parsed: PublicKeyEntry =
            serde_json::from_value(without_status).expect("status is optional at parse time");
        assert_eq!(parsed.status, KeyStatus::Unknown);

        let report = verify_receipt_with_key_set(&receipt, &[parsed])
            .expect("status-less receipt is structural");
        assert!(!report.is_valid());
        assert!(!report.valid_signature);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("missing or unrecognized status")),
            "expected fail-closed status reason, got {:?}",
            report.errors
        );
    }

    #[test]
    fn key_set_verifier_rejects_unknown_kid_without_fallback() {
        let receipt = signed_drand_receipt();
        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_2_HEX, "test-kid-2".to_string())
                .unwrap();
        let mut key = signer.public_key_entry();
        key.status = KeyStatus::Active;

        let report = verify_receipt_with_key_set(&receipt, &[key])
            .expect("unknown kid receipt is structural");

        assert!(!report.is_valid());
        assert!(!report.valid_signature);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("unknown signing kid")),
            "expected explicit unknown-kid reason, got {:?}",
            report.errors
        );
    }

    #[test]
    fn key_set_verifier_rejects_duplicate_matching_kid() {
        let receipt = signed_drand_receipt();
        let signer =
            ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_HEX, "test-kid-1".to_string())
                .unwrap();
        let key = signer.public_key_entry();

        let report = verify_receipt_with_key_set(&receipt, &[key.clone(), key])
            .expect("duplicate-kid receipt is structurally verifiable");

        assert!(!report.is_valid());
        assert!(!report.valid_signature);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("duplicate signing kid")),
            "expected explicit duplicate-kid reason, got {:?}",
            report.errors
        );
    }

    #[test]
    fn signed_drand_receipt_verifies_valid() {
        let receipt = signed_drand_receipt();
        let report =
            verify_receipt(&receipt, &test_public_key_b64()).expect("drand receipt verifies");
        assert!(report.valid_signature, "{:?}", report.errors);
        assert!(report.valid_drand, "{:?}", report.errors);
        assert!(report.valid_sampling, "{:?}", report.errors);
        assert!(report.face_ok, "{:?}", report.errors);
        assert!(report.metrics_ok, "{:?}", report.errors);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn api_envelope_deduplicated_field_is_not_part_of_signature() {
        let mut receipt = signed_drand_receipt();
        receipt["deduplicated"] = json!(false);

        let report =
            verify_receipt(&receipt, &test_public_key_b64()).expect("drand receipt verifies");
        assert!(report.valid_signature, "{:?}", report.errors);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn signed_drand_receipt_rejects_target_round_tamper() {
        let mut receipt = signed_drand_receipt();
        receipt["proof"]["drand"]["target_round"] = json!(124);
        let report = verify_receipt(&receipt, &test_public_key_b64()).expect("structural receipt");
        assert!(!report.valid_signature, "target round is signed");
        assert!(
            !report.valid_drand,
            "target round mismatch must fail drand proof"
        );
        assert!(!report.is_valid());
    }

    #[test]
    fn signed_drand_receipt_rejects_client_nonce_tamper() {
        let mut receipt = signed_drand_receipt();
        receipt["proof"]["drand"]["client_nonce"] =
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        let report = verify_receipt(&receipt, &test_public_key_b64()).expect("structural receipt");
        assert!(!report.valid_signature, "client nonce is signed");
        assert!(
            !report.valid_drand,
            "client nonce change must change derived seed"
        );
        assert!(!report.is_valid());
    }

    #[test]
    fn signed_drand_receipt_ignores_forged_drbg_key_for_sampling() {
        let mut receipt = signed_drand_receipt();
        receipt["proof"]["rng"]["drbg_key_hex"] = json!("00".repeat(32));

        let report = verify_receipt(&receipt, &test_public_key_b64()).expect("structural receipt");
        assert!(
            !report.valid_signature,
            "drbg_key_hex is part of the signed body"
        );
        assert!(
            !report.valid_drand,
            "forged drbg_key_hex must fail the drand-derived seed equality"
        );
        assert!(
            report.valid_sampling,
            "sampling must replay from the derived drand seed, not the forged drbg_key_hex"
        );
        assert!(
            report.face_ok,
            "face must also replay from the derived seed"
        );
        assert!(!report.is_valid());
    }
}
