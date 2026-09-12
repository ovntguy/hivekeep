# Shared helpers for the Hivekeep Windows 11 native scripts.
# Dot-source from the other scripts in this folder. Requires Windows PowerShell 5.1+.
#Requires -Version 5.1

$script:HivekeepTaskNameDefault = 'Hivekeep'
# Capture at dot-source time. $PSScriptRoot is unreliable inside functions
# after `. HivekeepCommon.ps1` on Windows PowerShell 5.1.
$script:HivekeepWindowsDir = $PSScriptRoot

function Get-HivekeepRepoRoot {
    param(
        [string]$Override
    )

    if ($Override) {
        $resolved = Resolve-Path -LiteralPath $Override -ErrorAction Stop
        return $resolved.Path
    }

    $windowsDir = $script:HivekeepWindowsDir
    if (-not $windowsDir) {
        $windowsDir = $PSScriptRoot
    }
    $candidate = (Resolve-Path (Join-Path $windowsDir '..\..')).Path
    $pkg = Join-Path $candidate 'package.json'
    if (-not (Test-Path -LiteralPath $pkg)) {
        throw "Could not find Hivekeep package.json at $pkg. Pass -RepoRoot to the script."
    }
    return $candidate
}

function Get-HivekeepBunDir {
    return (Join-Path $env:USERPROFILE '.bun\bin')
}

function Get-HivekeepBunPath {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    $local = Join-Path (Get-HivekeepBunDir) 'bun.exe'
    if (Test-Path -LiteralPath $local) {
        return $local
    }

    return $null
}

function Add-HivekeepBunToProcessPath {
    $bunDir = Get-HivekeepBunDir
    if (-not (Test-Path -LiteralPath $bunDir)) {
        return
    }

    $parts = $env:Path -split ';' | Where-Object { $_ }
    if ($parts -contains $bunDir) {
        return
    }
    $env:Path = "$bunDir;$env:Path"
}

function Add-HivekeepBunToUserPath {
    $bunDir = Get-HivekeepBunDir
    if (-not (Test-Path -LiteralPath $bunDir)) {
        return
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) {
        $userPath = ''
    }
    $parts = $userPath -split ';' | Where-Object { $_ }
    if ($parts -contains $bunDir) {
        Add-HivekeepBunToProcessPath
        return
    }

    $newPath = if ($userPath) { "$bunDir;$userPath" } else { $bunDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Add-HivekeepBunToProcessPath
    Write-Host "Added $bunDir to your user PATH. Open a new PowerShell window if 'bun' is still not found."
}

function Install-HivekeepBun {
    param(
        [switch]$SkipDownload
    )

    Add-HivekeepBunToProcessPath
    $existing = Get-HivekeepBunPath
    if ($existing) {
        Write-Host "Bun already available: $existing"
        Add-HivekeepBunToUserPath
        return $existing
    }

    if ($SkipDownload) {
        throw "Bun was not found on PATH or in $env:USERPROFILE\.bun\bin. Install it with: irm https://bun.sh/install.ps1 | iex"
    }

    Write-Host 'Installing Bun (https://bun.sh)...'
    $installer = Join-Path $env:TEMP 'hivekeep-bun-install.ps1'
    Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' -OutFile $installer
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    Add-HivekeepBunToProcessPath
    Add-HivekeepBunToUserPath

    $bun = Get-HivekeepBunPath
    if (-not $bun) {
        throw "Bun installer finished but bun.exe was not found. Close PowerShell, reopen it, and confirm $env:USERPROFILE\.bun\bin is on PATH."
    }
    return $bun
}

function Read-HivekeepDotEnv {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $map
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            return
        }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) {
            return
        }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $map[$key] = $value
    }
    return $map
}

function Set-HivekeepDotEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = Get-Content -LiteralPath $Path
    }

    $replaced = $false
    $out = foreach ($line in $lines) {
        if ($line -match "^(\s*#\s*)?$([regex]::Escape($Key))\s*=") {
            if (-not $replaced) {
                $replaced = $true
                "$Key=$Value"
            }
        }
        else {
            $line
        }
    }

    if (-not $replaced) {
        $out += "$Key=$Value"
    }

    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($Path, [string[]]$out, $utf8)
}

