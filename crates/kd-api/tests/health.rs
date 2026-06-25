mod _helpers;
use _helpers::{base_url, client};

#[tokio::test]
async fn healthz_ok_or_degraded_has_fields() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let c = client();
    let url = format!("{}/healthz", base_url());
    let r = c.get(url).send().await.unwrap();
    assert!(r.status().is_success(), "unexpected status: {}", r.status());
    let v: serde_json::Value = r.json().await.unwrap();
    assert!(v.get("status").is_some());
    assert!(v.get("db").is_some());
    assert!(v.get("redis").is_some());
    assert!(v.get("s3").is_some());
}
