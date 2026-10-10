import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { tool as aiTool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { augmentedPath, killProcessTree } from '@/server/lib/process'
import { mcpServers, agentMcpServers } from '@/server/db/schema'
import type { Tool } from '@/server/tools/tool-helper'
import {
  isRemoteMcpTransport,
  normalizeMcpTransport,
  parseSecretRecord,
  type McpTransport,
} from '@/server/services/mcp-config'

const log = createLogger('mcp')

// PATH augmentation + process-tree kill now live in @/server/lib/process and are
// shared with the custom-tools executor.

// ─── Types ───────────────────────────────────────────────────────────────────

type McpClientTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport

interface MCPConnection {
  client: Client
  transport: McpClientTransport
  kind: McpTransport
  tools: MCPToolDef[]
  serverId: string
  serverName: string
}

export interface MCPToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Application-level tool error (`CallToolResult.isError`), not a transport failure. */
class McpToolApplicationError extends Error {
  override name = 'McpToolApplicationError'
}

// ─── Connection pool (one connection per MCP server) ─────────────────────────

const connections = new Map<string, MCPConnection>()

const MCP_CONNECT_TIMEOUT_MS = 30_000
const MCP_CALL_TIMEOUT_MS = 120_000 // 2 minutes max for any single MCP tool call

/** Build the official SDK transport for a stored MCP server row. */
export function createMcpTransport(server: {
  name: string
  command?: string | null
  args?: string | null
  env?: string | null
  transport?: string | null
  url?: string | null
  headers?: string | null
}): { kind: McpTransport; transport: McpClientTransport } {
  const kind = normalizeMcpTransport(server.transport)

  if (isRemoteMcpTransport(kind)) {
    const rawUrl = server.url?.trim()
    if (!rawUrl) {
      throw new Error(`MCP server ${server.name} is missing a URL`)
    }
    const url = new URL(rawUrl)
    const headers = parseSecretRecord(server.headers)
    const opts = Object.keys(headers).length > 0
      ? { requestInit: { headers } }
      : undefined

    if (kind === 'sse') {
      return { kind, transport: new SSEClientTransport(url, opts) }
    }
    return { kind, transport: new StreamableHTTPClientTransport(url, opts) }
  }

  if (!server.command?.trim()) {
    throw new Error(`MCP server ${server.name} is missing a command`)
  }

  const args = server.args ? JSON.parse(server.args) as string[] : []
  const env = server.env ? JSON.parse(server.env) as Record<string, string> : {}

  return {
    kind,
    transport: new StdioClientTransport({
      command: server.command,
      args,
      env: { ...process.env, PATH: augmentedPath, ...env } as Record<string, string>,
    }),
  }
}

async function connectToServer(serverId: string): Promise<MCPConnection | null> {
  const server = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).get()
  if (!server) return null

  if (server.status !== 'active') {
    log.debug({ serverId, status: server.status }, 'Skipping non-active MCP server')
    return null
  }

  let client: Client | undefined
  try {
    const { kind, transport } = createMcpTransport(server)

    client = new Client({
      name: 'hivekeep',
      version: '1.0.0',
    })

    // Connect with timeout to avoid hanging on unresponsive servers
    const connectPromise = client.connect(transport)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP connection timeout after ${MCP_CONNECT_TIMEOUT_MS}ms`)), MCP_CONNECT_TIMEOUT_MS),
    )
    await Promise.race([connectPromise, timeoutPromise])

    // Discover tools. Bounded like `connect` above: a server that completes the
    // handshake and then goes quiet would otherwise hang the first toolset
    // resolution — which happens inside a turn.
    const toolsResult = await withTimeout(
      client.listTools(),
      MCP_CONNECT_TIMEOUT_MS,
      `MCP listTools for ${server.name}`,
    )
    const tools: MCPToolDef[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }))

    const conn: MCPConnection = {
      client,
      transport,
      kind,
      tools,
      serverId,
      serverName: server.name,
    }

    connections.set(serverId, conn)
    log.info({ serverId, serverName: server.name, kind, toolCount: tools.length }, 'MCP server connected')

    return conn
  } catch (err) {
    log.error({ serverId, serverName: server.name, err }, 'MCP connection failed')
    if (client) {
      try { await client.close() } catch { /* ignore */ }
    }
    return null
  }
}

async function getConnection(serverId: string): Promise<MCPConnection | null> {
  // Return existing connection if alive
  if (connections.has(serverId)) {
    return connections.get(serverId)!
  }

  return connectToServer(serverId)
}

// Register graceful shutdown hooks
process.on('beforeExit', () => { disconnectAll() })
process.on('SIGINT', () => { disconnectAll().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { disconnectAll().finally(() => process.exit(0)) })

// ─── Process tree cleanup ────────────────────────────────────────────────────

// ─── Disconnect ──────────────────────────────────────────────────────────────

export async function disconnectServer(serverId: string) {
  const conn = connections.get(serverId)
  if (conn) {
    // Grab the PID before close() clears it. HTTP/SSE transports have no
    // process tree — do not call killProcessTree on those connections.
    const pid = conn.kind === 'stdio' && conn.transport instanceof StdioClientTransport
      ? conn.transport.pid
      : undefined
    try {
      await conn.client.close()
    } catch { /* ignore */ }

    // Kill the entire process tree to clean up npm exec → sh → node chains.
    // client.close() only kills the direct child; grandchildren may survive.
    if (pid) {
      await killProcessTree(pid)
    }

    connections.delete(serverId)
  }
}

export async function disconnectAll() {
  for (const [id] of connections) {
    await disconnectServer(id)
  }
}

// ─── Connection status ───────────────────────────────────────────────────────

export interface MCPConnectionStatus {
  connected: boolean
  toolCount: number
  error?: string
}

/**
 * Check connection status for an MCP server. Uses cached connection if available.
 */
export async function getConnectionStatus(serverId: string): Promise<MCPConnectionStatus> {
  try {
    const conn = await getConnection(serverId)
    if (!conn) {
      return { connected: false, toolCount: 0, error: 'Failed to connect' }
    }
    return { connected: true, toolCount: conn.tools.length }
  } catch (err) {
    return { connected: false, toolCount: 0, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/**
 * Force a fresh connection attempt (evicts cached connection first).
 */
export async function testConnection(serverId: string): Promise<MCPConnectionStatus> {
  // Evict existing connection
  await disconnectServer(serverId)
  return getConnectionStatus(serverId)
}

// ─── MCP tool summary for system prompt ──────────────────────────────────────

export interface MCPToolSummary {
  serverName: string
  tools: Array<{ name: string; description: string }>
}

/**
 * Get a lightweight summary of MCP tools available to an Agent.
 * Used for injection into the system prompt so the Agent knows what MCP tools are available.
 * This reuses existing connections (or creates them) but only extracts metadata.
 */
export async function getMCPToolsSummary(agentId: string): Promise<MCPToolSummary[]> {
  const links = await db
    .select({ mcpServerId: agentMcpServers.mcpServerId })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.agentId, agentId))
    .all()

  if (links.length === 0) return []

  const summaries: MCPToolSummary[] = []

  for (const link of links) {
    const conn = await getConnection(link.mcpServerId)
    if (!conn) continue

    summaries.push({
      serverName: conn.serverName,
      tools: conn.tools.map((t) => ({
        name: `mcp_${sanitizeName(conn.serverName)}_${sanitizeName(t.name)}`,
        description: t.description,
      })),
    })
  }

  return summaries
}

// ─── MCP catalog (all global active servers, no per-Agent gate) ────────────────

/** A single MCP tool as it appears in the toolbox catalog. */
export interface MCPCatalogEntry {
  /** Stable grant name: `mcp_<sanitizeName(server)>_<sanitizeName(tool)>`. */
  name: string
  /** Human-facing display name of the originating server. */
  serverName: string
  serverId: string
  /** Raw (unsanitized) upstream tool name. */
  rawToolName: string
  description: string
}

/**
 * Enumerate every MCP tool from ALL global active servers, with no per-Agent
 * gate. This powers the toolbox catalog: a toolbox can list any of these stable
 * `mcp_*` names and the unified resolver will grant it to any Agent/task that
 * references that toolbox (the server's creds stay global).
 *
 * Servers that are not `active` are skipped. A server we cannot connect to (so
 * its tool list is unknown) contributes no entries — it simply won't appear in
 * the catalog until it connects.
 */
export async function listAllMCPCatalogTools(): Promise<MCPCatalogEntry[]> {
  const servers = await db.select().from(mcpServers).all()
  const entries: MCPCatalogEntry[] = []

  for (const server of servers) {
    if (server.status !== 'active') continue
    const conn = await getConnection(server.id)
    if (!conn) continue

    for (const t of conn.tools) {
      entries.push({
        name: `mcp_${sanitizeName(conn.serverName)}_${sanitizeName(t.name)}`,
        serverName: conn.serverName,
        serverId: server.id,
        rawToolName: t.name,
        description: t.description,
      })
    }
  }

  return entries
}

// ─── Resolve MCP tools (global, no per-Agent gate) ─────────────────────────────

/**
 * Resolve every MCP tool from ALL global ACTIVE servers, keyed by the canonical
 * `mcp_{sanitizeName(server)}_{sanitizeName(tool)}` name.
 *
 * The TOOLBOX is now the sole tool-grant primitive (see toolset-resolver.ts):
 * there is no per-Agent MCP access gate. MCP servers live globally in
 * `mcp_servers` with their own credentials; a toolbox references an MCP tool by
 * its stable name, and the unified resolver intersects that against this
 * universe. Server-level approval status (`status === 'active'`) still applies —
 * `pending_approval` servers contribute nothing.
 *
 * The `agentId` parameter is retained only for logging/diagnostic symmetry with
 * the other source resolvers; it no longer filters the result.
 */
export async function resolveMCPTools(
  _agentId?: string,
): Promise<Record<string, Tool<any, any>>> {
  const servers = await db.select().from(mcpServers).all()

  const resolved: Record<string, Tool<any, any>> = {}

  for (const server of servers) {
    if (server.status !== 'active') continue
    const conn = await getConnection(server.id)
    if (!conn) continue

    for (const mcpTool of conn.tools) {
      const toolKey = `mcp_${sanitizeName(conn.serverName)}_${sanitizeName(mcpTool.name)}`

      resolved[toolKey] = aiTool({
        description: `[MCP: ${conn.serverName}] ${mcpTool.description}`,
        inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
        execute: async (args) => {
          return callMCPTool(conn, mcpTool.name, args as Record<string, unknown>)
        },
      })
    }
  }

  return resolved
}


// ─── Public lookup / invoke (used by the MCP search provider) ────────────────

type McpServerRow = typeof mcpServers.$inferSelect

/**
 * Resolve an MCP server by id, exact name, case-insensitive name, or
 * sanitised name (`My Server` ↔ `my_server`). Returns undefined when
 * nothing matches. Does not connect.
 */
export async function findMcpServerByRef(ref: string): Promise<McpServerRow | undefined> {
  const needle = ref.trim()
  if (!needle) return undefined

  const servers = await db.select().from(mcpServers).all()
  const byId = servers.find((s) => s.id === needle)
  if (byId) return byId

  const exact = servers.find((s) => s.name === needle)
  if (exact) return exact

  const lower = needle.toLowerCase()
  const ci = servers.find((s) => s.name.toLowerCase() === lower)
  if (ci) return ci

  const san = sanitizeName(needle)
  return servers.find((s) => sanitizeName(s.name) === san)
}

/**
 * Tool list from the pooled connection (connects on first use).
 * Returns null when the server is missing, not active, or cannot connect.
 */
export async function listMcpServerTools(serverId: string): Promise<MCPToolDef[] | null> {
  const conn = await getConnection(serverId)
  if (!conn) return null
  return conn.tools
}

/**
 * Call a tool on a connected MCP server and return the extracted result.
 * Throws on connect failure, missing tool, transport error (after one
 * reconnect), or `CallToolResult.isError`. Reuses the Agent-facing
 * call path (timeouts, reconnect-once).
 */
export async function invokeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const conn = await getConnection(serverId)
  if (!conn) {
    throw new Error(`Failed to connect to MCP server ${serverId}`)
  }
  const result = await raceWithSignal(callMCPTool(conn, toolName, args), signal)
  if (isCallFailureEnvelope(result)) {
    throw new Error(result.error)
  }
  return result
}

async function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new Error('MCP search timed out')
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('MCP search timed out'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function isCallFailureEnvelope(result: unknown): result is { error: string } {
  if (!result || typeof result !== 'object') return false
  const rec = result as Record<string, unknown>
  return typeof rec.error === 'string' && Object.keys(rec).length === 1
}

// ─── Call an MCP tool ────────────────────────────────────────────────────────

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

/** Extract structuredContent when present, otherwise text content. */
function extractMCPResult(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent
  }
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .filter((t): t is string => typeof t === 'string')
    return texts.length === 1 ? texts[0] : texts.join('\n')
  }
  return result
}

/**
 * Interpret a successful RPC. `isError: true` is an application failure
 * (do NOT treat as a dead connection / reconnect trigger).
 */
function interpretCallResult(result: McpCallResult): unknown {
  const extracted = extractMCPResult(result)
  if (result.isError) {
    const message = typeof extracted === 'string' && extracted.trim()
      ? extracted
      : 'MCP tool returned an error'
    throw new McpToolApplicationError(message)
  }
  return extracted
}

async function callMCPToolOnce(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const result = await withTimeout(
    conn.client.callTool({ name: toolName, arguments: args }),
    MCP_CALL_TIMEOUT_MS,
    label,
  )
  return interpretCallResult(result as McpCallResult)
}

async function callMCPTool(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callMCPToolOnce(conn, toolName, args, `MCP tool ${toolName}`)
  } catch (err) {
    if (err instanceof McpToolApplicationError) {
      return { error: err.message }
    }

    // Connection may be dead, try to reconnect once
    log.warn({ toolName, serverName: conn.serverName, err }, 'MCP tool call failed, attempting reconnection')
    await disconnectServer(conn.serverId)

    try {
      const newConn = await connectToServer(conn.serverId)
      if (newConn) {
        return await callMCPToolOnce(newConn, toolName, args, `MCP tool ${toolName} (retry)`)
      }
    } catch (retryErr) {
      if (retryErr instanceof McpToolApplicationError) {
        return { error: retryErr.message }
      }
      log.error({ toolName, serverName: conn.serverName, retryErr }, 'MCP tool call retry also failed')
    }

    return { error: err instanceof Error ? err.message : 'MCP tool call failed' }
  }
}

// ─── JSON Schema → Zod (simplified conversion) ──────────────────────────────

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  // If there are properties, build an object schema
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>
    const required = (schema.required as string[]) ?? []
    const shape: Record<string, z.ZodType> = {}

    for (const [key, prop] of Object.entries(props)) {
      let field = jsonSchemaPropertyToZod(prop)
      if (!required.includes(key)) {
        field = field.optional() as any
      }
      shape[key] = field
    }

    return z.object(shape)
  }

  // Fallback: accept anything
  return z.object({}).passthrough()
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodType {
  const desc = (prop.description as string) ?? undefined

  switch (prop.type) {
    case 'string':
      if (prop.enum) {
        return z.enum(prop.enum as [string, ...string[]]).describe(desc ?? '')
      }
      return desc ? z.string().describe(desc) : z.string()
    case 'number':
    case 'integer':
      return desc ? z.number().describe(desc) : z.number()
    case 'boolean':
      return desc ? z.boolean().describe(desc) : z.boolean()
    case 'array':
      if (prop.items) {
        return z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
      }
      return z.array(z.unknown())
    case 'object':
      return jsonSchemaToZod(prop)
    default:
      return z.unknown()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitise a server or tool name the same way grant names are built. */
export function sanitizeMcpName(name: string): string {
  return sanitizeName(name)
}

function sanitizeName(name: string): string {
  // First try: transliterate common accented chars, then strip non-ascii
  const transliterated = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
  const result = transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  // Fallback: if result is empty (all non-Latin chars), use a hash of the original name
  if (result === '') {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
    }
    return `u${Math.abs(hash).toString(36)}`
  }

  return result
}
