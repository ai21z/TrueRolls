//! kd-core-wasm: thin wasm-bindgen wrapper exposing `kd-core` pure math to JavaScript.
//!
//! Design rules:
//! - **Zero math duplication.** Every number comes from `kd_core` (`compute_distribution`,
//!   `default_for_die`, `prefix_cdf_index_from_u64`). This crate only dispatches die strings
//!   to const-generic `N` and serializes results to JSON.
//! - **Host-testable core.** All logic lives in plain-Rust `*_impl` functions returning
//!   `Result<_, String>`; the `#[wasm_bindgen]` exports are thin wrappers converting errors
//!   to `JsError`. Unit tests run on the host target against the `*_impl` functions and
//!   assert *exact* (`f64 ==`) parity with direct `kd_core` calls — same code path,
//!   serde_json f64 round-trips are bit-exact.
//! - kd-core stays untouched; defaults come from `default_for_die(N)` (λ fixed at the
//!   per-die default; no λ override in v1 of these bindings).

use kd_core::die::Die;
use kd_core::distribution::compute_distribution;
use kd_core::params::default_for_die;
use kd_core::sample::prefix_cdf_index_from_u64;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Engine label echoed in every JSON payload so consumers can tell which
/// implementation produced the numbers.
pub const ENGINE_LABEL: &str = "kd-core-wasm-roll.math.v1";

/// Dispatch a die string ("d4".."d100") to a const-generic call with `N`.
/// Unknown die -> Err(String) "unsupported die ...".
macro_rules! dispatch_die {
    ($die:expr, $f:ident $(, $args:expr)*) => {
        match $die {
            "d4" => $f::<4>($($args),*),
            "d6" => $f::<6>($($args),*),
            "d8" => $f::<8>($($args),*),
            "d10" => $f::<10>($($args),*),
            "d12" => $f::<12>($($args),*),
            "d20" => $f::<20>($($args),*),
            "d100" => $f::<100>($($args),*),
            other => Err(format!(
                "unsupported die: {other:?} (expected one of d4, d6, d8, d10, d12, d20, d100)"
            )),
        }
    };
}

/// JSON payload for `computeDistributionJson`.
#[derive(Serialize, Deserialize)]
struct DistributionJson {
    engine: String,
    param_version: String,
    probs: Vec<f64>,
    alpha: f64,
    kl: f64,
    ev: f64,
    guards_applied: bool,
}

/// JSON payload for `computeRollReplayJson` (distribution + deterministic face replay).
#[derive(Serialize, Deserialize)]
struct RollReplayJson {
    engine: String,
    param_version: String,
    probs: Vec<f64>,
    alpha: f64,
    kl: f64,
    ev: f64,
    guards_applied: bool,
    /// 1-based face mapped from `draw_u64` via prefix-CDF.
    face: u32,
    /// The 64-bit draw, stringified (u64 does not fit JSON numbers losslessly).
    draw_u64: String,
}

// ---------------------------------------------------------------------------
// Plain-Rust core (host-testable, Result<_, String>)
// ---------------------------------------------------------------------------

fn distribution_payload<const N: usize>(kappa: f64) -> Result<DistributionJson, String> {
    let params = default_for_die(N);
    let out = compute_distribution::<N>(Die::<N>, kappa, &params).map_err(|e| e.to_string())?;
    Ok(DistributionJson {
        engine: ENGINE_LABEL.to_string(),
        param_version: kd_core::PARAM_VERSION.to_string(),
        probs: out.probs.to_vec(),
        alpha: out.alpha,
        kl: out.kl,
        ev: out.ev,
        guards_applied: out.guards_applied,
    })
}

fn roll_replay_payload<const N: usize>(kappa: f64, draw: u64) -> Result<RollReplayJson, String> {
    let params = default_for_die(N);
    let out = compute_distribution::<N>(Die::<N>, kappa, &params).map_err(|e| e.to_string())?;
    let idx = prefix_cdf_index_from_u64::<N>(&out.probs, draw);
    Ok(RollReplayJson {
        engine: ENGINE_LABEL.to_string(),
        param_version: kd_core::PARAM_VERSION.to_string(),
        probs: out.probs.to_vec(),
        alpha: out.alpha,
        kl: out.kl,
        ev: out.ev,
        guards_applied: out.guards_applied,
        face: (idx + 1) as u32,
        draw_u64: draw.to_string(),
    })
}

