#requires -Version 7
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Project = 'truerolls-candidate'
$ComposeFile = Join-Path $PSScriptRoot '..\infra\docker-compose.candidate.yml'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutputRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'outputs')) + [IO.Path]::DirectorySeparatorChar
$RehearsalRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'outputs\backup-restore-rehearsal'))
$DumpFile = Join-Path $RehearsalRoot 'postgres.sql'
$TranscriptBackup = Join-Path $RehearsalRoot 'transcripts'
$SentinelId = '00000000-0000-0000-0000-00000000b001'
$SentinelKey = 'ops-backup-rehearsal/sentinel.txt'
$SentinelText = 'truerolls-backup-restore-sentinel-v1'
$Succeeded = $false

function Require-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function Compose([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments) {
  & docker compose -p $Project -f $ComposeFile @Arguments
  Require-Exit "docker compose $($Arguments -join ' ')"
}

function Project-Resources {
  [pscustomobject]@{
    Containers = @(docker ps -a --filter "label=com.docker.compose.project=$Project" --format '{{.ID}} {{.Names}}')
    Volumes = @(docker volume ls --filter "label=com.docker.compose.project=$Project" --format '{{.Name}}')
    Networks = @(docker network ls --filter "label=com.docker.compose.project=$Project" --format '{{.ID}} {{.Name}}')
  }
}

function Remove-CandidateStack {
  $resources = Project-Resources
  if ($resources.Containers.Count -eq 0 -and $resources.Volumes.Count -eq 0 -and $resources.Networks.Count -eq 0) {
    return
  }
  Write-Host "Verified $Project containers:"; $resources.Containers | ForEach-Object { Write-Host "  $_" }
  Write-Host "Verified $Project volumes:"; $resources.Volumes | ForEach-Object { Write-Host "  $_" }
  Write-Host "Verified $Project networks:"; $resources.Networks | ForEach-Object { Write-Host "  $_" }
  if ($resources.Containers.Count -eq 0 -or $resources.Volumes.Count -eq 0 -or $resources.Networks.Count -eq 0) {
    throw "Refusing cleanup because the $Project resource set is incomplete"
  }
  Compose down --volumes
}

function Wait-Healthy {
  $deadline = (Get-Date).AddSeconds(90)
  do {
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:18080/healthz' -TimeoutSec 3
      if ($health.status -eq 'ok') { return $health }
    } catch { }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'candidate API did not become healthy on port 18080'
}

function Configure-MinioAlias {
  & docker compose -p $Project -f $ComposeFile exec -T minio mc alias set local http://localhost:9000 candidateadmin candidate_dev_only_minio
  Require-Exit 'configure MinIO alias'
}

if (-not $RehearsalRoot.StartsWith($OutputRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing output outside ignored outputs: $RehearsalRoot"
}
if ((Project-Resources).Containers.Count -ne 0 -or (Project-Resources).Volumes.Count -ne 0 -or (Project-Resources).Networks.Count -ne 0) {
  throw "Refusing to start: $Project already has Docker resources"
}
if (Test-Path -LiteralPath $RehearsalRoot) {
  Remove-Item -LiteralPath $RehearsalRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TranscriptBackup -Force | Out-Null

try {
  Compose up -d --wait
  $healthBefore = Wait-Healthy
  Configure-MinioAlias

  $insertSql = @"
WITH roll_row AS (
  INSERT INTO rolls
    (public_id, die, kappa, seed, idempotency_key, face, ev, alpha, kl, idem_payload_sha256, receipt_json)
  VALUES
    ('$SentinelId', 'd6', 0, NULL, 'ops-backup-rehearsal', 1, 3.5, 1, 0, NULL, NULL)
  ON CONFLICT (idempotency_key) DO UPDATE SET face = EXCLUDED.face
  RETURNING id
)
INSERT INTO transcripts_meta (roll_id, s3_key, size_bytes)
SELECT id, '$SentinelKey', $($SentinelText.Length) FROM roll_row
ON CONFLICT (s3_key) DO UPDATE SET roll_id = EXCLUDED.roll_id, size_bytes = EXCLUDED.size_bytes;
"@
  & docker compose -p $Project -f $ComposeFile exec -T postgres psql -U kd -d kd -v ON_ERROR_STOP=1 -c $insertSql
  Require-Exit 'insert Postgres sentinel'
  & docker compose -p $Project -f $ComposeFile exec -T minio sh -c "printf '%s' '$SentinelText' | mc pipe local/kd-transcripts/$SentinelKey"
  Require-Exit 'write MinIO sentinel'

  $rowBefore = (& docker compose -p $Project -f $ComposeFile exec -T postgres psql -U kd -d kd -tAc "SELECT public_id FROM rolls WHERE idempotency_key='ops-backup-rehearsal'").Trim()
  Require-Exit 'read Postgres sentinel before backup'
  $objectBefore = (& docker compose -p $Project -f $ComposeFile exec -T minio mc cat "local/kd-transcripts/$SentinelKey").Trim()
  Require-Exit 'read MinIO sentinel before backup'
  if ($rowBefore -ne $SentinelId -or $objectBefore -ne $SentinelText) { throw 'pre-backup sentinel mismatch' }

  & docker compose -p $Project -f $ComposeFile exec -T postgres pg_dump -U kd -d kd --clean --if-exists --no-owner --no-privileges > $DumpFile
  Require-Exit 'Postgres backup'
  & docker compose -p $Project -f $ComposeFile exec -T minio sh -c 'rm -rf /tmp/truerolls-backup && mkdir -p /tmp/truerolls-backup && mc mirror local/kd-transcripts /tmp/truerolls-backup'
  Require-Exit 'MinIO backup'
  $minioId = (& docker compose -p $Project -f $ComposeFile ps -q minio).Trim()
  Require-Exit 'resolve MinIO container'
  & docker cp "${minioId}:/tmp/truerolls-backup/." $TranscriptBackup
  Require-Exit 'copy MinIO backup'
  if ((Get-Item $DumpFile).Length -eq 0) { throw 'Postgres dump is empty' }

  Remove-CandidateStack
  Compose up -d --wait
  Wait-Healthy | Out-Null
  Configure-MinioAlias
  Compose stop api

  Get-Content -LiteralPath $DumpFile -Raw | & docker compose -p $Project -f $ComposeFile exec -T postgres psql -U kd -d kd -v ON_ERROR_STOP=1
  Require-Exit 'Postgres restore'
  $minioId = (& docker compose -p $Project -f $ComposeFile ps -q minio).Trim()
  Require-Exit 'resolve restored MinIO container'
  & docker cp "$TranscriptBackup/." "${minioId}:/tmp/truerolls-restore"
  Require-Exit 'copy MinIO restore input'
  & docker compose -p $Project -f $ComposeFile exec -T minio mc mirror /tmp/truerolls-restore local/kd-transcripts
  Require-Exit 'MinIO restore'
  Compose start api
  $healthAfter = Wait-Healthy

  $rowAfter = (& docker compose -p $Project -f $ComposeFile exec -T postgres psql -U kd -d kd -tAc "SELECT public_id FROM rolls WHERE idempotency_key='ops-backup-rehearsal'").Trim()
  Require-Exit 'read restored Postgres sentinel'
  $objectAfter = (& docker compose -p $Project -f $ComposeFile exec -T minio mc cat "local/kd-transcripts/$SentinelKey").Trim()
  Require-Exit 'read restored MinIO sentinel'
  if ($rowAfter -ne $SentinelId -or $objectAfter -ne $SentinelText) { throw 'restored sentinel mismatch' }

  $result = [ordered]@{
    schema = 'truerolls.backup-restore-rehearsal.v1'
    completed_at_utc = [DateTime]::UtcNow.ToString('o')
    project = $Project
    postgres_sentinel = $rowAfter
    minio_sentinel = $objectAfter
    postgres_dump_sha256 = (Get-FileHash $DumpFile -Algorithm SHA256).Hash
    health_before = $healthBefore
    health_after = $healthAfter
    verdict = 'PASS'
  }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $RehearsalRoot 'result.json') -Encoding utf8
  $Succeeded = $true
  Write-Host 'BACKUP/RESTORE REHEARSAL PASS'
  $result | ConvertTo-Json -Depth 8
} finally {
  $resources = Project-Resources
  if ($resources.Containers.Count -gt 0 -or $resources.Volumes.Count -gt 0 -or $resources.Networks.Count -gt 0) {
    Remove-CandidateStack
  }
}

if (-not $Succeeded) { exit 1 }
