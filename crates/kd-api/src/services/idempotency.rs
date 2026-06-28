// acquire_lock, release_lock, poll_dedup_row

use anyhow::Context;
use deadpool_redis::Pool as RedisPool;
use futures::future::BoxFuture;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdempotencyLock {
    pub key: String,
    pub token: String,
}

const RELEASE_LOCK_EVAL: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
"#;

pub async fn acquire_lock(
    pool: &RedisPool,
    key: &str,
    ttl_secs: usize,
) -> Result<Option<IdempotencyLock>, anyhow::Error> {
    let token = Uuid::new_v4().to_string();
    let mut conn = pool.get().await.context("redis pool get")?;
    let ok = redis::cmd("SET")
        .arg(key)
        .arg(&token)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async::<_, Option<String>>(&mut conn)
        .await
        .context("redis SET NX EX")?
        .is_some();
    if ok {
        Ok(Some(IdempotencyLock {
            key: key.to_string(),
            token,
        }))
    } else {
        Ok(None)
    }
}

/// Release an idempotency lock early. The normal post-mint flow deliberately does NOT call this
/// (it keeps the lock to fence concurrent duplicates until the row is written or the TTL expires).
/// It is used only on the global-mint-cap reject path, where no mint occurred, so releasing lets a
/// retry of the same idem key re-attempt once the window resets.
pub async fn release_lock(pool: &RedisPool, lock: &IdempotencyLock) -> Result<bool, anyhow::Error> {
    let mut conn = pool.get().await.context("redis pool get")?;
    let deleted: i64 = redis::cmd("EVAL")
        .arg(RELEASE_LOCK_EVAL)
        .arg(1)
        .arg(&lock.key)
        .arg(&lock.token)
        .query_async(&mut conn)
        .await
        .context("redis idempotency release EVAL")?;
    Ok(deleted == 1)
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

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn redis_test_pool() -> Option<RedisPool> {
        let url = std::env::var("KD_REDIS_TEST_URL").ok()?;
        Some(
            deadpool_redis::Config::from_url(url)
                .create_pool(Some(deadpool_redis::Runtime::Tokio1))
                .expect("KD_REDIS_TEST_URL should build a Redis pool"),
        )
    }

    #[tokio::test]
    async fn redis_release_is_owner_checked() -> Result<(), anyhow::Error> {
        let Some(pool) = redis_test_pool() else {
            return Ok(());
        };
        let key = format!("test:idem:{}", Uuid::new_v4());

        let lock_a = acquire_lock(&pool, &key, 1)
            .await?
            .expect("first owner should acquire the key");

        tokio::time::sleep(Duration::from_millis(1_200)).await;

        let lock_b = acquire_lock(&pool, &key, 30)
            .await?
            .expect("second owner should acquire after first TTL expires");

        assert!(
            !release_lock(&pool, &lock_a).await?,
            "stale owner must not delete the newer owner's lock"
        );
        assert!(
            acquire_lock(&pool, &key, 30).await?.is_none(),
            "key must still be locked by the second owner"
        );
        assert!(
            release_lock(&pool, &lock_b).await?,
            "current owner should delete its own lock"
        );

        let lock_c = acquire_lock(&pool, &key, 30)
            .await?
            .expect("key should be acquirable after current owner releases");
        assert!(release_lock(&pool, &lock_c).await?);

        Ok(())
    }
}
