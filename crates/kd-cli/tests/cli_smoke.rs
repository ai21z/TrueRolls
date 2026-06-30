//! KD-003, CLI smoke tests.
//!
//! These test the `kd` binary end-to-end via process invocation.
//! No server required, all tests use local mode (kd-core math).

use assert_cmd::Command;

fn kd() -> Command {
    #[allow(deprecated)]
    Command::cargo_bin("kd").expect("binary 'kd' not found")
}

// -----------------------------------------------------------------------
// roll subcommand
// -----------------------------------------------------------------------

#[test]
fn roll_basic_d20() {
    kd().args(["roll", "--kappa", "0.5"])
        .assert()
        .success()
        .stdout(predicates::str::is_match(r"^\d+\n$").unwrap());
}

#[test]
fn roll_json_output() {
    kd().args(["roll", "--kappa", "0.0", "--seed", "42", "--json"])
        .assert()
        .success()
        .stdout(predicates::str::contains("\"face\""))
        .stdout(predicates::str::contains("\"alpha\""))
        .stdout(predicates::str::contains("\"kl\""));
}

#[test]
fn roll_deterministic_same_seed() {
    let out1 = kd()
        .args([
            "roll", "--kappa", "0.7", "--seed", "12345", "-c", "5", "--json",
        ])
        .output()
        .expect("failed to run kd");
    let out2 = kd()
        .args([
            "roll", "--kappa", "0.7", "--seed", "12345", "-c", "5", "--json",
        ])
        .output()
        .expect("failed to run kd");
    assert_eq!(out1.stdout, out2.stdout, "FAIL: determinism broken");
}

#[test]
fn roll_d6() {
    let output = kd()
        .args(["roll", "--kappa", "-0.3", "--die", "d6", "--seed", "99"])
        .output()
        .expect("failed to run kd");
    assert!(output.status.success());
    let face: u32 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("output not a number");
    assert!((1..=6).contains(&face), "d6 face out of range: {face}");
}

#[test]
fn roll_d100() {
    let output = kd()
        .args(["roll", "--kappa", "0.9", "--die", "d100", "--seed", "7"])
        .output()
        .expect("failed to run kd");
    assert!(output.status.success());
    let face: u32 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("output not a number");
    assert!((1..=100).contains(&face), "d100 face out of range: {face}");
}

