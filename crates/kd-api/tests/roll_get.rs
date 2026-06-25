mod _helpers;
use _helpers::{base_url, client};
use uuid::Uuid;

#[tokio::test]
async fn get_by_id_and_by_idem_key_consistent() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let c = client();
    let base = base_url();
    let idem = Uuid::new_v4().to_string();
    let body = serde_json::json!({ "die":"d20","kappa":0.8,"seed":"alice" });

    // create
    let created = c
        .post(format!("{}/v1/roll", base))
        .header("Idempotency-Key", &idem)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let j: serde_json::Value = created.json().await.unwrap();
    let id = j["id"].as_str().unwrap().to_string();

    // GET by id
    let by_id = c
        .get(format!("{}/v1/roll/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(by_id.status(), 200);
    let j1: serde_json::Value = by_id.json().await.unwrap();

    // GET by idem_key
    let by_key = c
        .get(format!("{}/v1/roll?idem_key={}", base, idem))
        .send()
        .await
        .unwrap();
    assert_eq!(by_key.status(), 200);
    let j2: serde_json::Value = by_key.json().await.unwrap();

    assert_eq!(j1["id"], j2["id"]);
    assert_eq!(j1["transcript_key"], j2["transcript_key"]);
    assert_eq!(j2["deduplicated"], true);
}
