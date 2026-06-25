#requires -Version 7
<#
.SYNOPSIS
  Deterministic end-to-end tamper demo for the TrueRolls trust spine.

.DESCRIPTION
  Every check is an exact assertion. The script proves, against a running kd-api:

    1. POST /v1/roll returns a signed truerolls-1 receipt (sig + kid present).
    2. The unmodified receipt verifies VALID offline (kd verify --receipt) and
       server-side (POST /v1/verify -> all four checks true).
    3. A single tampered field (face flipped) is REJECTED both offline
       (Ed25519 signature FAILED + face mismatch, exit != 0) and server-side
       (valid_signature:false, face_ok:false).

  It does NOT start services and it does NOT fake success: if kd-api is not
  reachable it fails loudly with the exact commands to bring the stack up, and
  it exits non-zero if any assertion fails.

  The receipt is self-contained (proof.rng.drbg_key_hex + proof.draw_u64), so
  replay verification is fully deterministic regardless of how the server chose
  the idempotency key. The same guarantee is frozen, service-free, in
  `cargo test -p kd-cli --test goldens` (golden_receipt_valid_offline /
  golden_receipt_tampered_invalid).

.EXAMPLE
  pwsh -File scripts/tamper-demo.ps1

.EXAMPLE
  pwsh -File scripts/tamper-demo.ps1 -Server http://127.0.0.1:8080 -Die d20 -Kappa -0.5
