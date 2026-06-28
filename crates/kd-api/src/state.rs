// AppState + constructors (pg/migrations, redis, s3, signer)

use aws_config::BehaviorVersion;
use aws_sdk_s3 as s3;
use deadpool_redis::Pool as RedisPool;
use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::error::{AppError, internal};
use crate::services::drand::DrandHttpClient;
use crate::services::signing::ReceiptSigner;

#[derive(Clone)]
pub struct AppState {
    pub pg: PgPool,
    pub redis: RedisPool,
    pub s3: s3::Client,
    pub s3_bucket: String,
    pub cfg: Config,
    pub signer: Option<Arc<ReceiptSigner>>,
    pub drand: DrandHttpClient,
}

pub async fn build_state(cfg: &Config) -> Result<Arc<AppState>, AppError> {
    // SIG-2 (fail-fast): validate config - incl. refusing the published TEST signer under
    // KD_ENV=prod - BEFORE any DB / Redis / S3 I/O, so a misconfigured prod boot aborts
    // without connecting to (or migrating) the production database.
    cfg.validate()?;

    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(cfg.db_max_connections)
        .connect(&cfg.database_url)
        .await
        .map_err(internal)?;
    sqlx::migrate!().run(&pg).await.map_err(internal)?;

    let redis_cfg = deadpool_redis::Config::from_url(&cfg.redis_url);
    let redis = redis_cfg
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .map_err(internal)?;

    let base = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(cfg.s3_region.clone()))
        .load()
        .await;

    let s3_client = s3::Client::from_conf(
        s3::config::Builder::from(&base)
            .endpoint_url(&cfg.s3_endpoint)
            .force_path_style(true)
            .build(),
    );

    // Build receipt signer if both env vars are present
    let signer = match (&cfg.signing_secret, &cfg.signing_kid) {
        (Some(secret), Some(kid)) => {
            let s = ReceiptSigner::from_hex_seed(secret, kid.clone()).map_err(internal)?;
            tracing::info!(kid = %kid, "Ed25519 receipt signer initialized");
            Some(Arc::new(s))
        }
        _ => {
            tracing::warn!(
                "KD_SIGNING_ED25519_SECRET / KD_SIGNING_KID not set; receipts will be unsigned"
            );
            None
        }
    };
    let drand =
        DrandHttpClient::new(cfg.drand_relays.clone(), cfg.drand_timeout_ms).map_err(internal)?;

    Ok(Arc::new(AppState {
        pg,
        redis,
        s3: s3_client,
        s3_bucket: cfg.s3_bucket.clone(),
        cfg: cfg.clone(),
        signer,
        drand,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EnvProfile, TrustedProxy};
    use crate::services::signing::PUBLISHED_TEST_SEED_HEX;

    /// A Config that violates SIG-2 (prod + published test seed) with EMPTY connection
    /// strings. `build_state` must refuse at `cfg.validate()` - its FIRST line - before any
    /// DB/Redis/S3 I/O, so this test needs no running services. If the `validate()` call is
    /// ever removed from `build_state`, it would instead fail later at the DB connect with a
    /// different error, and the message assertion below catches that regression.
    fn prod_test_seed_cfg() -> Config {
        Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 0,
            database_url: String::new(),
            redis_url: String::new(),
            s3_endpoint: String::new(),
            s3_bucket: String::new(),
            s3_region: "us-east-1".to_string(),
            idem_ttl_secs: 0,
            idem_poll_ms: 0,
            idem_poll_max: 0,
            rng_salt: None,
            signing_secret: Some(PUBLISHED_TEST_SEED_HEX.to_string()),
            signing_kid: Some("test-kid-1".to_string()),
            public_base_url: String::new(),
            env_profile: EnvProfile::Prod,
            roll_rl_period_secs: 1,
            roll_rl_burst: 60,
            drand_relays: vec!["https://api.drand.sh".to_string()],
            drand_timeout_ms: 2500,
            drand_client_max_lag_rounds: 2,
            drand_target_wait_ms: 12_000,
            trusted_proxy: TrustedProxy::Peer,
            allow_peer_ip_in_prod: true,
            roll_max_inflight: 32,
            db_max_connections: 5,
            roll_timeout_ms: 34_000,
            roll_global_cap: 0,
            roll_global_cap_window_secs: 3_600,
            allow_uncapped_roll_in_prod: true,
        }
    }

    #[tokio::test]
    async fn sig2_build_state_refuses_test_seed_in_prod_before_io() {
        // `AppState` isn't `Debug`, so match rather than `expect_err`.
        let msg = match build_state(&prod_test_seed_cfg()).await {
            Ok(_) => panic!("prod + published test seed must refuse to build state"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("published TEST seed"),
            "expected SIG-2 refusal before any I/O (proves the guard is wired into build_state); got: {msg}"
        );
    }
}
