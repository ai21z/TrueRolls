#requires -Version 7
<#
.SYNOPSIS
  Live drand-backed end-to-end tamper demo for the TrueRolls trust spine.

.DESCRIPTION
  Against a running kd-api, this X-class script:

    1. Fetches the configured drand quicknet relays and records the freshest
       structurally valid pulse. The API then performs the pinned BLS check.
    2. Generates a cryptographic client nonce and requests target round observed + 2.
    3. Requires a signed truerolls-drand-1 receipt.
    4. Requires all five verifier checks to pass offline and server-side.
    5. Flips the signed face field and proves signature and face checks fail while
       the untouched drand, sampling, and metric checks still pass.

  Public-network failure is a failure, not a successful or deterministic result.

.EXAMPLE
  pwsh -File scripts/tamper-demo.ps1

.EXAMPLE
  pwsh -File scripts/tamper-demo.ps1 -Server http://127.0.0.1:8080 -Die d20 -Kappa 0
#>
[CmdletBinding()]
param(
  [string]$Server = 'http://127.0.0.1:8080',
  [string]$Kd = (Join-Path $PSScriptRoot '..\target\release\kd.exe'),
  [ValidateSet('d6', 'd20', 'd100')][string]$Die = 'd20',
  [ValidateRange(-1.0, 1.0)][double]$Kappa = 0.0,
  [string]$DrandRelay = 'https://api.drand.sh',
  [string[]]$DrandFallbackRelays = @('https://api2.drand.sh', 'https://api3.drand.sh')
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0
$script:startedUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$script:observedRound = 'not-fetched'
$script:selectedRelay = 'not-selected'
$script:relayAttempts = 0
$chainHash = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'

function Assert([bool]$Condition, [string]$Message) {
  if ($Condition) {
    Write-Host "  PASS  $Message" -ForegroundColor Green
    $script:pass++
  } else {
    Write-Host "  FAIL  $Message" -ForegroundColor Red
    $script:fail++
  }
}

function Exit-WithEvidence([int]$Code) {
  Write-Host ''
  Write-Host 'External observation:' -ForegroundColor Cyan
  Write-Host "  utc=$($script:startedUtc)"
  Write-Host "  relay=$($script:selectedRelay)"
  Write-Host "  chain_hash=$chainHash"
  Write-Host "  observed_round=$($script:observedRound)"
  Write-Host "  relay_attempts=$($script:relayAttempts)"
  Write-Host "  exit_code=$Code"
  exit $Code
}

function Fail-Fast([string]$Message) {
  Write-Host ''
  Write-Host "ABORT: $Message" -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Bring the stack up first, from the repository root:' -ForegroundColor Yellow
  Write-Host '  pwsh -File scripts/dev-up.ps1'
  Exit-WithEvidence 2
}

Write-Host "TrueRolls live tamper demo (server=$Server die=$Die kappa=$Kappa)" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $Kd)) {
  Fail-Fast "kd CLI not found at '$Kd'. Build it: cargo build --locked --release -p kd-cli"
}

try {
  $health = Invoke-RestMethod -Uri "$Server/healthz" -TimeoutSec 5
} catch {
  Fail-Fast "kd-api not reachable at $Server/healthz ($($_.Exception.Message))."
}
Assert ($health.status -eq 'ok') "healthz status ok (db=$($health.db) redis=$($health.redis) s3=$($health.s3))"

Write-Host "`n[1] Observe public drand quicknet" -ForegroundColor Cyan
$relayCandidates = @($DrandRelay) + @($DrandFallbackRelays) | Select-Object -Unique
$script:relayAttempts = $relayCandidates.Count
$observations = @()
foreach ($relay in $relayCandidates) {
  $pulseUrl = "$($relay.TrimEnd('/'))/$chainHash/public/latest"
  try {
    $candidate = Invoke-RestMethod -Uri $pulseUrl -TimeoutSec 10
    $round = [uint64]$candidate.round
    if ($round -eq 0 -or
        [string]::IsNullOrWhiteSpace([string]$candidate.signature) -or
        [string]::IsNullOrWhiteSpace([string]$candidate.randomness)) {
      throw 'malformed pulse'
    }
    $observations += [pscustomobject]@{
      Relay = $relay
      Round = $round
      Pulse = $candidate
    }
  } catch {
    Write-Host "  WARN  relay failed: $relay ($($_.Exception.Message))" -ForegroundColor Yellow
  }
}
if ($observations.Count -eq 0) {
  Fail-Fast 'all configured drand relays failed or returned malformed pulses.'
}
$selected = $observations | Sort-Object -Property Round -Descending | Select-Object -First 1
$pulse = $selected.Pulse
$script:selectedRelay = $selected.Relay

