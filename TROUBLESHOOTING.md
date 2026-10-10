# Troubleshooting

Common issues and solutions when running Hivekeep.

## Installation

### `better-sqlite3` build fails (node-gyp errors)

Hivekeep uses `better-sqlite3` which requires native compilation. If the install fails with `node-gyp` errors:

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install python3 make g++
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install python3 make gcc-c++
```

**macOS:**
```bash
xcode-select --install
```

Then retry `bun install`.

**Windows 11:** a native Bun install can succeed without Visual Studio Build Tools. If `node-gyp` / `vswhere` / `better-sqlite3` **does** fail on your machine, install VS Build Tools with the C++ workload (see [docs/windows.md](docs/windows.md#better-sqlite3--node-gyp--missing-vswhere)). The running server uses `bun:sqlite`, not `better-sqlite3`. Full Windows runbook: [docs/windows.md](docs/windows.md).

### `bun install` hangs or fails on lockfile

If you see errors about `bun.lock`:

```bash
rm -rf node_modules bun.lock
bun install
```

### Permission denied during install

Don't run the installer with `sudo`. If you previously did:

```bash
sudo chown -R $(whoami) /path/to/hivekeep
bun install
```

## Startup

### Port already in use (`EADDRINUSE`)

Another process is using the port (default 3000):

```bash
# Find what's using the port
lsof -i :3000

# Use a different port
PORT=4000 bun run start
```

### Database migration errors

If Hivekeep fails to start with database errors after an update:

```bash
bun run db:migrate
```

If that fails, the database may be corrupted. Check if you have a backup in your data directory. As a last resort:

```bash
# Back up first!
cp data/hivekeep.db data/hivekeep.db.bak
# Then try migrating again
bun run db:migrate
```

### `ENCRYPTION_KEY` warnings

Hivekeep auto-generates an encryption key on first run and stores it in a file at `$HIVEKEEP_DATA_DIR/.encryption-key` (alongside your database). Secrets are encrypted at rest with it (AES-256-GCM). If you see warnings about the encryption key:

- **Don't change it** after initial setup, or vault entries become unreadable
- **Back up `.encryption-key` together with your database.** A database restored without its matching key cannot decrypt stored API keys or vault secrets
- If migrating to a new server, copy the entire `data/` directory (this includes `.encryption-key`)
- To pin it explicitly for portability, set it in the environment before first start: `ENCRYPTION_KEY=$(openssl rand -hex 32)`, or reuse the existing one: `ENCRYPTION_KEY=$(cat $HIVEKEEP_DATA_DIR/.encryption-key)`

## Memory & Vector Search

### "sqlite-vec extension not available"

Vector search (semantic memory) requires the `sqlite-vec` extension. If you see this warning:

- Hivekeep still works, but memory recall falls back to full-text search only
- The extension is bundled automatically on most platforms
- On Alpine Linux or unusual architectures, it may not be available

### Memory not being recalled

If your Agent seems to forget things:

1. Check that an **embedding provider** is configured (e.g., OpenAI with `text-embedding-3-small`)
2. Verify the provider has the `embedding` capability in Settings > Providers
3. Check `MEMORY_SIMILARITY_THRESHOLD` (default `0.7`) — lower it if memories aren't matching
4. Check `MEMORY_MAX_RELEVANT` (default `10`) — increase for more context

## Channels

### Telegram webhook not receiving messages

1. Ensure `PUBLIC_URL` is set to your externally-accessible URL (with HTTPS)
2. The URL must be reachable from Telegram's servers
3. Check logs for "Error handling Telegram update" messages
4. Verify the bot token in channel settings

### Discord bot not responding

1. Check that the bot has the required intents enabled in the [Discord Developer Portal](https://discord.com/developers/applications):
   - **Message Content Intent** (required for reading messages)
   - **Server Members Intent** (if using member features)
2. Verify the bot token in channel settings
3. Check logs for WebSocket connection errors

### WhatsApp webhook verification failing

1. Ensure the **Verify Token** matches between Meta's webhook config and Hivekeep's channel settings
2. `PUBLIC_URL` must be HTTPS and reachable from Meta's servers
3. Check logs for "Webhook verification token mismatch"

### Signal messages not arriving

1. Verify `signal-cli` REST API is running and accessible
2. Check the API URL in channel settings (default: `http://localhost:8080`)
3. Ensure the phone number is registered with Signal

## Docker

### Container starts but can't access the UI

```bash
# Verify the container is running
docker ps | grep hivekeep

# Check logs
docker logs hivekeep

# Ensure you're mapping the port correctly
docker run -p 3000:3000 ...
```

### Data persistence across container restarts

Always mount a volume for the data directory:

```bash
docker run -v hivekeep-data:/app/data ...
```

Without this, all data (database, uploads, workspaces) is lost when the container is removed.

### Docker build fails on ARM (Raspberry Pi)

The multi-arch image supports `linux/amd64` and `linux/arm64`. For Raspberry Pi:

```bash
# Pull the arm64 image
docker pull ghcr.io/marlburrow/hivekeep:latest

# Or build locally
docker build -f docker/Dockerfile .
```

## Performance

### High memory usage

- **Session compacting** reduces context size — check `COMPACTING_THRESHOLD_PERCENT` and `COMPACTING_KEEP_PERCENT`
- Reduce `MEMORY_MAX_RELEVANT` if too many memories are injected per turn
- Lower `WEB_BROWSING_MAX_CONCURRENT` and `WEB_BROWSING_MAX_BROWSERS` if web browsing is active

### Slow responses

1. Check your LLM provider's status page
2. If using Ollama locally, ensure your hardware can handle the model size
3. Reduce `TOOLS_MAX_STEPS` if the agent is making too many tool calls
4. Check `QUEUE_POLL_INTERVAL` — the default (500ms) is fine for most setups

## Logs

Enable debug logging for more detail:

```bash
LOG_LEVEL=debug bun run start
```

For Docker:

```bash
docker run -e LOG_LEVEL=debug ...
```

## Diagnostic Report

The installer includes a `--doctor` command that generates a comprehensive diagnostic report covering your system, Hivekeep installation, runtime, providers, and database health:

```bash
bash install.sh --doctor
```

This outputs a Markdown report you can paste directly into a GitHub issue. To save it to a file:

```bash
bash install.sh --doctor > report.md
```

The report includes:
- System info (OS, kernel, memory, disk, container detection)
- Bun and Git versions
- Hivekeep installation status, version, and configuration
- Service health (systemd/launchd/Docker)
- Database integrity and stats
- Provider configuration summary
- Recent log entries

## Viewing Logs

The installer also provides a cross-platform way to tail Hivekeep logs:

```bash
bash install.sh --logs
```

This works whether Hivekeep is running via systemd, launchd, or Docker.

## Still stuck?

- Run `bash install.sh --doctor` and include the output
- Check [existing issues](https://github.com/MarlBurroW/hivekeep/issues) for similar problems
- Open a [new issue](https://github.com/MarlBurroW/hivekeep/issues/new/choose) with:
  - Diagnostic report (`bash install.sh --doctor`)
  - Steps to reproduce
  - Any additional log output
