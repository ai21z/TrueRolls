#![allow(dead_code)]

use std::time::Duration;

pub fn base_url() -> String {
    std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into())
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

#[derive(Debug, serde::Deserialize)]
struct DrandApiPulse {
    round: u64,
    randomness: String,
    signature: String,
}

pub async fn drand_roll_body(die: &str, kappa: f64) -> serde_json::Value {
    let pulse = fetch_latest_quicknet_pulse()
        .await
        .expect("fetch and verify latest drand quicknet pulse");
    drand_roll_body_from_pulse(die, kappa, pulse)
}

pub async fn drand_roll_body_with_already_published_target(
    die: &str,
    kappa: f64,
) -> serde_json::Value {
    let latest = fetch_latest_quicknet_pulse()
        .await
        .expect("fetch and verify latest drand quicknet pulse");
    let observed_round = latest
        .round
        .checked_sub(kd_drand::DEFAULT_TARGET_DELAY_ROUNDS)
        .expect("quicknet round is beyond target delay");
    let observed = fetch_quicknet_round(observed_round)
        .await
        .expect("fetch and verify older observed drand pulse");
    drand_roll_body_from_pulse(die, kappa, observed)
}

fn drand_roll_body_from_pulse(
    die: &str,
    kappa: f64,
    pulse: kd_drand::DrandPulse,
) -> serde_json::Value {
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    serde_json::json!({
        "die": die,
        "kappa": kappa,
        "client_nonce": nonce,
        "drand": {
            "client_observed_round": pulse.round,
            "client_observed_signature_hex": pulse.signature_hex,
            "client_observed_randomness_hex": pulse.randomness_hex,
            "target_round": kd_drand::target_round_from_observed(pulse.round)
        }
    })
}

async fn fetch_latest_quicknet_pulse() -> Result<kd_drand::DrandPulse, String> {
    fetch_quicknet_path("public/latest").await
}

async fn fetch_quicknet_round(round: u64) -> Result<kd_drand::DrandPulse, String> {
    fetch_quicknet_path(&format!("public/{round}")).await
}

async fn fetch_quicknet_path(path: &str) -> Result<kd_drand::DrandPulse, String> {
    let url = format!(
        "https://api.drand.sh/{}/{}",
        kd_drand::QUICKNET_CHAIN_HASH,
        path
    );
    let api = client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET drand {path} failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GET drand {path} status failed: {e}"))?
        .json::<DrandApiPulse>()
        .await
        .map_err(|e| format!("decode drand {path} failed: {e}"))?;

    let pulse = kd_drand::DrandPulse {
        chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
        round: api.round,
        signature_hex: api.signature,
        randomness_hex: api.randomness,
    };
    pulse.verify_quicknet().map_err(|e| e.to_string())?;
    Ok(pulse)
}

/// Poll /healthz until it responds or timeout. Useful at the start of each test.
pub async fn wait_until_ready(timeout: Duration) -> Result<(), String> {
    let c = client();
    let url = format!("{}/healthz", base_url());
    let start = std::time::Instant::now();
    loop {
        match c.get(&url).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            _ => {
                if start.elapsed() >= timeout {
                    return Err(format!(
                        "API not reachable at {} within {:?}. \
Start it in another terminal: `cargo run -p kd-api`.",
                        url, timeout
                    ));
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
    }
}
