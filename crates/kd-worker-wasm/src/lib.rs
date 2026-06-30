//! kd-worker-wasm, wasm-bindgen bindings for the TrueRolls Cloudflare Worker.
//!
//! One call, [`rollAndSign`], does a full server-side roll: replay the draw from a
//! CSPRNG seed, compute the guarded face + metrics via `kd_core`, then sign the
//! receipt with the shared `kd_receipt` signer, the SAME JCS canonicalization the
//! verifier (browser/CLI) checks, so a Worker receipt verifies bit-for-bit.
//!
//! This crate is **server-side only**. The signing key is supplied per-call from a
//! Worker secret and never leaves the Worker. The browser bundle is the separate
//! `kd-core-wasm` (math preview + verify), sign code never ships to the client.
//!
//! Design mirrors `kd-core-wasm`: a host-testable `*_impl` returning
//! `Result<_, String>` plus a thin `#[wasm_bindgen]` wrapper. The Worker supplies
//! the randomness (Web Crypto -> `drbg_key_hex`), so this crate is deterministic
//! given its inputs and needs no entropy at runtime.

use kd_core::die::Die;
use kd_core::distribution::compute_distribution;
use kd_core::params::default_for_die;
use kd_core::sample::prefix_cdf_index_from_u64;
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use serde_json::json;
use wasm_bindgen::prelude::*;

/// How the published `drbg_key_hex` relates to the draw: the 32-byte key is used
/// directly as the ChaCha20 seed (the Worker draws it from a CSPRNG). The verifier
/// only needs this relationship to replay. It does not depend on how the key was
/// generated. (kd-api uses `HKDF(SHA-256)->ChaCha20Rng`, both replay identically.)
pub const RNG_ALGO: &str = "csprng->ChaCha20Rng";

/// Dispatch a die string ("d4".."d100") to a const-generic call with `N`.
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

/// Replay the 1-based face + guard metrics for a draw at stance `kappa`
/// (every number comes from `kd_core`, this crate adds no math).
fn roll_face<const N: usize>(kappa: f64, draw: u64) -> Result<(u32, f64, f64, f64), String> {
    let params = default_for_die(N);
    let out = compute_distribution::<N>(Die::<N>, kappa, &params).map_err(|e| e.to_string())?;
    let idx = prefix_cdf_index_from_u64::<N>(&out.probs, draw);
    Ok(((idx + 1) as u32, out.alpha, out.kl, out.ev))
}

#[allow(clippy::too_many_arguments)]
fn roll_and_sign_impl(
    die: &str,
    kappa: f64,
    drbg_key_hex: &str,
    id: &str,
    created_at: &str,
    transcript_url: &str,
    secret_hex: &str,
    kid: &str,
) -> Result<String, String> {
    // 1. Replay the draw from the 32-byte CSPRNG seed, identical to the verifier.
    let drbg =
        hex::decode(drbg_key_hex.trim()).map_err(|e| format!("drbg_key_hex not hex: {e}"))?;
    if drbg.len() != 32 {
        return Err(format!(
            "drbg_key_hex must decode to 32 bytes, got {}",
            drbg.len()
        ));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&drbg);
    let draw = ChaCha20Rng::from_seed(seed).next_u64();

    // 2. Guarded face + metrics from kd-core.
    let (face, alpha, kl, ev) = dispatch_die!(die, roll_face, kappa, draw)?;

    // 3. Receipt body (pre-sig), the ReceiptV2 shape kd-api emits and the verifier reads.
    let body = json!({
        "v": kd_receipt::RECEIPT_VERSION,
        "id": id,
        "die": die,
        "kappa": kappa,
        "face": face,
        "alpha": alpha,
        "kl": kl,
        "ev": ev,
        "created_at": created_at,
        "transcript_url": transcript_url,
        "proof": {
            "math_param_version": kd_core::PARAM_VERSION,
            "rng": { "drbg_key_hex": drbg_key_hex, "algo": RNG_ALGO },
            "draw_u64": draw.to_string(),
        },
    });

    // 4. Sign with the shared signer (same JCS canonicalization the verifier checks).
    let signer = kd_receipt::ReceiptSigner::from_hex_seed(secret_hex, kid.to_string())?;
    let (sig, receipt_hash) = signer.sign_receipt(&body)?;

    // 5. Assemble the full receipt.
    let mut receipt = body;
    let obj = receipt
        .as_object_mut()
        .expect("receipt body is a JSON object");
    obj.insert("receipt_hash".into(), json!(receipt_hash));
    obj.insert(
        "sig".into(),
        serde_json::to_value(&sig).map_err(|e| e.to_string())?,
    );
    serde_json::to_string(&receipt).map_err(|e| e.to_string())
}

