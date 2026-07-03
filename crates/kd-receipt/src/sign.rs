//! Ed25519 receipt signing, the signer half of the shared receipt crate.
//!
//! Signing lives in the same crate as verification on purpose: both go through
//! [`crate::canonical_signing_bytes`], so the bytes a signature covers can never
//! drift between the signer and the verifier (a verifier that drifts from the
//! signer is worse than no verifier). Ed25519 signing is deterministic
//! (RFC 8032) and the key is derived from a fixed seed, so this needs no entropy
//! source and compiles to `wasm32-unknown-unknown`, the Cloudflare Worker can
//! sign with the exact same code `kd-api` runs.

use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The PUBLIC test signing seed (hex). Published in the goldens, these tests, and
/// the loom-demo demo key, safe to embed, but NEVER valid in production. The
/// SIG-2 guard ([`reject_test_signer_in_prod`]) blocks it under `KD_ENV=prod`.
/// Single source of truth: the verifier tests, kd-cli's gen_goldens, and kd-api's
/// boot guard all reference this one const so they cannot drift.
pub const PUBLISHED_TEST_SEED_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Second PUBLIC test signing seed for rotation tests. Published and safe to
/// embed, but NEVER valid in production.
pub const PUBLISHED_TEST_SEED_2_HEX: &str =
    "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

/// Public verifying key derived from [`PUBLISHED_TEST_SEED_HEX`]. Published for
/// bundled samples and goldens only. Production must refuse it even under a
/// renamed kid or a retired/revoked status.
pub const PUBLISHED_TEST_PUBLIC_KEY_B64: &str = "IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=";

/// Public verifying key derived from [`PUBLISHED_TEST_SEED_2_HEX`].
pub const PUBLISHED_TEST_PUBLIC_KEY_2_B64: &str = "QycWCxDM++7wJJeyTQHm3h8dNWxhPllY98M8wkVLFrQ=";

/// Key-ids known to belong to published TEST keys, refused in production.
pub const TEST_KIDS: &[&str] = &["test-kid-1", "test-kid-2"];

/// Public verifying keys known to belong to published TEST keys, refused in
/// production whether active, retired, or revoked.
pub const TEST_PUBLIC_KEYS_B64: &[&str] = &[
    PUBLISHED_TEST_PUBLIC_KEY_B64,
    PUBLISHED_TEST_PUBLIC_KEY_2_B64,
];

/// SIG-2 guard. Call ONLY under the production profile. Returns `Err` (which
/// aborts boot) when the configured signer is the published TEST seed, a
/// published TEST kid, or absent, so a leaked dev key can never sign forgeable
/// production receipts. Never logs seed bytes.
pub fn reject_test_signer_in_prod(
    secret_hex: Option<&str>,
    kid: Option<&str>,
) -> Result<(), String> {
    match (secret_hex, kid) {
        (Some(secret), Some(kid)) => {
            // Compare DECODED bytes so hex case / surrounding whitespace cannot bypass.
            let decoded_secret = hex::decode(secret.trim()).ok();
            let is_test_seed = decoded_secret.as_ref().is_some_and(|secret_bytes| {
                [PUBLISHED_TEST_SEED_HEX, PUBLISHED_TEST_SEED_2_HEX]
                    .iter()
                    .any(|test_hex| hex::decode(test_hex).is_ok_and(|b| b == *secret_bytes))
            });
            if is_test_seed {
                return Err(
                    "refusing to start: the configured signing seed is a published TEST seed; \
                     set a real KD_SIGNING_ED25519_SECRET for KD_ENV=prod"
                        .to_string(),
                );
            }
            if TEST_KIDS.iter().any(|t| t.eq_ignore_ascii_case(kid.trim())) {
                return Err(format!(
                    "refusing to start: signing kid '{kid}' is a published TEST kid; \
                     use a real production kid"
                ));
            }
            Ok(())
        }
        _ => Err(
            "refusing to start: production requires KD_SIGNING_ED25519_SECRET and KD_SIGNING_KID"
                .to_string(),
        ),
    }
}

/// SIG-2 guard for public key material. Call ONLY under the production profile
/// after normal base64/length validation. Returns `Err` when a configured
/// well-known verifier key is one of the published TEST keys, even if the kid is
/// renamed or the entry is retired/revoked.
pub fn reject_test_public_key_in_prod(
    public_key_b64: &str,
    kid: Option<&str>,
) -> Result<(), String> {
    let decoded_public_key = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64.trim())
        .ok();
    let is_test_public_key = decoded_public_key.as_ref().is_some_and(|public_key_bytes| {
        TEST_PUBLIC_KEYS_B64.iter().any(|test_b64| {
            base64::engine::general_purpose::STANDARD
                .decode(test_b64)
                .is_ok_and(|test_bytes| test_bytes == *public_key_bytes)
        })
    });

    if is_test_public_key {
        let kid = kid.unwrap_or("<unknown>").trim();
        return Err(format!(
            "refusing to start: signing kid '{kid}' uses a published TEST public key; \
             use a real production key"
        ));
    }

    Ok(())
}

