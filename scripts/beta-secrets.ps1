#requires -Version 7
<#
.SYNOPSIS
  Creates the home-PC beta env file with fresh secrets. Never overwrites one.

.DESCRIPTION
  Generates everything infra/docker-compose.beta.yml needs (the Ed25519 receipt signing seed and
  the Postgres, Redis and MinIO credentials) and writes it to a file outside the repository that
  only the current user can read. Prints no secret.

  TUNNEL_TOKEN and COMPOSE_PROFILES stay empty: paste the tunnel token from Cloudflare Zero Trust
  yourself, then set COMPOSE_PROFILES=tunnel. The public key is published later from the running
  API by scripts/beta-keyset.ps1, so this script never derives or prints it.

  An existing file is never replaced: its seed may already sign published receipts. Change keys
  with docs/how-to/key-rotation.md instead.

.EXAMPLE
  pwsh -File scripts/beta-secrets.ps1
.EXAMPLE
  pwsh -File scripts/beta-secrets.ps1 -Path D:\truerolls\beta.env -Kid trb-2026-11
#>
[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA 'TrueRolls\beta\beta.env'),
  [string]$Kid = ('trb-' + (Get-Date -AsUTC -Format 'yyyy-MM')),
  [string]$ApiImage
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Target = [IO.Path]::GetFullPath($Path)

if ($Target.StartsWith($RepoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write secrets inside the repository: $Target"
}
if (Test-Path -LiteralPath $Target) {
  throw "Refusing to overwrite $Target. Its seed may already sign receipts; rotate with docs/how-to/key-rotation.md."
}
if ($Kid -notmatch '^[a-z0-9][a-z0-9-]{2,63}$') {
  throw "Kid '$Kid' must be 3-64 lowercase letters, digits or hyphens"
}
if ($Kid -match '^test-') {
  throw "Kid '$Kid' looks like a published test kid; production refuses those"
}
if (-not $ApiImage) {
  $commit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed; pass -ApiImage explicitly' }
  $ApiImage = "truerolls-kd-api:beta-$commit"
}

function New-Hex([int]$Bytes) {
  [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).ToLowerInvariant()
}

# Create the file empty and lock it to the current user before any secret is written into it.
New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
$stream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$stream.Dispose()
if ($IsWindows) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'Allow'))
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Target), $acl)
} else {
  & chmod 600 $Target
  if ($LASTEXITCODE -ne 0) { throw "chmod 600 $Target failed" }
}

$created = Get-Date -AsUTC -Format 'yyyy-MM-ddTHH:mm:ssZ'
$lines = @(
  "# TrueRolls home-PC beta secrets, created $created by scripts/beta-secrets.ps1."
  '# Never commit, paste, or share this file. Back it up offline: losing the seed forces a key rotation.'
  "KD_API_IMAGE=$ApiImage"
  "KD_SIGNING_ED25519_SECRET=$(New-Hex 32)"
  "KD_SIGNING_KID=$Kid"
  "POSTGRES_ADMIN_PASSWORD=$(New-Hex 32)"
  "KD_DB_APP_PASSWORD=$(New-Hex 32)"
  "REDIS_PASSWORD=$(New-Hex 32)"
  "MINIO_ROOT_USER=trb-$(New-Hex 6)"
  "MINIO_ROOT_PASSWORD=$(New-Hex 20)"
  'KD_S3_ACCESS_KEY=kd-api'
  "KD_S3_SECRET_KEY=$(New-Hex 20)"
  'KD_ROLL_GLOBAL_CAP=1000'
  '# Paste the tunnel token, then set COMPOSE_PROFILES=tunnel to start cloudflared.'
  'TUNNEL_TOKEN='
  'COMPOSE_PROFILES='
)
[IO.File]::WriteAllText($Target, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))

Write-Host "Wrote $Target (readable only by $([Environment]::UserName))"
Write-Host "  kid:   $Kid"
Write-Host "  image: $ApiImage"
Write-Host 'Next: build that image, then bring the stack up as docs/how-to/home-pc-beta.md describes.'
