Set-StrictMode -Version Latest

function Assert-BetaRestoreProject {
  param([string]$Project, [string]$SourceProject)
  if ($Project -cnotmatch '\Atruerolls-beta-restore-[a-f0-9]{12}\z' -or $Project -eq $SourceProject) {
    throw 'Restore project must be a unique truerolls-beta-restore-<12 hex> name, different from the source.'
  }
}

function Assert-BetaBackupPath {
  param([string]$Path, [string]$RepoRoot)
  $full = [IO.Path]::GetFullPath($Path)
  $repo = [IO.Path]::GetFullPath($RepoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if ($full.Equals($repo, $comparison) -or $full.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, $comparison)) {
    throw 'Backup directory must be outside the repository and its Docker build context.'
  }
  if (Test-Path -LiteralPath $full) { throw 'Backup directory already exists; refusing to overwrite it.' }
  $ancestor = [IO.DirectoryInfo]::new($full).Parent
  while ($null -ne $ancestor) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Backup path must not traverse a symlink or junction.'
    }
    $ancestor = $ancestor.Parent
  }
  $full
}

function New-BetaPrivateDirectory {
  param([string]$Path)
  New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
  New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
  if ($IsWindows) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $acl)
  } else {
    & chmod 700 $Path
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict backup directory permissions.' }
  }
}

function Assert-BetaPrivateFile {
  param([string]$Path)
  $file = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected a regular private file, not a directory or symlink.'
  }
  if ($IsWindows) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($rule in (Get-Acl -LiteralPath $Path).Access) {
      if ($rule.AccessControlType -eq 'Allow' -and
          $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid) {
        throw 'Secret file grants another identity access; restrict its ACL first.'
      }
    }
  } else {
    $mode = [IO.File]::GetUnixFileMode($Path)
    $others = [IO.UnixFileMode]::GroupRead -bor [IO.UnixFileMode]::GroupWrite -bor
      [IO.UnixFileMode]::GroupExecute -bor [IO.UnixFileMode]::OtherRead -bor
      [IO.UnixFileMode]::OtherWrite -bor [IO.UnixFileMode]::OtherExecute
    if ($mode -band $others) { throw 'Secret file must not grant group or other access.' }
  }
}

function ConvertTo-BetaRestoreModel {
  param([System.Collections.IDictionary]$Source, [string]$Project, [string]$SourceProject)
  Assert-BetaRestoreProject $Project $SourceProject
  $model = $Source | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
  foreach ($section in @('configs', 'secrets', 'include', 'extends')) {
    if ($model.Contains($section)) { throw "Unsupported compose section: $section. Review isolation before using it." }
  }
  $allowed = @('postgres', 'redis', 'minio', 'minio-init', 'api')
  $model.services.Remove('cloudflared') | Out-Null
  foreach ($name in @($model.services.Keys)) {
    if ($name -notin $allowed) { throw "Unsupported restore service: $name" }
    $service = $model.services[$name]
    foreach ($key in @('ports', 'profiles', 'container_name', 'network_mode')) { $service.Remove($key) | Out-Null }
    foreach ($key in @('volumes_from', 'devices', 'privileged', 'pid', 'ipc', 'uts')) {
      if ($service.Contains($key)) { throw "Unsupported restore service option: $key" }
    }
    $service.restart = 'no'
    if ($service.Contains('environment')) {
      $service.environment.Remove('TUNNEL_TOKEN') | Out-Null
      $service.environment.Remove('COMPOSE_PROFILES') | Out-Null
    }
    if ($name -in @('minio', 'minio-init')) {
      $service.Remove('build') | Out-Null
      $service.pull_policy = 'never'
    }
    if ($service.Contains('volumes')) {
      foreach ($mount in $service.volumes) {
        if ($mount.type -eq 'bind' -and (-not $mount.Contains('read_only') -or -not $mount.read_only)) {
          throw 'Restore bind mounts must be read-only.'
        }
        if ($mount.type -notin @('bind', 'volume', 'tmpfs')) { throw 'Unsupported restore mount type.' }
      }
    }
  }
  foreach ($name in $allowed) {
    if (-not $model.services.Contains($name)) { throw "Missing restore service: $name" }
  }
  foreach ($kind in @('volumes', 'networks')) {
    if (-not $model.Contains($kind)) { throw "Missing compose section: $kind" }
    foreach ($key in @($model[$kind].Keys)) {
      if ($key -cnotmatch '\A[a-z][a-z0-9-]{0,40}\z') { throw 'Unsupported resource key.' }
      $entry = $model[$kind][$key]
      if ($entry.Contains('external') -and $entry.external) { throw 'External resources are forbidden in a restore rehearsal.' }
      if ($entry.Contains('driver_opts')) { throw 'Custom resource driver options require a separate isolation review.' }
      $entry.name = "${Project}_$key"
    }
  }
  if (-not $model.networks.backend.internal) { throw 'Restore backend network must remain internal.' }
  $model.name = $Project
  $model
}

function Assert-BetaOwnedResource {
  param([string]$Name, [string]$ProjectLabel, [string]$Project)
  $prefix = $Name.StartsWith($Project + '_', [StringComparison]::Ordinal) -or
    $Name.StartsWith($Project + '-', [StringComparison]::Ordinal)
  if ($ProjectLabel -ne $Project -or -not $prefix) {
    throw 'Resource ownership mismatch; refusing destructive cleanup.'
  }
}

Export-ModuleMember -Function Assert-BetaRestoreProject, Assert-BetaBackupPath, New-BetaPrivateDirectory,
  Assert-BetaPrivateFile, ConvertTo-BetaRestoreModel, Assert-BetaOwnedResource
