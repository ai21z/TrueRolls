// Roll persistence and idempotent receipt lookup.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::Row;
use uuid::Uuid;

pub struct RollInsertResult {
    pub id: i64, // rolls.id (PK)
}

pub struct IdempotencyRecord {
    pub idem_payload_sha256: Option<Vec<u8>>,
    pub receipt_json: Option<Value>,
}

pub async fn select_idempotency_record_by_key(
    pg: &PgPool,
    key: &str,
) -> Result<Option<IdempotencyRecord>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT idem_payload_sha256, receipt_json
        FROM rolls
        WHERE idempotency_key = $1
        ORDER BY id DESC
        LIMIT 1
        "#,
    )
    .bind(key)
    .fetch_optional(pg)
    .await?;

    row.map(|row| {
        Ok(IdempotencyRecord {
            idem_payload_sha256: row.try_get("idem_payload_sha256")?,
            receipt_json: row.try_get("receipt_json")?,
        })
    })
    .transpose()
}

// Return one roll + optional transcript S3 key by public_id
pub async fn select_roll_by_public_id(
    pg: &sqlx::PgPool,
    public_id: uuid::Uuid,
) -> sqlx::Result<Option<crate::models::db::RollRow>> {
    sqlx::query_as!(
        crate::models::db::RollRow,
        r#"
        SELECT
            rolls.public_id,
            rolls.die,
            rolls.kappa,
            rolls.seed,
            rolls.face,
            rolls.ev,
            rolls.alpha,
            rolls.kl,
            rolls.created_at,
            rolls.idem_payload_sha256 AS "idem_payload_sha256?",
            (SELECT s3_key FROM transcripts_meta WHERE roll_id = rolls.id LIMIT 1) AS "s3_key?"
        FROM rolls
        WHERE rolls.public_id = $1
        "#,
        public_id
    )
    .fetch_optional(pg)
    .await
}

// Already have selected by idem? If not, keep this version:
pub async fn select_roll_by_idem_key(
    pg: &sqlx::PgPool,
    idem_key: &str,
) -> sqlx::Result<Option<crate::models::db::RollRow>> {
    sqlx::query_as!(
        crate::models::db::RollRow,
        r#"
        SELECT
            rolls.public_id,
            rolls.die,
            rolls.kappa,
            rolls.seed,
            rolls.face,
            rolls.ev,
            rolls.alpha,
            rolls.kl,
            rolls.created_at,
            rolls.idem_payload_sha256 AS "idem_payload_sha256?",
            (SELECT s3_key FROM transcripts_meta WHERE roll_id = rolls.id LIMIT 1) AS "s3_key?"
        FROM rolls
        WHERE rolls.idempotency_key = $1
        ORDER BY rolls.id DESC
        LIMIT 1
        "#,
        idem_key
    )
    .fetch_optional(pg)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_complete_roll(
    pg: &PgPool,
    public_id: Uuid,
    created_at: DateTime<Utc>,
    die: &str,
    kappa: f64,
    seed: Option<&str>,
    idempotency_key: &str,
    idem_payload_sha256: &[u8],
    face: i32,
    ev: f64,
    alpha: f64,
    kl: f64,
    receipt_json: &Value,
    s3_key: &str,
    transcript_sha256: &[u8],
    transcript_size_bytes: i64,
) -> Result<Option<RollInsertResult>, sqlx::Error> {
    let mut tx = pg.begin().await?;

    let row = sqlx::query(
        r#"
        INSERT INTO rolls
            (public_id, die, kappa, seed, idempotency_key, idem_payload_sha256,
             face, ev, alpha, kl, created_at, receipt_json)
        VALUES
            ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(public_id)
    .bind(die)
    .bind(kappa)
    .bind(seed)
    .bind(idempotency_key)
    .bind(idem_payload_sha256)
    .bind(face)
    .bind(ev)
    .bind(alpha)
    .bind(kl)
    .bind(created_at)
    .bind(receipt_json)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let id: i64 = row.try_get("id")?;

    sqlx::query(
        r#"
        INSERT INTO transcripts_meta (roll_id, s3_key, sha256, size_bytes)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(id)
    .bind(s3_key)
    .bind(transcript_sha256)
    .bind(transcript_size_bytes)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Some(RollInsertResult { id }))
}
