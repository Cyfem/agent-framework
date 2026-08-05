[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $InstallRoot) {
  $InstallRoot = Join-Path $repoRoot '.tools\node'
}
$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
$safeToolRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot '.tools'))
if (-not $installRootFull.StartsWith($safeToolRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallRoot must remain inside $safeToolRoot"
}

$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'node22.lock.json') | ConvertFrom-Json
if ($lock.schema -ne 'agent-framework-node-toolchain/v1') {
  throw 'Unsupported Node toolchain lock schema.'
}
$nodeVersion = [string]$lock.node.version
$archiveName = [string]$lock.node.windowsX64.archive
$expectedSha256 = ([string]$lock.node.windowsX64.sha256).ToLowerInvariant()
$installDirectory = Join-Path $installRootFull "node-v$nodeVersion-win-x64"
$nodeExecutable = Join-Path $installDirectory 'node.exe'
$pnpmExecutable = Join-Path $installDirectory 'pnpm.cmd'
$env:COREPACK_HOME = Join-Path $installRootFull 'corepack'

if (Test-Path -LiteralPath $nodeExecutable) {
  $actualVersion = (& $nodeExecutable --version).Trim()
  if ($actualVersion -ne "v$nodeVersion") {
    throw "Existing portable Node has version $actualVersion; expected v$nodeVersion."
  }
} else {
  New-Item -ItemType Directory -Force -Path $installRootFull | Out-Null
  $temporaryDirectory = Join-Path $installRootFull ('.bootstrap-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  try {
    $archivePath = Join-Path $temporaryDirectory $archiveName
    $shasumsPath = Join-Path $temporaryDirectory 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$lock.node.windowsX64.url) -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$lock.node.windowsX64.shasumsUrl) -OutFile $shasumsPath

    $officialLine = Get-Content -LiteralPath $shasumsPath | Where-Object { $_ -match ("\s+" + [regex]::Escape($archiveName) + '$') }
    if (($officialLine | Measure-Object).Count -ne 1) {
      throw "Official SHASUMS256.txt does not contain exactly one entry for $archiveName."
    }
    $officialSha256 = (($officialLine -split '\s+')[0]).ToLowerInvariant()
    if ($officialSha256 -ne $expectedSha256) {
      throw 'The official Node checksum differs from node22.lock.json.'
    }
    $downloadSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($downloadSha256 -ne $expectedSha256) {
      throw 'The downloaded Node archive failed SHA-256 verification.'
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory
    $expandedDirectory = Join-Path $temporaryDirectory "node-v$nodeVersion-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $expandedDirectory 'node.exe'))) {
      throw 'The verified Node archive did not contain the expected directory.'
    }
    if (Test-Path -LiteralPath $installDirectory) {
      throw "Install destination already exists without a valid node.exe: $installDirectory"
    }
    Move-Item -LiteralPath $expandedDirectory -Destination $installDirectory
  } finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
      $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryDirectory)
      if ($resolvedTemporary.StartsWith($installRootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
      }
    }
  }
}

$corepackExecutable = Join-Path $installDirectory 'corepack.cmd'
if (-not (Test-Path -LiteralPath $corepackExecutable)) {
  throw 'The portable Node distribution does not contain corepack.cmd.'
}
& $corepackExecutable enable pnpm --install-directory $installDirectory | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'corepack enable pnpm failed.' }
& $corepackExecutable prepare ([string]$lock.pnpm.packageManager) --activate | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'corepack prepare failed.' }
$actualPnpmVersion = (& $pnpmExecutable --version).Trim()
if ($actualPnpmVersion -ne [string]$lock.pnpm.version) {
  throw "Portable pnpm has version $actualPnpmVersion; expected $($lock.pnpm.version)."
}

Write-Host "Portable Node v$nodeVersion and pnpm $actualPnpmVersion are ready."
if ($PassThru) {
  Write-Output $installDirectory
}
