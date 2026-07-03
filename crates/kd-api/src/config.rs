// typed env, validation

use crate::error::{AppError, bad_request, internal};
use crate::services::signing::{KeyStatus, TEST_KIDS};
use base64::Engine;
use serde::Deserialize;
use std::{env, net::IpAddr};

/// Deployment profile, parsed from `KD_ENV`. `Prod` activates the SIG-2 guard
/// (reject the published TEST signing seed/kid). **Fails closed:** only an explicit dev
/// allowlist => `Dev`, everything else (incl. unknown values) => `Prod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvProfile {
    Dev,
    Prod,
}

impl EnvProfile {
    /// Map a raw `KD_ENV` value to a profile, **failing closed**. Only an explicit dev
    /// allowlist, unset / empty / `dev` / `development` / `local` / `test` (case- and
    /// whitespace-insensitive), maps to `Dev`. Everything else (`prod`, `production`,
    /// `staging`, AND unrecognized values or typos like `prdo`) maps to `Prod`, activating
    /// the SIG-2 guard, so a misconfigured `KD_ENV` can never silently disable it.
    fn from_env_str(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("dev") | Some("development") | Some("local") | Some("test") => {
                EnvProfile::Dev
            }
            _ => EnvProfile::Prod,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustedProxy {
    Peer,
    Xff(u8),
    Cloudflare,
    Fly,
}

impl TrustedProxy {
    pub fn from_env_str(s: Option<&str>) -> Result<Self, AppError> {
        let raw = s.unwrap_or("").trim().to_ascii_lowercase();
        match raw.as_str() {
            "" | "none" | "peer" => Ok(Self::Peer),
            "cloudflare" | "cf" => Ok(Self::Cloudflare),
            "fly" => Ok(Self::Fly),
            _ if raw.starts_with("xff:") => {
                let hops = raw
                    .strip_prefix("xff:")
                    .and_then(|v| v.parse::<u8>().ok())
                    .filter(|v| *v >= 1)
                    .ok_or_else(|| bad_request("KD_TRUSTED_PROXY xff hop count must be >= 1"))?;
                Ok(Self::Xff(hops))
            }
            _ => Err(bad_request(format!(
                "KD_TRUSTED_PROXY must be peer, xff:<hops>, cloudflare, or fly; got '{raw}'"
            ))),
        }
    }

    pub fn ignores_forwarded_headers(self) -> bool {
        matches!(self, Self::Peer)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct SigningKeyConfig {
    pub kid: String,
    #[serde(default)]
    pub status: KeyStatus,
    #[serde(default)]
    pub secret_hex: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    pub database_url: String,
    pub redis_url: String,
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_region: String,
    pub idem_ttl_secs: usize,
    pub idem_poll_ms: u64,
    pub idem_poll_max: usize,
    pub rng_salt: Option<String>,
    /// Hex-encoded 32-byte Ed25519 seed for receipt signing
    pub signing_secret: Option<String>,
    /// Key ID string for the signing key
    pub signing_kid: Option<String>,
    /// Explicit key set. One active key signs. Retired keys verify only. Revoked keys fail verification.
    pub signing_keys: Vec<SigningKeyConfig>,
    /// Public base URL (for building transcript_url etc.)
    pub public_base_url: String,
    /// Deployment profile (KD_ENV). `Prod` activates the SIG-2 signer guard.
    pub env_profile: EnvProfile,
    /// Rate-limit for `POST /v1/roll`: replenish one token every N seconds (`KD_ROLL_RL_PERIOD_SECS`).
    pub roll_rl_period_secs: u64,
    /// Rate-limit for `POST /v1/roll`: max burst (`KD_ROLL_RL_BURST`).
    pub roll_rl_burst: u32,
    /// Comma-separated drand relay base URLs.
    pub drand_relays: Vec<String>,
    /// HTTP timeout per drand relay request.
    pub drand_timeout_ms: u64,
    /// Max tolerated lag between server-side freshness frontier and client-observed round.
    pub drand_client_max_lag_rounds: u64,
    /// Max wall-clock time to wait for the future target drand round to publish.
    pub drand_target_wait_ms: u64,
    /// Source of the client IP used by the `POST /v1/roll` rate limiter.
    pub trusted_proxy: TrustedProxy,
    /// Explicit production opt-in for peer-IP rate limiting with no trusted proxy.
    pub allow_peer_ip_in_prod: bool,
    /// Global max concurrent in-flight `POST /v1/roll` requests.
    pub roll_max_inflight: usize,
    /// Max Postgres connections. Size deliberately with `roll_max_inflight`.
    pub db_max_connections: u32,
    /// Whole-handler timeout for `POST /v1/roll`.
    pub roll_timeout_ms: u64,
    /// Global cap on receipts minted per window across ALL clients (`KD_ROLL_GLOBAL_CAP`).
    /// `0` means uncapped. Bounds the unauthenticated signing endpoint's total cost (OPS-AUTH-01).
    pub roll_global_cap: u64,
    /// Fixed-window length for `roll_global_cap` (`KD_ROLL_GLOBAL_CAP_WINDOW_SECS`).
    pub roll_global_cap_window_secs: u64,
    /// Explicit production opt-out for running the roll endpoint uncapped (`KD_ALLOW_UNCAPPED_ROLL`).
    pub allow_uncapped_roll_in_prod: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        let host: IpAddr = env::var("API_HOST")
            .unwrap_or_else(|_| "127.0.0.1".into())
            .parse()
            .map_err(|e| bad_request(format!("API_HOST invalid: {e}")))?;
        let port: u16 = env::var("API_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8080);

        let database_url =
            env::var("DATABASE_URL").map_err(|_| bad_request("Missing DATABASE_URL"))?;
        let redis_url = env::var("REDIS_URL").map_err(|_| bad_request("Missing REDIS_URL"))?;
        let s3_endpoint =
            env::var("S3_ENDPOINT").map_err(|_| bad_request("Missing S3_ENDPOINT"))?;
        let s3_bucket = env::var("S3_BUCKET").map_err(|_| bad_request("Missing S3_BUCKET"))?;
        let s3_region = env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into());
        let rng_salt = env::var("KD_RNG_SALT").ok();
        let signing_secret = env::var("KD_SIGNING_ED25519_SECRET").ok();
        let signing_kid = env::var("KD_SIGNING_KID").ok();
        let signing_keys = parse_signing_keys(signing_secret.as_deref(), signing_kid.as_deref())?;
        let public_base_url =
            env::var("KD_PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://{}:{}", host, port));
        let env_profile = EnvProfile::from_env_str(env::var("KD_ENV").ok().as_deref());
        let trusted_proxy =
            TrustedProxy::from_env_str(env::var("KD_TRUSTED_PROXY").ok().as_deref())?;
        let allow_peer_ip_in_prod = env_truthy("KD_ALLOW_PEER_IP");
        let roll_rl_period_secs = env::var("KD_ROLL_RL_PERIOD_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1)
            .max(1);
        let roll_rl_burst = env::var("KD_ROLL_RL_BURST")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60)
            .max(1);
        let drand_relays = env::var("DRAND_RELAYS")
            .unwrap_or_else(|_| {
                "https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh".to_string()
            })
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let drand_timeout_ms = env::var("DRAND_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2_500)
            .max(250);
        let drand_client_max_lag_rounds = env::var("DRAND_CLIENT_MAX_LAG_ROUNDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        let drand_target_wait_ms = env::var("DRAND_TARGET_WAIT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(12_000)
            .max(1_000);
        let roll_max_inflight = env::var("KD_ROLL_MAX_INFLIGHT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(32)
            .max(1);
        let db_max_connections = env::var("KD_DB_MAX_CONNECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5)
            .max(1);
        let computed_roll_timeout_ms = drand_target_wait_ms
            + (drand_relays.len() as u64) * 2 * drand_timeout_ms
            + 2 * drand_timeout_ms
            + 2_000;
        let roll_timeout_ms = env::var("KD_ROLL_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(computed_roll_timeout_ms)
            .max(1_000);
        let roll_global_cap = env::var("KD_ROLL_GLOBAL_CAP")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let roll_global_cap_window_secs = env::var("KD_ROLL_GLOBAL_CAP_WINDOW_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3_600)
            .max(1);
        let allow_uncapped_roll_in_prod = env_truthy("KD_ALLOW_UNCAPPED_ROLL");

        Ok(Self {
            host,
            port,
            database_url,
            redis_url,
            s3_endpoint,
            s3_bucket,
            s3_region,
            idem_ttl_secs: 300,
            idem_poll_ms: 50,
            idem_poll_max: 200,
            rng_salt,
            signing_secret,
            signing_kid,
            signing_keys,
            public_base_url,
            env_profile,
            roll_rl_period_secs,
            roll_rl_burst,
            drand_relays,
            drand_timeout_ms,
            drand_client_max_lag_rounds,
            drand_target_wait_ms,
            trusted_proxy,
            allow_peer_ip_in_prod,
            roll_max_inflight,
            db_max_connections,
            roll_timeout_ms,
            roll_global_cap,
            roll_global_cap_window_secs,
            allow_uncapped_roll_in_prod,
        })
    }

    /// Boot-time validation that needs **no I/O**, so it can run fail-fast before any DB /
    /// Redis / S3 connection (see `build_state`). In production it runs the SIG-2 guard:
    /// refuse the published TEST signer, a published TEST kid, or an absent signer. Dev
    /// performs no check (the test seed is allowed locally).
    pub fn validate(&self) -> Result<(), AppError> {
        self.validate_signing_keys()?;
        if self.env_profile == EnvProfile::Prod {
            if self.trusted_proxy.ignores_forwarded_headers() && !self.allow_peer_ip_in_prod {
                return Err(internal(
                    "KD_TRUSTED_PROXY is unset/peer in prod. Set peer, xff:<hops>, cloudflare, or fly. To intentionally run peer-IP keyed in prod, set KD_ALLOW_PEER_IP=1.",
                ));
            }
            if self.roll_global_cap == 0 && !self.allow_uncapped_roll_in_prod {
                return Err(internal(
                    "KD_ROLL_GLOBAL_CAP is unset/0 in prod: the unauthenticated POST /v1/roll endpoint would mint signed receipts without a global ceiling. Set KD_ROLL_GLOBAL_CAP=<max mints per window>. To intentionally run uncapped, set KD_ALLOW_UNCAPPED_ROLL=1.",
                ));
            }
        }
        if self.drand_relays.is_empty() {
            return Err(bad_request("DRAND_RELAYS must contain at least one relay"));
        }
        Ok(())
    }

    fn validate_signing_keys(&self) -> Result<(), AppError> {
        if self.signing_keys.is_empty() {
            if self.env_profile == EnvProfile::Prod {
                return Err(internal(
                    "refusing to start: production requires one active signing key",
                ));
            }
            return Ok(());
        }

        let mut active_count = 0usize;
        let mut seen = std::collections::HashSet::new();
        for key in &self.signing_keys {
            let kid = key.kid.trim();
            if kid.is_empty() {
                return Err(bad_request("signing key kid must not be empty"));
            }
            if !seen.insert(kid.to_ascii_lowercase()) {
                return Err(bad_request(format!("duplicate signing kid '{kid}'")));
            }
            if self.env_profile == EnvProfile::Prod
                && TEST_KIDS.iter().any(|t| t.eq_ignore_ascii_case(kid))
            {
                return Err(internal(format!(
                    "refusing to start: signing kid '{kid}' is a published TEST kid; use a real production kid"
                )));
            }

            if let Some(secret) = key.secret_hex.as_deref() {
                validate_seed_hex(secret)?;
                if self.env_profile == EnvProfile::Prod {
                    crate::services::signing::reject_test_signer_in_prod(Some(secret), Some(kid))
                        .map_err(internal)?;
                }
            }
            if let Some(public_key) = key.public_key.as_deref() {
                validate_public_key(public_key)?;
                if self.env_profile == EnvProfile::Prod {
                    crate::services::signing::reject_test_public_key_in_prod(public_key, Some(kid))
                        .map_err(internal)?;
                }
            }

            match key.status {
                KeyStatus::Active => {
                    active_count += 1;
                    if key
                        .secret_hex
                        .as_deref()
                        .is_none_or(|s| s.trim().is_empty())
                    {
                        return Err(bad_request(format!(
                            "active signing key '{kid}' requires secret_hex"
                        )));
                    }
                }
                KeyStatus::Retired | KeyStatus::Revoked => {
                    let has_secret = key
                        .secret_hex
                        .as_deref()
                        .is_some_and(|s| !s.trim().is_empty());
                    let has_public = key
                        .public_key
                        .as_deref()
                        .is_some_and(|s| !s.trim().is_empty());
                    if !has_secret && !has_public {
                        return Err(bad_request(format!(
                            "{:?} signing key '{kid}' requires public_key or secret_hex",
                            key.status
                        )));
                    }
                }
            }
        }

        if active_count != 1 {
            return Err(bad_request(format!(
                "signing key set must contain exactly one active key; found {active_count}"
            )));
        }
        Ok(())
    }
}

fn parse_signing_keys(
    legacy_secret: Option<&str>,
    legacy_kid: Option<&str>,
) -> Result<Vec<SigningKeyConfig>, AppError> {
    match env::var("KD_SIGNING_KEYS") {
        Ok(raw) if !raw.trim().is_empty() => {
            if legacy_secret.is_some() || legacy_kid.is_some() {
                return Err(bad_request(
                    "KD_SIGNING_KEYS must not be combined with KD_SIGNING_ED25519_SECRET / KD_SIGNING_KID",
                ));
            }
            serde_json::from_str(raw.trim())
                .map_err(|e| bad_request(format!("KD_SIGNING_KEYS must be JSON: {e}")))
        }
        _ => match (legacy_secret, legacy_kid) {
            (Some(secret), Some(kid)) => Ok(vec![SigningKeyConfig {
                kid: kid.to_string(),
                status: KeyStatus::Active,
                secret_hex: Some(secret.to_string()),
                public_key: None,
            }]),
            _ => Ok(Vec::new()),
        },
    }
}

fn validate_seed_hex(secret: &str) -> Result<(), AppError> {
    let bytes = hex::decode(secret.trim())
        .map_err(|e| bad_request(format!("signing secret_hex is not valid hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(bad_request(format!(
            "signing secret_hex must be 32 bytes (64 hex chars), got {}",
            bytes.len()
        )));
    }
    Ok(())
}

fn validate_public_key(public_key: &str) -> Result<(), AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key.trim())
        .map_err(|e| bad_request(format!("signing public_key is not valid base64: {e}")))?;
    if bytes.len() != 32 {
        return Err(bad_request(format!(
            "signing public_key must decode to 32 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(())
}

fn env_truthy(name: &str) -> bool {
    matches!(
        env::var(name)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "y" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::signing::KeyStatus;
    use kd_receipt::{
        PUBLISHED_TEST_PUBLIC_KEY_2_B64, PUBLISHED_TEST_PUBLIC_KEY_B64, PUBLISHED_TEST_SEED_2_HEX,
        PUBLISHED_TEST_SEED_HEX,
    };

    /// A fresh, never-published 32-byte seed (64 hex) standing in for a real prod key.
    const FRESH_SEED_HEX: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn sig2_env_profile_parsing_fails_closed() {
        // Dev allowlist (incl. unset / empty) keeps the permissive local path.
        assert_eq!(EnvProfile::from_env_str(None), EnvProfile::Dev);
        assert_eq!(EnvProfile::from_env_str(Some("")), EnvProfile::Dev);
        assert_eq!(EnvProfile::from_env_str(Some("dev")), EnvProfile::Dev);
        assert_eq!(
            EnvProfile::from_env_str(Some("development")),
            EnvProfile::Dev
        );
        assert_eq!(EnvProfile::from_env_str(Some("local")), EnvProfile::Dev);
        assert_eq!(EnvProfile::from_env_str(Some("test")), EnvProfile::Dev);
        assert_eq!(EnvProfile::from_env_str(Some("  DEV ")), EnvProfile::Dev);
        // Prod, and ANYTHING unrecognized, fails closed to Prod.
        assert_eq!(EnvProfile::from_env_str(Some("prod")), EnvProfile::Prod);
        assert_eq!(
            EnvProfile::from_env_str(Some("PRODUCTION")),
            EnvProfile::Prod
        );
        assert_eq!(EnvProfile::from_env_str(Some("  Prod  ")), EnvProfile::Prod);
        assert_eq!(EnvProfile::from_env_str(Some("staging")), EnvProfile::Prod);
        assert_eq!(EnvProfile::from_env_str(Some("prdo")), EnvProfile::Prod); // typo => fail-closed
    }

    fn cfg_with(profile: EnvProfile, secret: Option<&str>, kid: Option<&str>) -> Config {
        Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 8080,
            database_url: String::new(),
            redis_url: String::new(),
            s3_endpoint: String::new(),
            s3_bucket: String::new(),
            s3_region: String::new(),
            idem_ttl_secs: 0,
            idem_poll_ms: 0,
            idem_poll_max: 0,
            rng_salt: None,
            signing_secret: secret.map(String::from),
            signing_kid: kid.map(String::from),
            signing_keys: match (secret, kid) {
                (Some(secret), Some(kid)) => vec![SigningKeyConfig {
                    kid: kid.to_string(),
                    status: KeyStatus::Active,
                    secret_hex: Some(secret.to_string()),
                    public_key: None,
                }],
                _ => Vec::new(),
            },
            public_base_url: String::new(),
            env_profile: profile,
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

    #[test]
    fn sig2_validate_rejects_test_seed_in_prod() {
        let c = cfg_with(
            EnvProfile::Prod,
            Some(PUBLISHED_TEST_SEED_HEX),
            Some("test-kid-1"),
        );
        assert!(
            c.validate().is_err(),
            "prod + published test seed must fail validate()"
        );
    }

    #[test]
    fn sig2_validate_rejects_test_seed_with_fresh_kid_in_prod() {
        let c = cfg_with(
            EnvProfile::Prod,
            Some(PUBLISHED_TEST_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("published TEST seed"),
            "prod + published test seed under a fresh kid must fail via seed guard, got: {err}"
        );
    }

    #[test]
    fn sig2_validate_rejects_second_test_kid_in_prod() {
        let c = cfg_with(
            EnvProfile::Prod,
            Some(PUBLISHED_TEST_SEED_2_HEX),
            Some("test-kid-2"),
        );
        assert!(
            c.validate().is_err(),
            "prod + second published test signer must fail validate()"
        );
    }

    #[test]
    fn sig2_validate_rejects_second_test_seed_with_fresh_kid_in_prod() {
        let c = cfg_with(
            EnvProfile::Prod,
            Some(PUBLISHED_TEST_SEED_2_HEX),
            Some("truerolls-prod-2"),
        );
        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("published TEST seed"),
            "prod + second published test seed under a fresh kid must fail via seed guard, got: {err}"
        );
    }

    #[test]
    fn signing_key_config_requires_single_active_signer() {
        let mut c = cfg_with(EnvProfile::Dev, None, None);
        c.signing_keys = vec![
            SigningKeyConfig {
                kid: "dev-active-1".to_string(),
                status: KeyStatus::Active,
                secret_hex: Some(FRESH_SEED_HEX.to_string()),
                public_key: None,
            },
            SigningKeyConfig {
                kid: "dev-active-2".to_string(),
                status: KeyStatus::Active,
                secret_hex: Some(
                    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".to_string(),
                ),
                public_key: None,
            },
        ];

        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("exactly one active"),
            "expected single-active-key validation, got: {err}"
        );
    }

    #[test]
    fn signing_key_config_allows_retired_public_key_plus_one_active() {
        let mut c = cfg_with(EnvProfile::Dev, Some(FRESH_SEED_HEX), Some("dev-active-1"));
        c.signing_keys.push(SigningKeyConfig {
            kid: "dev-retired-1".to_string(),
            status: KeyStatus::Retired,
            secret_hex: None,
            public_key: Some("IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=".to_string()),
        });

        assert!(c.validate().is_ok(), "{:?}", c.validate());
    }

    #[test]
    fn sig2_validate_rejects_renamed_test_public_key_in_prod() {
        let mut c = cfg_with(
            EnvProfile::Prod,
            Some(FRESH_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        c.signing_keys.push(SigningKeyConfig {
            kid: "issuer-2026-06".to_string(),
            status: KeyStatus::Retired,
            secret_hex: None,
            public_key: Some(PUBLISHED_TEST_PUBLIC_KEY_B64.to_string()),
        });

        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("published TEST public key"),
            "prod must reject a published test public key even under a fresh kid, got: {err}"
        );
    }

    #[test]
    fn sig2_validate_rejects_second_renamed_test_public_key_in_prod() {
        let mut c = cfg_with(
            EnvProfile::Prod,
            Some(FRESH_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        c.signing_keys.push(SigningKeyConfig {
            kid: "issuer-2026-07".to_string(),
            status: KeyStatus::Revoked,
            secret_hex: None,
            public_key: Some(PUBLISHED_TEST_PUBLIC_KEY_2_B64.to_string()),
        });

        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("published TEST public key"),
            "prod must reject the second published test public key too, got: {err}"
        );
    }

    #[test]
    fn sig2_validate_rejects_absent_signer_in_prod() {
        assert!(
            cfg_with(EnvProfile::Prod, None, None).validate().is_err(),
            "prod must require a signer"
        );
    }

    #[test]
    fn sig2_validate_accepts_fresh_signer_in_prod() {
        let c = cfg_with(
            EnvProfile::Prod,
            Some(FRESH_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        assert!(c.validate().is_ok(), "{:?}", c.validate());
    }

    #[test]
    fn sig2_validate_skips_guard_in_dev() {
        // Dev must NOT run the guard, the published test seed is allowed locally.
        let c = cfg_with(
            EnvProfile::Dev,
            Some(PUBLISHED_TEST_SEED_HEX),
            Some("test-kid-1"),
        );
        assert!(c.validate().is_ok());
    }

    #[test]
    fn trusted_proxy_parsing_is_fail_closed() {
        assert_eq!(
            TrustedProxy::from_env_str(None).unwrap(),
            TrustedProxy::Peer
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("")).unwrap(),
            TrustedProxy::Peer
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("peer")).unwrap(),
            TrustedProxy::Peer
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("none")).unwrap(),
            TrustedProxy::Peer
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("xff:2")).unwrap(),
            TrustedProxy::Xff(2)
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("cloudflare")).unwrap(),
            TrustedProxy::Cloudflare
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("cf")).unwrap(),
            TrustedProxy::Cloudflare
        );
        assert_eq!(
            TrustedProxy::from_env_str(Some("fly")).unwrap(),
            TrustedProxy::Fly
        );
        assert!(TrustedProxy::from_env_str(Some("xff:0")).is_err());
        assert!(TrustedProxy::from_env_str(Some("xff:nope")).is_err());
        assert!(TrustedProxy::from_env_str(Some("smart")).is_err());
    }

    #[test]
    fn prod_rejects_peer_ip_mode_unless_explicitly_allowed() {
        let mut c = cfg_with(
            EnvProfile::Prod,
            Some(FRESH_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        c.trusted_proxy = TrustedProxy::Peer;
        c.allow_peer_ip_in_prod = false;

        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("KD_TRUSTED_PROXY"),
            "prod peer mode without explicit opt-in must fail closed, got: {err}"
        );

        c.allow_peer_ip_in_prod = true;
        assert!(c.validate().is_ok());

        c.allow_peer_ip_in_prod = false;
        c.trusted_proxy = TrustedProxy::Xff(1);
        assert!(c.validate().is_ok());
    }

    #[test]
    fn prod_requires_global_roll_cap_unless_explicitly_uncapped() {
        // Fresh signer + a real proxy boundary, so SIG-2 and the proxy gate both pass and only
        // the mint-cap gate is under test.
        let mut c = cfg_with(
            EnvProfile::Prod,
            Some(FRESH_SEED_HEX),
            Some("truerolls-prod-1"),
        );
        c.trusted_proxy = TrustedProxy::Xff(1);
        c.allow_peer_ip_in_prod = false;

        // Uncapped (0) without the explicit opt-out must refuse to boot.
        c.roll_global_cap = 0;
        c.allow_uncapped_roll_in_prod = false;
        let err = c.validate().unwrap_err().to_string();
        assert!(
            err.contains("KD_ROLL_GLOBAL_CAP"),
            "prod uncapped without opt-out must fail closed, got: {err}"
        );

        // A finite cap satisfies the gate.
        c.roll_global_cap = 10_000;
        assert!(c.validate().is_ok(), "{:?}", c.validate());

        // Or an explicit uncapped opt-out.
        c.roll_global_cap = 0;
        c.allow_uncapped_roll_in_prod = true;
        assert!(c.validate().is_ok(), "{:?}", c.validate());
    }

    #[test]
    fn dev_does_not_require_a_global_roll_cap() {
        // Dev skips the gate (like SIG-2 and the proxy gate): uncapped is fine locally.
        let mut c = cfg_with(EnvProfile::Dev, None, None);
        c.roll_global_cap = 0;
        c.allow_uncapped_roll_in_prod = false;
        assert!(c.validate().is_ok());
    }
}
