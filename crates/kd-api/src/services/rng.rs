use hkdf::Hkdf;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
pub struct RngProvenance {
    pub algo: &'static str, // "HKDF(SHA-256)->ChaCha20Rng"
    pub info_label: &'static str,
    pub salt_source: &'static str, // "env:KD_RNG_SALT" | "none"
    pub inputs: RngInputs,
    /// The 32-byte derived key (hex). Included in receipts so verifiers can
    /// replay the ChaCha20 draw deterministically. NOT the raw IKM.
    #[serde(skip_serializing)]
    pub drbg_key: [u8; 32],
}

#[derive(Debug, Serialize)]
pub struct RngInputs {
    pub idem_key_hash12: String,      // redacted
    pub payload_sha256_hex12: String, // redacted
    pub user_seed_sha256_hex12: Option<String>,
}

/// Construct a deterministic, Send ChaCha20Rng from (idem_key, payload_sha, user_seed?, salt?)
/// Also returns a provenance payload for transcript embedding.
pub fn rng_for_roll(
    idem_key: &str,
    payload_sha256: &[u8],
    user_seed: Option<&str>,
    rng_salt_opt: Option<&str>,
) -> (ChaCha20Rng, RngProvenance) {
    // Build IKM: idem_key || 0x00 || payload_sha || 0x00 || user_seed?
    let mut ikm = Vec::with_capacity(
        idem_key.len() + 1 + payload_sha256.len() + 1 + user_seed.map(|s| s.len()).unwrap_or(0),
    );
    ikm.extend_from_slice(idem_key.as_bytes());
    ikm.push(0);
    ikm.extend_from_slice(payload_sha256);
    if let Some(s) = user_seed {
        ikm.push(0);
        ikm.extend_from_slice(s.as_bytes());
    }

    // HKDF-SHA256
    let salt_source = if rng_salt_opt.is_some() {
        "env:KD_RNG_SALT"
    } else {
        "none"
    };
    let hk = Hkdf::<Sha256>::new(rng_salt_opt.map(|s| s.as_bytes()), &ikm);
    let info_label = "kd-roll-v1";
    let mut okm = [0u8; 32];
    hk.expand(info_label.as_bytes(), &mut okm)
        .expect("HKDF expand");

    let rng = ChaCha20Rng::from_seed(okm);

    let prov = RngProvenance {
        algo: "HKDF(SHA-256)->ChaCha20Rng",
        info_label,
        salt_source,
        inputs: RngInputs {
            idem_key_hash12: short_hash_hex(idem_key),
            payload_sha256_hex12: short_hex12(payload_sha256),
            user_seed_sha256_hex12: user_seed.map(|s| short_hex12(&sha256(s.as_bytes()))),
        },
        drbg_key: okm,
    };

    (rng, prov)
}

// ---------- helpers ----------

fn short_hash_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let digest = h.finalize();
    hex12(&digest)
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn hex12(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(12);
    for b in bytes.iter().take(6) {
        use core::fmt::Write;
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

fn short_hex12(bytes: &[u8]) -> String {
    hex12(bytes)
}