$script:observedRound = [uint64]$pulse.round
$targetRound = [uint64]$pulse.round + 2
Assert ($script:observedRound -gt 0) "observed round is positive ($($script:observedRound))"
Assert (-not [string]::IsNullOrWhiteSpace([string]$pulse.signature)) 'observed signature present'
Assert (-not [string]::IsNullOrWhiteSpace([string]$pulse.randomness)) 'observed randomness present'

$nonceBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$clientNonce = [Convert]::ToHexString($nonceBytes).ToLowerInvariant()
$idemKey = [Guid]::NewGuid().ToString()
$rollBody = @{
  die = $Die
  kappa = $Kappa
  client_nonce = $clientNonce
  drand = @{
    client_observed_round = [uint64]$pulse.round
    client_observed_signature_hex = [string]$pulse.signature
    client_observed_randomness_hex = [string]$pulse.randomness
    target_round = $targetRound
  }
} | ConvertTo-Json -Depth 8 -Compress

Write-Host "`n[2] Mint a signed drand receipt, waiting for target $targetRound" -ForegroundColor Cyan
try {
  $rawRoll = (Invoke-WebRequest `
    -Uri "$Server/v1/roll" `
    -Method POST `
    -Headers @{ 'Idempotency-Key' = $idemKey } `
    -ContentType 'application/json' `
    -Body $rollBody `
    -TimeoutSec 45 `
    -UseBasicParsing).Content
} catch {
  $responseDetail = [string]$_.ErrorDetails.Message
  $detailSuffix = if ([string]::IsNullOrWhiteSpace($responseDetail)) { '' } else { " body=$responseDetail" }
  Fail-Fast "drand-backed roll failed ($($_.Exception.Message)).$detailSuffix"
}

# Remove the response-envelope field without reserializing signed receipt bytes.
$rawClean = [regex]::Replace($rawRoll, ',?\s*"deduplicated"\s*:\s*(?:true|false)', '')
$roll = $rawClean | ConvertFrom-Json
Assert ($roll.v -eq 'truerolls-drand-1') 'receipt version is truerolls-drand-1'
Assert ($null -ne $roll.sig) 'receipt signature block present'
Assert ($roll.sig.alg -eq 'Ed25519') 'signature algorithm is Ed25519'
Assert (-not [string]::IsNullOrWhiteSpace([string]$roll.sig.kid)) "signing kid present ($($roll.sig.kid))"
Assert ($roll.proof.drand.chain_hash -eq $chainHash) 'receipt carries the pinned quicknet chain hash'
Assert ([uint64]$roll.proof.drand.client_observed_round -eq $script:observedRound) 'receipt binds the observed round'
Assert ([uint64]$roll.proof.drand.target_round -eq $targetRound) 'receipt binds target round = observed + 2'
Assert ($roll.proof.drand.client_nonce -eq $clientNonce) 'receipt binds the client-generated nonce'

$faces = @{ d6 = 6; d20 = 20; d100 = 100 }[$Die]
Assert ($roll.face -ge 1 -and $roll.face -le $faces) "face is in range for $Die ($($roll.face))"

$suffix = [Guid]::NewGuid().ToString('N')
$cleanPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-clean-$suffix.json"
$tamperPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-tampered-$suffix.json"
$cleanCliOutPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-clean-cli-$suffix.json"
$cleanCliErrPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-clean-cli-$suffix.err"
$tamperCliOutPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-tampered-cli-$suffix.json"
$tamperCliErrPath = Join-Path ([IO.Path]::GetTempPath()) "truerolls-tampered-cli-$suffix.err"
Set-Content -LiteralPath $cleanPath -Value $rawClean -Encoding utf8 -NoNewline

Write-Host "`n[3] Unmodified receipt verifies VALID" -ForegroundColor Cyan
& $Kd verify --receipt $cleanPath --server $Server --json 1> $cleanCliOutPath 2> $cleanCliErrPath
$cleanCode = $LASTEXITCODE
$cleanCli = Get-Content -Raw -LiteralPath $cleanCliOutPath | ConvertFrom-Json
Assert ($cleanCode -eq 0) 'offline status-aware verification exits 0'
Assert ($cleanCli.verdict -eq 'VALID') 'offline output reports VALID'
Assert ($cleanCli.valid_signature -eq $true) 'offline valid_signature is true'
Assert ($cleanCli.valid_drand -eq $true) 'offline valid_drand is true'
Assert ($cleanCli.valid_sampling -eq $true) 'offline valid_sampling is true'
Assert ($cleanCli.face_ok -eq $true) 'offline face_ok is true'
Assert ($cleanCli.metrics_ok -eq $true) 'offline metrics_ok is true'

$cleanSrv = Invoke-RestMethod -Uri "$Server/v1/verify" -Method POST -ContentType 'application/json' -Body $rawClean
Assert ($cleanSrv.valid_signature -eq $true) 'server valid_signature is true'
Assert ($cleanSrv.valid_drand -eq $true) 'server valid_drand is true'
Assert ($cleanSrv.valid_sampling -eq $true) 'server valid_sampling is true'
Assert ($cleanSrv.face_ok -eq $true) 'server face_ok is true'
Assert ($cleanSrv.metrics_ok -eq $true) 'server metrics_ok is true'

Write-Host "`n[4] Flip the signed face and prove rejection" -ForegroundColor Cyan
$originalFace = [int]$roll.face
$newFace = ($originalFace % $faces) + 1
$rawTampered = [regex]::Replace($rawClean, '"face"\s*:\s*\d+', "`"face`":$newFace", 1)
if ($rawTampered -eq $rawClean) {
  Fail-Fast 'tamper produced no change; numeric face field not found'
}
Set-Content -LiteralPath $tamperPath -Value $rawTampered -Encoding utf8 -NoNewline
Write-Host "      face $originalFace -> $newFace; signature left unchanged"

& $Kd verify --receipt $tamperPath --server $Server --json 1> $tamperCliOutPath 2> $tamperCliErrPath
$tamperCode = $LASTEXITCODE
$tamperCli = Get-Content -Raw -LiteralPath $tamperCliOutPath | ConvertFrom-Json
Assert ($tamperCode -ne 0) 'offline verification exits non-zero'
Assert ($tamperCli.verdict -eq 'INVALID') 'offline output reports INVALID'
Assert ($tamperCli.valid_signature -eq $false) 'offline valid_signature is false'
Assert ($tamperCli.valid_drand -eq $true) 'offline valid_drand remains true'
Assert ($tamperCli.valid_sampling -eq $true) 'offline valid_sampling remains true'
Assert ($tamperCli.face_ok -eq $false) 'offline face_ok is false'
Assert ($tamperCli.metrics_ok -eq $true) 'offline metrics_ok remains true'

$tamperSrv = Invoke-RestMethod -Uri "$Server/v1/verify" -Method POST -ContentType 'application/json' -Body $rawTampered
Assert ($tamperSrv.valid_signature -eq $false) 'server valid_signature is false'
Assert ($tamperSrv.valid_drand -eq $true) 'server valid_drand remains true'
Assert ($tamperSrv.valid_sampling -eq $true) 'server valid_sampling remains true'
Assert ($tamperSrv.face_ok -eq $false) 'server face_ok is false'
Assert ($tamperSrv.metrics_ok -eq $true) 'server metrics_ok remains true'

Remove-Item -LiteralPath @(
  $cleanPath,
  $tamperPath,
  $cleanCliOutPath,
  $cleanCliErrPath,
  $tamperCliOutPath,
  $tamperCliErrPath
) -Force -ErrorAction SilentlyContinue

Write-Host ''
$total = $script:pass + $script:fail
if ($script:fail -eq 0) {
  Write-Host "ALL $total CHECKS PASSED" -ForegroundColor Green
  Exit-WithEvidence 0
}

Write-Host "$($script:fail) of $total CHECKS FAILED" -ForegroundColor Red
Exit-WithEvidence 1
