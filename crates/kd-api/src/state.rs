// AppState + constructors (pg/migrations, redis, s3, signer)

use aws_config::BehaviorVersion;
use aws_sdk_s3 as s3;
use deadpool_redis::Pool as RedisPool;
use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::error::{AppError, internal};
use crate::services::drand::DrandHttpClient;
use crate::services::signing::{KeyStatus, PublicKeyEntry, ReceiptSigner};

#[derive(Clone)]
pub struct AppState {
    pub pg: PgPool,
    pub redis: RedisPool,
    pub s3: s3::Client,
    pub s3_bucket: String,
    pub cfg: Config,
    pub signer: Option<Arc<ReceiptSigner>>,
    pub public_keys: Vec<PublicKeyEntry>,
    pub drand: DrandHttpClient,
}

pub async fn build_state(cfg: &Config) -> Result<Arc<AppState>, AppError> {
    // SIG-2 (fail-fast): validate config, incl. refusing the published TEST signer under
    // KD_ENV=prod, BEFORE any DB / Redis / S3 I/O, so a misconfigured prod boot aborts
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

    let (signer, public_keys) = build_signing_material(cfg)?;
    if let Some(signer) = &signer {
        tracing::info!(kid = %signer.kid, "Ed25519 receipt signer initialized");
    } else {
        tracing::warn!("no active Ed25519 receipt signer configured; receipts will be unsigned");
    }
    let drand =
        DrandHttpClient::new(cfg.drand_relays.clone(), cfg.drand_timeout_ms).map_err(internal)?;

    Ok(Arc::new(AppState {
        pg,
        redis,
        s3: s3_client,
        s3_bucket: cfg.s3_bucket.clone(),
        cfg: cfg.clone(),
        signer,
        public_keys,
        drand,
    }))
}

fn build_signing_material(
    cfg: &Config,
) -> Result<(Option<Arc<ReceiptSigner>>, Vec<PublicKeyEntry>), AppError> {
    let mut active_signer: Option<Arc<ReceiptSigner>> = None;
    let mut public_keys = Vec::with_capacity(cfg.signing_keys.len());

    for key in &cfg.signing_keys {
        let kid = key.kid.trim().to_string();
        let mut entry = if let Some(secret) = key.secret_hex.as_deref() {
            let signer = ReceiptSigner::from_hex_seed(secret, kid.clone()).map_err(internal)?;
            let entry = signer.public_key_entry();
            if let Some(configured_public_key) = key.public_key.as_deref()
                && configured_public_key.trim() != entry.public_key
            {
                return Err(internal(format!(
                    "configured public_key for signing kid '{kid}' does not match secret_hex"
                )));
            }
            if key.status == KeyStatus::Active {
                active_signer = Some(Arc::new(signer));
            }
            entry
        } else {
            PublicKeyEntry {
                kid: kid.clone(),
                alg: "Ed25519".to_string(),
                public_key: key
                    .public_key
                    .as_ref()
                    .expect("Config::validate requires public_key or secret_hex")
                    .trim()
                    .to_string(),
                status: key.status,
            }
        };
        entry.status = key.status;
        public_keys.push(entry);
    }

    Ok((active_signer, public_keys))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EnvProfile, TrustedProxy};
    use crate::services::signing::KeyStatus;
    use kd_receipt::PUBLISHED_TEST_SEED_HEX;

    /// A Config that violates SIG-2 (prod + published test seed) with EMPTY connection
    /// strings. `build_state` must refuse at `cfg.validate()`, its FIRST line, before any
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
            signing_keys: vec![crate::config::SigningKeyConfig {
                kid: "test-kid-1".to_string(),
                status: KeyStatus::Active,
                secret_hex: Some(PUBLISHED_TEST_SEED_HEX.to_string()),
                public_key: None,
            }],
            public_base_url: String::new(),
            env_profile: EnvProfile::Prod,
            roll_rl_period_secs: 1,
            roll_rl_burst: 60,
            verify_rl_period_secs: 1,
            verify_rl_burst: 120,
            read_rl_period_secs: 1,
            read_rl_burst: 240,
            drand_relays: vec!["https://api.drand.sh".to_string()],
            drand_timeout_ms: 2500,
            drand_client_max_lag_rounds: 2,
            drand_target_wait_ms: 12_000,
            trusted_proxy: TrustedProxy::Peer,
            allow_peer_ip_in_prod: true,
            roll_max_inflight: 32,
            db_max_connections: 5,
            roll_timeout_ms: 44_000,
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
            msg.contains("published TEST"),
            "expected SIG-2 refusal before any I/O (proves the guard is wired into build_state); got: {msg}"
        );
    }

    #[test]
    fn signing_material_publishes_active_and_retired_keys() {
        let mut cfg = prod_test_seed_cfg();
        cfg.env_profile = EnvProfile::Dev;
        cfg.signing_keys = vec![
            crate::config::SigningKeyConfig {
                kid: "dev-active-1".to_string(),
                status: KeyStatus::Active,
                secret_hex: Some(
                    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".to_string(),
                ),
                public_key: None,
            },
            crate::config::SigningKeyConfig {
                kid: "dev-retired-1".to_string(),
                status: KeyStatus::Retired,
                secret_hex: None,
                public_key: Some("IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=".to_string()),
            },
        ];

        let (signer, keys) = build_signing_material(&cfg).expect("build signing material");

        assert_eq!(
            signer.as_ref().map(|s| s.kid.as_str()),
            Some("dev-active-1")
        );
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].status, KeyStatus::Active);
        assert_eq!(keys[1].status, KeyStatus::Retired);
    }

    #[test]
    fn signing_material_rejects_secret_public_key_mismatch() {
        let mut cfg = prod_test_seed_cfg();
        cfg.env_profile = EnvProfile::Dev;
        cfg.signing_keys = vec![crate::config::SigningKeyConfig {
            kid: "dev-active-1".to_string(),
            status: KeyStatus::Active,
            secret_hex: Some(
                "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".to_string(),
            ),
            public_key: Some("IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=".to_string()),
        }];

        let err = match build_signing_material(&cfg) {
            Ok(_) => panic!("mismatched public_key must be rejected"),
            Err(err) => err.to_string(),
        };
        assert!(
            err.contains("does not match"),
            "expected mismatch refusal, got: {err}"
        );
    }
}
