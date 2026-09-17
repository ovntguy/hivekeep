This Hivekeep instance runs **natively on Windows 11** (Bun on the host — not WSL, not Docker, unless the user says otherwise). Windows tools are the default for every command-line call.

## Default shell

- `run_shell` executes **PowerShell** (`pwsh` when installed, otherwise Windows PowerShell 5.1). Pass `cwd` instead of `cd …;`.
- Optional `shell` argument: `powershell` (5.1), `pwsh` (7+), `cmd` (cmd.exe), `bash` (Git Bash only when you truly need POSIX).
- Write **PowerShell**, not bash, unless you set `shell=bash`. Do not assume `/bin/sh`, `which`, `export`, or Unix pipelines.

## PowerShell vs bash (use these)

| Intent | PowerShell | Do not use |
|---|---|---|
| Env var | `$env:NAME` / `$env:USERPROFILE` | `$HOME`, `export NAME=` |
| Chain commands | `;` (PS 5.1 has no `&&`) | `cmd1 && cmd2` unless you know this is `pwsh` 7+ |
| Last native exit code | `$LASTEXITCODE` | `$?` the bash way |
| List dir (but prefer `list_directory`) | `Get-ChildItem` | `ls -la` |
| Read file (but prefer `read_file`) | `Get-Content` | `cat` / `head` / `tail` |
| Search file (but prefer `grep`) | `Select-String` | `grep` / `rg` / `findstr` as a file-read |
| Path join | `Join-Path $env:USERPROFILE '.bun\bin'` | `~/…` |
| Temp dir | `$env:TEMP` | `/tmp` |
| Which binary | `Get-Command bun` / `where.exe bun` | `which`, `command -v` |
| HTTP | `http_request` tool | `curl` / `wget` / `Invoke-WebRequest` / `iwr` |

Dedicated Hivekeep tools still win for files: `read_file`, `grep`, `list_directory`, `edit_file`, `write_file`, `multi_edit`. `run_shell` is for git, builds, tests, package managers, services, and OS admin.

## Paths

- Windows paths: `C:\Users\…`, backslashes or forward slashes. Drive letters are required for absolute paths.
- User profile: `$env:USERPROFILE` (not `$HOME` unless Git Bash).
- Workspace cwd is the Agent workspace — keep clones and generated files there.
- Line endings are often CRLF; do not "fix" them unless asked.

## Common Windows commands (via `run_shell`)

**Process / service / hardware**

```powershell
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, WorkingSet
Get-Service | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 20 Name, Status
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, @{N='SizeGB';E={[math]::Round($_.Size/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.SizeRemaining/1GB,1)}}
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' }
```

**Software**

```powershell
winget search <name>
winget list
Get-Command git, bun, node, python, py, pwsh, docker, gh -ErrorAction SilentlyContinue
py --version
python --version
```

Python on Windows is often `py` or `python`, not `python3`. Node/git/bun shims are `*.cmd` / `*.exe` — call `git`, `bun`, `npm` by name; the runner PATH already includes typical install dirs.

**Files outside the workspace** (when a dedicated tool cannot): `Get-ChildItem -Force`, `Get-Item`, `Test-Path`. Still do not use these as a substitute for `read_file` / `list_directory` on workspace/project files.

**Scheduled tasks / Task Scheduler**

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'Hivekeep' } | Select-Object TaskName, State
```

**Git** — `git` from Git for Windows. Same porcelain as elsewhere (`git status`, `git diff`). No `&&` on PS 5.1: `git status; if ($LASTEXITCODE -eq 0) { git diff }`.

**Long failing commands** — capture the tail once, do not grep-fish:

```powershell
bun test 2>&1 | Select-Object -Last 80
```

## cmd.exe

Only when the user asks for a `.bat` / cmd built-in. Set `shell=cmd`. Use `cd /d C:\path` if you must change drive+dir (prefer the `cwd` argument). `dir`, `type`, `findstr` on project files are still refused — use the dedicated tools.

## Git Bash / WSL

Do not switch to bash or WSL for routine work. Use `shell=bash` only for a POSIX script that cannot run in PowerShell. WSL (`wsl.exe …`) only when the user explicitly wants the Linux distro.

## Safety (unchanged)

No `--no-verify`, `git push --force`, `git reset --hard`, or hook bypasses without explicit authorization. No `curl`/`wget`/`Invoke-WebRequest` for HTTP — `http_request`. No launching `chrome`/`msedge`/`firefox` — `browse_url` / `screenshot_url`.
