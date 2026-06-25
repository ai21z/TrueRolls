#requires -Version 7
<#
.SYNOPSIS
  Tear down the local stack started by dev-up.ps1.

.EXAMPLE
  pwsh -File scripts/dev-down.ps1            # stop kd-api + dev servers + infra (keep DB volume)
.EXAMPLE
  pwsh -File scripts/dev-down.ps1 -Volumes   # also wipe Postgres/MinIO volumes
#>
[CmdletBinding()]
param([switch]$Volumes)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host "Stopping kd-api..." -ForegroundColor Cyan
Get-Process kd-api | Stop-Process -Force

Write-Host "Stopping Vite dev server (5173 loom)..." -ForegroundColor Cyan
foreach ($p in 5173, 5174) {
  Get-NetTCPConnection -LocalPort $p -State Listen |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
}

Write-Host "Stopping infra containers..." -ForegroundColor Cyan
$compose = @('compose', '-f', 'infra/docker-compose.yml', '--env-file', 'infra/.env')
if ($Volumes) { docker @compose down -v } else { docker @compose down }

Write-Host "Stack is DOWN." -ForegroundColor Green
