import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { mcpServers } from '@/server/db/schema'
import { disconnectServer, getConnectionStatus, testConnection } from '@/server/services/mcp'
import {
  isRemoteMcpTransport,
  maskSecretRecord,
  mergeSecretRecord,
  normalizeMcpTransport,
  parseSecretRecord,
  serializeSecretJson,
  validateMcpServerConfig,
} from '@/server/services/mcp-config'
import { sseManager } from '@/server/sse/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { requireAdmin } from '@/server/auth/require-admin'
import type { McpTransport } from '@/shared/types'

const log = createLogger('routes:mcp-servers')

export const mcpServerRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
mcpServerRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

interface McpServerBody {
  name?: string
  transport?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  status?: string
  createdByAgentId?: string
}

function serialize(server: typeof mcpServers.$inferSelect) {
  // Never expose env/header values to the frontend — only return keys with empty strings
  const envParsed = parseSecretRecord(server.env)
  const headersParsed = parseSecretRecord(server.headers)
  const transport = normalizeMcpTransport(server.transport)

  return {
    id: server.id,
    name: server.name,
    transport,
    command: isRemoteMcpTransport(transport) ? null : server.command,
    args: server.args ? JSON.parse(server.args) : [],
    env: maskSecretRecord(envParsed),
    hasEnv: Object.keys(envParsed).length > 0,
    url: server.url ?? null,
    headers: maskSecretRecord(headersParsed),
    hasHeaders: Object.keys(headersParsed).length > 0,
    status: server.status,
    createdByAgentId: server.createdByAgentId,
    createdAt: new Date(server.createdAt).getTime(),
    updatedAt: new Date(server.updatedAt).getTime(),
  }
}

// GET /api/mcp-servers — list all MCP servers
mcpServerRoutes.get('/', async (c) => {
  const servers = await db.select().from(mcpServers).all()
  return c.json({ servers: servers.map(serialize) })
})

// POST /api/mcp-servers — create a new MCP server
mcpServerRoutes.post('/', async (c) => {
  const body = await c.req.json<McpServerBody>()

  const transport = normalizeMcpTransport(body.transport)
  const trimmedName = body.name?.trim() ?? ''
  const trimmedCommand = body.command?.trim() ?? ''
  const trimmedUrl = body.url?.trim() || null

  const validation = validateMcpServerConfig({
    name: trimmedName,
    transport,
    command: trimmedCommand,
    url: trimmedUrl,
    args: body.args ?? null,
    env: body.env ?? null,
    headers: body.headers ?? null,
  })
  if (!validation.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: validation.message } }, 400)
  }

  const id = uuid()
  const now = new Date()
  const remote = isRemoteMcpTransport(transport)

  await db.insert(mcpServers).values({
    id,
    name: trimmedName,
    command: remote ? '' : trimmedCommand,
    args: !remote && body.args ? JSON.stringify(body.args) : null,
    env: !remote ? serializeSecretJson(body.env) : null,
    transport,
    url: remote ? trimmedUrl : null,
    headers: remote ? serializeSecretJson(body.headers) : null,
    status: body.status ?? 'active',
    createdByAgentId: body.createdByAgentId ?? null,
    createdAt: now,
    updatedAt: now,
  })

  log.info({ serverId: id, name: trimmedName, transport, status: body.status ?? 'active' }, 'MCP server created')

  const created = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serialized = serialize(created!)

  sseManager.broadcast({
    type: 'mcp-server:created',
    data: { serverId: id, server: serialized },
  })

  return c.json({ server: serialized }, 201)
})

// PATCH /api/mcp-servers/:id — update an MCP server
mcpServerRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const body = await c.req.json<McpServerBody>()

  const nextTransport = body.transport !== undefined
    ? normalizeMcpTransport(body.transport)
    : normalizeMcpTransport(existing.transport)
  const nextName = body.name !== undefined ? body.name.trim() : existing.name
  const nextCommand = body.command !== undefined ? body.command.trim() : existing.command
  const nextUrl = body.url !== undefined ? (body.url?.trim() || null) : existing.url
  const nextArgs = body.args !== undefined ? body.args : (existing.args ? JSON.parse(existing.args) as string[] : null)

  let nextEnv: Record<string, string> | null = parseSecretRecord(existing.env)
  if (body.env !== undefined) {
    nextEnv = body.env
      ? mergeSecretRecord(parseSecretRecord(existing.env), body.env)
      : null
  }

  let nextHeaders: Record<string, string> | null = parseSecretRecord(existing.headers)
  if (body.headers !== undefined) {
    nextHeaders = body.headers
      ? mergeSecretRecord(parseSecretRecord(existing.headers), body.headers)
      : null
  }

  const validation = validateMcpServerConfig({
    name: nextName,
    transport: nextTransport,
    command: nextCommand ?? '',
    url: nextUrl,
    args: nextArgs,
    env: nextEnv,
    headers: nextHeaders,
  })
  if (!validation.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: validation.message } }, 400)
  }

  const remote = isRemoteMcpTransport(nextTransport)
  const updates: Partial<typeof mcpServers.$inferInsert> = {
    updatedAt: new Date(),
    name: nextName,
    transport: nextTransport,
    command: remote ? '' : nextCommand,
    args: !remote && nextArgs ? JSON.stringify(nextArgs) : null,
    env: !remote ? serializeSecretJson(nextEnv) : null,
    url: remote ? nextUrl : null,
    headers: remote ? serializeSecretJson(nextHeaders) : null,
  }

  await db.update(mcpServers).set(updates).where(eq(mcpServers.id, id))

  const configChanged = body.transport !== undefined
    || body.command !== undefined
    || body.args !== undefined
    || body.env !== undefined
    || body.url !== undefined
    || body.headers !== undefined
  if (configChanged) {
    await disconnectServer(id)
  }

  const updated = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serializedUpdated = serialize(updated!)
  log.info({ serverId: id, name: updated!.name, transport: nextTransport, configChanged }, 'MCP server updated')

  sseManager.broadcast({
    type: 'mcp-server:updated',
    data: { serverId: id, server: serializedUpdated },
  })

  return c.json({ server: serializedUpdated })
})

// POST /api/mcp-servers/:id/approve — approve a pending MCP server
mcpServerRoutes.post('/:id/approve', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  if (existing.status !== 'pending_approval') {
    return c.json({ error: { code: 'ALREADY_ACTIVE', message: 'This server is already active' } }, 409)
  }

  await db.update(mcpServers).set({ status: 'active', updatedAt: new Date() }).where(eq(mcpServers.id, id))

  const updated = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serializedApproved = serialize(updated!)
  log.info({ serverId: id, name: updated!.name }, 'MCP server approved')

  sseManager.broadcast({
    type: 'mcp-server:updated',
    data: { serverId: id, server: serializedApproved },
  })

  return c.json({ server: serializedApproved })
})

// GET /api/mcp-servers/:id/status — check connection status
mcpServerRoutes.get('/:id/status', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const status = await getConnectionStatus(id)
  return c.json(status)
})

// POST /api/mcp-servers/:id/test — force a fresh connection test
mcpServerRoutes.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const status = await testConnection(id)
  return c.json(status)
})

// DELETE /api/mcp-servers/:id — delete an MCP server
mcpServerRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  // Disconnect if running
  await disconnectServer(id)

  // Delete (cascade removes agent_mcp_servers links)
  await db.delete(mcpServers).where(eq(mcpServers.id, id))

  log.info({ serverId: id, name: existing.name }, 'MCP server deleted')

  sseManager.broadcast({
    type: 'mcp-server:deleted',
    data: { serverId: id },
  })

  return c.json({ success: true })
})
