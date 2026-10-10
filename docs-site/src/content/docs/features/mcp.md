---
title: MCP, Model Context Protocol
description: "Connect external MCP servers to Hivekeep so their tools become callable by your Agents, with global scope, toolbox-based granting, and approval controls."
---

The Model Context Protocol (MCP) is an open standard for exposing tools to an LLM through a small server. Hivekeep can act as an MCP **client**: you register external MCP servers, Hivekeep connects to them, discovers the tools they expose, and makes those tools callable by your Agents alongside Hivekeep's own native tools.

This lets you bolt on capabilities Hivekeep does not ship with, a filesystem server, a database server, a third-party API wrapper, without writing a plugin, as long as the capability already exists as an MCP server.

## How the connection works

Hivekeep speaks the official MCP TypeScript SDK transports. A registered server is one of:

- **Local command (stdio)**: Hivekeep runs an executable on the same host and talks to it over standard input and output.
- **Remote URL (Streamable HTTP)**: Hivekeep connects to an `http(s)://` endpoint using `StreamableHTTPClientTransport` (the current MCP remote transport).
- **Remote URL (SSE, legacy)**: same idea, using `SSEClientTransport` for older servers that have not moved to Streamable HTTP yet.

A server is defined by:

- **name**: a display name (also used to derive the tool prefix).
- **transport**: `stdio`, `http`, or `sse`.
- **command / args / env** (stdio): the executable, arguments, and environment variables (merged on top of Hivekeep's own environment). Env values are stored and never sent back to the frontend; the UI only shows which keys exist.
- **url / headers** (http and sse): the remote endpoint and optional HTTP headers (bearer token, API keys). Header values are stored and redacted the same way as env.

On first use Hivekeep opens the transport, performs the MCP handshake (with a 30-second connection timeout), and calls the server's `listTools` to learn what it offers. Connections are pooled and reused; one live connection per server. Individual tool calls have a 2-minute timeout, and if a call fails because the connection died, Hivekeep reconnects once and retries.

:::note
Remote HTTP is especially useful on **Windows 11 native** installs, where local `npx` MCP servers are awkward. You do not need WSL or Docker for a hosted Streamable HTTP / SSE server. Hivekeep still supports stdio when you do have a local binary.
:::

When Hivekeep shuts down it closes every pooled connection. For **stdio** it also terminates the whole process tree of each server. HTTP and SSE connections have no process tree, so they are only closed, never `kill`ed.

## Registering a server

You manage MCP servers from the app (Settings). Pick **Local command** or **Remote URL**, fill in command/args/env or URL/headers, then save.

A typical local example, registering the official filesystem server:

- **name**: `Filesystem`
- **transport**: `stdio`
- **command**: `npx`
- **args**: `["-y", "@modelcontextprotocol/server-filesystem", "/data/shared"]`

A typical remote example:

- **name**: `Hosted tools`
- **transport**: `http` (Streamable HTTP) or `sse` if the server is still on the older transport
- **url**: `https://mcp.example.com/mcp`
- **headers** / bearer token: optional `Authorization: Bearer …` or other API-key headers

After registering you can check the connection status or run a fresh connection test from the UI; the test evicts any cached connection and reconnects so you see the live result and the number of tools discovered.

Servers have a status. An `active` server contributes its tools; a `pending_approval` server contributes nothing until approved (see below). Editing a server's connection settings (command, args, env, url, headers, or transport) disconnects it so the next call reconnects with the new configuration.

## How the tools surface to Agents

Once a server is active, each of its tools is exposed under a stable, sanitised name:

```
mcp_<server-name>_<tool-name>
```

For example a `read_file` tool on a server named `Filesystem` becomes `mcp_filesystem_read_file`. Names are lowercased and non-alphanumeric characters are collapsed to underscores, so the prefix stays stable even if the server name has spaces or punctuation.

MCP servers are **global**: their tools live in the shared tool universe with no per-Agent access gate, and their credentials stay global. Granting works through **toolboxes**, Hivekeep's single tool-grant mechanism. To let a specific Agent call an MCP tool, add that tool's `mcp_*` name to a toolbox attached to the Agent.

:::caution
The catch-all `all` toolbox expands to every **native** tool (plus enabled custom tools), but it does **not** automatically include MCP tools. MCP (and plugin) tools must be listed by their stable name in a toolbox to be granted. So even with the `all` toolbox, an Agent will not call `mcp_filesystem_read_file` unless that name is explicitly in one of its toolboxes.
:::

When an Agent has MCP tools available, its system prompt includes a short summary listing each external server and how many tools it provides, so the Agent knows the tools exist and can call them like any other tool. The Agent calls them by name; Hivekeep forwards the call to the server and returns the result (text content is extracted and passed back to the Agent).

## Agents that manage MCP themselves

Agents can also create and manage MCP servers through tools, not just admins through the UI:

| Tool | What it does |
|---|---|
| `add_mcp_server` | Register a new server (name, transport, command/args/env or url/headers). It is auto-linked to the calling Agent. |
| `update_mcp_server` | Change a server's name or connection settings (env and headers are merged with existing values). |
| `remove_mcp_server` | Delete a server, disconnect it, and remove it from all Agents. |
| `list_mcp_servers` | List every server on the platform with transport, command or URL, and status. |

## Approval

Letting an Agent add an MCP server is sensitive: stdio runs an arbitrary local command, and HTTP servers receive whatever headers you store. The `MCP_REQUIRE_APPROVAL` setting (default **true**) controls this: when on, a server created by an Agent via `add_mcp_server` starts in `pending_approval` and contributes no tools until an admin approves it from the UI. Hivekeep also raises a persistent notification so you know a server is waiting. Set `MCP_REQUIRE_APPROVAL=false` to let Agent-created servers become active immediately (only do this if you trust what your Agents will register).

## Limits and behaviour to expect

- **Transports.** stdio, Streamable HTTP (`http`), and legacy SSE (`sse`). There is no auto-detect: pick the transport the server actually speaks. WebSocket and other unofficial transports are not supported.
- **Auth.** Optional static headers and a bearer token (stored as `Authorization`). Hivekeep does **not** implement the MCP OAuth authorization-code flow, dynamic client registration, or rotating tokens. If the remote server requires an interactive OAuth handshake, it will not connect from Hivekeep today.
- **Secrets.** Env (stdio) and headers (HTTP/SSE) are stored on the server and redacted in the API and UI. They are not vault entries; they follow the same empty-value-preserves-secret merge as stdio env.
- **Tools only.** Hivekeep consumes the MCP `listTools` and `callTool` surface. Resources, prompts, sampling, and completions are not exposed. Tool inputs are converted from the server's JSON Schema into the internal schema Agents call against; unusual or deeply nested schemas may be simplified, and unknown shapes fall back to accepting any object.
- **Timeouts.** 30 seconds to connect (including `listTools`), 2 minutes per tool call. A failed call triggers one reconnect-and-retry before returning an error to the Agent.
- **Process cleanup.** stdio servers are killed as a process tree on disconnect or shutdown. HTTP/SSE connections are only closed.
- **Granting is explicit.** Servers are global, but a tool is only callable by an Agent whose toolbox lists that tool's `mcp_*` name.
- **SDK.** Hivekeep uses `@modelcontextprotocol/sdk` (1.29 in the lockfile). Streamable HTTP and SSE are the official client transports from that package; no private protocol.

## Web search backend

Native `web_search` is not limited to Brave / Tavily / SerpAPI / Perplexity / SearXNG. Under **Settings → Providers** you can add type **MCP** and point it at one tool on one of your registered MCP servers. `web_search` (and `list_search_providers`) then treat that row like any other search provider: it can be the global default, or selected by `provider_slug`.

This reuses the existing MCP connection pool, `listTools`, and `callTool` path (30 s connect, 2 min call, one reconnect). No third-party search MCP is hardcoded; any server whose tool qualifies works.

### Which tools qualify

A tool can back `web_search` when all of the following hold:

1. The server is **active** and Hivekeep can complete the MCP handshake.
2. The tool exists on that server. The config accepts the raw MCP name (`web_search`), a sanitised name, or the grant name `mcp_<server>_<tool>`.
3. Hivekeep can identify a **query argument**:
   - the optional `queryArg` config field, or
   - a string property named like `query`, `q`, `search`, `search_query`, `keywords`, `question`, `objective`, `prompt`, `text`, or `input`, or
   - a string-array property named like `search_queries`, `searchQueries`, `queries`, or `keyword_queries`.
     Non-standard names (`topic`, …) need `queryArg`. Hivekeep does not treat an arbitrary required string (`path`, `file`) as a query. Setting `queryArg` to `q` does nothing on a tool that has no `q` — leave it blank and let auto-detect run.
4. Every **required** input is either that query argument or another field `web_search` already knows how to fill (`count` / `max_results` / `limit`, `freshness` / `time_range`, `lang` / `language`, `location` / `country`, include/exclude domains, `answer` / `include_answer`, companion query fields such as `objective` + `search_queries`). Unknown required fields fail closed — Hivekeep will not invent values.

A tool that requires **both** a natural-language `objective` and a `search_queries` string[] (the Parallel Search MCP `web_search` shape) qualifies without `queryArg`. Hivekeep copies its single `SearchRequest.query` into `objective` and into `search_queries` as a one-element array (padded if the schema sets `minItems`).

Optional unknown fields are ignored. Test Connection on the provider row checks this and shows `server / tool` as the account label when it passes.

### Example: Parallel Search MCP

Parallel's hosted `web_search` tool has no `q` field. It requires `objective` (string) and `search_queries` (string[]). Leave `queryArg` blank.

1. **Settings → MCP**: add a remote server.
   - name: `Parallel Search`
   - transport: `http`
   - url: `https://search.parallel.ai/mcp`
   - headers: put the Parallel API key on the MCP server row (not on the search provider).
2. **Settings → Providers**: add type **MCP**.
   - server: `Parallel Search` (name or id)
   - tool: `web_search`
   - queryArg: empty
3. Test Connection. The account label should read `Parallel Search / web_search`. You can then set this row as the default search provider.

`web_search` then sends `{ objective: "<query>", search_queries: ["<query>"] }`. Result `excerpts[]` become snippets.

### Auth

The MCP search provider has **no API key**. Auth stays where it already lives:

- **stdio**: env vars on the MCP server row
- **http / sse**: headers / bearer token on the MCP server row

Same limits as the rest of MCP: static headers only. Hivekeep does not implement the MCP OAuth authorization-code flow. If the remote server needs an interactive OAuth handshake, it will not connect, and this provider cannot authenticate.

Do not paste MCP secrets into the search provider form. There is nowhere to put them, and they must not be invented or copied into provider config.

### How a call is mapped

`web_search` builds a normalised `SearchRequest`. The MCP adapter writes `query` into the resolved query argument (and into companion `search_queries` / required `objective`-style fields when the schema has them) and, when the tool schema has a matching key, best-effort maps `count`, `freshness`, `lang`, `location`, domain filters, and `answer`. Static capability flags stay conservative (`supportsAnswer: true` because unstructured text can become an answer; freshness / domains / lang / location are **not** advertised), so the host still warns when the LLM asks for a knob the adapter cannot guarantee.

### How results are parsed

MCP tools do not share an output schema. The adapter, in order:

1. Prefers `structuredContent` when the server sends it, otherwise concatenated text content.
2. Parses JSON objects/arrays (`results`, `organic_results`, `web.results`, `items`, `hits`, or a single `{ url, title }` object). String `snippet` / `excerpt` and `excerpts[]` become the result snippet; `publish_date` / `published_at` become `publishedAt`.
3. Falls back to markdown `[title](url)` lists, then bare `http(s)` URLs.
4. If nothing looks like a result list, the raw text is returned as `answer` with a warning. Use `browse_url` to read a specific page.

`CallToolResult.isError` is treated as a failed search (no reconnect). A dead connection still gets the usual one reconnect-and-retry.

### Failure modes

| Symptom | Likely cause |
|---|---|
| Test Connection: missing server / tool | `server` or `tool` blank in the provider form. |
| No MCP server matches "…" | Typo, or the server was renamed/deleted. Use the name or id from Settings → MCP. |
| Server is `pending_approval` | Agent-created server waiting for admin approval. It contributes no tools. |
| Could not connect | Command/URL wrong, process crashed, handshake timeout (30 s), or remote auth rejected. Fix the MCP server row, not the search provider. |
| Tool not found | Wrong name, or the server's `listTools` set changed. Grant names must use the current sanitised server name. |
| No query-like argument / extra required fields | The tool is not a search tool (e.g. `write_file`), or it requires a collection/index/key Hivekeep cannot fill. Pick another tool or set `queryArg`. Do not set `queryArg` to `q` on a tool that uses `objective` / `search_queries` instead of `q`. |
| `web_search` error from the tool | Upstream search error, 2 min call timeout, or the parent `web_search` timeout (`SEARCH_REQUEST_TIMEOUT`, default 30 s). |
| Empty results + `answer` warning | The tool returned prose or an unknown JSON shape. The text is still in `answer`; it is not a crash. |
| Freshness / domain / lang warnings | Expected. Those flags are not advertised for MCP. Matching schema keys are still forwarded when present. |

Granting the MCP tool on an Agent toolbox is **not** required for this path. `web_search` calls the tool host-side through the search provider; the Agent does not need `mcp_*` in its toolbox unless you also want it to call that tool directly.

## Related

- [Supported providers](/docs/providers/supported/) for the MCP row in the search-provider table.
- [Native tools](/docs/agents/tools/) for the built-in tools MCP tools sit alongside.
- [Plugins overview](/docs/plugins/overview/) for the in-process alternative when you want to ship a tool, provider, or channel as code rather than connect an external server.
- [Configuration](/docs/getting-started/configuration/) for `MCP_REQUIRE_APPROVAL` and related settings.
