#requires -Version 7
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../lib/beta-ops.psm1') -Force -DisableNameChecking
$passed = 0
function Check([bool]$Value, [string]$Name) {
  if (-not $Value) { throw "FAIL: $Name" }
  $script:passed++
  Write-Host "PASS: $Name"
}
function Reject([scriptblock]$Action, [string]$Name) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  Check $rejected $Name
}
$project = 'truerolls-beta-restore-012345abcdef'
$sourceProject = 'truerolls-beta'
Assert-BetaRestoreProject $project $sourceProject
Check $true 'unique restore project accepted'
Reject { Assert-BetaRestoreProject 'truerolls-beta' $sourceProject } 'real beta project refused'
Reject { Assert-BetaRestoreProject $project $project } 'source and restore equality refused'
Reject { Assert-BetaRestoreProject 'another-project' $sourceProject } 'unscoped restore name refused'
Reject { Assert-BetaRestoreProject ($project + "`n") $sourceProject } 'trailing newline in project refused'
Reject { Assert-BetaRestoreProject $project.ToUpperInvariant() $sourceProject } 'uppercase project refused'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Reject { Assert-BetaBackupPath (Join-Path $repo 'outputs/private-backup') $repo } 'backup inside repository refused'
Reject { Assert-BetaBackupPath $repo $repo } 'repository root refused'
Reject { Assert-BetaBackupPath $PSScriptRoot $repo } 'existing backup path refused'

$services = @{}
foreach ($name in @('postgres', 'redis', 'minio', 'minio-init', 'api')) {
  $services[$name] = @{ image='fixture'; environment=@{}; restart='unless-stopped' }
}
$services.api.ports = @(@{target=8080;published='18080'})
$services.api.environment.TUNNEL_TOKEN = 'fixture-token-not-a-secret'
$services.api.environment.COMPOSE_PROFILES = 'tunnel'
$services.cloudflared = @{image='fixture'; profiles=@('tunnel');environment=@{TUNNEL_TOKEN='fixture-token-not-a-secret'}}
$services.minio.build = @{context='fixture'}
$model = @{
  name=$sourceProject; services=$services
  volumes=@{'postgres-data'=@{name='truerolls-beta_postgres-data'}; 'minio-data'=@{name='truerolls-beta_minio-data'}}
  networks=@{backend=@{name='truerolls-beta_backend';internal=$true};egress=@{name='truerolls-beta_egress'}}
}
$before = $model | ConvertTo-Json -Depth 20 -Compress
$isolated = ConvertTo-BetaRestoreModel $model $project $sourceProject
Check (-not $isolated.services.Contains('cloudflared')) 'tunnel service removed entirely'
Check (-not $isolated.services.api.Contains('ports')) 'host ports removed'
Check (-not $isolated.services.api.environment.Contains('TUNNEL_TOKEN')) 'tunnel credential removed'
Check (-not $isolated.services.api.environment.Contains('COMPOSE_PROFILES')) 'profile environment removed'
Check ($isolated.volumes['postgres-data'].name -eq "${project}_postgres-data") 'restore volume renamed'
Check ($isolated.networks.backend.name -eq "${project}_backend") 'restore network renamed'
Check $isolated.networks.backend.internal 'backend isolation retained'
Check (-not $isolated.services.minio.Contains('build')) 'restore does not silently rebuild images'
Check ($isolated.services.minio.pull_policy -eq 'never') 'restore requires existing fixture image'
Check ($isolated.services.api.restart -eq 'no') 'restore does not leave auto-restarting services'
Check (($model | ConvertTo-Json -Depth 20 -Compress) -eq $before) 'source configuration unchanged'
$external = $before | ConvertFrom-Json -AsHashtable
$external.volumes['postgres-data'].external = $true
Reject { ConvertTo-BetaRestoreModel $external $project $sourceProject } 'external volume refused'
$unknown = $before | ConvertFrom-Json -AsHashtable
$unknown.services.unexpected = @{image='fixture'}
Reject { ConvertTo-BetaRestoreModel $unknown $project $sourceProject } 'unexpected service refused'
$unsafe = $before | ConvertFrom-Json -AsHashtable
$unsafe.services.api.volumes = @(@{type='bind';source='/private';target='/private';read_only=$false})
Reject { ConvertTo-BetaRestoreModel $unsafe $project $sourceProject } 'writable host bind refused'
$driver = $before | ConvertFrom-Json -AsHashtable
$driver.volumes['postgres-data'].driver_opts = @{device='/private'}
Reject { ConvertTo-BetaRestoreModel $driver $project $sourceProject } 'custom volume driver refused'
Assert-BetaOwnedResource "${project}_postgres-data" $project $project
Check $true 'matching resource ownership accepted'
Reject { Assert-BetaOwnedResource 'truerolls-beta_postgres-data' $project $project } 'foreign resource name refused'
Reject { Assert-BetaOwnedResource "${project}_postgres-data" 'truerolls-beta' $project } 'foreign project label refused'

$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$private = Join-Path $tempParent ('truerolls-beta-ops-tests-' + [Guid]::NewGuid().ToString('N'))
Assert-BetaBackupPath $private $repo | Out-Null
try {
  New-BetaPrivateDirectory $private
  Reject { New-BetaPrivateDirectory $private } 'private directory cannot overwrite an existing path'
  $file = Join-Path $private 'fixture.txt'
  [IO.File]::WriteAllText($file, 'fixture')
  if (-not $IsWindows) { [IO.File]::SetUnixFileMode($file, [IO.UnixFileMode]384) }
  Assert-BetaPrivateFile $file
  Check $true 'owner-only fixture accepted'
  if ($IsWindows) {
    $acl = Get-Acl -LiteralPath $file
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $acl
  } else {
    [IO.File]::SetUnixFileMode($file, [IO.UnixFileMode]420)
  }
  Reject { Assert-BetaPrivateFile $file } 'shared fixture refused'
} finally {
  $resolved = (Resolve-Path -LiteralPath $private).Path
  if (-not $resolved.StartsWith($tempParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^truerolls-beta-ops-tests-[a-f0-9]{32}$') {
    throw 'Unsafe test cleanup path.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "ALL $passed BETA OPS CHECKS PASSED"