/// Holds the signing key, verifying key, and key-id. Built once at startup from
/// a hex seed via [`ReceiptSigner::from_hex_seed`].
#[derive(Clone)]
pub struct ReceiptSigner {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
    pub kid: String,
}

/// Signature block attached to a receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptSignature {
    pub alg: String,
    pub kid: String,
    pub signature_b64: String, // base64 of the 64-byte Ed25519 signature
    pub canon: String,         // "JCS/RFC8785"
}

/// One entry returned by /.well-known/truerolls-keys.json
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStatus {
    #[default]
    Active,
    Retired,
    Revoked,
}

/// One entry returned by /.well-known/truerolls-keys.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicKeyEntry {
    pub kid: String,
    pub alg: String,
    pub public_key: String, // base64-encoded 32-byte Ed25519 verifying key
    #[serde(default)]
    pub status: KeyStatus,
}

impl ReceiptSigner {
    /// Construct from a hex-encoded 32-byte seed + key ID string.
    pub fn from_hex_seed(hex_seed: &str, kid: String) -> Result<Self, String> {
        let bytes = hex::decode(hex_seed.trim())
            .map_err(|e| format!("KD_SIGNING_ED25519_SECRET is not valid hex: {e}"))?;
        if bytes.len() != 32 {
            return Err(format!(
                "KD_SIGNING_ED25519_SECRET must be 32 bytes (64 hex chars), got {}",
                bytes.len()
            ));
        }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&bytes);
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        Ok(Self {
            signing_key,
            verifying_key,
            kid,
        })
    }

    /// Sign a receipt body (the JSON value WITHOUT the `sig`/`receipt_hash`
    /// fields, [`crate::canonical_signing_bytes`] strips them defensively).
    /// Returns the [`ReceiptSignature`] and the `sha256:<hex>` receipt hash, both
    /// over the SAME canonical bytes the verifier checks.
    pub fn sign_receipt(
        &self,
        body: &serde_json::Value,
    ) -> Result<(ReceiptSignature, String), String> {
        let canonical_bytes = crate::canonical_signing_bytes(body)?;

        // receipt_hash = sha256 of the canonical bytes.
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(&canonical_bytes);
        let receipt_hash = format!("sha256:{}", hex::encode(hash));

        let signature = self.signing_key.sign(&canonical_bytes);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());
        Ok((
            ReceiptSignature {
                alg: "Ed25519".to_string(),
                kid: self.kid.clone(),
                signature_b64: sig_b64,
                canon: "JCS/RFC8785".to_string(),
            },
            receipt_hash,
        ))
    }

    /// Return the public key entry for the well-known endpoint.
    pub fn public_key_entry(&self) -> PublicKeyEntry {
        let pk_b64 =
            base64::engine::general_purpose::STANDARD.encode(self.verifying_key.as_bytes());
        PublicKeyEntry {
            kid: self.kid.clone(),
            alg: "Ed25519".to_string(),
            public_key: pk_b64,
            status: KeyStatus::Active,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_signer() -> ReceiptSigner {
        ReceiptSigner::from_hex_seed(PUBLISHED_TEST_SEED_HEX, "test-kid-1".to_string()).unwrap()
    }

    #[test]
    fn sign_receipt_is_wellformed() {
        let signer = test_signer();
        let body = json!({
            "v": "truerolls-1",
            "id": "00000000-0000-0000-0000-000000000001",
            "die": "d20",
            "kappa": 0.6,
            "face": 14,
            "alpha": 0.5803,
            "kl": 0.0204,
            "ev": 11.6532,
        });

        let (sig, receipt_hash) = signer.sign_receipt(&body).unwrap();
        assert_eq!(sig.alg, "Ed25519");
        assert_eq!(sig.kid, "test-kid-1");
        assert_eq!(sig.canon, "JCS/RFC8785");
        assert_eq!(
            sig.signature_b64.len(),
            88,
            "base64 of a 64-byte Ed25519 sig"
        );
        assert!(receipt_hash.starts_with("sha256:"));
    }

    #[test]
    fn public_key_entry_format() {
        let signer = test_signer();
        let entry = signer.public_key_entry();
        assert_eq!(entry.kid, "test-kid-1");
        assert_eq!(entry.alg, "Ed25519");
        // base64-encoded 32-byte key = 44 chars
        assert_eq!(entry.public_key.len(), 44);
    }

    /// The clincher: a receipt signed by THIS crate's signer verifies VALID under
    /// THIS crate's verifier. Both share [`crate::canonical_signing_bytes`], so they
    /// cannot drift. Builds a structurally honest d20 receipt via `kd_core` (the
    /// same math the verifier recomputes) so the legacy receipt checks pass.
    #[test]
    fn sign_then_verify_roundtrip_is_valid() {
        use kd_core::{
            die::Die, distribution::compute_distribution, params::default_for_die,
            sample::prefix_cdf_index_from_u64,
        };
        use rand_chacha::ChaCha20Rng;
        use rand_core::{RngCore, SeedableRng};

        let drbg = [0x42u8; 32];
        let draw = ChaCha20Rng::from_seed(drbg).next_u64();
        let params = default_for_die(20);
        let out = compute_distribution::<20>(Die::<20>, 0.6, &params).unwrap();
        let face = (prefix_cdf_index_from_u64::<20>(&out.probs, draw) + 1) as u64;

        let body = json!({
            "v": "truerolls-1",
            "id": "00000000-0000-0000-0000-00000000d201",
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
                "rng": { "drbg_key_hex": hex::encode(drbg), "algo": "HKDF(SHA-256)->ChaCha20Rng" },
                "draw_u64": draw.to_string(),
            },
        });

        let signer = test_signer();
        let (sig, receipt_hash) = signer.sign_receipt(&body).unwrap();
        let mut receipt = body;
        let obj = receipt.as_object_mut().unwrap();
        obj.insert("receipt_hash".into(), json!(receipt_hash));
        obj.insert("sig".into(), serde_json::to_value(&sig).unwrap());

        let pk = signer.public_key_entry().public_key;
        let report = crate::verify_receipt(&receipt, &pk).expect("structurally verifiable");
        assert!(
            report.is_valid(),
            "sign<->verify must round-trip VALID; errors: {:?}",
            report.errors
        );
        assert!(report.valid_signature);
        assert!(report.valid_sampling);
        assert!(report.face_ok);
        assert!(report.metrics_ok);
    }

    // ---- SIG-2: production test-seed guard ----------------------------------
    // A fresh, never-published 32-byte seed (64 hex chars) used as the "real" prod key.
    const FRESH_SEED_HEX: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn sig2_prod_rejects_published_test_seed() {
        let r = reject_test_signer_in_prod(Some(PUBLISHED_TEST_SEED_HEX), Some("truerolls-prod-1"));
        assert!(r.is_err(), "published test seed must be refused in prod");
        // The error must never leak the seed bytes.
        assert!(
            !r.unwrap_err().contains(PUBLISHED_TEST_SEED_HEX),
            "error message must not contain the seed"
        );
    }

    #[test]
    fn sig2_prod_rejects_test_kid() {
        let r = reject_test_signer_in_prod(Some(FRESH_SEED_HEX), Some("test-kid-1"));
        assert!(
            r.is_err(),
            "a published test kid must be refused even with a fresh seed"
        );
    }

    #[test]
    fn sig2_prod_rejects_published_test_public_key() {
        let r =
            reject_test_public_key_in_prod(PUBLISHED_TEST_PUBLIC_KEY_B64, Some("truerolls-prod-1"));
        assert!(
            r.is_err(),
            "a published test public key must be refused even with a fresh kid"
        );
        assert!(
            !r.unwrap_err().contains(PUBLISHED_TEST_PUBLIC_KEY_B64),
            "error message must not contain the public key"
        );
    }

    #[test]
    fn sig2_prod_rejects_second_published_test_public_key() {
        assert!(
            reject_test_public_key_in_prod(
                PUBLISHED_TEST_PUBLIC_KEY_2_B64,
                Some("truerolls-prod-2"),
            )
            .is_err(),
            "the second published test public key must also be refused"
        );
    }

    #[test]
    fn sig2_prod_rejects_missing_signer() {
        assert!(
            reject_test_signer_in_prod(None, None).is_err(),
            "prod must sign"
        );
        assert!(reject_test_signer_in_prod(Some(FRESH_SEED_HEX), None).is_err());
        assert!(reject_test_signer_in_prod(None, Some("truerolls-prod-1")).is_err());
    }

    #[test]
    fn sig2_prod_accepts_fresh_signer() {
        let r = reject_test_signer_in_prod(Some(FRESH_SEED_HEX), Some("truerolls-prod-1"));
        assert!(r.is_ok(), "a fresh seed + non-test kid must boot: {r:?}");
    }

    #[test]
    fn sig2_blocklist_normalizes_case_and_whitespace() {
        // Uppercased hex wrapped in whitespace still decodes to the known-bad bytes.
        let upper_ws = format!("  {}  ", PUBLISHED_TEST_SEED_HEX.to_ascii_uppercase());
        assert!(
            reject_test_signer_in_prod(Some(&upper_ws), Some("truerolls-prod-1")).is_err(),
            "case/whitespace must not bypass the seed blocklist"
        );
        let public_ws = format!("  {PUBLISHED_TEST_PUBLIC_KEY_B64}  ");
        assert!(
            reject_test_public_key_in_prod(&public_ws, Some("truerolls-prod-1")).is_err(),
            "whitespace must not bypass the public-key blocklist"
        );
        // Mixed-case, padded test kid still blocked.
        assert!(
            reject_test_signer_in_prod(Some(FRESH_SEED_HEX), Some("  Test-Kid-1 ")).is_err(),
            "case/whitespace must not bypass the kid blocklist"
        );
    }
}
