mod _helpers;
use _helpers::{base_url, client};
use serde_json::Value;

/// Helper: build a verify-request payload from known inputs.
/// We use the roll_math transcript structure (same fields the endpoint wrote to S3).
/// Since we can't easily fetch from MinIO in tests, we reconstruct the verify
/// payload from the roll response fields + recomputing probs via kd-core.
/// But actually the verify endpoint only needs the fields in VerifyRequest;
/// we can get `face`, `alpha`, `kl`, `ev` from the roll response, and
/// we need `draw_u64` + `probs` which aren't in the roll response - they're
/// only in the S3 transcript.
///
/// Strategy: POST /v1/roll → get face/alpha/kl/ev, then recompute distribution
/// and draw locally to build a golden transcript, then POST /v1/verify.
///
/// BETTER strategy: just use kd-core directly to build a full transcript
/// from known inputs, then verify it. This tests the endpoint logic without
/// needing S3 access.
fn build_verify_payload(die: &str, kappa: f64) -> Value {
    use kd_core::{
        PARAM_VERSION, die::Die, distribution::compute_distribution, params::default_for_die,
        sample::prefix_cdf_index_from_u64,
    };
    use rand::RngCore;

    // Build the distribution and sample, mirroring roll_math.rs logic
    let (face, draw_u64, alpha, kl, ev, probs_vec) = match die {
        "d6" => {
            let params = default_for_die(6);
            let out = compute_distribution::<6>(Die::<6>, kappa, &params).unwrap();
            let draw = rand::rng().next_u64();
            let idx = prefix_cdf_index_from_u64::<6>(&out.probs, draw);
            let face = (idx + 1) as u32;
            let probs: Vec<f64> = out.probs.into_iter().collect();
            (face, draw, out.alpha, out.kl, out.ev, probs)
        }
        "d20" => {
            let params = default_for_die(20);
            let out = compute_distribution::<20>(Die::<20>, kappa, &params).unwrap();
            let draw = rand::rng().next_u64();
            let idx = prefix_cdf_index_from_u64::<20>(&out.probs, draw);
            let face = (idx + 1) as u32;
            let probs: Vec<f64> = out.probs.into_iter().collect();
            (face, draw, out.alpha, out.kl, out.ev, probs)
        }
        "d100" => {
            let params = default_for_die(100);
            let out = compute_distribution::<100>(Die::<100>, kappa, &params).unwrap();
            let draw = rand::rng().next_u64();
            let idx = prefix_cdf_index_from_u64::<100>(&out.probs, draw);
            let face = (idx + 1) as u32;
            let probs: Vec<f64> = out.probs.into_iter().collect();
            (face, draw, out.alpha, out.kl, out.ev, probs)
        }
        _ => panic!("unsupported die"),
    };

    let raw = serde_json::json!({
        "math_param_version": PARAM_VERSION,
        "die": die,
        "kappa": kappa,
        "face": face,
        "draw_u64": draw_u64.to_string(),
        "alpha": alpha,
        "kl": kl,
        "ev": ev,
        "probs": probs_vec,
    });

    // Simulate a real-world flow: the transcript is stored as JSON text in S3,
    // then the verifier downloads and parses it. This round-trip through JSON
    // text ensures the f64 values in our payload match what the server will
    // see after deserialization (serde_json Ryu shortest-representation).
    let json_text = serde_json::to_string(&raw).unwrap();
    serde_json::from_str(&json_text).unwrap()
}

// ---- Happy path tests ----

#[tokio::test]
async fn verify_d6_happy_path() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let payload = build_verify_payload("d6", 0.5);
    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "d6 verify should return 200");
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "OK");
}

#[tokio::test]
async fn verify_d20_happy_path() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let payload = build_verify_payload("d20", 0.6);
    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "d20 verify should return 200");
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "OK");
}

#[tokio::test]
async fn verify_d100_happy_path() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let payload = build_verify_payload("d100", 0.3);
    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "d100 verify should return 200");
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "OK");
}

// ---- Tampered field tests → 422 MISMATCH ----

