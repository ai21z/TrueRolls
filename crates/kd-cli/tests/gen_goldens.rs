//! KD-026 — Golden fixture generator (ignored by default; run explicitly).
//!
//! Regenerates EVERY file in `goldens/`:
//!
//! ```text
//! cargo test -p kd-cli --test gen_goldens -- --ignored
//! ```
//!
//! Determinism contract: running the generator twice must produce
//! byte-identical files. All inputs are fixed — seeds, the receipt id, the
//! `created_at` timestamp, the drbg key, and the PUBLIC test signing seed
//! (the same seed used by kd-api's `signing.rs` unit tests; it is committed
//! to the repo on purpose and must NEVER be used in production). Ed25519
//! signing is deterministic (RFC 8032), and serde_json prints floats via
//! shortest-round-trip, so re-serialization is stable.
//!
//! Output format: pretty-printed JSON with sorted keys plus a trailing
//! newline. serde_json without the `preserve_order` feature backs
//! `serde_json::Map` with a BTreeMap (verified for this workspace via
//! `cargo tree -p kd-cli -i serde_json -e features` — only `default`,
//! `float_roundtrip`, `std` are unified), so keys are already sorted; the
//! explicit `sort_keys` pass below keeps the output stable even if
//! `preserve_order` is ever unified into the build later.

use assert_cmd::Command;
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey, Verifier as _};
use kd_core::{
    die::Die, distribution::compute_distribution, params::default_for_die,
    sample::prefix_cdf_index_from_u64,
};
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// PUBLIC test signing seed — identical to the one in kd-api
/// `src/services/signing.rs` unit tests. Committed on purpose: it exists so
/// receipt goldens are reproducible by anyone. NEVER a production key.
const TEST_SIGNING_SEED_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_KID: &str = "test-kid-1";

/// Fixed receipt id for golden_receipt_01/02 (valid UUID, recognizable).
const RECEIPT_ID: &str = "00000000-0000-0000-0000-00000000d201";

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("goldens")
}

fn kd() -> Command {
    #[allow(deprecated)]
    Command::cargo_bin("kd").expect("binary 'kd' not found")
}

/// Recursively rebuild every JSON object with keys inserted in sorted order.
/// A no-op with the default BTreeMap backing; insurance against
/// `preserve_order` feature unification.
fn sort_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut sorted = serde_json::Map::new();
            for (k, v) in entries {
                sorted.insert(k, sort_keys(v));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sort_keys).collect()),
        scalar => scalar,
    }
}

/// Write a golden file: pretty JSON, sorted keys, trailing newline.
fn write_golden(name: &str, value: &Value) {
    let pretty = serde_json::to_string_pretty(&sort_keys(value.clone()))
        .expect("golden serialization failed");
    let path = goldens_dir().join(name);
    std::fs::write(&path, format!("{pretty}\n"))
        .unwrap_or_else(|e| panic!("failed to write {}: {e}", path.display()));
    println!("wrote {}", path.display());
}

/// Produce a clean kd.local.v2 transcript by invoking the real `kd` binary.
fn roll_clean(die: &str, kappa: &str, seed: &str) -> Value {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let out_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        kappa,
        "--die",
        die,
        "--seed",
        seed,
        "--output",
        out_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    let content = std::fs::read_to_string(&out_path).expect("failed to read kd output");
    serde_json::from_str(&content).expect("kd wrote invalid JSON")
}

/// Replay the prefix-CDF face from a raw draw — mirrors
/// `kd_core::sample::prefix_cdf_index_from_u64` over a dynamic prob slice.
fn replay_face(probs: &[f64], draw: u64) -> u64 {
    let u = (draw as f64) / ((u64::MAX as f64) + 1.0);
    let mut acc = 0.0;
    for (i, &p) in probs.iter().enumerate() {
        acc += p;
        if u < acc {
            return (i + 1) as u64;
        }
    }
    probs.len() as u64
}

/// Build the valid signed receipt golden (golden_receipt_01_d20).
fn build_receipt_01() -> Value {
    // Deterministic draw: first next_u64() of ChaCha20Rng seeded with the
    // drbg key bytes ([0x42; 32]) — exactly what the CLI/server replay does.
    let drbg_key_hex: String = "42".repeat(32);
    let mut rng = ChaCha20Rng::from_seed([0x42u8; 32]);
    let draw = rng.next_u64();

    // d20 @ κ=0.6 with default params — same math path as kd-api recompute.
    let params = default_for_die(20);
    let out =
        compute_distribution::<20>(Die::<20>, 0.6, &params).expect("compute_distribution failed");
    let face = (prefix_cdf_index_from_u64::<20>(&out.probs, draw) + 1) as u64;

    // Receipt body — everything except sig and receipt_hash (the signature
    // and the hash both cover the JCS canonicalization of this body).
    let body = json!({
        "v": "truerolls-1",
        "id": RECEIPT_ID,
        "die": "d20",
        "kappa": 0.6,
        "face": face,
        "alpha": out.alpha,
        "kl": out.kl,
        "ev": out.ev,
        "created_at": "2026-01-01T00:00:00Z",
        "transcript_url": format!("/v1/roll/{RECEIPT_ID}/transcript"),
        "proof": {
            "math_param_version": "roll.math.v1",
            "rng": {
                "drbg_key_hex": drbg_key_hex,
                "algo": "HKDF(SHA-256)->ChaCha20Rng",
            },
            "draw_u64": draw.to_string(),
        },
    });

    // Sign the JCS canonical bytes with the PUBLIC test key.
    let canonical = serde_jcs::to_vec(&body).expect("JCS canonicalization failed");
    let seed_bytes = hex::decode(TEST_SIGNING_SEED_HEX).expect("test seed hex invalid");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes);
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(&canonical);

    // Self-check: the signature must verify against the derived public key.
    signing_key
        .verifying_key()
        .verify(&canonical, &signature)
        .expect("self-check failed: fresh signature does not verify");

    // Print the DERIVED PUBLIC key only (the consumer tests and README need
    // it); the seed itself is already public in the repo's unit tests.
    let public_key_b64 =
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
    println!("test public key (kid {TEST_KID}): {public_key_b64}");

    let receipt_hash = format!("sha256:{}", hex::encode(Sha256::digest(&canonical)));
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signature.to_bytes());

    let mut receipt = body;
    let obj = receipt.as_object_mut().unwrap();
    obj.insert("receipt_hash".into(), json!(receipt_hash));
    obj.insert(
        "sig".into(),
        json!({
            "alg": "Ed25519",
            "kid": TEST_KID,
            "signature_b64": sig_b64,
            "canon": "JCS/RFC8785",
        }),
    );
    receipt
}

