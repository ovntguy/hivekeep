#Requires -Version 5.1
<#
.SYNOPSIS
    Start the Hivekeep server with native Bun on Windows 11.

.DESCRIPTION
    Runs `bun src/server/index.ts` from the repo root (same as `bun run start`).
    Bun loads `.env` from the working directory. Default is a detached process
    so the PowerShell window can close; use -Foreground when the Task Scheduler
    task should stay bound to the server process.

.PARAMETER RepoRoot
    Hivekeep checkout. Defaults to the repository that contains this script.

.PARAMETER DataDir
    Overrides HIVEKEEP_DATA_DIR for this process.

.PARAMETER Port
    Overrides PORT for this process.

.PARAMETER Foreground
    Run bun in this console (used by Register-HivekeepService.ps1).

.PARAMETER Detached
    Start bun in a new hidden process and write a PID file (default).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$DataDir,
    [int]$Port,
    [switch]$Foreground,
    [switch]$Detached
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HivekeepCommon.ps1')

# Default is detached unless -Foreground (Task Scheduler) is set.

$root = Get-HivekeepRepoRoot -Override $RepoRoot
Add-HivekeepBunToProcessPath
$bun = Get-HivekeepBunPath
if (-not $bun) {
    throw "Bun not found. Run Install-Hivekeep.ps1 first, or: irm https://bun.sh/install.ps1 | iex"
}

$resolvedDataDir = Get-HivekeepDataDir -RepoRoot $root -Override $DataDir
$resolvedPort = Get-HivekeepPort -RepoRoot $root -Override $Port

if (-not (Test-Path -LiteralPath $resolvedDataDir)) {
    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
}

$env:HIVEKEEP_DATA_DIR = $resolvedDataDir
$env:PORT = "$resolvedPort"
if (-not $env:NODE_ENV) {
    $env:NODE_ENV = 'production'
}

if (Test-HivekeepHealth -Port $resolvedPort) {
    Write-Host "Hivekeep is already responding on port $resolvedPort (http://127.0.0.1:$resolvedPort)."
    exit 0
}

$existing = @(Get-HivekeepServerProcesses)
if ($existing.Count -gt 0) {
    Write-Host "Found an existing Hivekeep bun process (PID $($existing[0].ProcessId)). Waiting for /api/health..."
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-HivekeepHealth -Port $resolvedPort) {
            Write-Host "Hivekeep is up at http://127.0.0.1:$resolvedPort"
            exit 0
        }
        Start-Sleep -Seconds 1
    }
    Write-Warning "A bun process is running but /api/health is not ready yet. Check $resolvedDataDir\hivekeep-server.err.log"
    exit 0
}

$indexHtml = Join-Path $root 'dist\client\index.html'
if (-not (Test-Path -LiteralPath $indexHtml)) {
    Write-Warning "dist\client\index.html is missing. The API will start, but the UI needs: bun run build"
}

Write-Host "Starting Hivekeep"
Write-Host "  bun:      $bun"
Write-Host "  repo:     $root"
Write-Host "  data dir: $resolvedDataDir"
Write-Host "  port:     $resolvedPort"

if ($Foreground) {
    Set-Location -LiteralPath $root
    & $bun 'src/server/index.ts'
    exit $LASTEXITCODE
}

$outLog = Join-Path $resolvedDataDir 'hivekeep-server.out.log'
$errLog = Join-Path $resolvedDataDir 'hivekeep-server.err.log'
$pidPath = Get-HivekeepPidPath -DataDir $resolvedDataDir
Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $bun -ArgumentList 'src/server/index.ts' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
if (-not $p) {
    throw 'Failed to start bun.'
}

[System.IO.File]::WriteAllText($pidPath, "$($p.Id)`n")
Write-Host "Started bun PID $($p.Id)."
Write-Host "  stdout: $outLog"
Write-Host "  stderr: $errLog"

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) {
        Write-Host '--- stderr ---'
        if (Test-Path -LiteralPath $errLog) {
            Get-Content -LiteralPath $errLog -Tail 40
        }
        Write-Host '--- stdout ---'
        if (Test-Path -LiteralPath $outLog) {
            Get-Content -LiteralPath $outLog -Tail 40
        }
        throw "Hivekeep exited immediately (code $($p.ExitCode)). See $errLog"
    }
    if (Test-HivekeepHealth -Port $resolvedPort) {
        Write-Host "Hivekeep is up: http://127.0.0.1:$resolvedPort"
        Write-Host "Health:         http://127.0.0.1:$resolvedPort/api/health"
        Write-Host "Onboarding:     http://127.0.0.1:$resolvedPort"
        exit 0
    }
    Start-Sleep -Seconds 1
}

Write-Warning "Started PID $($p.Id) but /api/health did not respond within 45s. Check $errLog"
exit 0
