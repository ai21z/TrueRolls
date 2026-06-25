#requires -Version 7
<#
.SYNOPSIS
  One-shot local bring-up for kd-api + its dependencies. Idempotent.

.DESCRIPTION
  Brings the full local stack up in the correct order and leaves kd-api
  running in the background, then prints next steps. Replaces the manual
  dance (compose up -> wait healthy -> migrate -> bucket -> build -> run).

  Order matters and is enforced here:
    1. docker compose up   (Postgres / Redis / MinIO) + wait for healthy
    2. sqlx migrate run     (schema must exist BEFORE the build:
                             kd-api's sqlx::query! macros validate against
                             the live DB at COMPILE time)
    3. create the S3 bucket (idempotent)
    4. cargo build -p kd-api (DEBUG — reuses the already-compiled
                             aws-lc-sys artifact; a clean/release build
                             would need NASM + cmake, which this repo's
                             aws-lc-sys dependency requires on Windows)
    5. launch target/debug/kd-api.exe detached (NOT `cargo run`, so a later
                             `cargo test` never collides with the exe lock)
    6. health-gate /healthz

  Signing uses the PUBLIC TEST key (kid test-kid-1). NEVER production.

.EXAMPLE
  pwsh -File scripts/dev-up.ps1
.EXAMPLE
  pwsh -File scripts/dev-up.ps1 -Recreate   # wipe DB/bucket volumes first
#>
[CmdletBinding()]
param(
  [switch]$Recreate,          # docker compose down -v first (cold start)
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$DB   = 'postgres://kd:1643@localhost:5432/kd'
$compose = @('compose', '-f', 'infra/docker-compose.yml', '--env-file', 'infra/.env')

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "ABORT: $msg" -ForegroundColor Red; exit 1 }

# --- preconditions ------------------------------------------------------------
try { docker info *> $null } catch { Die "Docker daemon not reachable. Start Docker Desktop and retry." }
if (-not (Test-Path infra/.env)) {
  Copy-Item .env.example infra/.env
  Write-Host "  created infra/.env from .env.example"
}

# --- 1. infra -----------------------------------------------------------------
Step 1 "Bring up Postgres / Redis / MinIO"
if ($Recreate) { Write-Host "  --Recreate: wiping volumes"; docker @compose down -v *> $null }
docker @compose up -d *> $null
$deadline = (Get-Date).AddSeconds(120)
do {
  Start-Sleep 3
  $healthy = (docker ps --filter 'name=kd-' --format '{{.Status}}' | Select-String 'healthy').Count
} until ($healthy -ge 3 -or (Get-Date) -gt $deadline)
if ($healthy -lt 3) { Die "infra did not become healthy in 120s. Check: docker ps" }
Write-Host "  postgres / redis / minio healthy"

# --- 2. migrations (BEFORE build — compile-time sqlx checks) -------------------
Step 2 "Apply database migrations"
$env:DATABASE_URL = $DB
sqlx migrate run --source crates/kd-api/migrations | ForEach-Object { "  $_" }

# --- 3. S3 bucket -------------------------------------------------------------
Step 3 "Ensure S3 transcript bucket"
docker exec kd-minio mc alias set local http://localhost:9000 kdadmin kd_dev_only_123 *> $null
docker exec kd-minio mc mb --ignore-existing local/kd-transcripts *> $null
Write-Host "  bucket kd-transcripts ready"

# --- 4. build (debug; reuses aws-lc-sys, no NASM needed) -----------------------
Step 4 "Build kd-api (debug)"
cargo build -p kd-api 2>&1 | Select-Object -Last 1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "cargo build -p kd-api failed (a clean/release build needs NASM + cmake for aws-lc-sys)." }

# --- 5. launch kd-api detached, with the TEST signing key ---------------------
Step 5 "Launch kd-api (detached, test signing key)"
if (Get-Process kd-api -ErrorAction SilentlyContinue) {
  Write-Host "  kd-api already running — stopping it first"
  Get-Process kd-api | Stop-Process -Force; Start-Sleep 2
}
$env:REDIS_URL  = 'redis://:kd_dev_only@127.0.0.1:6379'
$env:S3_ENDPOINT = 'http://127.0.0.1:9000'
$env:S3_BUCKET  = 'kd-transcripts'
$env:AWS_REGION = 'us-east-1'
$env:AWS_ACCESS_KEY_ID = 'kdadmin'
$env:AWS_SECRET_ACCESS_KEY = 'kd_dev_only_123'
$env:KD_SIGNING_ED25519_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' # TEST KEY — never production
$env:KD_SIGNING_KID = 'test-kid-1'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = "$Port"
New-Item -ItemType Directory -Force outputs *> $null
$log = Join-Path $root 'outputs/kd-api.log'
Start-Process -FilePath (Join-Path $root 'target/debug/kd-api.exe') `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden

# --- 6. health gate -----------------------------------------------------------
Step 6 "Wait for /healthz"
$deadline = (Get-Date).AddSeconds(60); $ok = $false
while ((Get-Date) -lt $deadline) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2; if ($h.status -eq 'ok') { $ok = $true; break } } catch { Start-Sleep 2 }
}
if (-not $ok) { Write-Host "  last log lines:"; Get-Content $log.err -Tail 8 -EA SilentlyContinue; Die "kd-api did not become healthy. See $log.err" }
Write-Host "  healthz: ok (db=$($h.db) redis=$($h.redis) s3=$($h.s3))" -ForegroundColor Green

Write-Host "`nStack is UP." -ForegroundColor Green
Write-Host "  kd-api:        http://127.0.0.1:$Port  (log: outputs/kd-api.log)"
Write-Host "  tamper demo:   pwsh -File scripts/tamper-demo.ps1"
Write-Host "  loom UI:       corepack pnpm -C services/loom-demo dev      (proxies /api -> :$Port)"
Write-Host "  tear down:     pwsh -File scripts/dev-down.ps1"
