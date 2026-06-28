# scripts/

Operational helpers for local verification. These are deterministic: every
assertion is an exact equality, and they fail loudly (non-zero exit) rather
than reporting false success.

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
2. `sqlx migrate run` **before** building - kd-api's `sqlx::query!` macros
   validate against the live DB at *compile* time, so the schema must exist
   first.
3. create the S3 bucket (idempotent).
4. `cargo build -p kd-api` (**debug** - reuses the already-compiled
   `aws-lc-sys` artifact).
5. launch `target/debug/kd-api.exe` **detached** (not `cargo run`, so a later
   `cargo test` never collides with the Windows exe lock).
6. health-gate `/healthz`.

Signing uses the **public test key** (`kid test-kid-1`) - never production.

### Build-tooling note (NASM / cmake)

This repo's `aws-lc-sys` dependency needs **NASM** and **cmake** to compile on
Windows. Normal incremental debug builds reuse the already-compiled artifact
and don't need them, which is why `dev-up.ps1` uses the debug profile. But a
`cargo clean`, a `--release` build, or `cargo check` (which `cargo sqlx
prepare` runs) will try to rebuild `aws-lc-sys` and fail without those tools.
Consequence: there is currently **no committed `.sqlx` offline cache** because
generating one requires `cargo check` to succeed. Install NASM + cmake (or
switch the TLS backend off `aws-lc`) to enable release builds and an offline
sqlx cache.

## `tamper-demo.ps1` - end-to-end trust-spine proof

Proves, against a running `kd-api`, that a signed receipt verifies VALID and
that a single tampered field is rejected both offline (`kd verify --receipt`)
and server-side (`POST /v1/verify`). See the header comment in the script for
the full assertion list.

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
cargo build --release -p kd-cli              # for the kd CLI the script calls
$env:REDIS_URL  = 'redis://:kd_dev_only@127.0.0.1:6379'
$env:S3_ENDPOINT = 'http://127.0.0.1:9000'
$env:S3_BUCKET  = 'kd-transcripts'
$env:AWS_ACCESS_KEY_ID = 'kdadmin'
$env:AWS_SECRET_ACCESS_KEY = 'kd_dev_only_123'
$env:KD_SIGNING_ED25519_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$env:KD_SIGNING_KID = 'test-kid-1'
cargo run -p kd-api          # leave running in this terminal
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
cargo test -p kd-cli --test goldens
# golden_receipt_valid_offline      -> VALID
# golden_receipt_tampered_invalid   -> INVALID
```
