# Hivekeep on Windows 11 (native Bun)

This is the **native Windows 11 path**: Git + Bun on the host. **No WSL. No Docker.** The official `install.sh` is a bash installer for Linux and macOS (systemd / launchd) and is **not** used here.

PowerShell scripts live in [`scripts/windows/`](../scripts/windows/). Known limitations are listed in [`windows-gaps.md`](windows-gaps.md).

This runbook was written against the current tree (`package.json` version **1.10.0**, `bun run start` → `bun src/server/index.ts`). It incorporates a reported successful run on Windows 11 (build 26200) with Bun 1.4.2. **These scripts and docs were not executed on that PC as part of this change.**

## Prerequisites

| Tool | Why | How |
|---|---|---|
| [Git for Windows](https://git-scm.com/download/win) | Clone and updates | Installer; enable "Git from the command line" |
| [Bun](https://bun.sh) 1.3+ | Runtime, package manager, production server | `irm https://bun.sh/install.ps1 \| iex` → `%USERPROFILE%\.bun\bin\bun.exe` |

You do **not** need Docker Desktop, WSL, Visual Studio, or Python for the path that already succeeded: `bun install`, `bun run build`, `bun run start`, Queenie onboarding.

**Optional, only if a native addon fails to compile on your machine:**

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload (provides `node-gyp`, `vswhere`, MSVC). See [Troubleshooting](#troubleshooting).

**Optional, only if you want Agent browser tools** (`browse_url` / `screenshot_url` / `browser_*`):

- Playwright Chromium: `bunx playwright install chromium`. Not required for the HTTP server or first-run Queenie onboarding.

## Quick start (scripts)

From a PowerShell window in the clone:

```powershell
# If scripts are blocked (ExecutionPolicy):
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# or invoke each file with:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-Hivekeep.ps1

.\scripts\windows\Install-Hivekeep.ps1
.\scripts\windows\Start-Hivekeep.ps1
```

Then open `http://localhost:3000`.

Idempotent re-run of install is safe (Bun is reused, `.env` is updated in place, the data directory is created if missing).

Optional timezone when creating `.env`:

```powershell
.\scripts\windows\Install-Hivekeep.ps1 -Timezone America/Chicago
```

## Manual install (same commands the scripts wrap)

### 1. Install Bun

```powershell
irm https://bun.sh/install.ps1 | iex
```

Expected: Bun under `%USERPROFILE%\.bun\bin\bun.exe` (example: 1.4.2).

**PATH:** the installer updates your **user** PATH. If `bun` is not found in the same window:

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
bun --version
```

Open a new terminal for a permanent PATH. `Install-Hivekeep.ps1` also appends `%USERPROFILE%\.bun\bin` to the user PATH when needed.

### 2. Clone

```powershell
git clone https://github.com/MarlBurroW/hivekeep.git
cd hivekeep
```

Use your fork URL if that is what you are running.

### 3. `bun install`

```powershell
$env:HUSKY = '0'   # optional; skips the git prepare hook
bun install
```

Packages install (on the order of ~1100+). **husky** runs from `package.json` `"prepare": "husky"` and may write to **stderr**. PowerShell can then show **exit code 1 even when `node_modules` is complete**. If `node_modules` exists, continue. The install script sets `HUSKY=0` so the hook is skipped on this runtime path.

### 4. Production frontend build

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=6144'
bun run build
```

`package.json` defines `"build": "NODE_OPTIONS=--max-old-space-size=6144 vite build"`. Bun on Windows has been observed to honor that Unix-style prefix; setting `NODE_OPTIONS` in PowerShell is the safer equivalent. Success is `dist\client\index.html`. Vite may take about a minute. PowerShell may again report exit 1 from stderr noise; trust the output files.

The production server (`src/server/main.ts`) serves `./dist/client` when `NODE_ENV=production`.

### 5. `.env` and data directory

```powershell
copy .env.example .env
```

Minimum useful values (see [`.env.example`](../.env.example) and [`config.md`](../config.md)):

| Variable | Suggested | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | This machine only. Use `0.0.0.0` to reach Hivekeep from other devices on the LAN |
| `PUBLIC_URL` | `http://localhost:3000` | Links, webhooks, CORS defaults |
| `HIVEKEEP_DATA_DIR` | `%LOCALAPPDATA%\Hivekeep` or a folder you choose | SQLite, uploads, workspaces, `.encryption-key` |
| `NODE_ENV` | `production` | Serves the Vite build |
| `HIVEKEEP_TIMEZONE` | e.g. `America/Chicago` | Optional. IANA name for cron interpretation |

The code default for `HIVEKEEP_DATA_DIR` is `./data` (repo-relative). The Windows install script defaults to `%LOCALAPPDATA%\Hivekeep` so a `git clean` does not wipe the database. Either works. Create the folder if you set an absolute path.

**Do not** put secrets in the prompt. `ENCRYPTION_KEY` is auto-generated on first boot and stored at `$HIVEKEEP_DATA_DIR/.encryption-key`. Back up that file (or the whole data directory) or vault secrets become unreadable.

### 6. Start

```powershell
bun run start
```

That is `bun src/server/index.ts`. On a healthy boot you should see logs for:

1. SQLite opened (`HIVEKEEP_DATA_DIR` / `DB_PATH`, default `hivekeep.db`)
2. Drizzle migrations
3. FTS5 + sqlite-vec virtual tables
4. `Hivekeep server started` on `PORT` / `HOST`

`bun run db:migrate` is **not** required before first start: `main.ts` runs migrations itself. The standalone migrate script exists for maintenance.

### 7. Verify

In a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
Invoke-RestMethod http://127.0.0.1:3000/api/onboarding/status
```

Healthy first boot (shapes from `src/server/app.ts` and `src/server/routes/onboarding.ts`):

```json
{
  "status": "ok",
  "version": "1.10.0",
  "uptime": 12,
  "timestamp": 1730000000000
}
```

```json
{
  "completed": false,
  "hasAdmin": false,
  "hasLlm": false,
  "hasEmbedding": false
}
```

`completed` / `hasAdmin` stay false until the first admin user exists. Open `http://localhost:3000` and finish Queenie onboarding there. Both routes are unauthenticated (`/api/health` and `/api/onboarding/*`).

After an admin exists, anonymous `/api/onboarding/status` only returns `{ "completed": true, "hasAdmin": true }`.

## What the process actually uses

| Piece | Runtime role on this path |
|---|---|
| **Bun + `bun:sqlite`** | Database. This is what `src/server/db/index.ts` opens |
| **`better-sqlite3`** | Listed in `package.json` because drizzle-kit historically wanted it. **`scripts/migrate.ts` and the server do not use it.** A `node-gyp` failure is a risk, not a proven blocker |
| **`sqlite-vec`** | Loaded via `getLoadablePath()` + `loadExtension`. If it fails, boot continues and vector search is disabled (FTS5 still works) |
| **Playwright** | Dependency for Agent browser tools. Chromium is launched lazily; **boot does not download browsers** |
| **husky** | `prepare` hook for git commits. Irrelevant to running the server |

## Task Scheduler (Windows-native service)

There is no systemd, launchd, or `services.msc` Windows Service in this path. Use **Task Scheduler**:

```powershell
# Start when you log on (default):
.\scripts\windows\Register-HivekeepService.ps1

# Or register a task you start by hand:
.\scripts\windows\Register-HivekeepService.ps1 -OnDemand

# Start / stop the task:
Start-ScheduledTask -TaskName Hivekeep
Stop-ScheduledTask -TaskName Hivekeep

# Same stop helper also kills a detached bun started by Start-Hivekeep.ps1:
.\scripts\windows\Stop-Hivekeep.ps1
```

The task runs `Start-Hivekeep.ps1 -Foreground` as your user (`LogonType Interactive`). It does **not** start at boot before anyone logs in, and it does not store a password for "run whether user is logged on or not."

### Unregister

```powershell
.\scripts\windows\Register-HivekeepService.ps1 -Unregister

# equivalent:
Unregister-ScheduledTask -TaskName Hivekeep -Confirm:$false
```

Unregister does not delete the git checkout, `node_modules`, or `$HIVEKEEP_DATA_DIR`.

## Updating

On this path, `install.sh --update` is unused. Typical upgrade:

```powershell
.\scripts\windows\Stop-Hivekeep.ps1
git pull
.\scripts\windows\Install-Hivekeep.ps1
.\scripts\windows\Start-Hivekeep.ps1
```

The in-app updater is built around `install.sh` / systemd / launchd / Docker. Treat it as unproven on native Windows ([`windows-gaps.md`](windows-gaps.md)).

## Troubleshooting

### `bun` is not recognized after install

1. `$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"`
2. Confirm `Test-Path $env:USERPROFILE\.bun\bin\bun.exe`
3. New terminal (user PATH refresh)
4. Re-run `Install-Hivekeep.ps1` (it writes the Bun directory into the user PATH)

### PowerShell exit code 1 after a successful `bun install` or `bun run build`

Husky and some Node tools write to stderr. Windows PowerShell surfaces that as a failing native command. **Check artifacts**, not `$LASTEXITCODE` alone:

- install: `node_modules` present
- build: `dist\client\index.html` present

`Install-Hivekeep.ps1` does exactly that. You can also set `$env:HUSKY = '0'` before `bun install`.

### `better-sqlite3` / `node-gyp` / missing `vswhere`

A reported Win11 run completed **without** Visual Studio Build Tools. If *your* `bun install` dies compiling `better-sqlite3` (or another native addon):

1. Install [VS Build Tools 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe)
2. Select **Desktop development with C++**
3. Or via winget:

   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

4. Open a **new** PowerShell, `cd` to the repo, `bun install` again

The running server still talks to SQLite through **bun:sqlite**. This step is only to satisfy the npm dependency graph on machines that insist on compiling the addon.

### `sqlite-vec` warning at startup

Log line: `sqlite-vec extension not available — vector search will be disabled` (or virtual table creation failed). The process still starts. Hybrid memory falls back to FTS5. Confirm the `sqlite-vec` package extracted a Windows loadable under `node_modules`. Re-run `bun install`. File an issue with the exact log if the prebuild is missing for your arch.

### Playwright / browser tools fail

Expected until you install a browser:

```powershell
bunx playwright install chromium
```

Optional: set `PLAYWRIGHT_BROWSERS_PATH` to a folder you control. Server + Queenie onboarding do **not** need this.

### Port already in use

```powershell
netstat -ano | findstr :3000
# or
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
```

Stop the other process, or set `PORT=3001` (and matching `PUBLIC_URL`) in `.env`.

### UI is a blank API / 404 on `/`

`NODE_ENV` is not `production`, or `bun run build` never produced `dist/client`. Rebuild and restart.

### Encryption key / vault

First start prints that it generated `ENCRYPTION_KEY` in the data directory. If you later point `HIVEKEEP_DATA_DIR` at an empty folder, Hivekeep mints a **new** key and cannot decrypt the old vault. Keep data dir + `.encryption-key` together.

## Agent command line (Windows-first)

Every Agent sees an **Environment** block that this host is Windows 11 and that **`run_shell` defaults to PowerShell** (`pwsh` when installed, otherwise Windows PowerShell 5.1). File reads still go through `read_file` / `grep` / `list_directory`, not `Get-Content` / `Select-String`.

- Optional `shell` on `run_shell`: `powershell` | `pwsh` | `cmd` | `bash` (Git Bash).
- Built-in **`windows` toolbox**: host diagnostics (`get_system_info`), `http_request`, and web docs around that core shell. Grant it to Windows-ops specialists; do not assign it to every Agent just to "get a command line" — that is already on the core floor.
- PATH for spawned commands is augmented with `%USERPROFILE%\.bun\bin`, Git for Windows, WinGet links, and `HIVEKEEP_AUGMENT_PATH` (semicolon-separated on Windows).
- In-app Terminal defaults to PowerShell as well (`HIVEKEEP_TERMINAL_SHELL` to override).

## MCP servers on Windows

**Remote HTTP MCP** (Settings → MCP Servers → Remote URL) is the path that does not need a local Node toolchain, `npx`, WSL, or Docker. Hivekeep connects with the official Streamable HTTP transport (or legacy SSE). See [MCP](../docs-site/src/content/docs/features/mcp.md) and [docs/mcp-http.md](mcp-http.md).

Local stdio MCP (`npx …`) can still work if those tools are on PATH, but it is the awkward path on native Windows.

## Script reference

| Script | Role |
|---|---|
| [`scripts/windows/Install-Hivekeep.ps1`](../scripts/windows/Install-Hivekeep.ps1) | Bun, `bun install`, `bun run build`, `.env`, data dir |
| [`scripts/windows/Start-Hivekeep.ps1`](../scripts/windows/Start-Hivekeep.ps1) | Detached `bun src/server/index.ts` (or `-Foreground`) |
| [`scripts/windows/Stop-Hivekeep.ps1`](../scripts/windows/Stop-Hivekeep.ps1) | Stop bun + optional scheduled task |
| [`scripts/windows/Register-HivekeepService.ps1`](../scripts/windows/Register-HivekeepService.ps1) | Task Scheduler register / `-Unregister` |
| [`scripts/windows/HivekeepCommon.ps1`](../scripts/windows/HivekeepCommon.ps1) | Shared helpers (dot-sourced; do not run alone) |

```powershell
Get-Help .\scripts\windows\Install-Hivekeep.ps1 -Detailed
```

## See also

- [Known gaps](windows-gaps.md)
- [Configuration](../config.md)
- [Starlight: Installation](../docs-site/src/content/docs/getting-started/installation.md)
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (Linux/macOS-oriented; Windows notes above take precedence on this OS)
