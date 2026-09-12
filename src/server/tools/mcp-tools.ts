import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { mcpServers, agentMcpServers } from '@/server/db/schema'
import { disconnectServer } from '@/server/services/mcp'
import {
  isRemoteMcpTransport,
  normalizeMcpTransport,
  parseArgs,
  parseSecretRecord,
  serializeSecretJson,
  validateMcpServerConfig,
} from '@/server/services/mcp-config'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { McpTransport } from '@/shared/types'

const log = createLogger('tools:mcp')

const transportSchema = z.enum(['stdio', 'http', 'sse']).optional().describe(
  'How to connect: stdio (local command, default), http (Streamable HTTP URL), or sse (legacy remote SSE).',
)

/**
 * add_mcp_server — create a new MCP server on the platform.
 * The server is auto-assigned to the calling Agent.
 * If MCP_REQUIRE_APPROVAL is true, the server stays pending until approved by the user.
 * Available to main agents only.
 */
export const addMcpServerTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Add a new MCP server (local stdio command, or remote HTTP/SSE URL). Auto-assigned to you. May require user approval.',
      inputSchema: z.object({
        name: z.string(),
        transport: transportSchema,
        command: z.string().optional().describe('Executable for stdio (e.g. "npx", "node", "python")'),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        url: z.string().optional().describe('Remote MCP server URL (required for http/sse)'),
        headers: z.record(z.string(), z.string()).optional().describe('HTTP headers for remote servers (Authorization, API keys). Values are stored and never shown back.'),
      }),
      execute: async ({ name, transport: rawTransport, command, args, env, url, headers }) => {
        try {
          const transport = normalizeMcpTransport(rawTransport)
          const validation = validateMcpServerConfig({
            name,
            transport,
            command: command ?? '',
            url: url?.trim() || null,
            args: args ?? null,
            env: env ?? null,
            headers: headers ?? null,
          })
          if (!validation.ok) return { error: validation.message }

          const id = uuid()
          const now = new Date()
          const status = config.mcp.requireApproval ? 'pending_approval' : 'active'
          const remote = isRemoteMcpTransport(transport)

          await db.insert(mcpServers).values({
            id,
            name,
            command: remote ? '' : (command ?? ''),
            args: !remote && args ? JSON.stringify(args) : null,
            env: !remote ? serializeSecretJson(env) : null,
            transport,
            url: remote ? (url?.trim() || null) : null,
            headers: remote ? serializeSecretJson(headers) : null,
            status,
            createdByAgentId: ctx.agentId,
            createdAt: now,
            updatedAt: now,
          })

          // Auto-assign to the calling Agent
          await db.insert(agentMcpServers).values({
            agentId: ctx.agentId,
            mcpServerId: id,
          })

          log.info({ serverId: id, name, transport, agentId: ctx.agentId, status }, 'MCP server created by Agent')

          sseManager.broadcast({
            type: 'mcp-server:created',
            data: { mcpServerId: id, name, status },
          })

          // Persistent notification for pending approval
          if (status === 'pending_approval') {
            const { createNotification } = await import('@/server/services/notifications')
            createNotification({
              type: 'mcp:pending-approval',
              title: 'MCP server needs approval',
              body: name,
              agentId: ctx.agentId,
              relatedId: id,
              relatedType: 'mcp',
            }).catch(() => {})
          }

          return {
            serverId: id,
            name,
            transport,
            status,
            message: status === 'pending_approval'
              ? 'MCP server created — awaiting user approval before activation.'
              : 'MCP server created and active.',
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * update_mcp_server — modify an existing MCP server's configuration.
 * Available to main agents only.
 */
export const updateMcpServerTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Update an MCP server configuration (name, transport, command, args, env, url, headers).',
      inputSchema: z.object({
        server_id: z.string(),
        name: z.string().optional(),
        transport: transportSchema,
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.object({}).catchall(z.string()).optional().describe('Environment variables as key-value pairs. Merged with existing. Pass null to clear all.'),
        url: z.string().optional(),
        headers: z.object({}).catchall(z.string()).optional().describe('HTTP headers as key-value pairs. Merged with existing. Pass null to clear all.'),
      }),
      execute: async ({ server_id, name, transport: rawTransport, command, args, env, url, headers }) => {
        try {
          const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, server_id)).get()
          if (!existing) return { error: 'MCP server not found' }

          const nextTransport: McpTransport = rawTransport !== undefined
            ? normalizeMcpTransport(rawTransport)
            : normalizeMcpTransport(existing.transport)
          const nextName = name ?? existing.name
          const nextCommand = command ?? existing.command ?? ''
          const nextUrl = url !== undefined ? (url.trim() || null) : existing.url
          const nextArgs = args !== undefined ? args : parseArgs(existing.args)

          let nextEnv: Record<string, string> | null = parseSecretRecord(existing.env)
          if (env !== undefined) {
            // Agent updates are additive: omitted keys stay, provided keys override.
            nextEnv = env ? { ...parseSecretRecord(existing.env), ...env } : null
          }

          let nextHeaders: Record<string, string> | null = parseSecretRecord(existing.headers)
          if (headers !== undefined) {
            nextHeaders = headers ? { ...parseSecretRecord(existing.headers), ...headers } : null
          }

          const validation = validateMcpServerConfig({
            name: nextName,
            transport: nextTransport,
            command: nextCommand,
            url: nextUrl,
            args: nextArgs,
            env: nextEnv,
            headers: nextHeaders,
          })
          if (!validation.ok) return { error: validation.message }

          const remote = isRemoteMcpTransport(nextTransport)
          const updates: Partial<typeof mcpServers.$inferInsert> = {
            updatedAt: new Date(),
            name: nextName,
            transport: nextTransport,
            command: remote ? '' : nextCommand,
            args: !remote && nextArgs.length > 0 ? JSON.stringify(nextArgs) : null,
            env: !remote ? serializeSecretJson(nextEnv) : null,
            url: remote ? nextUrl : null,
            headers: remote ? serializeSecretJson(nextHeaders) : null,
          }

          await db.update(mcpServers).set(updates).where(eq(mcpServers.id, server_id))

          const configChanged = rawTransport !== undefined
            || command !== undefined
            || args !== undefined
            || env !== undefined
            || url !== undefined
            || headers !== undefined
          if (configChanged) {
            await disconnectServer(server_id)
          }

          log.info({ serverId: server_id, agentId: ctx.agentId, transport: nextTransport, configChanged }, 'MCP server updated by Agent')

          sseManager.broadcast({
            type: 'mcp-server:updated',
            data: { mcpServerId: server_id, name: nextName },
          })

          return { success: true, serverId: server_id, transport: nextTransport }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * remove_mcp_server — delete an MCP server from the platform.
 * Available to main agents only.
 */
export const removeMcpServerTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Remove an MCP server permanently. Disconnects and removes from all Agents.',
      inputSchema: z.object({
        server_id: z.string(),
      }),
      execute: async ({ server_id }) => {
        try {
          const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, server_id)).get()
          if (!existing) return { error: 'MCP server not found' }

          await disconnectServer(server_id)
          await db.delete(mcpServers).where(eq(mcpServers.id, server_id))

          log.info({ serverId: server_id, name: existing.name, agentId: ctx.agentId }, 'MCP server removed by Agent')

          sseManager.broadcast({
            type: 'mcp-server:deleted',
            data: { mcpServerId: server_id },
          })

          return { success: true }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * list_mcp_servers — list all MCP servers configured on the platform.
 * Available to main agents only.
 */
export const listMcpServersTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description: 'List all MCP servers on the platform.',
      inputSchema: z.object({}),
      execute: async () => {
        const servers = await db.select().from(mcpServers).all()
        return {
          servers: servers.map((s) => {
            const transport = normalizeMcpTransport(s.transport)
            const remote = isRemoteMcpTransport(transport)
            return {
              id: s.id,
              name: s.name,
              transport,
              command: remote ? null : s.command,
              args: remote ? [] : parseArgs(s.args),
              url: s.url ?? null,
              status: s.status,
              createdByAgentId: s.createdByAgentId,
            }
          }),
        }
      },
    }),
}
