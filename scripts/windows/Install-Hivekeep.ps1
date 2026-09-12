#Requires -Version 5.1
<#
.SYNOPSIS
    Idempotent Windows 11 native install of Hivekeep (Bun, no WSL, no Docker).

.DESCRIPTION
    Ensures Bun is on PATH, installs npm dependencies, builds the Vite frontend,
    copies .env.example to .env when missing, and creates the data directory.

    Run from a clone of this repository:

        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-Hivekeep.ps1

.PARAMETER RepoRoot
    Hivekeep checkout. Defaults to the repository that contains this script.

.PARAMETER DataDir
    Persistent data directory (SQLite, uploads, workspaces, encryption key).
    Defaults to %LOCALAPPDATA%\Hivekeep, or HIVEKEEP_DATA_DIR if already set.

.PARAMETER Port
    HTTP port written into a newly created .env (default 3000).

.PARAMETER HostAddress
    Bind address written into a newly created .env (default 127.0.0.1).

.PARAMETER PublicUrl
    PUBLIC_URL written into a newly created .env (default http://localhost:<Port>).

.PARAMETER SkipBunInstall
    Do not download Bun if it is missing; fail instead.

.PARAMETER SkipBuild
    Skip `bun run build` (only useful if dist/client already exists).

.PARAMETER Timezone
    Optional IANA timezone written as HIVEKEEP_TIMEZONE (example: America/Chicago).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$DataDir,
    [int]$Port = 3000,
    [string]$HostAddress = '127.0.0.1',
    [string]$PublicUrl,
    [switch]$SkipBunInstall,
    [switch]$SkipBuild,
    [string]$Timezone
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HivekeepCommon.ps1')

$root = Get-HivekeepRepoRoot -Override $RepoRoot
Set-Location -LiteralPath $root

if (-not $PublicUrl) {
    $PublicUrl = "http://localhost:$Port"
}

$resolvedDataDir = Get-HivekeepDataDir -RepoRoot $root -Override $DataDir
$envPath = Get-HivekeepEnvPath -RepoRoot $root
$examplePath = Join-Path $root '.env.example'

Write-Host ''
Write-Host "Hivekeep Windows install"
Write-Host "  repo:     $root"
Write-Host "  data dir: $resolvedDataDir"
Write-Host ''

# ── Bun ──────────────────────────────────────────────────────────────────────
$bun = Install-HivekeepBun -SkipDownload:$SkipBunInstall
$bunVersion = & $bun --version
Write-Host "Using Bun $bunVersion ($bun)"

# ── Dependencies ─────────────────────────────────────────────────────────────
# HUSKY=0 skips the prepare hook. husky often writes to stderr on Windows and
# PowerShell then reports exit code 1 even when packages installed correctly.
Write-Host 'Running bun install (HUSKY=0)...'
$installCode = Invoke-HivekeepBun -BunPath $bun -Arguments @('install') -WorkingDirectory $root -Environment @{
    HUSKY = '0'
}

$nodeModules = Join-Path $root 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    throw "bun install exited $installCode and node_modules is missing. See docs/windows.md (troubleshooting)."
}

if ($installCode -ne 0) {
    Write-Warning "bun install reported exit code $installCode. node_modules exists, so this is often husky/stderr noise. Continuing."
}
else {
    Write-Host 'bun install finished.'
}

# ── Frontend build ───────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Host 'Running bun run build (NODE_OPTIONS=--max-old-space-size=6144)...'
    $buildCode = Invoke-HivekeepBun -BunPath $bun -Arguments @('run', 'build') -WorkingDirectory $root -Environment @{
        NODE_OPTIONS = '--max-old-space-size=6144'
    }

    $indexHtml = Join-Path $root 'dist\client\index.html'
    if (-not (Test-Path -LiteralPath $indexHtml)) {
        throw "bun run build exited $buildCode and dist\client\index.html is missing. Increase memory or see docs/windows.md."
    }

    if ($buildCode -ne 0) {
        Write-Warning "bun run build reported exit code $buildCode, but dist\client\index.html exists. Treating as success."
    }
    else {
        Write-Host 'Production frontend built (dist/client).'
    }
}
else {
    Write-Host 'Skipping build (-SkipBuild).'
}

# ── .env ─────────────────────────────────────────────────────────────────────
$createdEnv = $false
if (-not (Test-Path -LiteralPath $envPath)) {
    if (-not (Test-Path -LiteralPath $examplePath)) {
        throw "Missing $examplePath; cannot create .env."
    }
    Copy-Item -LiteralPath $examplePath -Destination $envPath
    $createdEnv = $true
    Write-Host "Created $envPath from .env.example"
}

# New .env: write the Windows defaults. Existing .env: only touch keys the
# caller explicitly passed so a re-run does not clobber a working file.
if ($createdEnv -or $PSBoundParameters.ContainsKey('Port')) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'PORT' -Value "$Port"
}
if ($createdEnv -or $PSBoundParameters.ContainsKey('HostAddress')) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'HOST' -Value $HostAddress
}
if ($createdEnv -or $PSBoundParameters.ContainsKey('PublicUrl')) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'PUBLIC_URL' -Value $PublicUrl
}
$existingEnv = Read-HivekeepDotEnv -Path $envPath
if (
    $createdEnv -or
    $PSBoundParameters.ContainsKey('DataDir') -or
    -not $existingEnv.ContainsKey('HIVEKEEP_DATA_DIR')
) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'HIVEKEEP_DATA_DIR' -Value $resolvedDataDir
}
if ($createdEnv) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'NODE_ENV' -Value 'production'
}
if ($Timezone) {
    Set-HivekeepDotEnvValue -Path $envPath -Key 'HIVEKEEP_TIMEZONE' -Value $Timezone
}

# ── Data directory ───────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $resolvedDataDir)) {
    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
    Write-Host "Created data directory $resolvedDataDir"
}
else {
    Write-Host "Data directory already exists: $resolvedDataDir"
}

Write-Host ''
Write-Host 'Install complete. Next:'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-Hivekeep.ps1"
Write-Host "  then open $PublicUrl"
Write-Host ''
Write-Host 'Optional service (Task Scheduler, not systemd/Docker/WSL):'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Register-HivekeepService.ps1"
Write-Host ''
Write-Host 'Playwright browsers are not installed here. Basic server + Queenie onboarding do not need them.'
Write-Host 'See docs/windows.md and docs/windows-gaps.md.'