#>
[CmdletBinding()]
param(
  [string]$Server = 'http://127.0.0.1:8080',
  [string]$Kd     = (Join-Path $PSScriptRoot '..\target\release\kd.exe'),
  [ValidateSet('d6', 'd20', 'd100')][string]$Die = 'd20',
  [double]$Kappa  = -0.5,
  [string]$Seed   = 'tamper-demo-001'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Assert([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "  PASS  $msg" -ForegroundColor Green; $script:pass++ }
  else { Write-Host "  FAIL  $msg" -ForegroundColor Red; $script:fail++ }
}

function Fail-Fast([string]$msg) {
  Write-Host ""
  Write-Host "ABORT: $msg" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Bring the stack up first (PowerShell, from repo root):" -ForegroundColor Yellow
  Write-Host '  docker compose -f infra/docker-compose.yml --env-file infra/.env up -d'
  Write-Host '  sqlx migrate run --source crates/kd-api/migrations   # DATABASE_URL set'
  Write-Host '  # then run kd-api with the TEST signing key (see scripts/README.md)'
  exit 2
}

# --- 0. Preconditions ---------------------------------------------------------
Write-Host "KarmaDice tamper demo  (server=$Server  die=$Die  kappa=$Kappa)" -ForegroundColor Cyan

if (-not (Test-Path $Kd)) {
  Fail-Fast "kd CLI not found at '$Kd'. Build it: cargo build --release -p kd-cli"
}

try {
  $health = Invoke-RestMethod -Uri "$Server/healthz" -TimeoutSec 5
} catch {
  Fail-Fast "kd-api not reachable at $Server/healthz ($($_.Exception.Message))."
}
Assert ($health.status -eq 'ok') "healthz status ok (db=$($health.db) redis=$($health.redis) s3=$($health.s3))"

# --- 1. Roll -> signed receipt ------------------------------------------------
# We verify the RAW response bytes the server actually signed. A signed body
# must never be round-tripped through a lossy serializer (PowerShell's
# ConvertTo-Json reformats timestamps/floats, which would change the
# JCS-canonical bytes and break the signature for reasons unrelated to tamper).
# The server's ReceiptV2 deserialization ignores unknown fields, so the
# envelope-only `deduplicated` field is harmless and left in place.
Write-Host "`n[1] Roll a signed receipt" -ForegroundColor Cyan
$rollBody = @{ die = $Die; kappa = $Kappa; seed = $Seed } | ConvertTo-Json -Compress
$rawRoll = (Invoke-WebRequest -Uri "$Server/v1/roll" -Method POST -ContentType 'application/json' -Body $rollBody -UseBasicParsing).Content
# Strip the envelope-only `deduplicated` field surgically (preserving every
# other byte). The server ignores it during ReceiptV2 deserialization, but the
# offline `kd verify --receipt` canonicalizes the JSON as-is (removing only
# sig/receipt_hash), so a stray `deduplicated` would change its canonical bytes
# and reject a genuine receipt. See KD-029 "CLI observation".
$rawClean = [regex]::Replace($rawRoll, ',?\s*"deduplicated"\s*:\s*(?:true|false)', '')
$roll = $rawClean | ConvertFrom-Json   # parsed copy for READING fields only
Assert ($null -ne $roll.v) "receipt bytes still parse as JSON after stripping deduplicated"
Assert ($rawClean -notmatch 'deduplicated') "deduplicated envelope field removed"
Assert ($roll.v -eq 'truerolls-1')          "receipt envelope v == truerolls-1"
Assert ($null -ne $roll.sig)                "receipt is signed (sig block present)"
Assert ($roll.sig.alg -eq 'Ed25519')        "sig.alg == Ed25519"
Assert (-not [string]::IsNullOrWhiteSpace($roll.sig.kid)) "sig.kid present ($($roll.sig.kid))"
$faces = @{ d6 = 6; d20 = 20; d100 = 100 }[$Die]
Assert ($roll.face -ge 1 -and $roll.face -le $faces) "face in range for $Die ($($roll.face))"

$cleanPath = Join-Path ([System.IO.Path]::GetTempPath()) 'kd_clean_receipt.json'
$tamperPath = Join-Path ([System.IO.Path]::GetTempPath()) 'kd_tampered_receipt.json'
Set-Content -Path $cleanPath -Value $rawClean -Encoding utf8 -NoNewline

# Published Ed25519 key for offline verification.
$keys = Invoke-RestMethod -Uri "$Server/.well-known/truerolls-keys.json"
$pk = ($keys.keys | Where-Object { $_.kid -eq $roll.sig.kid }).public_key
Assert (-not [string]::IsNullOrWhiteSpace($pk)) "published public key for kid $($roll.sig.kid)"

# --- 2. Clean receipt verifies VALID (offline + server) -----------------------
Write-Host "`n[2] Unmodified receipt verifies VALID" -ForegroundColor Cyan
$cleanOut = & $Kd verify --receipt $cleanPath --public-key $pk 2>&1
$cleanCode = $LASTEXITCODE
Assert ($cleanCode -eq 0)              "offline kd verify --receipt exits 0"
Assert ("$cleanOut" -match 'VALID' -and "$cleanOut" -notmatch 'INVALID') "offline output reports VALID (not INVALID)"

$cleanSrv = Invoke-RestMethod -Uri "$Server/v1/verify" -Method POST -ContentType 'application/json' -Body $rawClean
Assert ($cleanSrv.valid_signature -eq $true) "server valid_signature == true"
Assert ($cleanSrv.valid_sampling  -eq $true) "server valid_sampling  == true"
Assert ($cleanSrv.face_ok         -eq $true) "server face_ok         == true"
Assert ($cleanSrv.metrics_ok      -eq $true) "server metrics_ok      == true"

# --- 3. Tampered receipt is REJECTED (offline + server) -----------------------
# Surgical edit: change ONLY the face digits in the raw bytes, so the single
# reason verification fails is the tamper (signature no longer covers the body,
# and the recomputed face no longer matches).
Write-Host "`n[3] Tampered receipt (face flipped) is REJECTED" -ForegroundColor Cyan
$origFace = [int]$roll.face
$newFace = ($origFace % $faces) + 1
$rawTampered = [regex]::Replace($rawClean, '"face"\s*:\s*\d+', "`"face`":$newFace", 1)
if ($rawTampered -eq $rawClean) { Fail-Fast "tamper produced no change — face field not found in receipt bytes" }
Set-Content -Path $tamperPath -Value $rawTampered -Encoding utf8 -NoNewline
Write-Host "      (face $origFace -> $newFace; signature left intact)"

$tamperOut = & $Kd verify --receipt $tamperPath --public-key $pk 2>&1
$tamperCode = $LASTEXITCODE
Assert ($tamperCode -ne 0)                    "offline kd verify --receipt exits non-zero"
Assert ("$tamperOut" -match 'INVALID')        "offline output reports INVALID"
Assert ("$tamperOut" -match 'signature')      "offline names the failed Ed25519 signature"
Assert ("$tamperOut" -match 'face')           "offline names the face mismatch"

$tamperSrv = Invoke-RestMethod -Uri "$Server/v1/verify" -Method POST -ContentType 'application/json' -Body $rawTampered
Assert ($tamperSrv.valid_signature -eq $false) "server valid_signature == false"
Assert ($tamperSrv.face_ok         -eq $false) "server face_ok         == false"
Assert ($tamperSrv.valid_sampling  -eq $true)  "server valid_sampling  == true (draw untouched)"
Assert (($tamperSrv.errors -join ' ') -match 'signature') "server lists the signature error"

# --- Summary ------------------------------------------------------------------
Write-Host ""
$total = $script:pass + $script:fail
if ($script:fail -eq 0) {
  Write-Host "ALL $total CHECKS PASSED" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$($script:fail) of $total CHECKS FAILED" -ForegroundColor Red
  exit 1
}