function Get-HivekeepEnvPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )
    return (Join-Path $RepoRoot '.env')
}

function Get-HivekeepDataDir {
    param(
        [string]$RepoRoot,
        [string]$Override
    )

    if ($Override) {
        return $Override
    }

    if ($env:HIVEKEEP_DATA_DIR) {
        return $env:HIVEKEEP_DATA_DIR
    }

    if ($RepoRoot) {
        $dotEnv = Read-HivekeepDotEnv -Path (Get-HivekeepEnvPath -RepoRoot $RepoRoot)
        if ($dotEnv.ContainsKey('HIVEKEEP_DATA_DIR') -and $dotEnv['HIVEKEEP_DATA_DIR']) {
            $configured = $dotEnv['HIVEKEEP_DATA_DIR']
            if ([System.IO.Path]::IsPathRooted($configured)) {
                return $configured
            }
            return (Join-Path $RepoRoot $configured)
        }
    }

    return (Join-Path $env:LOCALAPPDATA 'Hivekeep')
}

function Get-HivekeepPort {
    param(
        [string]$RepoRoot,
        [int]$Override
    )

    if ($Override -gt 0) {
        return $Override
    }
    if ($env:PORT) {
        return [int]$env:PORT
    }
    if ($RepoRoot) {
        $dotEnv = Read-HivekeepDotEnv -Path (Get-HivekeepEnvPath -RepoRoot $RepoRoot)
        if ($dotEnv.ContainsKey('PORT') -and $dotEnv['PORT']) {
            return [int]$dotEnv['PORT']
        }
    }
    return 3000
}

function Get-HivekeepPidPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DataDir
    )
    return (Join-Path $DataDir 'hivekeep.pid')
}

function Get-HivekeepServerProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine -match 'src[/\\]server[/\\]index\.ts' -or
                $_.CommandLine -match 'bun run start'
            )
        }
}

function Stop-HivekeepServerProcesses {
    param(
        [string]$DataDir
    )

    $stopped = 0

    if ($DataDir) {
        $pidPath = Get-HivekeepPidPath -DataDir $DataDir
        if (Test-Path -LiteralPath $pidPath) {
            $raw = (Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
            $savedPid = 0
            if ([int]::TryParse($raw, [ref]$savedPid) -and $savedPid -gt 0) {
                $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
                if ($proc) {
                    Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
                    $stopped++
                }
            }
            Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        }
    }

    Get-HivekeepServerProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
    }

    return $stopped
}

function Invoke-HivekeepBun {
    <#
    .SYNOPSIS
        Run bun without treating stderr as a terminating error.
        Native tools (husky, vite) often write to stderr; PowerShell then
        reports a failed exit even when the command succeeded.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$BunPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment
    )

    $previous = @{}
    if ($Environment) {
        foreach ($key in $Environment.Keys) {
            $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            Set-Item -Path "Env:$key" -Value $Environment[$key]
        }
    }

    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exitCode = 0
    try {
        if ($WorkingDirectory) {
            Push-Location -LiteralPath $WorkingDirectory
        }
        # Call operator: do not let PS NativeCommandError become a hard failure.
        & $BunPath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($WorkingDirectory) {
            Pop-Location
        }
        $ErrorActionPreference = $oldEap
        if ($Environment) {
            foreach ($key in $Environment.Keys) {
                $prior = $previous[$key]
                if ($null -eq $prior) {
                    Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
                }
                else {
                    Set-Item -Path "Env:$key" -Value $prior
                }
            }
        }
    }

    return $exitCode
}

function Test-HivekeepHealth {
    param(
        [int]$Port = 3000,
        [int]$TimeoutSec = 2
    )

    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec $TimeoutSec
        return ($resp.StatusCode -eq 200)
    }
    catch {
        return $false
    }
}
