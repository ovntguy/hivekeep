#Requires -Version 5.1
<#
.SYNOPSIS
    Stop a Hivekeep server started by Start-Hivekeep.ps1 or the scheduled task.

.DESCRIPTION
    Stops bun processes whose command line is `src/server/index.ts`, removes the
    PID file, and optionally stops the Hivekeep Task Scheduler task.

.PARAMETER RepoRoot
    Hivekeep checkout. Used to resolve the data directory / PID file.

.PARAMETER DataDir
    Directory that contains hivekeep.pid.

.PARAMETER SkipScheduledTask
    Do not stop the Hivekeep scheduled task (only kill matching bun processes).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$DataDir,
    [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HivekeepCommon.ps1')

$root = $null
try {
    $root = Get-HivekeepRepoRoot -Override $RepoRoot
}
catch {
    if (-not $DataDir) {
        throw
    }
}

$resolvedDataDir = Get-HivekeepDataDir -RepoRoot $root -Override $DataDir
$taskName = $script:HivekeepTaskNameDefault

if (-not $SkipScheduledTask) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') {
        Write-Host "Stopping scheduled task '$taskName'..."
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
}

$killed = Stop-HivekeepServerProcesses -DataDir $resolvedDataDir
if ($killed -gt 0) {
    Write-Host "Stopped $killed Hivekeep process(es)."
}
else {
    Write-Host 'No Hivekeep bun process was running.'
}

$pidPath = Get-HivekeepPidPath -DataDir $resolvedDataDir
if (Test-Path -LiteralPath $pidPath) {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}
