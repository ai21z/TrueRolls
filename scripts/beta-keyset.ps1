#requires -Version 7
<#
.SYNOPSIS
  Publishes the running beta API's key set into the site build, or checks a published copy.

.DESCRIPTION
  Reads /.well-known/truerolls-keys.json from the kd-api container over the Compose network (the
  stack publishes no host port) and checks it: exactly one active key, and no published test kid.

  Default mode writes the exact bytes to services/loom-demo/dist/.well-known/truerolls-keys.json,
  so the site serves the key set as a static asset and receipts stay verifiable while the PC is off.
  Run it after `pnpm build:beta`, which empties dist/.

  -Check compares the API's key set with -Against (a file, or an https URL) and exits 1 on any
  difference in kid, algorithm, public key or status.

.EXAMPLE
  pwsh -File scripts/beta-keyset.ps1
.EXAMPLE
  pwsh -File scripts/beta-keyset.ps1 -Check -Against .\truerolls-keys.downloaded.json
#>
[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $env:LOCALAPPDATA 'TrueRolls\beta\beta.env'),
  [string]$OutFile,
  [switch]$Check,
  [string]$Against
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ComposeFile = Join-Path $RepoRoot 'infra\docker-compose.beta.yml'
$Dist = Join-Path $RepoRoot 'services\loom-demo\dist'
if (-not $OutFile) { $OutFile = Join-Path $Dist '.well-known\truerolls-keys.json' }

if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Beta env file not found: $EnvFile" }

function Read-ApiKeySet {
  $out = & docker compose -f $ComposeFile --env-file $EnvFile exec -T api `
    curl -fsS --max-time 5 http://127.0.0.1:8080/.well-known/truerolls-keys.json
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the key set from the api container. Is the beta stack up?' }
  ($out -join "`n").Trim()
}

# Canonical, comparable form of a key set: one line per key, sorted by kid.
function Get-KeyLines([string]$Json, [string]$Label) {
  try { $set = $Json | ConvertFrom-Json -Depth 5 } catch { throw "$Label is not JSON" }
  if ($null -eq $set.keys -or $set.keys -isnot [array] -or $set.keys.Count -eq 0) {
    throw "$Label has no keys array"
  }
  $set.keys | ForEach-Object { "$($_.kid)|$($_.alg)|$($_.public_key)|$($_.status)" } | Sort-Object
}

function Assert-BetaKeySet([string]$Json) {
  $keys = ($Json | ConvertFrom-Json -Depth 5).keys
  $active = @($keys | Where-Object { $_.status -eq 'active' })
  if ($active.Count -ne 1) { throw "Expected exactly one active key, found $($active.Count)" }
  $testKids = @($keys | Where-Object { $_.kid -match '^test-' })
  if ($testKids.Count -ne 0) { throw "Key set contains a test kid: $($testKids.kid -join ', ')" }
  if ($active[0].alg -ne 'Ed25519') { throw "Active key algorithm is '$($active[0].alg)', expected Ed25519" }
  $active[0]
}

$apiJson = Read-ApiKeySet
$apiLines = Get-KeyLines $apiJson 'API key set'
$activeKey = Assert-BetaKeySet $apiJson

if ($Check) {
  if (-not $Against) { throw '-Check needs -Against <file or https URL>' }
  if ($Against -match '^https://') {
    $resp = Invoke-WebRequest -Uri $Against -MaximumRedirection 0 -SkipHttpErrorCheck
    if ($resp.StatusCode -ne 200) {
      throw "GET $Against returned $($resp.StatusCode). Behind Cloudflare Access, save the file from a signed-in browser and pass its path."
    }
    $otherJson = [string]$resp.Content
  } else {
    $otherJson = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Against).Path)
  }
  $otherLines = Get-KeyLines $otherJson $Against
  $diff = Compare-Object $apiLines $otherLines
  if ($diff) {
    Write-Host 'MISMATCH between the API key set and the published copy:' -ForegroundColor Red
    $diff | ForEach-Object {
      $side = if ($_.SideIndicator -eq '<=') { 'api only      ' } else { 'published only' }
      Write-Host "  $side $($_.InputObject)"
    }
    exit 1
  }
  Write-Host "MATCH: $($apiLines.Count) key(s); active kid $($activeKey.kid)"
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $Dist 'index.html'))) {
  throw "No site build in $Dist. Run 'corepack pnpm -C services/loom-demo build:beta' first."
}
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($apiJson)
[IO.File]::WriteAllBytes($OutFile, $bytes)
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()

Write-Host "Wrote $OutFile"
Write-Host "  active kid: $($activeKey.kid)"
Write-Host "  public key: $($activeKey.public_key)"
Write-Host "  sha256:     $hash"
