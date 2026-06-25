// acquire_lock, release_lock, poll_dedup_row

use anyhow::Context;
use deadpool_redis::Pool as RedisPool;
use futures::future::BoxFuture;
use std::time::Duration;

pub async fn acquire_lock(
    pool: &RedisPool,
    key: &str,
    ttl_secs: usize,
) -> Result<bool, anyhow::Error> {
    let mut conn = pool.get().await.context("redis pool get")?;
    let ok = redis::cmd("SET")
        .arg(key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async::<_, Option<String>>(&mut conn)
        .await
        .context("redis SET NX EX")?
        .is_some();
    Ok(ok)
}

#[allow(dead_code)] // intentionally disabled active unlocking in-route
pub async fn release_lock(pool: &RedisPool, key: &str) {
    let _ = async {
        let mut conn = pool.get().await.map_err(|_| ())?;
        let _: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|_| ())?;
        Ok::<(), ()>(())
    }
    .await;
}

pub async fn poll_for_row<F, T>(mut fetch: F, poll_ms: u64, max_iters: usize) -> Option<T>
where
    F: FnMut() -> BoxFuture<'static, Option<T>> + Send + 'static,
    T: Send + 'static,
{
    for _ in 0..max_iters {
        if let Some(x) = fetch().await {
            return Some(x);
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
    None
}
