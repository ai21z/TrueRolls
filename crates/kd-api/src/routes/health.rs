// GET /healthz

use crate::models::dto::Health;
use crate::state::AppState;
use axum::{Json, extract::State};
use std::sync::Arc;
use tracing::warn;

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
