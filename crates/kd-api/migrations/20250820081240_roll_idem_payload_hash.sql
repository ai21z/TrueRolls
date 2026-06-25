-- Add payload hash for strict idempotency
ALTER TABLE rolls
    ADD COLUMN IF NOT EXISTS idem_payload_sha256 BYTEA;

-- Optional: backfill existing rows to an empty value
-- (we'll treat NULL as "unknown" and still deduplicate, no conflict)
UPDATE rolls SET idem_payload_sha256 = NULL WHERE idem_payload_sha256 IS NULL;