#[test]
#[ignore = "regenerates goldens — run explicitly: cargo test -p kd-cli --test gen_goldens -- --ignored"]
fn regenerate_goldens() {
    let dir = goldens_dir();
    std::fs::create_dir_all(&dir)
        .unwrap_or_else(|e| panic!("cannot create {}: {e}", dir.display()));

    // ---- clean transcripts (produced by the real kd binary) ---------------
    let g01 = roll_clean("d6", "0.6", "1001");
    write_golden("golden_01_d6_k06.json", &g01);

    let g02 = roll_clean("d20", "0.6", "2002");
    write_golden("golden_02_d20_k06.json", &g02);

    let g03 = roll_clean("d100", "0.6", "3003");
    write_golden("golden_03_d100_k06.json", &g03);

    let g07 = roll_clean("d6", "-0.5", "4004");
    write_golden("golden_07_d6_kneg05.json", &g07);

    // ---- tampered transcripts (derived programmatically from golden_01) ---
    let claimed_face = g01["face"].as_u64().expect("golden_01 missing face");

    // 04 — tampered face: rotate to the next in-range face; everything else
    // (probs, draw_u64, metrics) still reflects the honest roll.
    let mut g04 = g01.clone();
    let tampered_face = (claimed_face % 6) + 1;
    assert_ne!(
        tampered_face, claimed_face,
        "face tamper must change the face"
    );
    g04["face"] = json!(tampered_face);
    write_golden("golden_04_d6_tampered_face.json", &g04);

    // 05 — tampered kappa: only κ changes; recomputation from κ=-0.9 yields
    // different probs/alpha/kl/ev (and a different replayed face).
    let mut g05 = g01.clone();
    g05["kappa"] = json!(-0.9);
    write_golden("golden_05_d6_tampered_kappa.json", &g05);

    // 06 — bad math_param_version: the version gate must hard-error before
    // any recomputation.
    let mut g06 = g01.clone();
    g06["math_param_version"] = json!("roll.math.v2_FAKE");
    write_golden("golden_06_d6_bad_version.json", &g06);

    // 08 — tampered draw: keep the claimed face, replace draw_u64 with a
    // draw that replays to a DIFFERENT face. draw=0 replays to face 1; if
    // the claimed face is already 1, u64::MAX replays to the last face.
    let probs: Vec<f64> = g01["probs"]
        .as_array()
        .expect("golden_01 missing probs")
        .iter()
        .map(|p| p.as_f64().expect("probs entry not a number"))
        .collect();
    let tampered_draw: u64 = if replay_face(&probs, 0) != claimed_face {
        0
    } else {
        assert_ne!(
            replay_face(&probs, u64::MAX),
            claimed_face,
            "neither draw 0 nor u64::MAX replays to a different face"
        );
        u64::MAX
    };
    let mut g08 = g01.clone();
    g08["draw_u64"] = json!(tampered_draw.to_string());
    write_golden("golden_08_d6_tampered_draw.json", &g08);

    // 09 — missing draw: face present but unverifiable (no replay possible).
    let mut g09 = g01.clone();
    g09.as_object_mut().unwrap().remove("draw_u64");
    write_golden("golden_09_d6_missing_draw.json", &g09);

    // ---- receipt goldens ---------------------------------------------------
    let receipt_01 = build_receipt_01();
    write_golden("golden_receipt_01_d20.json", &receipt_01);

    // 02 — tampered receipt face: bump the face (1-based mod 20) but keep the
    // ORIGINAL signature, so both the Ed25519 check and the face recompute
    // must fail.
    let receipt_face = receipt_01["face"]
        .as_u64()
        .expect("receipt_01 missing face");
    let mut receipt_02 = receipt_01.clone();
    receipt_02["face"] = json!((receipt_face % 20) + 1);
    assert_ne!(receipt_02["face"], receipt_01["face"]);
    write_golden("golden_receipt_02_d20_tampered_face.json", &receipt_02);
}
