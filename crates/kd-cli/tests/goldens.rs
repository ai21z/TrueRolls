//! KD-026, Golden consumer tests (run in CI, never ignored).
//!
//! Every `expected_local` verdict in `goldens/goldens.csv` is enforced
//! here by invoking the real `kd` binary against the committed fixtures.
//! If a fixture is missing, regenerate first:
//!
//! ```text
//! cargo test -p kd-cli --test gen_goldens -- --ignored
//! ```

use assert_cmd::Command;
use base64::Engine;
use std::path::Path;

/// PUBLIC test signing seed, identical to the one in kd-api
/// `src/services/signing.rs` unit tests and `tests/gen_goldens.rs`.
/// NEVER a production key.
const TEST_SIGNING_SEED_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn kd() -> Command {
    #[allow(deprecated)]
    Command::cargo_bin("kd").expect("binary 'kd' not found")
}

fn golden(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("goldens")
        .join(name);
    assert!(
        path.is_file(),
        "missing golden fixture {} - regenerate with: cargo test -p kd-cli --test gen_goldens -- --ignored",
        path.display()
    );
    path.to_string_lossy().into_owned()
}

/// Derive the test Ed25519 public key (base64) from the public test seed.
/// Derived in code so the goldens and the tests can never drift apart.
fn test_public_key_b64() -> String {
    let seed_bytes = hex::decode(TEST_SIGNING_SEED_HEX).expect("test seed hex invalid");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes);
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
    base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes())
}

// ---------------------------------------------------------------------------
// Transcript goldens, local CLI verification
// ---------------------------------------------------------------------------

#[test]
fn goldens_clean_verify_ok() {
    for file in [
        "golden_01_d6_k06.json",
        "golden_02_d20_k06.json",
        "golden_03_d100_k06.json",
        "golden_07_d6_kneg05.json",
    ] {
        kd().args(["verify", "--input", &golden(file)])
            .assert()
            .success()
            .stdout(predicates::str::contains("OK"));
    }
}

#[test]
fn goldens_tampered_verify_mismatch() {
    for file in [
        "golden_04_d6_tampered_face.json",
        "golden_05_d6_tampered_kappa.json",
        "golden_08_d6_tampered_draw.json",
    ] {
        kd().args(["verify", "--input", &golden(file)])
            .assert()
            .failure()
            .stdout(predicates::str::contains("MISMATCH"));
    }
}

#[test]
fn golden_missing_draw_unverifiable() {
    kd().args([
        "verify",
        "--input",
        &golden("golden_09_d6_missing_draw.json"),
    ])
    .assert()
    .failure()
    .stdout(predicates::str::contains("unverifiable"));
}

#[test]
fn golden_bad_version_errors() {
    kd().args([
        "verify",
        "--input",
        &golden("golden_06_d6_bad_version.json"),
    ])
    .assert()
    .failure()
    .stderr(predicates::str::contains("version"));
}

// ---------------------------------------------------------------------------
// Receipt goldens, offline signed-receipt verification
// ---------------------------------------------------------------------------

#[test]
fn golden_receipt_valid_offline() {
    kd().args([
        "verify",
        "--receipt",
        &golden("golden_receipt_01_d20.json"),
        "--public-key",
        &test_public_key_b64(),
    ])
    .assert()
    .success()
    .stdout(predicates::str::contains("VALID"));
}

#[test]
fn golden_receipt_tampered_invalid() {
    kd().args([
        "verify",
        "--receipt",
        &golden("golden_receipt_02_d20_tampered_face.json"),
        "--public-key",
        &test_public_key_b64(),
    ])
    .assert()
    .failure()
    .stdout(predicates::str::contains("INVALID"));
}
