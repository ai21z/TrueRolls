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

$testParent = Join-Path $repo '.local-work'
$fixture = Join-Path $testParent ('beta-storage-tests-' + [Guid]::NewGuid().ToString('N'))
New-BetaPrivateDirectory $fixture
try {
  & git -C $fixture init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize storage test fixture.' }
  $info = Join-Path $fixture '.git/info/exclude'
  $dockerIgnore = Join-Path $fixture '.dockerignore'
  $dockerSpecific = Join-Path $fixture 'Dockerfile.dockerignore'
  [IO.File]::WriteAllText($info, "/.local-work/`n")
  [IO.File]::WriteAllText($dockerIgnore, ".local-work/`n")
  $private = Join-Path $fixture '.local-work/private-beta/permissions'
  Reject { Assert-BetaStoragePath $private $fixture } 'local storage still requires explicit opt-in'
  $allowed = Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage
  Check ($allowed -eq [IO.Path]::GetFullPath($private)) 'explicit Git and Docker excluded local storage accepted'
  Reject { Assert-BetaStoragePath (Join-Path $fixture 'outputs/private') $fixture -AllowRepositoryLocalStorage } 'opt-in does not allow arbitrary repository folders'
  Reject { Assert-BetaStoragePath (Join-Path $fixture '.local-work/private-beta-elsewhere/file') $fixture -AllowRepositoryLocalStorage } 'similar private folder prefix refused'
  Reject { Assert-BetaStoragePath (Join-Path $fixture '.LOCAL-WORK/private-beta/file') $fixture -AllowRepositoryLocalStorage } 'case-mismatched Docker exclusion refused'
  Reject { Assert-BetaStoragePath (Join-Path $fixture '.local-work/private-beta/../../escape') $fixture -AllowRepositoryLocalStorage } 'local storage traversal refused'
  Reject { Assert-BetaStoragePath $private (Split-Path $fixture -Parent) -AllowRepositoryLocalStorage } 'non-repository root refused'
  [IO.File]::WriteAllText($info, '')
  [IO.File]::WriteAllText((Join-Path $fixture '.gitignore'), "/.local-work/`n")
  Reject { Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage } 'gitignore alone cannot replace local info exclusion'
  [IO.File]::WriteAllText($info, "/.local-work/`n")
  [IO.File]::WriteAllText((Join-Path $fixture '.gitignore'), "!/.local-work/`n")
  Reject { Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage } 'ineffective Git exclusion refused'
  [IO.File]::WriteAllText((Join-Path $fixture '.gitignore'), '')
  [IO.File]::WriteAllText($dockerIgnore, "target/`n")
  Reject { Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage } 'missing Docker exclusion refused'
  [IO.File]::WriteAllText($dockerIgnore, ".local-work/`n!.local-work/private-beta/`n")
  Reject { Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage } 'negated Docker rules require review'
  [IO.File]::WriteAllText($dockerIgnore, ".local-work/`n")
  [IO.File]::WriteAllText($dockerSpecific, ".local-work/`n")
  Reject { Assert-BetaStoragePath $private $fixture -AllowRepositoryLocalStorage } 'Dockerfile-specific ignore overrides require review'
  Remove-Item -LiteralPath $dockerSpecific
  Assert-BetaBackupPath $private $fixture -AllowRepositoryLocalStorage | Out-Null
  Check $true 'new local backup directory accepted with explicit opt-in'
  New-BetaPrivateDirectory $private
  Reject { Assert-BetaBackupPath $private $fixture -AllowRepositoryLocalStorage } 'local backup cannot overwrite an existing directory'
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
  $scripts = Join-Path $fixture 'scripts'
  New-Item -ItemType Directory -Path (Join-Path $scripts 'lib') | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'scripts/beta-secrets.ps1') -Destination $scripts
  Copy-Item -LiteralPath (Join-Path $repo 'scripts/lib/beta-ops.psm1') -Destination (Join-Path $scripts 'lib')
  $generator = Join-Path $scripts 'beta-secrets.ps1'
  $envPath = Join-Path $fixture '.local-work/private-beta/issuer/beta.env'
  Reject { & $generator -Path $envPath -ApiImage 'truerolls-kd-api:storage-fixture' } 'secret generator refuses repository-local default'
  Check (-not (Test-Path -LiteralPath $envPath)) 'refused generator creates no credential file'
  $generatorOutput = @(& $generator -Path $envPath -ApiImage 'truerolls-kd-api:storage-fixture' -Kid 'trb-storage-fixture' -AllowRepositoryLocalStorage *>&1) | Out-String
  Assert-BetaPrivateFile $envPath
  Check $true 'explicit local secret generation keeps owner-only permissions'
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -and -not $line.StartsWith('#')) { $pair = $line.Split('=', 2); $values[$pair[0]] = $pair[1] }
  }
  Check ($values.KD_SIGNING_ED25519_SECRET -cmatch '^[a-f0-9]{64}$') 'disposable signing seed has expected encoding'
  $printedSecrets = @($values.Keys | Where-Object {
    $_ -match 'SECRET|PASSWORD' -and $values[$_] -and $generatorOutput.Contains($values[$_])
  })
  Check ($printedSecrets.Count -eq 0) 'secret generator output contains no credential values'
  Check ($values.TUNNEL_TOKEN -eq '' -and $values.COMPOSE_PROFILES -eq '') 'local credential generation never activates a tunnel'
  $beforeEnv = (Get-FileHash -LiteralPath $envPath).Hash
  Reject { & $generator -Path $envPath -ApiImage 'truerolls-kd-api:storage-fixture' -AllowRepositoryLocalStorage } 'local secret generator cannot overwrite credentials'
  Check ((Get-FileHash -LiteralPath $envPath).Hash -ceq $beforeEnv) 'refused overwrite leaves credentials byte-identical'
  $tracked = Join-Path $fixture '.local-work/private-beta/tracked-public-fixture.txt'
  [IO.File]::WriteAllText($tracked, 'public test fixture, not a credential')
  & git -C $fixture add --force -- '.local-work/private-beta/tracked-public-fixture.txt'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare tracked-file rejection test.' }
  Reject { Assert-BetaStoragePath (Join-Path $fixture '.local-work/private-beta/new-file') $fixture -AllowRepositoryLocalStorage } 'tracked files in private storage refused'
} finally {
  $resolved = (Resolve-Path -LiteralPath $fixture).Path
  if (-not $resolved.StartsWith($testParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^beta-storage-tests-[a-f0-9]{32}$') {
    throw 'Unsafe test cleanup path.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "ALL $passed BETA OPS CHECKS PASSED"