#[test]
fn roll_invalid_kappa_rejected() {
    kd().args(["roll", "--kappa", "1.5"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("κ must be in"));
}

#[test]
fn roll_invalid_die_rejected() {
    kd().args(["roll", "--kappa", "0.5", "--die", "d7"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("unsupported die"));
}

#[test]
fn roll_with_lambda_override() {
    kd().args([
        "roll", "--kappa", "1.0", "--lambda", "0.6", "--seed", "1", "--json",
    ])
    .assert()
    .success()
    .stdout(predicates::str::contains("\"lambda\": 0.6"));
}

#[test]
fn roll_multiple_count() {
    let output = kd()
        .args(["roll", "--kappa", "0.3", "--seed", "42", "-c", "3"])
        .output()
        .expect("failed to run kd");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = text.trim().lines().collect();
    assert_eq!(lines.len(), 3, "expected 3 lines for -c 3");
}

#[test]
fn roll_output_to_file() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let out_path = dir.path().join("transcript.json");

    kd().args([
        "roll",
        "--kappa",
        "0.5",
        "--seed",
        "42",
        "--output",
        out_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    let content = std::fs::read_to_string(&out_path).expect("failed to read output file");
    let v: serde_json::Value = serde_json::from_str(&content).expect("invalid JSON");
    assert!(v["face"].is_u64(), "transcript missing face");
    assert!(v["probs"].is_array(), "transcript missing probs");
}

// -----------------------------------------------------------------------
// roll subcommand, transcript v2 provenance (KD-023)
// -----------------------------------------------------------------------

#[test]
fn roll_transcript_contains_draw_and_versions() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let out_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--seed",
        "42",
        "--output",
        out_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    let content = std::fs::read_to_string(&out_path).expect("failed to read output file");
    let v: serde_json::Value = serde_json::from_str(&content).expect("invalid JSON");

    let draw_str = v["draw_u64"]
        .as_str()
        .expect("draw_u64 missing or not a string");
    draw_str
        .parse::<u64>()
        .expect("draw_u64 not parseable as u64");
    assert_eq!(v["math_param_version"], "roll.math.v1");
    assert_eq!(v["transcript_version"], "kd.local.v2");
    assert_eq!(v["seed"], "42");
    assert_eq!(v["sampling"]["rng"], "ChaCha20Rng(seed_from_u64)");
}

#[test]
fn roll_transcript_os_entropy_omits_seed() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let out_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--output",
        out_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    let content = std::fs::read_to_string(&out_path).expect("failed to read output file");
    let v: serde_json::Value = serde_json::from_str(&content).expect("invalid JSON");

    assert!(
        v.get("seed").is_none(),
        "seed key must be omitted on OS entropy"
    );
    assert_eq!(v["sampling"]["rng"], "ChaCha20Rng(os_entropy)");
}

// -----------------------------------------------------------------------
// verify subcommand, parameter mode
// -----------------------------------------------------------------------

#[test]
fn verify_single_pass() {
    kd().args(["verify", "--kappa", "0.5", "--json"])
        .assert()
        .success()
        .stdout(predicates::str::contains("\"pass\": true"));
}

#[test]
fn verify_sweep_all_pass() {
    kd().args(["verify", "--kappa", "0", "--sweep", "20", "--json"])
        .assert()
        .success()
        .stdout(predicates::str::contains("\"all_pass\": true"));
}

#[test]
fn verify_lambda_06() {
    kd().args(["verify", "--kappa", "1.0", "--lambda", "0.6", "--json"])
        .assert()
        .success()
        .stdout(predicates::str::contains("\"pass\": true"));
}

#[test]
fn verify_all_die_sizes() {
    for die in &["d4", "d6", "d8", "d10", "d12", "d20", "d100"] {
        kd().args(["verify", "--kappa", "0.5", "--die", die, "--json"])
            .assert()
            .success()
            .stdout(predicates::str::contains("\"pass\": true"));
    }
}

#[test]
fn verify_text_output() {
    kd().args(["verify", "--kappa", "0.5"])
        .assert()
        .success()
        .stdout(predicates::str::contains("PASS"));
}

#[test]
fn verify_sweep_text_output() {
    kd().args(["verify", "--kappa", "0", "--sweep", "5"])
        .assert()
        .success()
        .stdout(predicates::str::contains("PASS  κ=-1.0000"))
        .stdout(predicates::str::contains("PASS  κ=+1.0000"));
}

// -----------------------------------------------------------------------
// verify subcommand, transcript mode
// -----------------------------------------------------------------------

#[test]
fn verify_transcript_ok() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    // First, roll and save transcript
    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "42",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Then, verify the transcript
    kd().args([
        "verify",
        "--input",
        transcript_path.to_str().unwrap(),
        "--json",
    ])
    .assert()
    .success()
    .stdout(predicates::str::contains("\"verdict\": \"OK\""));
}

#[test]
fn verify_transcript_tampered_kappa_fails() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    // Roll
    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "42",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Tamper with kappa
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&content).unwrap();
    v["kappa"] = serde_json::json!(-0.9);
    std::fs::write(&transcript_path, serde_json::to_string_pretty(&v).unwrap()).unwrap();

    // Verify should fail
    kd().args([
        "verify",
        "--input",
        transcript_path.to_str().unwrap(),
        "--json",
    ])
    .assert()
    .failure()
    .stdout(predicates::str::contains("\"verdict\": \"MISMATCH\""));
}

#[test]
fn verify_transcript_tampered_face_fails() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "42",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Tamper: replace face with a different in-range value
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&content).unwrap();
    let face = v["face"].as_u64().expect("face missing");
    v["face"] = serde_json::json!(face % 20 + 1);
    std::fs::write(&transcript_path, serde_json::to_string_pretty(&v).unwrap()).unwrap();

    kd().args(["verify", "--input", transcript_path.to_str().unwrap()])
        .assert()
        .failure()
        .stdout(predicates::str::contains("MISMATCH"))
        .stdout(predicates::str::contains("face"));
}

