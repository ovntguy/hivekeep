---
title: Installation
description: Get Hivekeep running in under a minute.
---

Hivekeep runs as a single process with an embedded SQLite database. No Postgres, no Redis, no external dependencies.

## Docker (recommended)

```bash
docker run -d --name hivekeep \
  -p 3000:3000 \
  -v hivekeep-data:/app/data \
  ghcr.io/marlburrow/hivekeep:latest
```

Open `http://localhost:3000` and Queenie, your setup guide, handles the rest.

## One-liner script (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh | bash
```

This will:
1. Install [Bun](https://bun.sh) if not present
2. Clone the repository to `/opt/hivekeep`
3. Install dependencies and build the frontend
4. Run database migrations
5. Create a system service (systemd on Linux, launchd on macOS)
6. Start Hivekeep on port **3000**

### Customizing the install

```bash
HIVEKEEP_DIR=/home/me/hivekeep \
HIVEKEEP_DATA_DIR=/home/me/hivekeep-data \
HIVEKEEP_PORT=8080 \
  bash <(curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh)
```

## Docker Compose

```bash
git clone https://github.com/MarlBurroW/hivekeep.git
cd hivekeep/docker
ENCRYPTION_KEY=$(openssl rand -hex 32) docker compose up -d
```

See [`docker/docker-compose.yml`](https://github.com/MarlBurroW/hivekeep/blob/main/docker/docker-compose.yml) for all options.

## Windows 11 (native Bun, no WSL)

The bash `install.sh` one-liner is Linux and macOS only. On Windows 11 you can install and run Hivekeep with **native Bun** (no WSL, no Docker):

1. Install [Git for Windows](https://git-scm.com/download/win) and [Bun](https://bun.sh) (`irm https://bun.sh/install.ps1 | iex`).
2. Clone this repository and, from PowerShell:

```powershell
.\scripts\windows\Install-Hivekeep.ps1
.\scripts\windows\Start-Hivekeep.ps1
```

3. Open `http://localhost:3000`. Confirm `GET /api/health` and first-run `GET /api/onboarding/status` (`completed: false` until an admin exists).

Optional: register a **Task Scheduler** task (at logon or on demand) with `.\scripts\windows\Register-HivekeepService.ps1`. That is not systemd, Docker, or WSL.

Full runbook, `.env` / data-dir notes, and troubleshooting (husky exit codes, `better-sqlite3`, `sqlite-vec`, Playwright, PATH): **[docs/windows.md](https://github.com/MarlBurroW/hivekeep/blob/main/docs/windows.md)** in the repository. Honest limitations: **[docs/windows-gaps.md](https://github.com/MarlBurroW/hivekeep/blob/main/docs/windows-gaps.md)**. Playwright browsers are **not** required for the server or Queenie onboarding.

## Manual install

```bash
git clone https://github.com/MarlBurroW/hivekeep.git
cd hivekeep
bun install
bun run build
bun run db:migrate
NODE_ENV=production bun run start
```

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Git
- Windows 11 native path: see [Windows 11 (native Bun)](#windows-11-native-bun-no-wsl) above

## What's next?

Head to [First Agent](/docs/getting-started/first-agent/) to create your first AI agent.

Already installed? See [Updating Hivekeep](/docs/getting-started/updating/) for the in-app updater, update channels, and automatic rollback.
