#requires -Version 7
<#
.SYNOPSIS
  Back up a beta stack and rehearse restoration into an isolated, Tunnel-free project.
.DESCRIPTION
  The source must already exist. This script never deletes source containers, volumes or objects.
  -ConfirmSourcePause is required to pause a running source API. Its prior running state is restored
  even if backup fails. Backup files contain secrets and stay in a new owner-only directory outside
  the repository. They are not an offline backup until the owner moves a protected copy offline.

  Restoration uses the running source containers' immutable image IDs, new volumes and networks,
  no published ports and no cloudflared service. Only label-checked restore resources are deleted.
.EXAMPLE
  pwsh -File scripts/beta-backup-restore.ps1 -ConfirmSourcePause `
    -BackupDirectory D:\private-backups\truerolls-2026-11-01
#>
[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $env:LOCALAPPDATA 'TrueRolls/beta/beta.env'),
  [Parameter(Mandatory)][string]$BackupDirectory,
  [string]$SourceProject = 'truerolls-beta',
  [string]$RestoreProject = ('truerolls-beta-restore-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)),
  [string]$KeySetFile,
  [switch]$ConfirmSourcePause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib/beta-ops.psm1') -Force -DisableNameChecking
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repo 'infra/docker-compose.beta.yml'
if ($SourceProject -cnotmatch '\Atruerolls-beta(?:-[a-z0-9-]+)?\z') { throw 'Unexpected source project name.' }
Assert-BetaRestoreProject $RestoreProject $SourceProject
$backup = Assert-BetaBackupPath $BackupDirectory $repo
Assert-BetaPrivateFile $EnvFile
$envSha256 = (Get-FileHash -LiteralPath $EnvFile -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceArgs = @('compose', '-p', $SourceProject, '-f', $composeFile, '--env-file', $EnvFile)
$restoreFile = Join-Path $backup 'restore.compose.json'
$restoreArgs = @('compose', '-p', $RestoreProject, '-f', $restoreFile)
$work = '/tmp/truerolls-beta-backup-' + [Guid]::NewGuid().ToString('N')
$paused = $false
$restoreStarted = $false
$result = $null
$temporarySourcePaths = @{}
$source = @{}
$oldProfiles = [Environment]::GetEnvironmentVariable('COMPOSE_PROFILES', 'Process')

function Docker-Text {
  [CmdletBinding()]
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)
  # Config and subprocess output can contain credentials. Do not echo either on failure.
  $output = & docker @Command 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Docker operation failed (exit $LASTEXITCODE); no subprocess output printed." }
  ($output -join "`n")
}

function Get-SourceContainer([string]$Service) {
  $ids = @((Docker-Text ($sourceArgs + @('ps', '--all', '-q', $Service))) -split '\r?\n' | Where-Object { $_ })
  if ($ids.Count -ne 1 -or $ids[0] -notmatch '^[a-f0-9]{12,64}$') { throw "Expected one source container for $Service." }
  $id = $ids[0]
  $labels = Docker-Text @('inspect', '--format', '{{json .Config.Labels}}', $id) | ConvertFrom-Json -AsHashtable
  if ($labels['com.docker.compose.project'] -ne $SourceProject -or $labels['com.docker.compose.service'] -ne $Service) {
    throw 'Source container label mismatch.'
  }
  @{
    Id = $id
    Running = (Docker-Text @('inspect', '--format', '{{.State.Running}}', $id)).Trim() -eq 'true'
    Image = (Docker-Text @('inspect', '--format', '{{.Image}}', $id)).Trim()
  }
}

