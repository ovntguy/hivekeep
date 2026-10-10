#Requires -Version 5.1
<#
.SYNOPSIS
    Register or unregister Hivekeep as a Windows Task Scheduler task.

.DESCRIPTION
    This is a Windows-native service stand-in (Task Scheduler), not systemd,
    Docker, or WSL. The task runs Start-Hivekeep.ps1 -Foreground so the task
    lifetime matches the bun process.

    AtLogon (default): start when the current user logs on.
    OnDemand: no trigger; start with Start-ScheduledTask -TaskName Hivekeep.

    Unregister:

        .\Register-HivekeepService.ps1 -Unregister

    Or:

        Unregister-ScheduledTask -TaskName Hivekeep -Confirm:$false

.PARAMETER RepoRoot
    Hivekeep checkout. Defaults to the repository that contains this script.

.PARAMETER DataDir
    Passed through to Start-Hivekeep.ps1 as -DataDir.

.PARAMETER TaskName
    Scheduled task name (default Hivekeep).

.PARAMETER OnDemand
    Register without a logon trigger.

.PARAMETER AtLogon
    Register an At logon trigger (default if neither switch is set).

.PARAMETER Unregister
    Remove the scheduled task and exit.

.PARAMETER Start
    Start the task immediately after registering.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$DataDir,
    [string]$TaskName = 'Hivekeep',
    [switch]$OnDemand,
    [switch]$AtLogon,
    [switch]$Unregister,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HivekeepCommon.ps1')

if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "Scheduled task '$TaskName' is not registered."
        exit 0
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered scheduled task '$TaskName'."
    Write-Host 'Hivekeep data and the git checkout are unchanged. Stop a leftover process with Stop-Hivekeep.ps1.'
    exit 0
}

if (-not $OnDemand -and -not $AtLogon) {
    $AtLogon = $true
}
if ($OnDemand -and $AtLogon) {
    throw 'Use only one of -AtLogon or -OnDemand.'
}

$root = Get-HivekeepRepoRoot -Override $RepoRoot
$startScript = Join-Path $PSScriptRoot 'Start-Hivekeep.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Missing $startScript"
}

Add-HivekeepBunToProcessPath
if (-not (Get-HivekeepBunPath)) {
    throw 'Bun not found. Run Install-Hivekeep.ps1 first.'
}

$argumentList = @(
    '-NoProfile'
    '-ExecutionPolicy', 'Bypass'
    '-File', "`"$startScript`""
    '-RepoRoot', "`"$root`""
    '-Foreground'
)
if ($DataDir) {
    $argumentList += @('-DataDir', "`"$DataDir`"")
}

$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argString = ($argumentList -join ' ')

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argString -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$registerArgs = @{
    TaskName    = $TaskName
    Action      = $action
    Settings    = $settings
    Principal   = $principal
    Description = 'Hivekeep AI agent platform (native Bun). Not systemd, Docker, or WSL.'
    Force       = $true
}

if ($AtLogon) {
    try {
        $registerArgs.Trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
    }
    catch {
        $registerArgs.Trigger = New-ScheduledTaskTrigger -AtLogon
    }
    $mode = 'At logon (current user session)'
}
else {
    $mode = 'On demand (Start-ScheduledTask)'
}

$already = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($already) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Register-ScheduledTask @registerArgs | Out-Null

Write-Host "Registered scheduled task '$TaskName' ($mode)."
Write-Host "  action: $psExe $argString"
Write-Host "  cwd:    $root"
Write-Host ''
Write-Host 'Start now:   Start-ScheduledTask -TaskName Hivekeep'
Write-Host 'Stop:        Stop-ScheduledTask -TaskName Hivekeep'
Write-Host '             or .\scripts\windows\Stop-Hivekeep.ps1'
Write-Host 'Unregister:  .\scripts\windows\Register-HivekeepService.ps1 -Unregister'
Write-Host '             or Unregister-ScheduledTask -TaskName Hivekeep -Confirm:$false'
Write-Host ''
Write-Host 'This is Task Scheduler, not services.msc. The task runs as your user after logon (or when you start it). It does not start at boot before anyone logs in.'

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started task '$TaskName'."
}
