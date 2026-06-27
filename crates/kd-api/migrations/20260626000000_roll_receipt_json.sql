-- Store the signed receipt envelope for idempotency replay.
ALTER TABLE rolls
    ADD COLUMN IF NOT EXISTS receipt_json JSONB;