function Get-Health([string]$Container) {
  $health = Docker-Text @('exec', $Container, 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:8080/healthz') |
    ConvertFrom-Json
  if ($health.status -ne 'ok' -or -not $health.db -or -not $health.redis -or -not $health.s3) {
    throw 'API readiness is degraded.'
  }
  $health
}

function Wait-Ready([string]$Container) {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    try { return Get-Health $Container } catch { Start-Sleep -Seconds 2 }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'API did not become ready within 90 seconds.'
}

function Resume-Source {
  if ($script:paused) {
    Docker-Text ($sourceArgs + @('start', 'api')) | Out-Null
    Wait-Ready $source.api.Id | Out-Null
    $script:paused = $false
  }
}

function Get-DatabaseFingerprint([string]$Container) {
  $tables = (Docker-Text @('exec', $Container, 'psql', '-U', 'kd_app', '-d', 'kd', '-At', '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")) -split '\r?\n' |
    Where-Object { $_ }
  $fingerprint = [ordered]@{}
  foreach ($table in $tables) {
    if ($table -notmatch '^[a-z_][a-z0-9_]*$') { throw 'Unexpected table identifier.' }
    $sql = 'COPY (SELECT row_to_json(t)::text AS row FROM public."' + $table + '" t ORDER BY 1) TO STDOUT'
    $data = Docker-Text @('exec', $Container, 'psql', '-U', 'kd_app', '-d', 'kd', '-At', '-v', 'ON_ERROR_STOP=1', '-c', $sql)
    $fingerprint[$table] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
      [Text.Encoding]::UTF8.GetBytes($data))).ToLowerInvariant()
  }
  $sequences = Docker-Text @('exec', $Container, 'psql', '-U', 'kd_app', '-d', 'kd', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")
  $fingerprint['_sequence_state'] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($sequences))).ToLowerInvariant()
  $fingerprint
}

function Get-ObjectFingerprint([string]$Directory) {
  $entries = [ordered]@{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File -Recurse | Sort-Object FullName)) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected symlink in object backup.' }
    $relative = [IO.Path]::GetRelativePath($Directory, $file.FullName).Replace([IO.Path]::DirectorySeparatorChar, [char]'/')
    $entries[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $entries
}

function Mirror-Objects([string]$Container, [string]$Directory) {
  Docker-Text @('exec', $Container, 'sh', '-eu', '-c',
    'umask 077; mkdir -p "$1"; mc alias set backup http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror backup/kd-transcripts "$1" >/dev/null', 'sh', $work) | Out-Null
  New-Item -ItemType Directory -Path $Directory | Out-Null
  Docker-Text @('cp', "${Container}:$work/.", $Directory) | Out-Null
}

function Get-RestoreResources {
  $resources = @()
  foreach ($kind in @('container', 'volume', 'network')) {
    $command = switch ($kind) {
      container { @('ps', '-a', '--filter', "label=com.docker.compose.project=$RestoreProject", '--format', '{{.ID}}') }
      volume { @('volume', 'ls', '--filter', "label=com.docker.compose.project=$RestoreProject", '--format', '{{.Name}}') }
      network { @('network', 'ls', '--filter', "label=com.docker.compose.project=$RestoreProject", '--format', '{{.ID}}') }
    }
    foreach ($id in @((Docker-Text $command) -split '\r?\n' | Where-Object { $_ })) {
      $inspect = switch ($kind) { container { @('inspect', $id) } default { @($kind, 'inspect', $id) } }
      # Never print the full inspection: container environments contain secrets.
      $entry = @(Docker-Text $inspect | ConvertFrom-Json)[0]
      $labels = if ($kind -eq 'container') { $entry.Config.Labels } else { $entry.Labels }
      $name = $entry.Name.TrimStart('/')
      Assert-BetaOwnedResource $name $labels.'com.docker.compose.project' $RestoreProject
      $resources += @{Kind=$kind; Name=$name}
    }
  }
  $resources
}

function Remove-Restore {
  $resources = @(Get-RestoreResources)
  if ($resources.Count -gt 0) {
    Docker-Text ($restoreArgs + @('down', '--volumes')) | Out-Null
    if (@(Get-RestoreResources).Count -ne 0) { throw 'Restore cleanup left owned resources behind.' }
  }
}