fn face_payload<const N: usize>(probs: &[f64], draw: u64) -> Result<u32, String> {
    if probs.len() != N {
        return Err(format!(
            "probs length {} does not match die size {N}",
            probs.len()
        ));
    }
    let mut arr = [0.0_f64; N];
    arr.copy_from_slice(probs);
    let idx = prefix_cdf_index_from_u64::<N>(&arr, draw);
    Ok((idx + 1) as u32)
}

fn compute_distribution_json_impl(die: &str, kappa: f64) -> Result<String, String> {
    let payload = dispatch_die!(die, distribution_payload, kappa)?;
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

fn compute_roll_replay_json_impl(die: &str, kappa: f64, draw: u64) -> Result<String, String> {
    let payload = dispatch_die!(die, roll_replay_payload, kappa, draw)?;
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

fn face_from_draw_impl(die: &str, probs: &[f64], draw: u64) -> Result<u32, String> {
    dispatch_die!(die, face_payload, probs, draw)
}

/// Verify a signed receipt via the shared `kd_receipt` engine (the same code the
/// CLI runs) and serialize the result. Never fails: structurally unverifiable
/// receipts become a `{"verdict":"ERROR","error":...}` payload so the browser
/// always gets a structured answer to render.
fn verify_receipt_json_impl(receipt_json: &str, public_key_b64: &str) -> String {
    match kd_receipt::verify_receipt_str(receipt_json, public_key_b64) {
        Ok(report) => report.to_result_json().to_string(),
        Err(e) => serde_json::json!({ "verdict": "ERROR", "error": e.to_string() }).to_string(),
    }
}

// ---------------------------------------------------------------------------
// wasm-bindgen exports (thin JsError wrappers)
// ---------------------------------------------------------------------------

/// Returns [`ENGINE_LABEL`].
#[wasm_bindgen(js_name = engineLabel)]
pub fn engine_label() -> String {
    ENGINE_LABEL.to_string()
}

/// Returns `kd_core::PARAM_VERSION` ("roll.math.v1").
#[wasm_bindgen(js_name = paramVersion)]
pub fn param_version() -> String {
    kd_core::PARAM_VERSION.to_string()
}

/// Compute the guarded distribution for `die` ("d4".."d100") at stance `kappa`.
/// Returns a JSON string:
/// `{"engine", "param_version", "probs", "alpha", "kl", "ev", "guards_applied"}`.
#[wasm_bindgen(js_name = computeDistributionJson)]
pub fn compute_distribution_json(die: &str, kappa: f64) -> Result<String, JsError> {
    compute_distribution_json_impl(die, kappa).map_err(|e| JsError::new(&e))
}

/// Map a 64-bit draw (JS BigInt) onto `probs` via prefix-CDF; returns the 1-based face.
/// `probs.length` must equal the die size.
#[wasm_bindgen(js_name = faceFromDraw)]
pub fn face_from_draw(die: &str, probs: &[f64], draw: u64) -> Result<u32, JsError> {
    face_from_draw_impl(die, probs, draw).map_err(|e| JsError::new(&e))
}

/// Compute the distribution and replay the face for a 64-bit draw (JS BigInt).
/// Returns the `computeDistributionJson` payload plus `"face"` and `"draw_u64"`
/// (draw stringified).
#[wasm_bindgen(js_name = computeRollReplayJson)]
pub fn compute_roll_replay_json(die: &str, kappa: f64, draw: u64) -> Result<String, JsError> {
    compute_roll_replay_json_impl(die, kappa, draw).map_err(|e| JsError::new(&e))
}

/// Verify a signed TrueRolls receipt entirely client-side — Ed25519 signature,
/// DRBG sampling replay, face, and metric caps — using the shared `kd_receipt`
/// engine (identical to `kd verify --receipt`).
///
/// - `receiptJson`: the raw receipt JSON string.
/// - `publicKeyB64`: base64 of the 32-byte Ed25519 verifying key (from
///   `/.well-known/truerolls-keys.json`).
///
/// Returns a JSON string:
/// `{"verdict": "VALID"|"INVALID"|"ERROR", "valid_signature", "valid_sampling",
///   "face_ok", "metrics_ok", "details", "errors"}`. `ERROR` (with an `error`
/// field) is returned for structurally unverifiable input. Never throws.
#[wasm_bindgen(js_name = verifyReceiptJson)]
pub fn verify_receipt_json(receipt_json: &str, public_key_b64: &str) -> String {
    verify_receipt_json_impl(receipt_json, public_key_b64)
}

// ---------------------------------------------------------------------------
// Host-side unit tests (run on the native target, not wasm)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Direct kd-core reference, same dispatch as the bindings.
    fn reference_output<const N: usize>(
        kappa: f64,
    ) -> Result<(Vec<f64>, f64, f64, f64, bool), String> {
        let out = compute_distribution::<N>(Die::<N>, kappa, &default_for_die(N))
            .map_err(|e| e.to_string())?;
        Ok((
            out.probs.to_vec(),
            out.alpha,
            out.kl,
            out.ev,
            out.guards_applied,
        ))
    }

    fn reference_for(die: &str, kappa: f64) -> (Vec<f64>, f64, f64, f64, bool) {
        dispatch_die!(die, reference_output, kappa).unwrap()
    }

    /// All supported dice, kappa grid including negative and zero stances.
    const CASES: &[(&str, f64)] = &[
        ("d4", 0.6),
        ("d6", 0.0),
        ("d6", 0.6),
        ("d6", -1.0),
        ("d8", 0.25),
        ("d10", -0.4),
        ("d12", 1.0),
        ("d20", -0.5),
        ("d20", 0.85),
        ("d100", 0.9),
        ("d100", -0.75),
    ];

    #[test]
    fn engine_label_embeds_param_version() {
        assert!(ENGINE_LABEL.ends_with(kd_core::PARAM_VERSION));
        assert_eq!(param_version(), kd_core::PARAM_VERSION);
        assert_eq!(engine_label(), ENGINE_LABEL);
    }

    #[test]
    fn distribution_json_exactly_matches_kd_core() {
        for &(die, kappa) in CASES {
            let json = compute_distribution_json_impl(die, kappa).unwrap();
            let (probs, alpha, kl, ev, guards) = reference_for(die, kappa);

            // Byte-exact JSON: ryu serialization of the reference must match.
            let expected = serde_json::to_string(&DistributionJson {
                engine: ENGINE_LABEL.to_string(),
                param_version: kd_core::PARAM_VERSION.to_string(),
                probs: probs.clone(),
                alpha,
                kl,
                ev,
                guards_applied: guards,
            })
            .unwrap();
            assert_eq!(json, expected, "{die} κ={kappa} JSON bytes");

            // Exact f64 equality after round-trip (dev-dep float_roundtrip
            // gives correctly rounded parsing, like JS JSON.parse).
            let parsed: DistributionJson = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed.engine, ENGINE_LABEL, "{die} κ={kappa}");
            assert_eq!(parsed.param_version, kd_core::PARAM_VERSION);
            assert_eq!(parsed.probs, probs, "{die} κ={kappa} probs");
            assert_eq!(parsed.alpha, alpha, "{die} κ={kappa} alpha");
            assert_eq!(parsed.kl, kl, "{die} κ={kappa} kl");
            assert_eq!(parsed.ev, ev, "{die} κ={kappa} ev");
            assert_eq!(parsed.guards_applied, guards, "{die} κ={kappa} guards");
        }
    }

    #[test]
    fn face_from_draw_edge_draws_agree_with_prefix_cdf() {
        // d6, shaped distribution; draws 0 and u64::MAX.
        let out6 = compute_distribution::<6>(Die::<6>, 0.6, &default_for_die(6)).unwrap();
        for draw in [0_u64, u64::MAX] {
            let expected = (prefix_cdf_index_from_u64::<6>(&out6.probs, draw) + 1) as u32;
            let got = face_from_draw_impl("d6", &out6.probs, draw).unwrap();
            assert_eq!(got, expected, "d6 draw={draw}");
        }
        // d20, negative stance; same edges plus a mid draw.
        let out20 = compute_distribution::<20>(Die::<20>, -0.5, &default_for_die(20)).unwrap();
        for draw in [0_u64, u64::MAX / 2, u64::MAX] {
            let expected = (prefix_cdf_index_from_u64::<20>(&out20.probs, draw) + 1) as u32;
            let got = face_from_draw_impl("d20", &out20.probs, draw).unwrap();
            assert_eq!(got, expected, "d20 draw={draw}");
        }
        // Sanity on the edges themselves: draw 0 -> face 1, draw MAX -> face N.
        assert_eq!(face_from_draw_impl("d6", &out6.probs, 0).unwrap(), 1);
        assert_eq!(face_from_draw_impl("d6", &out6.probs, u64::MAX).unwrap(), 6);
    }

    #[test]
    fn roll_replay_json_matches_compute_plus_prefix_cdf() {
        let draw = 12_345_678_901_234_567_890_u64;
        for &(die, kappa) in &[("d6", 0.6), ("d20", -0.5), ("d100", 0.9)] {
            let json = compute_roll_replay_json_impl(die, kappa, draw).unwrap();
            let parsed: RollReplayJson = serde_json::from_str(&json).unwrap();
            let (probs, alpha, kl, ev, guards) = reference_for(die, kappa);

            assert_eq!(parsed.engine, ENGINE_LABEL);
            assert_eq!(parsed.param_version, kd_core::PARAM_VERSION);
            assert_eq!(parsed.probs, probs);
            assert_eq!(parsed.alpha, alpha);
            assert_eq!(parsed.kl, kl);
            assert_eq!(parsed.ev, ev);
            assert_eq!(parsed.guards_applied, guards);
            assert_eq!(parsed.draw_u64, draw.to_string());

            let expected_face = face_from_draw_impl(die, &probs, draw).unwrap();
            assert_eq!(parsed.face, expected_face, "{die} κ={kappa} face");
        }
    }

    #[test]
    fn unsupported_die_errors() {
        for bad in ["d7", "D6", "", "6", "d", "d1000"] {
            let err = compute_distribution_json_impl(bad, 0.5).unwrap_err();
            assert!(err.contains("unsupported die"), "{bad}: {err}");
            let err = face_from_draw_impl(bad, &[0.5, 0.5], 0).unwrap_err();
            assert!(err.contains("unsupported die"), "{bad}: {err}");
            let err = compute_roll_replay_json_impl(bad, 0.5, 1).unwrap_err();
            assert!(err.contains("unsupported die"), "{bad}: {err}");
        }
    }

    #[test]
    fn face_from_draw_rejects_wrong_probs_length() {
        let err = face_from_draw_impl("d6", &[0.5, 0.5], 0).unwrap_err();
        assert!(err.contains("does not match die size 6"), "{err}");
        let err = face_from_draw_impl("d4", &[0.25; 5], 0).unwrap_err();
        assert!(err.contains("does not match die size 4"), "{err}");
    }

    #[test]
    fn non_finite_kappa_propagates_core_error() {
        assert!(compute_distribution_json_impl("d6", f64::NAN).is_err());
        assert!(compute_roll_replay_json_impl("d20", f64::INFINITY, 0).is_err());
    }

    // --- verifyReceiptJson: the browser verifier IS the kd_receipt engine ----

    /// PUBLIC test signing seed (never production) — same as the goldens.
    const TEST_SIGNING_SEED_HEX: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn test_public_key_b64() -> String {
        use base64::Engine;
        let seed_bytes = hex::decode(TEST_SIGNING_SEED_HEX).unwrap();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().as_bytes())
    }

    fn golden_str(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("goldens")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn verify_receipt_json_matches_kd_receipt_exactly() {
        // The wasm wrapper must add nothing: its output bytes equal the shared
        // engine's to_result_json() for the same inputs.
        let pk = test_public_key_b64();
        let receipt = golden_str("golden_receipt_01_d20.json");
        let wrapper = verify_receipt_json_impl(&receipt, &pk);
        let direct = kd_receipt::verify_receipt_str(&receipt, &pk)
            .unwrap()
            .to_result_json()
            .to_string();
        assert_eq!(wrapper, direct);
    }

    #[test]
    fn verify_receipt_json_clean_golden_is_valid() {
        let out = verify_receipt_json_impl(
            &golden_str("golden_receipt_01_d20.json"),
            &test_public_key_b64(),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["verdict"], "VALID");
        assert_eq!(v["valid_signature"], true);
        assert_eq!(v["valid_sampling"], true);
        assert_eq!(v["face_ok"], true);
        assert_eq!(v["metrics_ok"], true);
    }

    #[test]
    fn verify_receipt_json_tampered_golden_is_invalid() {
        let out = verify_receipt_json_impl(
            &golden_str("golden_receipt_02_d20_tampered_face.json"),
            &test_public_key_b64(),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["verdict"], "INVALID");
        assert_eq!(v["valid_signature"], false);
        assert_eq!(v["face_ok"], false);
    }

    #[test]
    fn verify_receipt_json_unverifiable_is_error_not_panic() {
        // Malformed JSON and unsupported version both yield a structured ERROR.
        let bad_json = verify_receipt_json_impl("{not json", "");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&bad_json).unwrap()["verdict"],
            "ERROR"
        );
        let mut r: serde_json::Value =
            serde_json::from_str(&golden_str("golden_receipt_01_d20.json")).unwrap();
        r["v"] = serde_json::json!("truerolls-0");
        let bad_ver = verify_receipt_json_impl(&r.to_string(), &test_public_key_b64());
        let v: serde_json::Value = serde_json::from_str(&bad_ver).unwrap();
        assert_eq!(v["verdict"], "ERROR");
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .contains("unsupported receipt version")
        );
    }
}
