mod _helpers;
use _helpers::{base_url, client};
use uuid::Uuid;

#[tokio::test]
async fn post_roll_201_then_200_on_same_idem_key() {
    let c = client();
    let url = format!("{}/v1/roll", base_url());
    let idem = Uuid::new_v4().to_string();
    let body = _helpers::drand_roll_body("d20", 0.8).await;

    let r1 = c
        .post(&url)
        .header("Idempotency-Key", &idem)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r1.status(), 201, "first should be 201");

    let r2 = c
        .post(&url)
        .header("Idempotency-Key", &idem)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 200, "second should be 200");

    let j1: serde_json::Value = r1.json().await.unwrap();
    let j2: serde_json::Value = r2.json().await.unwrap();
    assert_eq!(j1["id"], j2["id"], "should return the same public_id");
    assert_eq!(j2["deduplicated"], true);
}

#[tokio::test]
async fn post_roll_conflict_on_same_key_different_body() {
    let c = client();
    let url = format!("{}/v1/roll", base_url());
    let idem = Uuid::new_v4().to_string();
    let b1 = _helpers::drand_roll_body("d20", 0.8).await;
    let mut b2 = b1.clone();
    b2["kappa"] = serde_json::json!(0.9);

    let r1 = c
        .post(&url)
        .header("Idempotency-Key", &idem)
        .json(&b1)
        .send()
        .await
        .unwrap();
    assert!(r1.status().is_success());

    let r2 = c
        .post(&url)
        .header("Idempotency-Key", &idem)
        .json(&b2)
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 409, "same key, different body → 409");
}

#[tokio::test]
async fn post_roll_validation_errors() {
    let c = client();
    let url = format!("{}/v1/roll", base_url());

    // invalid die
    let r = c
        .post(&url)
        .json(&serde_json::json!({"die":"d7","kappa":0.1}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    // kappa = -1.0 is a valid signed stance (lower bound of [-1, 1]) -> 201
    let body = _helpers::drand_roll_body("d6", -1.0).await;
    let r = c.post(&url).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 201, "kappa=-1.0 is valid signed kappa");

    // kappa below -1 → 400
    let r = c
        .post(&url)
        .json(&serde_json::json!({"die":"d6","kappa":-1.5}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "kappa=-1.5 is out of [-1, 1]");

    // kappa above 1 → 400
    let r = c
        .post(&url)
        .json(&serde_json::json!({"die":"d6","kappa":1.5}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400, "kappa=1.5 is out of [-1, 1]");
}

#[tokio::test]
async fn post_roll_rejects_already_published_drand_target() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let c = client();
    let url = format!("{}/v1/roll", base_url());
    let body = _helpers::drand_roll_body_with_already_published_target("d20", 0.8).await;

    let r = c.post(&url).json(&body).send().await.unwrap();
    assert_eq!(
        r.status(),
        400,
        "target round at or behind server latest must be rejected"
    );
}

#[tokio::test]
async fn post_roll_concurrent_same_key_thundering_herd() {
    _helpers::wait_until_ready(std::time::Duration::from_secs(2))
        .await
        .expect("kd-api must be running externally");

    let c = client();
    let url = format!("{}/v1/roll", base_url());
    let idem = Uuid::new_v4().to_string();
    let body = _helpers::drand_roll_body("d20", 0.8).await;

    let mut tasks = Vec::new();
    for _ in 0..10 {
        let c = c.clone();
        let url = url.clone();
        let idem = idem.clone();
        let body = body.clone();
        tasks.push(tokio::spawn(async move {
            c.post(&url)
                .header("Idempotency-Key", &idem)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status()
        }));
    }

    let statuses = futures::future::join_all(tasks)
        .await
        .into_iter()
        .map(|r| r.unwrap())
        .collect::<Vec<_>>();

    let created = statuses.iter().filter(|&&s| s.as_u16() == 201).count();
    let ok = statuses.iter().filter(|&&s| s.as_u16() == 200).count();
    let accepted = statuses.iter().filter(|&&s| s.as_u16() == 202).count(); // if polling returns 202 in your edge case

    assert_eq!(created, 1, "exactly one should be 201, got {:?}", statuses);
    assert!(
        ok + accepted >= 9,
        "rest should be 200/202, got {:?}",
        statuses
    );
}