try {
  # Inherited profiles must never activate a connector in the restore project.
  $env:COMPOSE_PROFILES = ''
  Docker-Text @('info', '--format', '{{.ServerVersion}}') | Out-Null
  if (@(Get-RestoreResources).Count -ne 0) { throw 'Restore project already has resources; refusing to reuse it.' }
  foreach ($service in @('api', 'postgres', 'redis', 'minio')) { $source[$service] = Get-SourceContainer $service }
  foreach ($service in @('postgres', 'redis', 'minio')) {
    if (-not $source[$service].Running) { throw "Source $service is not running." }
  }
  if ($source.api.Running -and -not $ConfirmSourcePause) { throw 'A running source API requires -ConfirmSourcePause.' }
  if (-not $source.api.Running -and -not $KeySetFile) { throw 'A stopped source API requires -KeySetFile.' }
  $model = Docker-Text ($sourceArgs + @('config', '--format', 'json')) | ConvertFrom-Json -AsHashtable
  if ($source.api.Running) { Get-Health $source.api.Id | Out-Null }
  $keys = if ($KeySetFile) { [IO.File]::ReadAllText((Resolve-Path -LiteralPath $KeySetFile).Path) } else {
    Docker-Text @('exec', $source.api.Id, 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:8080/.well-known/truerolls-keys.json')
  }
  if (@(($keys | ConvertFrom-Json).keys).Count -eq 0) { throw 'Source key set is empty.' }

  New-BetaPrivateDirectory $backup
  Copy-Item -LiteralPath $EnvFile -Destination (Join-Path $backup 'issuer.env')
  if (-not $IsWindows) {
    & chmod 600 (Join-Path $backup 'issuer.env')
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict backed-up env permissions.' }
  }
  Assert-BetaPrivateFile (Join-Path $backup 'issuer.env')
  if ((Get-FileHash -LiteralPath $EnvFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $envSha256 -or
      (Get-FileHash -LiteralPath (Join-Path $backup 'issuer.env') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $envSha256) {
    throw 'Env file changed during backup or the protected copy does not match.'
  }
  $savedModel = Docker-Text @('compose', '-p', $SourceProject, '-f', $composeFile, '--env-file',
    (Join-Path $backup 'issuer.env'), 'config', '--format', 'json') | ConvertFrom-Json -AsHashtable
  $restoreModel = ConvertTo-BetaRestoreModel $savedModel $RestoreProject $SourceProject
  foreach ($service in @('api', 'postgres', 'redis', 'minio')) {
    $restoreModel.services[$service].image = $source[$service].Image
    $restoreModel.services[$service].pull_policy = 'never'
  }
  $restoreModel.services['minio-init'].image = $source.minio.Image
  [IO.File]::WriteAllText((Join-Path $backup 'issuer-keys.json'), $keys, [Text.UTF8Encoding]::new($false))
  # Values are already resolved; escape dollars so Compose cannot interpolate them a second time.
  [IO.File]::WriteAllText($restoreFile, ($restoreModel | ConvertTo-Json -Depth 100).Replace('$', '$$'), [Text.UTF8Encoding]::new($false))
  if (-not $IsWindows) {
    & chmod 600 $restoreFile
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict restore model permissions.' }
  }
  Assert-BetaPrivateFile $restoreFile
  $resolved = Docker-Text ($restoreArgs + @('config', '--format', 'json')) | ConvertFrom-Json -AsHashtable
  if ($resolved.services.Contains('cloudflared')) { throw 'Tunnel service present in restore model.' }
  foreach ($service in $resolved.services.Values) {
    if ($service.Contains('ports') -and $service.ports.Count -gt 0) { throw 'Restore publishes a host port.' }
  }
  foreach ($kind in @('volumes', 'networks')) {
    $sourceNames = @($model[$kind].Values | ForEach-Object { $_.name })
    foreach ($entry in $resolved[$kind].Values) {
      if ($entry.name -in $sourceNames -or -not $entry.name.StartsWith($RestoreProject + '_', [StringComparison]::Ordinal)) {
        throw 'Restore resource overlaps the source or escapes its namespace.'
      }
    }
  }

  try {
    if ($source.api.Running) {
      # Arm before stopping, so a partially successful stop is still repaired in finally.
      $paused = $true
      Docker-Text ($sourceArgs + @('stop', '--timeout', '40', 'api')) | Out-Null
    }
    $databaseBefore = Get-DatabaseFingerprint $source.postgres.Id
    $temporarySourcePaths.postgres = "$work.sql"
    Docker-Text @('exec', $source.postgres.Id, 'sh', '-eu', '-c',
      'umask 077; pg_dump -U kd_app -d kd --clean --if-exists --no-owner --no-privileges > "$1"', 'sh', "$work.sql") | Out-Null
    Docker-Text @('cp', "$($source.postgres.Id):$work.sql", (Join-Path $backup 'postgres.sql')) | Out-Null
    Assert-BetaPrivateFile (Join-Path $backup 'postgres.sql')
    $temporarySourcePaths.minio = $work
    Mirror-Objects $source.minio.Id (Join-Path $backup 'transcripts')
    $objectsBefore = Get-ObjectFingerprint (Join-Path $backup 'transcripts')
  } finally {
    Resume-Source
  }

  $restoreStarted = $true
  Docker-Text ($restoreArgs + @('up', '-d', '--wait', '--no-build', 'postgres', 'redis', 'minio')) | Out-Null
  Docker-Text ($restoreArgs + @('run', '--rm', '--no-deps', 'minio-init')) | Out-Null
  $pg = (Docker-Text ($restoreArgs + @('ps', '-q', 'postgres'))).Trim()
  $minio = (Docker-Text ($restoreArgs + @('ps', '-q', 'minio'))).Trim()
  Docker-Text @('cp', (Join-Path $backup 'postgres.sql'), "${pg}:/tmp/restore.sql") | Out-Null
  Docker-Text @('exec', $pg, 'psql', '-U', 'kd_app', '-d', 'kd', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/restore.sql') | Out-Null
  Docker-Text @('cp', ((Join-Path $backup 'transcripts') + '/.'), "${minio}:/tmp/restore-objects") | Out-Null
  Docker-Text @('exec', $minio, 'sh', '-eu', '-c',
    'mc alias set backup http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror /tmp/restore-objects backup/kd-transcripts >/dev/null') | Out-Null
  Docker-Text ($restoreArgs + @('up', '-d', '--wait', '--no-build', 'api')) | Out-Null
  $api = (Docker-Text ($restoreArgs + @('ps', '-q', 'api'))).Trim()
  $healthAfter = Wait-Ready $api
  $databaseAfter = Get-DatabaseFingerprint $pg
  if (($databaseBefore | ConvertTo-Json -Compress) -cne ($databaseAfter | ConvertTo-Json -Compress)) {
    throw 'Restored database rows or sequence state do not match the backup point.'
  }
  Mirror-Objects $minio (Join-Path $backup 'restored-transcripts')
  $objectsAfter = Get-ObjectFingerprint (Join-Path $backup 'restored-transcripts')
  if (($objectsBefore | ConvertTo-Json -Compress) -cne ($objectsAfter | ConvertTo-Json -Compress)) {
    throw 'Restored object names or SHA-256 hashes do not match the backup.'
  }
  $restoredKeys = Docker-Text @('exec', $api, 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:8080/.well-known/truerolls-keys.json')
  if (($keys | ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress) -cne
      ($restoredKeys | ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress)) { throw 'Restored issuer key set changed.' }
  $result = [ordered]@{
    schema = 'truerolls.beta-backup-restore.v1'
    completed_at_utc = [DateTime]::UtcNow.ToString('o')
    source_project = $SourceProject
    restore_project = $RestoreProject
    source_image_id = $source.api.Image
    source_api_was_running = $source.api.Running
    issuer_env_sha256 = $envSha256
    postgres_dump_sha256 = (Get-FileHash -LiteralPath (Join-Path $backup 'postgres.sql') -Algorithm SHA256).Hash.ToLowerInvariant()
    database = $databaseBefore
    objects = $objectsBefore
    restored_health = $healthAfter
    verdict = 'PASS'
  }
} finally {
  try {
    if ($restoreStarted) { Remove-Restore }
  } finally {
    try {
      Resume-Source
      if (Get-Variable source -ErrorAction SilentlyContinue) {
        foreach ($service in @('postgres', 'minio')) {
          if ($temporarySourcePaths.ContainsKey($service)) {
            $path = $temporarySourcePaths[$service]
            $remove = if ($service -eq 'postgres') { 'rm -f -- "$1"' } else { 'rm -rf -- "$1"' }
            Docker-Text @('exec', $source[$service].Id, 'sh', '-c', $remove, 'sh', $path) | Out-Null
          }
        }
      }
    } finally {
      [Environment]::SetEnvironmentVariable('COMPOSE_PROFILES', $oldProfiles, 'Process')
    }
  }
}

if ($null -eq $result) { throw 'Rehearsal did not finish.' }
[IO.File]::WriteAllText((Join-Path $backup 'result.json'), ($result | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Host "BETA BACKUP/RESTORE PASS: $BackupDirectory"
Write-Host 'The source volumes were not deleted. The backup contains secrets; keep it protected and make an offline copy.'
