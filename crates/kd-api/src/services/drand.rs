use crate::models::dto::RollDrandRequest;
use serde::Deserialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

#[derive(Clone)]
pub struct DrandHttpClient {
    relays: Vec<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DrandInfo {
    pub public_key: String,
    pub period: u64,
    pub genesis_time: u64,
    pub hash: String,
    #[serde(rename = "schemeID")]
    pub scheme_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DrandApiPulse {
    round: u64,
    randomness: String,
    signature: String,
}

impl DrandHttpClient {
    pub fn new(relays: Vec<String>, timeout_ms: u64) -> Result<Self, String> {
        if relays.is_empty() {
            return Err("at least one drand relay is required".to_string());
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|e| format!("failed to build drand HTTP client: {e}"))?;
        Ok(Self { relays, http })
    }

    pub async fn fetch_latest_verified(&self) -> Result<kd_drand::DrandPulse, String> {
        self.fetch_verified("public/latest").await
    }

    pub async fn fetch_round_verified(&self, round: u64) -> Result<kd_drand::DrandPulse, String> {
        let pulse = self.fetch_verified(&format!("public/{round}")).await?;
        validate_requested_round(&pulse, round)?;
        Ok(pulse)
    }

    pub async fn wait_for_round_verified(
        &self,
        round: u64,
        max_wait_ms: u64,
    ) -> Result<kd_drand::DrandPulse, String> {
        let deadline = Instant::now() + Duration::from_millis(max_wait_ms);
        loop {
            let last_error = match self.fetch_round_verified(round).await {
                Ok(pulse) => return Ok(pulse),
                Err(e) => e,
            };
            if Instant::now() >= deadline {
                return Err(format!(
                    "target round {round} was not available within {max_wait_ms}ms; last error: {}",
                    last_error
                ));
            }
            sleep(Duration::from_millis(200)).await;
        }
    }

    async fn fetch_verified(&self, path: &str) -> Result<kd_drand::DrandPulse, String> {
        let mut errors = Vec::new();
        for relay in &self.relays {
            match self.fetch_verified_from_relay(relay, path).await {
                Ok(pulse) => return Ok(pulse),
                Err(e) => errors.push(format!("{relay}: {e}")),
            }
        }
        Err(format!("all drand relays failed: {}", errors.join("; ")))
    }

    async fn fetch_verified_from_relay(
        &self,
        relay: &str,
        path: &str,
    ) -> Result<kd_drand::DrandPulse, String> {
        let info_url = format!("{}/{}/info", relay, kd_drand::QUICKNET_CHAIN_HASH);
        let info = self
            .http
            .get(&info_url)
            .send()
            .await
            .map_err(|e| format!("GET /info failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GET /info status failed: {e}"))?
            .json::<DrandInfo>()
            .await
            .map_err(|e| format!("decode /info failed: {e}"))?;
        validate_info(&info)?;

        let pulse_url = format!("{}/{}/{}", relay, kd_drand::QUICKNET_CHAIN_HASH, path);
        let api = self
            .http
            .get(&pulse_url)
            .send()
            .await
            .map_err(|e| format!("GET {path} failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GET {path} status failed: {e}"))?
            .json::<DrandApiPulse>()
            .await
            .map_err(|e| format!("decode {path} failed: {e}"))?;

        let pulse = kd_drand::DrandPulse {
            chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
            round: api.round,
            signature_hex: api.signature,
            randomness_hex: api.randomness,
        };
        pulse.verify_quicknet().map_err(|e| e.to_string())?;
        Ok(pulse)
    }
}

pub fn validate_info(info: &DrandInfo) -> Result<(), String> {
    if info.hash != kd_drand::QUICKNET_CHAIN_HASH {
        return Err(format!(
            "hash {} != pinned {}",
            info.hash,
            kd_drand::QUICKNET_CHAIN_HASH
        ));
    }
    if info.public_key != kd_drand::QUICKNET_PUBLIC_KEY_HEX {
        return Err("public_key does not match pinned quicknet key".to_string());
    }
    if info.scheme_id != kd_drand::QUICKNET_SCHEME {
        return Err(format!(
            "schemeID {} != {}",
            info.scheme_id,
            kd_drand::QUICKNET_SCHEME
        ));
    }
    if info.period != kd_drand::QUICKNET_PERIOD_SECONDS {
        return Err(format!(
            "period {} != {}",
            info.period,
            kd_drand::QUICKNET_PERIOD_SECONDS
        ));
    }
    if info.genesis_time != kd_drand::QUICKNET_GENESIS_TIME {
        return Err(format!(
            "genesis_time {} != {}",
            info.genesis_time,
            kd_drand::QUICKNET_GENESIS_TIME
        ));
    }
    Ok(())
}

fn validate_requested_round(
    pulse: &kd_drand::DrandPulse,
    requested_round: u64,
) -> Result<(), String> {
    if pulse.round == requested_round {
        Ok(())
    } else {
        Err(format!(
            "drand relay returned round {} for requested round {}",
            pulse.round, requested_round
        ))
    }
}

pub fn validate_roll_drand_request(
    req: &RollDrandRequest,
    server_latest_round: u64,
    wall_clock_frontier_round: u64,
    max_lag_rounds: u64,
) -> Result<kd_drand::DrandPulse, String> {
    kd_drand::validate_target_round(req.client_observed_round, req.target_round)
        .map_err(|e| e.to_string())?;

    let freshness_frontier_round = server_latest_round.max(wall_clock_frontier_round);

    if req.target_round <= freshness_frontier_round {
        return Err(format!(
            "target_round {} must be a future drand round beyond freshness frontier {} (server latest {}, wall-clock frontier {}); refresh and retry",
            req.target_round,
            freshness_frontier_round,
            server_latest_round,
            wall_clock_frontier_round
        ));
    }

    if freshness_frontier_round.saturating_sub(req.client_observed_round) > max_lag_rounds {
        return Err(format!(
            "client drand frontier round {} is too stale versus freshness frontier {} (server latest {}, wall-clock frontier {}); refresh and retry",
            req.client_observed_round,
            freshness_frontier_round,
            server_latest_round,
            wall_clock_frontier_round
        ));
    }

    let observed = kd_drand::DrandPulse {
        chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
        round: req.client_observed_round,
        signature_hex: req.client_observed_signature_hex.clone(),
        randomness_hex: req.client_observed_randomness_hex.clone(),
    };
    observed.verify_quicknet().map_err(|e| e.to_string())?;
    Ok(observed)
}

pub fn quicknet_wall_clock_frontier_round() -> Result<u64, String> {
    let unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("server wall clock is before Unix epoch: {e}"))?
        .as_secs();
    Ok(kd_drand::quicknet_round_at_unix_seconds(unix_seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_info() -> DrandInfo {
        DrandInfo {
            public_key: kd_drand::QUICKNET_PUBLIC_KEY_HEX.to_string(),
            period: kd_drand::QUICKNET_PERIOD_SECONDS,
            genesis_time: kd_drand::QUICKNET_GENESIS_TIME,
            hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
            scheme_id: kd_drand::QUICKNET_SCHEME.to_string(),
        }
    }

    #[test]
    fn validate_info_accepts_pinned_quicknet_and_rejects_wrong_key() {
        validate_info(&good_info()).expect("pinned quicknet info must validate");
        let mut bad = good_info();
        bad.public_key = "00".repeat(96);
        assert!(validate_info(&bad).is_err());
    }

    #[test]
    fn validate_roll_drand_request_rejects_stale_client_frontier() {
        let req = RollDrandRequest {
            client_observed_round: 121,
            client_observed_signature_hex: "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd".to_string(),
            client_observed_randomness_hex: "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f".to_string(),
            target_round: 123,
        };
        validate_roll_drand_request(&req, 122, 122, 1).expect("one-round lag is accepted");
        assert!(validate_roll_drand_request(&req, 125, 125, 1).is_err());
    }

    #[test]
    fn validate_roll_drand_request_rejects_already_published_target_round() {
        let req = RollDrandRequest {
            client_observed_round: 121,
            client_observed_signature_hex: "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd".to_string(),
            client_observed_randomness_hex: "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f".to_string(),
            target_round: 123,
        };
        let err = validate_roll_drand_request(&req, 123, 123, 2).unwrap_err();
        assert!(
            err.contains("future"),
            "already-published target must be rejected as non-future: {err}"
        );
    }

    #[test]
    fn validate_roll_drand_request_rejects_target_not_future_vs_wall_clock_frontier() {
        let req = RollDrandRequest {
            client_observed_round: 121,
            client_observed_signature_hex: "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd".to_string(),
            client_observed_randomness_hex: "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f".to_string(),
            target_round: 123,
        };
        let err = validate_roll_drand_request(&req, 121, 123, 2).unwrap_err();
        assert!(
            err.contains("wall-clock"),
            "target already due by local wall-clock frontier must be rejected: {err}"
        );
    }

    #[test]
    fn validate_roll_drand_request_rejects_current_round_from_pinned_schedule() {
        let req = RollDrandRequest {
            client_observed_round: 121,
            client_observed_signature_hex: "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd".to_string(),
            client_observed_randomness_hex: "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f".to_string(),
            target_round: 123,
        };
        let unix_seconds =
            kd_drand::QUICKNET_GENESIS_TIME + 122 * kd_drand::QUICKNET_PERIOD_SECONDS;
        let current_round = kd_drand::quicknet_round_at_unix_seconds(unix_seconds);
        assert_eq!(current_round, 123);

        let err = validate_roll_drand_request(&req, 121, current_round, 2).unwrap_err();
        assert!(
            err.contains("future"),
            "current published target must be rejected even when relay latest is stale: {err}"
        );
    }

    #[test]
    fn validate_requested_round_rejects_relay_round_substitution() {
        let pulse = kd_drand::DrandPulse {
            chain_hash: kd_drand::QUICKNET_CHAIN_HASH.to_string(),
            round: 123,
            signature_hex: "b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92".to_string(),
            randomness_hex: "fb8f7bc29bf24db51871ec8c79f3a1e4bd0557bc0dfcee9ed1d924e69d1c60dc".to_string(),
        };
        assert!(validate_requested_round(&pulse, 123).is_ok());
        assert!(validate_requested_round(&pulse, 124).is_err());
    }
}
