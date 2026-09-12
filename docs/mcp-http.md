# HTTP MCP client (Hivekeep as MCP client)

Hivekeep already spoke MCP over **stdio**. It now also connects to **remote** MCP servers using the official TypeScript SDK transports. No private protocol.

## Transports

| Value stored in `mcp_servers.transport` | SDK class | When to use |
|---|---|---|
| `stdio` (default) | `StdioClientTransport` | Local command (`npx`, a binary). Unchanged. |
| `http` | `StreamableHTTPClientTransport` | Current MCP remote transport (preferred). |
| `sse` | `SSEClientTransport` | Older remote servers that only speak SSE. |

The user (or `add_mcp_server`) picks the transport. There is no auto-detect.

`@modelcontextprotocol/sdk` is already **1.29** in `bun.lock` (`package.json` range `^1.26.0`). Streamable HTTP and SSE ship in that version; this change does **not** require an SDK bump.

## Schema

`mcp_servers` gains `transport`, `url`, and `headers` (JSON). `command` stays NOT NULL for a simple ALTER migration; HTTP/SSE rows store an empty command. Env (stdio) and headers (remote) are redacted on read, same merge-on-empty-value rule.

## Disconnect

stdio: `client.close()` then `killProcessTree(pid)`.
HTTP/SSE: `client.close()` only. No process tree.

## Gaps (not in this change)

- MCP OAuth (authorization code, dynamic client registration, token refresh)
- Mutual TLS / custom CA beyond what the runtime `fetch` already trusts
- WebSocket or other unofficial transports
- MCP resources, prompts, sampling, completions (tools only, same as stdio)
- Auto-fallback from Streamable HTTP to SSE on 4xx/405
- Per-call header overrides; headers are static per server

See `docs-site/src/content/docs/features/mcp.md` for the user-facing write-up (including Windows).