/// Roll a die and return a signed TrueRolls receipt (JSON string).
///
/// - `die`: "d4".."d100". `kappa`: stance in [-1, 1].
/// - `drbgKeyHex`: 32 random bytes (hex) from the Worker's CSPRNG, the ChaCha20
///   seed the verifier replays.
/// - `id`, `createdAt`, `transcriptUrl`: receipt provenance the Worker supplies.
/// - `secretHex`, `kid`: the Ed25519 signing seed + key id (a Worker secret,
///   never exposed to the browser).
///
/// Returns the full receipt (`{…, receipt_hash, sig}`) the shared verifier accepts
/// as VALID. Throws a `JsError` on bad input (unknown die, non-32-byte key,
/// out-of-range kappa, malformed secret).
#[wasm_bindgen(js_name = rollAndSign)]
#[allow(clippy::too_many_arguments)]
pub fn roll_and_sign(
    die: &str,
    kappa: f64,
    drbg_key_hex: &str,
    id: &str,
    created_at: &str,
    transcript_url: &str,
    secret_hex: &str,
    kid: &str,
) -> Result<String, JsError> {
    roll_and_sign_impl(
        die,
        kappa,
        drbg_key_hex,
        id,
        created_at,
        transcript_url,
        secret_hex,
        kid,
    )
    .map_err(|e| JsError::new(&e))
}

// ---------------------------------------------------------------------------
// Host-side unit tests (run on the native target, not wasm)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = kd_receipt::PUBLISHED_TEST_SEED_HEX;
    const KID: &str = "test-kid-1";

    fn roll(die: &str, kappa: f64, drbg_hex: &str) -> String {
        roll_and_sign_impl(
            die,
            kappa,
            drbg_hex,
            "00000000-0000-0000-0000-00000000d201",
            "2026-01-01T00:00:00Z",
            "/v1/roll/x/transcript",
            SECRET,
            KID,
        )
        .unwrap()
    }

    fn pubkey() -> String {
        kd_receipt::ReceiptSigner::from_hex_seed(SECRET, KID.to_string())
            .unwrap()
            .public_key_entry()
            .public_key
    }

    #[test]
    fn rolled_receipt_verifies_valid() {
        // The Worker signer and the shared verifier agree end-to-end, every die.
        for (die, kappa) in [("d20", 0.6), ("d6", -0.5), ("d100", 0.9), ("d4", 0.0)] {
            let receipt = roll(die, kappa, &"42".repeat(32));
            let report = kd_receipt::verify_receipt_str(&receipt, &pubkey()).unwrap();
            assert!(report.is_valid(), "{die} κ={kappa}: {:?}", report.errors);
            assert!(report.valid_signature && report.valid_sampling);
            assert!(report.face_ok && report.metrics_ok);
        }
    }

    #[test]
    fn rolled_receipt_has_the_expected_shape() {
        let receipt = roll("d20", 0.6, &"42".repeat(32));
        let v: serde_json::Value = serde_json::from_str(&receipt).unwrap();
        assert_eq!(v["v"], "truerolls-1");
        assert_eq!(v["die"], "d20");
        assert_eq!(v["proof"]["rng"]["algo"], RNG_ALGO);
        assert_eq!(v["proof"]["math_param_version"], kd_core::PARAM_VERSION);
        assert!(v["proof"]["rng"]["drbg_key_hex"].as_str().unwrap().len() == 64);
        assert!(v["receipt_hash"].as_str().unwrap().starts_with("sha256:"));
        assert_eq!(v["sig"]["kid"], KID);
        assert_eq!(v["sig"]["alg"], "Ed25519");
        assert!((1..=20).contains(&v["face"].as_u64().unwrap()));
    }

    #[test]
    fn tampering_the_signed_receipt_breaks_verification() {
        let receipt = roll("d20", 0.6, &"42".repeat(32));
        let mut v: serde_json::Value = serde_json::from_str(&receipt).unwrap();
        let f = v["face"].as_u64().unwrap();
        v["face"] = json!((f % 20) + 1); // change the face, keep the original signature
        let report = kd_receipt::verify_receipt_str(&v.to_string(), &pubkey()).unwrap();
        assert!(!report.valid_signature, "tamper must break the signature");
        assert!(
            !report.face_ok,
            "the recomputed face must not match the tamper"
        );
        assert!(!report.is_valid());
    }

    #[test]
    fn bad_inputs_error_cleanly() {
        let k = "42".repeat(32);
        // unsupported die
        assert!(roll_and_sign_impl("d7", 0.5, &k, "i", "t", "u", SECRET, KID).is_err());
        // wrong-length / non-hex drbg key
        assert!(roll_and_sign_impl("d20", 0.5, "abcd", "i", "t", "u", SECRET, KID).is_err());
        // out-of-range kappa (kd-core rejects during compute)
        assert!(roll_and_sign_impl("d20", 50.0, &k, "i", "t", "u", SECRET, KID).is_err());
        // malformed signing secret
        assert!(roll_and_sign_impl("d20", 0.5, &k, "i", "t", "u", "not-hex", KID).is_err());
    }
}