#[tokio::test]
async fn verify_tampered_face_returns_422() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d20", 0.6);
    // Tamper: change the face to something different
    let original_face = payload["face"].as_u64().unwrap();
    let tampered_face = if original_face == 1 { 2 } else { 1 };
    payload["face"] = serde_json::json!(tampered_face);

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422, "tampered face should return 422");
}

#[tokio::test]
async fn verify_tampered_kappa_returns_422() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d20", 0.6);
    // Tamper: change kappa so the recomputed distribution won't match
    payload["kappa"] = serde_json::json!(0.3);

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422, "tampered kappa should return 422");
}

#[tokio::test]
async fn verify_tampered_draw_u64_returns_422() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d20", 0.6);
    // Tamper: change draw_u64 to 0 (almost certainly produces a different face)
    // But even if it happens to produce the same face, alpha/kl/ev won't change.
    // To guarantee mismatch, also tamper the face value.
    payload["draw_u64"] = serde_json::json!("0");
    // Recomputed face from draw_u64=0 will be face=1 (first bucket in CDF).
    // Set the transcript face to something else to guarantee mismatch.
    payload["face"] = serde_json::json!(20);

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422, "tampered draw_u64 should return 422");
}

// ---- Bad input tests → 400 ----

#[tokio::test]
async fn verify_bad_version_returns_400() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d20", 0.6);
    payload["math_param_version"] = serde_json::json!("roll.math.v999");

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "bad version should return 400");
}

#[tokio::test]
async fn verify_bad_die_returns_400() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d20", 0.6);
    payload["die"] = serde_json::json!("d7");

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "bad die should return 400");
}

#[tokio::test]
async fn verify_kappa_zero_happy_path() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    // kappa=0 means uniform distribution (α=0, no tilting)
    let payload = build_verify_payload("d6", 0.0);
    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "kappa=0 verify should return 200");
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "OK");
}

// ---- Signed kappa domain tests ----

#[tokio::test]
async fn verify_negative_kappa_happy_path() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    // Negative kappa is a valid signed stance in [-1, 1]
    let payload = build_verify_payload("d6", -0.7);
    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "kappa=-0.7 verify should return 200");
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["verdict"], "OK");
}

#[tokio::test]
async fn verify_kappa_above_one_returns_400() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    // Build a valid payload, then overwrite kappa WITHOUT recomputing.
    // The server must reject on the kappa domain check (400) BEFORE any
    // recompute-mismatch verdict (which would be 422).
    let mut payload = build_verify_payload("d6", 0.5);
    payload["kappa"] = serde_json::json!(1.5);

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "kappa=1.5 should return 400, not 422");
}

#[tokio::test]
async fn verify_kappa_below_neg_one_returns_400() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let mut payload = build_verify_payload("d6", 0.5);
    payload["kappa"] = serde_json::json!(-1.5);

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "kappa=-1.5 should return 400, not 422");
}

// ---- Receipt version gate tests ----

#[tokio::test]
async fn verify_receipt_bad_math_param_version_returns_400() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    // Receipt-shaped body ("v": "truerolls-1") with an unsupported
    // math_param_version. All ReceiptV2 required fields are present so
    // deserialization succeeds and the version gate is reached.
    let receipt = serde_json::json!({
        "v": "truerolls-1",
        "id": uuid::Uuid::new_v4().to_string(),
        "die": "d20",
        "kappa": 0.6,
        "face": 14,
        "alpha": 0.5,
        "kl": 0.02,
        "ev": 11.6,
        "created_at": "2026-01-01T00:00:00Z",
        "transcript_url": "/x",
        "proof": {
            "math_param_version": "roll.math.v999",
            "rng": {
                "drbg_key_hex": "0000000000000000000000000000000000000000000000000000000000000000",
                "algo": "x"
            },
            "draw_u64": "1"
        }
    });

    let c = client();
    let r = c
        .post(format!("{}/v1/verify", base_url()))
        .json(&receipt)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status(),
        400,
        "receipt with unsupported math_param_version should return 400"
    );
}
