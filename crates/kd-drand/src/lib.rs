use drand_verify::{G2PubkeyRfc, Pubkey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use std::fmt;

pub const DRAND_RECEIPT_VERSION: &str = "truerolls-drand-1";
pub const QUICKNET_CHAIN_HASH: &str =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const QUICKNET_SCHEME: &str = "bls-unchained-g1-rfc9380";
pub const QUICKNET_PUBLIC_KEY_HEX: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
pub const QUICKNET_PERIOD_SECONDS: u64 = 3;
pub const QUICKNET_GENESIS_TIME: u64 = 1_692_803_367;
pub const DEFAULT_TARGET_DELAY_ROUNDS: u64 = 2;
pub const RNG_ALGO: &str = "drand-quicknet+HKDF(SHA-256)->ChaCha20Rng";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrandError {
    ChainHashMismatch {
        got: String,
    },
    BadHex {
        field: &'static str,
        error: String,
    },
    BadLength {
        field: &'static str,
        got: usize,
        want: usize,
    },
    BadPublicKey(String),
    BadSignature,
    RandomnessMismatch {
        expected: String,
        got: String,
    },
    TargetRoundOverflow {
        observed: u64,
    },
    TargetRoundMismatch {
        observed: u64,
        target: u64,
        expected: u64,
    },
    Canonicalization(String),
    Hkdf(String),
}

impl fmt::Display for DrandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DrandError::ChainHashMismatch { got } => {
                write!(
                    f,
                    "drand chain hash mismatch: got {got}, expected {QUICKNET_CHAIN_HASH}"
                )
            }
            DrandError::BadHex { field, error } => write!(f, "{field} is not valid hex: {error}"),
            DrandError::BadLength { field, got, want } => {
                write!(f, "{field} must decode to {want} bytes, got {got}")
            }
            DrandError::BadPublicKey(e) => write!(f, "invalid pinned drand public key: {e}"),
            DrandError::BadSignature => write!(f, "drand BLS signature verification failed"),
            DrandError::RandomnessMismatch { expected, got } => {
                write!(
                    f,
                    "drand randomness mismatch: expected {expected}, got {got}"
                )
            }
            DrandError::TargetRoundOverflow { observed } => write!(
                f,
                "client_observed_round {observed} cannot add target delay {DEFAULT_TARGET_DELAY_ROUNDS}"
            ),
            DrandError::TargetRoundMismatch {
                observed,
                target,
                expected,
            } => write!(
                f,
                "target_round {target} does not equal client_observed_round {observed} + {DEFAULT_TARGET_DELAY_ROUNDS} (expected {expected})"
            ),
            DrandError::Canonicalization(e) => write!(f, "JCS canonicalization failed: {e}"),
            DrandError::Hkdf(e) => write!(f, "HKDF expand failed: {e}"),
        }
    }
}

impl std::error::Error for DrandError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DrandPulse {
    pub chain_hash: String,
    pub round: u64,
    pub signature_hex: String,
    pub randomness_hex: String,
}

