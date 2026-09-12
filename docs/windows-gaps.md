# Hivekeep on Windows 11 — known gaps

Honest list for the **native Bun** path (`docs/windows.md`, `scripts/windows/`). This is not a promise that every Hivekeep feature matches Linux/macOS/`install.sh`.

These scripts and docs were **not** executed on the physical Windows 11 PC that originally proved `bun install` / `bun run build` / `bun run start`. Treat that run as community experience; treat this file as inventory against the current code.

## Installer and packaging

| Gap | Detail |
|---|---|
| Official `install.sh` is unused | Bash one-liner: Bun (if needed), clone, build, migrations, **systemd or launchd**, optional Playwright Chromium. It does not run on native PowerShell. Do not pipe it through Git Bash and expect a supported Windows service. |
| No Docker / WSL in this path | By design. Docker Desktop and WSL2 remain possible on Windows; they are a different install story. |
| Marketing site still says "use WSL2 or Docker" | `site/` locale strings still tell Windows users the native installer will not run. This repo path exists; the marketing copy was not rewritten in the same change (10 locales). |
| In-app / `install.sh --update` | Self-update and rollback assume a managed install (systemd, launchd, Docker, or the bash start/stop fallback). On native Windows the supported upgrade is `git pull` + `Install-Hivekeep.ps1`. |
| `InstallationType` has no Windows value | `src/server/config.ts` detects `docker`, `launchd`, `systemd-*`, else `manual`. A Task Scheduler install reports **`manual`**. Queenie / platform-config tools that print systemd unit paths will be wrong. |
| No `services.msc` service | `Register-HivekeepService.ps1` uses **Task Scheduler** (at logon or on demand). It does not install a Windows Service (SCM), NSSM, or WinSW. The task does not start at boot before logon. |

## Tooling and exit codes

| Gap | Detail |
|---|---|
| PowerShell + stderr | `bun install` / `bun run build` may print to stderr (husky, vite). Windows PowerShell then reports **exit code 1** even when the work succeeded. Judge `node_modules` and `dist\client\index.html`. |
| husky `prepare` | `"prepare": "husky"` is a contributor hook. It is skipped by `Install-Hivekeep.ps1` (`HUSKY=0`). Developers who want hooks can run `bunx husky`. `.husky/pre-commit` is a POSIX `sh` script (`bun run typecheck` / `bun run test`) and is not the production start path. |
| `bun run test` | `package.json` `test` script uses Unix `find`. That is a **contributor** gap on Windows, not a server-onboarding blocker. |
| Unix-style `NODE_OPTIONS=...` in npm scripts | `build` and `typecheck` use env prefixes. Bun on Windows has been observed to accept them; the install script also sets `NODE_OPTIONS` in the PowerShell environment. |

## Native addons (risk, not always fatal)

| Gap | Detail |
|---|---|
| Visual Studio Build Tools | A Win11 run completed **without** VS Build Tools / `vswhere`. Other machines may still fail `node-gyp` while compiling **`better-sqlite3`** (or another addon). Install the C++ Build Tools workload if `bun install` errors on compile. Runtime I/O is **bun:sqlite**, not better-sqlite3. |
| `sqlite-vec` | Prebuilds usually load via `getLoadablePath()`. If `loadExtension` throws, the server **keeps running** and logs that vector search is disabled. FTS5 still works. |
| `bun-pty` | In-app **Terminal** (`src/server/services/terminal-sessions.ts`) uses `bun-pty` and defaults to `/bin/bash`. Native Win11 PTY / `cmd.exe` / PowerShell behavior is **unproven**. Disable with `HIVEKEEP_TERMINAL_ENABLED=false` if it misbehaves. |
| Other native extras | Channel stacks (for example WhatsApp Web / Signal) may pull extra optional binaries. Not required for first boot. |

## Playwright (optional / feature gap)

| Gap | Detail |
|---|---|
| Browsers are not installed | `playwright` is a dependency. `install.sh` best-effort installs Chromium; **Windows scripts do not.** |
| Boot does not need browsers | `playwright-manager` launches Chromium lazily. `/api/health` and Queenie onboarding work without `playwright install`. |
| Browser tools fail until Chromium exists | `browse_url`, `screenshot_url`, and `browser_*` need `bunx playwright install chromium` (and a working GPU/sandbox config on some hosts). |

## Product behavior vs Linux install

| Gap | Detail |
|---|---|
| PATH for Agent `run_shell` | Server `PATH` augmentation in `src/server/services/system-context.ts` is colon-separated and Unix-home oriented. Windows Agents may not see the same extra bins. |
| `HOST=127.0.0.1` | Same as `.env.example`. LAN access needs `0.0.0.0` and a matching `PUBLIC_URL`. |
| Cron timezone | Set `HIVEKEEP_TIMEZONE` to an IANA name (`America/Chicago`). Windows display names are not mapped automatically. |
| Contributor pre-commit | Relies on `sh` + Bun on PATH. Fine in Git Bash; not required to **run** Hivekeep. |
| Local stdio MCP (`npx`) | Still needs a host binary / npm on PATH. **Remote HTTP/SSE MCP** is supported (Streamable HTTP preferred) and does not need WSL or Docker. |

## What is in scope for this path

- Git clone + native Bun 1.x
- `bun install` / `bun run build` / `bun run start`
- `.env` + data directory + auto `ENCRYPTION_KEY`
- `GET /api/health` and first-run `GET /api/onboarding/status`
- Queenie UI at `http://localhost:3000`
- Optional Task Scheduler task (logon or on-demand)

If something above is a hard requirement for you (Playwright browsers, Windows Service SCM, in-app updater, marketing-site copy), it is not delivered by `scripts/windows/` today.
