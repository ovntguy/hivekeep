#!/usr/bin/env bash
# Cloud Agent bootstrap for Hivekeep.
# Idempotent: safe to run repeatedly and against cached/snapshot state.
set -euo pipefail

# Hivekeep runs on Bun (>= 1.3). The default Cloud Agent image ships Node,
# git, curl and the C toolchain (python3/make/g++) that better-sqlite3's
# node-gyp build needs, but not Bun, so install it here.
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Expose bun on the default PATH for every future (non-login) shell without
# mutating shell profiles. Best-effort: skip silently if sudo is unavailable.
if command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun 2>/dev/null || true
  sudo ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx 2>/dev/null || true
fi

# Install workspace dependencies from the committed lockfile.
bun install --frozen-lockfile

# Prepare the local SQLite database (creates ./data and applies migrations).
bun run db:migrate

echo "Hivekeep install complete: $(bun --version)"