#[test]
fn verify_transcript_tampered_draw_fails() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "42",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Tamper: replace draw_u64 with a draw whose replayed face differs
    // from the claimed face. draw=0 replays to face 1; draw=u64::MAX
    // replays to face 20. The claimed face cannot equal both.
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&content).unwrap();
    let face = v["face"].as_u64().expect("face missing");
    let tampered_draw = if face == 1 {
        u64::MAX.to_string()
    } else {
        "0".to_string()
    };
    v["draw_u64"] = serde_json::json!(tampered_draw);
    std::fs::write(&transcript_path, serde_json::to_string_pretty(&v).unwrap()).unwrap();

    kd().args(["verify", "--input", transcript_path.to_str().unwrap()])
        .assert()
        .failure()
        .stdout(predicates::str::contains("MISMATCH"))
        .stdout(predicates::str::contains("face"));
}

#[test]
fn verify_transcript_missing_draw_unverifiable() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "42",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Delete draw_u64, face becomes unverifiable, which must FAIL
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&content).unwrap();
    v.as_object_mut().unwrap().remove("draw_u64");
    std::fs::write(&transcript_path, serde_json::to_string_pretty(&v).unwrap()).unwrap();

    kd().args(["verify", "--input", transcript_path.to_str().unwrap()])
        .assert()
        .failure()
        .stdout(predicates::str::contains("unverifiable"));
}

#[test]
fn verify_transcript_multi_roll_array_ok() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--seed",
        "7",
        "-c",
        "3",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Sanity: the file is a JSON array of 3 entries
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(v.as_array().map(|a| a.len()), Some(3));

    kd().args([
        "verify",
        "--input",
        transcript_path.to_str().unwrap(),
        "--json",
    ])
    .assert()
    .success()
    .stdout(predicates::str::contains("\"verdict\": \"OK\""))
    .stdout(predicates::str::contains("\"count\": 3"));
}

#[test]
fn verify_transcript_server_shape_ok() {
    // F-09 regression: a transcript in the SERVER shape (math_param_version,
    // no lambda, no transcript_version, extra rng object) must verify OK.
    let dir = tempfile::tempdir().expect("failed to create temp dir");
    let transcript_path = dir.path().join("t.json");

    kd().args([
        "roll",
        "--kappa",
        "0.6",
        "--die",
        "d20",
        "--seed",
        "99",
        "--output",
        transcript_path.to_str().unwrap(),
    ])
    .assert()
    .success();

    // Reshape into the server transcript form: strip CLI-only keys and add
    // an extra server-only object that the verifier must ignore.
    let content = std::fs::read_to_string(&transcript_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&content).unwrap();
    let obj = v.as_object_mut().unwrap();
    obj.remove("lambda");
    obj.remove("transcript_version");
    obj.remove("seed");
    obj.remove("param_version");
    obj.insert(
        "rng".to_string(),
        serde_json::json!({ "algo": "HKDF(SHA-256)->ChaCha20Rng", "drbg_key_hex": "deadbeef" }),
    );
    std::fs::write(&transcript_path, serde_json::to_string_pretty(&v).unwrap()).unwrap();

    kd().args([
        "verify",
        "--input",
        transcript_path.to_str().unwrap(),
        "--json",
    ])
    .assert()
    .success()
    .stdout(predicates::str::contains("\"verdict\": \"OK\""));
}

#[test]
fn verify_transcript_all_die_sizes() {
    let dir = tempfile::tempdir().expect("failed to create temp dir");

    for die in &["d4", "d6", "d8", "d10", "d12", "d20", "d100"] {
        let transcript_path = dir.path().join(format!("{die}.json"));

        kd().args([
            "roll",
            "--kappa",
            "0.3",
            "--die",
            die,
            "--seed",
            "7",
            "--output",
            transcript_path.to_str().unwrap(),
        ])
        .assert()
        .success();

        kd().args([
            "verify",
            "--input",
            transcript_path.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicates::str::contains("\"verdict\": \"OK\""));
    }
}

// -----------------------------------------------------------------------
// help & version
// -----------------------------------------------------------------------

#[test]
fn help_works() {
    kd().arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("TrueRolls CLI"));
}

#[test]
fn roll_help_works() {
    kd().args(["roll", "--help"])
        .assert()
        .success()
        .stdout(predicates::str::contains("--kappa"));
}

#[test]
fn verify_help_works() {
    kd().args(["verify", "--help"])
        .assert()
        .success()
        .stdout(predicates::str::contains("--kappa"));
}