impl DrandPulse {
    pub fn verify_quicknet(&self) -> Result<(), DrandError> {
        if self.chain_hash != QUICKNET_CHAIN_HASH {
            return Err(DrandError::ChainHashMismatch {
                got: self.chain_hash.clone(),
            });
        }

        let signature = decode_hex_exact("signature_hex", &self.signature_hex, 48)?;
        let expected_randomness = drand_verify::derive_randomness(&signature);
        let expected_randomness_hex = hex::encode(expected_randomness);
        if expected_randomness_hex != self.randomness_hex {
            return Err(DrandError::RandomnessMismatch {
                expected: expected_randomness_hex,
                got: self.randomness_hex.clone(),
            });
        }

        let pk_bytes = decode_hex_exact("quicknet public key", QUICKNET_PUBLIC_KEY_HEX, 96)?;
        let pk_arr: [u8; 96] = pk_bytes
            .as_slice()
            .try_into()
            .expect("length checked above");
        let pk =
            G2PubkeyRfc::from_fixed(pk_arr).map_err(|e| DrandError::BadPublicKey(e.to_string()))?;
        match pk.verify(self.round, b"", &signature) {
            Ok(true) => Ok(()),
            Ok(false) => Err(DrandError::BadSignature),
            Err(_) => Err(DrandError::BadSignature),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DrandSeedInput {
    pub target_pulse: DrandPulse,
    pub client_nonce: String,
    pub die: String,
    pub kappa: f64,
    pub idem_payload_sha256_hex: String,
}

pub fn target_round_from_observed(client_observed_round: u64) -> u64 {
    client_observed_round.saturating_add(DEFAULT_TARGET_DELAY_ROUNDS)
}

pub fn quicknet_round_at_unix_seconds(unix_seconds: u64) -> u64 {
    if unix_seconds < QUICKNET_GENESIS_TIME {
        0
    } else {
        ((unix_seconds - QUICKNET_GENESIS_TIME) / QUICKNET_PERIOD_SECONDS) + 1
    }
}

pub fn validate_target_round(
    client_observed_round: u64,
    target_round: u64,
) -> Result<(), DrandError> {
    let expected = client_observed_round
        .checked_add(DEFAULT_TARGET_DELAY_ROUNDS)
        .ok_or(DrandError::TargetRoundOverflow {
            observed: client_observed_round,
        })?;
    if target_round == expected {
        Ok(())
    } else {
        Err(DrandError::TargetRoundMismatch {
            observed: client_observed_round,
            target: target_round,
            expected,
        })
    }
}

pub fn randomness_from_signature_hex(signature_hex: &str) -> Result<String, DrandError> {
    let signature = decode_hex_exact("signature_hex", signature_hex, 48)?;
    Ok(hex::encode(drand_verify::derive_randomness(&signature)))
}

pub fn derive_roll_seed(input: &DrandSeedInput) -> Result<[u8; 32], DrandError> {
    input.target_pulse.verify_quicknet()?;
    let randomness = decode_hex_exact("randomness_hex", &input.target_pulse.randomness_hex, 32)?;
    let salt = decode_hex_exact(
        "idem_payload_sha256_hex",
        &input.idem_payload_sha256_hex,
        32,
    )?;
    let info = hkdf_info(input)?;
    let hk = Hkdf::<Sha256>::new(Some(&salt), &randomness);
    let mut okm = [0u8; 32];
    hk.expand(&info, &mut okm)
        .map_err(|e| DrandError::Hkdf(e.to_string()))?;
    Ok(okm)
}

pub fn hkdf_info(input: &DrandSeedInput) -> Result<Vec<u8>, DrandError> {
    let info = json!([
        DRAND_RECEIPT_VERSION,
        QUICKNET_CHAIN_HASH,
        input.target_pulse.round,
        input.die,
        input.kappa,
        input.client_nonce,
        input.idem_payload_sha256_hex
    ]);
    serde_jcs::to_vec(&info).map_err(|e| DrandError::Canonicalization(e.to_string()))
}

fn decode_hex_exact(field: &'static str, value: &str, want: usize) -> Result<Vec<u8>, DrandError> {
    let bytes = hex::decode(value).map_err(|e| DrandError::BadHex {
        field,
        error: e.to_string(),
    })?;
    if bytes.len() == want {
        Ok(bytes)
    } else {
        Err(DrandError::BadLength {
            field,
            got: bytes.len(),
            want,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUICKNET_ROUND_123_SIG: &str = "b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92";
    const QUICKNET_ROUND_123_RANDOMNESS: &str =
        "fb8f7bc29bf24db51871ec8c79f3a1e4bd0557bc0dfcee9ed1d924e69d1c60dc";

    fn round_123() -> DrandPulse {
        DrandPulse {
            chain_hash: QUICKNET_CHAIN_HASH.to_string(),
            round: 123,
            signature_hex: QUICKNET_ROUND_123_SIG.to_string(),
            randomness_hex: QUICKNET_ROUND_123_RANDOMNESS.to_string(),
        }
    }

    #[test]
    fn quicknet_fixture_verifies_and_derives_randomness() {
        let pulse = round_123();
        pulse.verify_quicknet().expect("round 123 must verify");
        assert_eq!(
            randomness_from_signature_hex(QUICKNET_ROUND_123_SIG).unwrap(),
            QUICKNET_ROUND_123_RANDOMNESS
        );
    }

    #[test]
    fn wrong_round_signature_and_randomness_reject() {
        let mut wrong_round = round_123();
        wrong_round.round = 124;
        assert!(wrong_round.verify_quicknet().is_err());

        let mut wrong_sig = round_123();
        wrong_sig.signature_hex = format!(
            "{}00",
            &wrong_sig.signature_hex[..wrong_sig.signature_hex.len() - 2]
        );
        assert!(wrong_sig.verify_quicknet().is_err());

        let mut wrong_randomness = round_123();
        wrong_randomness.randomness_hex = "00".repeat(32);
        assert!(wrong_randomness.verify_quicknet().is_err());
    }

    #[test]
    fn target_round_is_client_observed_plus_default_delay() {
        assert_eq!(target_round_from_observed(123), 125);
        assert!(validate_target_round(123, 125).is_ok());
        assert!(validate_target_round(123, 126).is_err());
        assert!(matches!(
            validate_target_round(u64::MAX, u64::MAX),
            Err(DrandError::TargetRoundOverflow { .. })
        ));
    }

    #[test]
    fn quicknet_round_at_unix_seconds_matches_pinned_schedule() {
        assert_eq!(quicknet_round_at_unix_seconds(QUICKNET_GENESIS_TIME - 1), 0);
        assert_eq!(quicknet_round_at_unix_seconds(QUICKNET_GENESIS_TIME), 1);
        assert_eq!(
            quicknet_round_at_unix_seconds(QUICKNET_GENESIS_TIME + QUICKNET_PERIOD_SECONDS),
            2
        );
        assert_eq!(
            quicknet_round_at_unix_seconds(QUICKNET_GENESIS_TIME + 125 * QUICKNET_PERIOD_SECONDS),
            126
        );
    }

    #[test]
    fn hkdf_seed_is_stable_and_bound_to_nonce_payload_and_round() {
        let input = DrandSeedInput {
            target_pulse: round_123(),
            client_nonce: "0123456789abcdef0123456789abcdef".to_string(),
            die: "d20".to_string(),
            kappa: 0.6,
            idem_payload_sha256_hex: "11".repeat(32),
        };
        let seed = derive_roll_seed(&input).expect("derive seed");
        assert_eq!(
            hex::encode(seed),
            "66182f1190e253814ba74d22e302a68ff011c09050616e46ef91d32b649579d2"
        );

        let mut changed = input;
        changed.client_nonce = "fedcba9876543210fedcba9876543210".to_string();
        assert_ne!(derive_roll_seed(&changed).unwrap(), seed);
    }
}
