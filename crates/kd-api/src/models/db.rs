use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Row shape returned by our SELECT's over `rolls` (+ optional transcript key).
/// This mirrors the columns we SELECT in services/db.rs.
pub struct RollRow {
    pub public_id: Uuid,
    pub die: String,
    pub kappa: f64,
    pub seed: Option<String>,
    pub face: i32,
    pub ev: f64,
    pub alpha: f64,
    pub kl: f64,
    pub created_at: DateTime<Utc>,
    #[allow(dead_code)]
    pub idem_payload_sha256: Option<Vec<u8>>, // for audit/dedup checks
    pub s3_key: Option<String>,
}
