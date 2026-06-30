// Global mint-rate cap for POST /v1/roll.
//
// OPS-AUTH-01: the roll endpoint is unauthenticated and mints a signed receipt + DB row + S3
// object + drand fetch on every committed call. Per-IP rate limiting (tower_governor) bounds a
// single client but not the TOTAL across all clients, an attacker rotating source IPs drives
// unbounded mints. This module adds a global fixed-window ceiling: at most `cap` mints per
// `window_secs` across every client.
//
// It is called on the *committed-mint* path only (after the idempotency lock is acquired AND the
// drand proof is validated, before the expensive target-round wait), so valid requests that reach
// the mint-commit point are counted before they can spend the expensive wait/sign/write budget. The
// counter is a monotonic count of validated reservation attempts in the window, including rejected
// over-cap attempts. Rejected attempts are not minted receipts. It charges neither a legitimate
// idempotent retry (those dedup earlier) nor an invalid request (those 400 at validation, before the
// reservation).
// Fail-closed: a Redis error propagates to the caller, which is consistent with the roll path
// already hard-depending on Redis for idempotency.

use anyhow::Context;
use deadpool_redis::Pool as RedisPool;

/// Outcome of trying to reserve one unit of global mint budget for the current window.
#[derive(Debug, PartialEq, Eq)]
pub enum MintReservation {
    /// Under the cap, the mint may proceed. `window_count` is the post-increment window total.
    Allowed { window_count: u64 },
    /// At/over the cap, reject with 429. `retry_after_secs` is the seconds until the window
    /// resets (always >= 1). `window_count` includes this rejected reservation attempt.
    Rejected {
        window_count: u64,
        retry_after_secs: u64,
    },
}

// INCR the window counter, and on the window's first mint (counter == 1) set the TTL, in one
// atomic round-trip, so the key cannot be left without an expiry if the process dies mid-pair.
// TTL = window length covers the worst case (first mint landing at the very start of a window);
// a later window uses a different key, so an over-long TTL would only waste a few bytes, never
// leak budget across windows.
const MINTCAP_EVAL: &str = r#"
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
"#;

/// Atomically reserve one mint in the current fixed window.
///
/// `cap == 0` means "uncapped" and short-circuits without touching Redis. Otherwise this runs an
/// atomic INCR + first-write EXPIRE and compares the post-increment count against the cap. The
/// counter is allowed to climb past the cap under sustained load (every excess request is still
/// rejected until the window's TTL resets it). We deliberately do not decrement on rejection, so
/// the count stays monotonic within a window and there is no oscillation an attacker could exploit
/// to squeeze extra mints.
pub async fn reserve_mint(
    pool: &RedisPool,
    cap: u64,
    window_secs: u64,
    now_unix: u64,
) -> Result<MintReservation, anyhow::Error> {
    if cap == 0 {
        return Ok(MintReservation::Allowed { window_count: 0 });
    }
    let (window_id, retry_after_secs) = window_bounds(now_unix, window_secs);
    let window_secs = window_secs.max(1);
    let key = format!("roll:mintcap:{window_id}");

    let mut conn = pool.get().await.context("redis pool get")?;
    let window_count: u64 = redis::cmd("EVAL")
        .arg(MINTCAP_EVAL)
        .arg(1) // numkeys
        .arg(&key) // KEYS[1]
        .arg(window_secs) // ARGV[1]
        .query_async(&mut conn)
        .await
        .context("redis mint-cap EVAL")?;

    if window_count > cap {
        Ok(MintReservation::Rejected {
            window_count,
            retry_after_secs,
        })
    } else {
        Ok(MintReservation::Allowed { window_count })
    }
}

/// Pure fixed-window arithmetic. Returns the window id (the Redis key suffix) and the seconds
/// until this window ends (the Retry-After hint, always >= 1). Factored out so the off-by-one-
/// prone math is unit-tested without a live Redis.
fn window_bounds(now_unix: u64, window_secs: u64) -> (u64, u64) {
    let window_secs = window_secs.max(1);
    let window_id = now_unix / window_secs;
    let window_end = window_id.saturating_add(1).saturating_mul(window_secs);
    let retry_after_secs = window_end.saturating_sub(now_unix).max(1);
    (window_id, retry_after_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn window_bounds_are_correct_at_edges() {
        // Start of the very first window.
        assert_eq!(window_bounds(0, 3600), (0, 3600));
        // One second before the window closes -> retry in 1s.
        assert_eq!(window_bounds(3599, 3600), (0, 1));
        // Exactly on the boundary -> new window, full retry horizon.
        assert_eq!(window_bounds(3600, 3600), (1, 3600));
        // Mid second window.
        assert_eq!(window_bounds(5400, 3600), (1, 1800));
        // Unit window: every second is its own bucket, retry is always 1s.
        assert_eq!(window_bounds(10, 1), (10, 1));
    }

    #[test]
    fn window_secs_zero_is_clamped_to_one() {
        // A misconfigured 0 must not divide-by-zero. It degrades to a 1s window.
        assert_eq!(window_bounds(42, 0), (42, 1));
    }

    #[tokio::test]
    async fn uncapped_short_circuits_without_redis() {
        // cap == 0 must not touch the pool, so a pool pointed at a dead address still returns
        // Allowed. This pins the "uncapped never fails the roll" contract.
        let pool = deadpool_redis::Config::from_url("redis://127.0.0.1:6390/")
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .unwrap();
        let outcome = reserve_mint(&pool, 0, 3600, 1_000).await.unwrap();
        assert_eq!(outcome, MintReservation::Allowed { window_count: 0 });
    }

    fn redis_test_pool() -> Option<RedisPool> {
        let url = std::env::var("KD_REDIS_TEST_URL").ok()?;
        Some(
            deadpool_redis::Config::from_url(url)
                .create_pool(Some(deadpool_redis::Runtime::Tokio1))
                .expect("KD_REDIS_TEST_URL should build a Redis pool"),
        )
    }

    #[tokio::test]
    async fn redis_boundary_allows_cap_then_rejects_next_attempt() -> Result<(), anyhow::Error> {
        let Some(pool) = redis_test_pool() else {
            return Ok(());
        };

        let window_secs = 60;
        let now_unix = ((Uuid::new_v4().as_u128() as u64) % 1_000_000).saturating_mul(window_secs);
        let (window_id, _) = window_bounds(now_unix, window_secs);
        let key = format!("roll:mintcap:{window_id}");

        let mut conn = pool.get().await?;
        let _: i64 = redis::cmd("DEL").arg(&key).query_async(&mut conn).await?;
        drop(conn);

        assert_eq!(
            reserve_mint(&pool, 2, window_secs, now_unix).await?,
            MintReservation::Allowed { window_count: 1 }
        );
        assert_eq!(
            reserve_mint(&pool, 2, window_secs, now_unix).await?,
            MintReservation::Allowed { window_count: 2 }
        );
        match reserve_mint(&pool, 2, window_secs, now_unix).await? {
            MintReservation::Rejected {
                window_count: 3,
                retry_after_secs,
            } => assert!(retry_after_secs >= 1),
            other => panic!("expected third reservation to reject, got {other:?}"),
        }

        let mut conn = pool.get().await?;
        let _: i64 = redis::cmd("DEL").arg(&key).query_async(&mut conn).await?;

        Ok(())
    }
}
