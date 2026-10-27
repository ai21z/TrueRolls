// GET /livez, GET /healthz

use crate::models::dto::{Health, Live};
use crate::state::AppState;
use axum::{Json, extract::State};
use std::sync::Arc;
use tracing::warn;

/// Process liveness only: no DB, Redis, S3, or network I/O. This is the probe for
/// browsers and container health checks; `/healthz` stays the operator dependency check.
pub async fn livez() -> Json<Live> {
    Json(Live { status: "ok" })
}

pub async fn healthz(State(state): State<Arc<AppState>>) -> Json<Health> {
    let db_ok = sqlx::query("SELECT 1").execute(&state.pg).await.is_ok();

    let redis_ok = match state.redis.get().await {
        Ok(mut conn) => redis::cmd("PING")
            .query_async::<String>(&mut conn)
            .await
            .is_ok(),
        Err(_) => false,
    };

    let s3_ok = match state.s3.head_bucket().bucket(&state.s3_bucket).send().await {
        Ok(_) => true,
        Err(err) => {
            warn!("S3 head_bucket failed: {err:?}");
            false
        }
    };

    Json(Health {
        status: if db_ok && redis_ok && s3_ok {
            "ok"
        } else {
            "degraded"
        },
        db: db_ok,
        redis: redis_ok,
        s3: s3_ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn livez_reports_ok_without_dependencies() {
        let Json(live) = livez().await;
        assert_eq!(live.status, "ok");
        assert_eq!(
            serde_json::to_value(&live).unwrap(),
            serde_json::json!({ "status": "ok" })
        );
    }
}
