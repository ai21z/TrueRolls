use std::time::Duration;

pub fn base_url() -> String {
    std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into())
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
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
