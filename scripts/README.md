# scripts/

Operational helpers for local verification. Assertions are exact and failures
exit non-zero. Scripts that call public drand are external-network observations,
not deterministic gates; relay failure is reported as failure, never PASS.

## `dev-up.ps1` / `dev-down.ps1` - one-command local stack

`dev-up.ps1` brings the whole stack up in the correct order and leaves kd-api
running detached, then prints next steps:

```powershell
pwsh -File scripts/dev-up.ps1            # up (keeps DB volume if present)
pwsh -File scripts/dev-up.ps1 -Recreate  # cold start: wipe DB/bucket first
pwsh -File scripts/dev-down.ps1          # stop kd-api + dev servers + infra
pwsh -File scripts/dev-down.ps1 -Volumes # also wipe volumes
```

It enforces the ordering that previously caused friction:

1. `docker compose up` → wait until Postgres/Redis/MinIO are **healthy**.
2. `sqlx migrate run` before launch, so the local database schema is current.
   A committed `.sqlx` cache supports offline compile-time query checks, while
   the live migration remains necessary for the running service.
3. create the S3 bucket (idempotent).
4. `cargo build --locked -p kd-api` (debug).
5. launch `target/debug/kd-api.exe` **detached** (not `cargo run`, so a later
   `cargo test` never collides with the Windows exe lock).
6. health-gate `/healthz`.

Signing uses the **public test key** (`kid test-kid-1`) - never production.

### Build-tooling note (NASM / cmake)

This repo's `aws-lc-sys` dependency needs **NASM** and **cmake** for a clean
Windows compile. Both tools must be on `PATH` when rebuilding the native
dependency. The repository includes a committed `.sqlx` cache and CI sets
`SQLX_OFFLINE=true`; local stack startup still applies migrations before launch
so the runtime database matches the code.

## `tamper-demo.ps1` - end-to-end trust-spine proof

Fetches the configured live drand quicknet relays, selects the freshest structurally valid pulse,
and requests a future-round
`truerolls-drand-1` roll, and requires all five receipt checks to pass both
offline (`kd verify --receipt`) and server-side (`POST /v1/verify`). It then
changes the signed face and proves signature and face checks fail. This is an
X-class external-network test: all-relay failure is reported as failure, never PASS. The API still
performs the pinned BLS verification; freshest-relay selection is only a liveness measure.

### One-time stack bring-up (PowerShell, from repo root)

```powershell
# 1. infra
Copy-Item .env.example infra/.env -Force
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d

# 2. db schema + transcript bucket
$env:DATABASE_URL = 'postgres://kd:kd_dev_only_pw@localhost:5432/kd'
sqlx migrate run --source crates/kd-api/migrations
docker exec kd-minio mc alias set local http://localhost:9000 kdadmin kd_dev_only_123
docker exec kd-minio mc mb --ignore-existing local/kd-transcripts

# 3. build + run kd-api with the PUBLIC TEST signing key (never production)
cargo build --locked --release -p kd-cli     # for the kd CLI the script calls
$env:REDIS_URL  = 'redis://:kd_dev_only@127.0.0.1:6379'
$env:S3_ENDPOINT = 'http://127.0.0.1:9000'
$env:S3_BUCKET  = 'kd-transcripts'
$env:AWS_ACCESS_KEY_ID = 'kdadmin'
$env:AWS_SECRET_ACCESS_KEY = 'kd_dev_only_123'
$env:KD_SIGNING_ED25519_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$env:KD_SIGNING_KID = 'test-kid-1'
cargo run --locked -p kd-api # leave running in this terminal
```

### Run the demo (second terminal)

```powershell
pwsh -File scripts/tamper-demo.ps1
# -> ALL <N> CHECKS PASSED   (exit 0)
```

### Service-free equivalent (CI)

The same tamper guarantee is frozen as a committed regression test that needs
no services at all:

```powershell
cargo test --locked -p kd-cli --test goldens
# golden_receipt_valid_offline      -> VALID
# golden_receipt_tampered_invalid   -> INVALID
```

## `backup-restore-rehearsal.ps1` - disposable recovery proof

Exercises PostgreSQL and MinIO backup/restore against only the isolated
`truerolls-candidate` Compose project. It refuses pre-existing candidate resources, verifies Compose
project labels before deleting volumes, restores relational and object-store sentinels, checks API
health, and removes the disposable candidate resources afterward.

```powershell
docker build --pull --no-cache -t truerolls-kd-api:a-tier-candidate .
pwsh -File scripts/backup-restore-rehearsal.ps1
```

This is a local controlled rehearsal, not a production backup command.
