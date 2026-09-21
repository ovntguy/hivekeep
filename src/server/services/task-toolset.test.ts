/**
 * Scout leaf toolset + sub-agent protocol merge.
 *
 * Real in-memory SQLite (same pattern as toolboxes.test.ts) so assembleTaskToolset
 * runs through drizzle. Throwaway tools are registered on the live registry and
 * removed in afterAll. The assertions are the grant contract: a scout child must
 * not receive writes, shell, spawn, or further scout.
 */
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { v4 as uuid } from 'uuid'
import * as schema from '@/server/db/schema'
import { toolRegistry } from '@/server/tools/index'
import type { ToolRegistration } from '@/server/tools/types'
import type { Tool } from '@/server/tools/tool-helper'
import { LEAF_EXCLUDED_TOOLS } from '@/shared/constants'

const schemaIsReal = !!(schema as any).toolboxes?.id && !!(schema as any).agents?.id

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = OFF')
const db = schemaIsReal ? drizzle(sqlite, { schema }) : (null as any)

if (schemaIsReal) {
  mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables: () => {} }))
}

const svc = schemaIsReal
  ? await import('@/server/services/task-toolset')
  : ({} as typeof import('@/server/services/task-toolset'))
const {
  assembleTaskToolset,
  isExclusiveScoutToolbox,
  resolveSubAgentProtocolTools,
  isSubAgentProtocolAvailability,
} = svc as typeof import('@/server/services/task-toolset')

const itReal = schemaIsReal && typeof assembleTaskToolset === 'function' ? it : it.skip

const SCOUT_BOX_ID = 'tb-scout-leaf'
const AGENT_ID = 'agent-windows-ops'

const ENSURED_BOTH: string[] = [
  'write_file',
  'edit_file',
  'multi_edit',
  'run_shell',
  'read_file',
  'grep',
  'list_directory',
  'web_search',
  'browse_url',
  'extract_links',
  'spawn_self',
  'spawn_agent',
  'scout',
  'request_tool_access',
  'http_request',
]

const ENSURED_PROTOCOL: string[] = [
  'report_to_parent',
  'update_task_status',
  'request_input',
]

const added: string[] = []

const fakeTool = (availability: ('main' | 'sub-agent')[]): ToolRegistration => ({
  availability,
  create: () =>
    ({ description: '', inputSchema: undefined as any, execute: async () => null } as unknown as Tool<
      any,
      any
    >),
})

function ensureTool(name: string, availability: ('main' | 'sub-agent')[]): void {
  const existing = toolRegistry.list().some((t) => t.name === name)
  if (existing) return
  toolRegistry.register(name, fakeTool(availability), 'system')
  added.push(name)
}

beforeAll(() => {
  if (!schemaIsReal) return
  for (const name of ENSURED_BOTH) ensureTool(name, ['main', 'sub-agent'])
  for (const name of ENSURED_PROTOCOL) ensureTool(name, ['sub-agent'])

  sqlite.run(`
    CREATE TABLE toolboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      tool_names TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE custom_tools (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      parameters TEXT NOT NULL,
      entrypoint TEXT NOT NULL,
      translations TEXT,
      language TEXT,
      domain_slug TEXT NOT NULL DEFAULT 'custom',
      timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
      env TEXT,
      transport TEXT NOT NULL DEFAULT 'stdio',
      url TEXT,
      headers TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_agent_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      avatar_path TEXT,
      character TEXT NOT NULL,
      expertise TEXT NOT NULL,
      model TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      toolbox_ids TEXT,
      extra_tool_names TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
})

afterAll(() => {
  if (!schemaIsReal) return
  for (const name of added) toolRegistry.unregister(name)
})

beforeEach(() => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM toolboxes')
  sqlite.run('DELETE FROM custom_tools')
  sqlite.run('DELETE FROM mcp_servers')
  sqlite.run('DELETE FROM agents')

  const now = Date.now()
  sqlite.run(
    `INSERT INTO toolboxes (id, name, description, tool_names, builtin, created_at, updated_at)
     VALUES (?, 'scout', 'Read-only exploration', ?, 1, ?, ?)`,
    [
      SCOUT_BOX_ID,
      JSON.stringify(['grep', 'read_file', 'list_directory', 'web_search', 'browse_url', 'extract_links']),
      now,
      now,
    ],
  )
  sqlite.run(
    `INSERT INTO agents (id, slug, name, role, character, expertise, model, workspace_path, extra_tool_names, created_at, updated_at)
     VALUES (?, 'windows-ops', 'Windows Ops', 'ops', 'c', 'e', 'm', '/tmp', ?, ?, ?)`,
    [AGENT_ID, JSON.stringify(['spawn_self', 'write_file']), now, now],
  )
})

describe('isSubAgentProtocolAvailability', () => {
  itReal('is true only for exactly [sub-agent]', () => {
    expect(isSubAgentProtocolAvailability(['sub-agent'])).toBe(true)
    expect(isSubAgentProtocolAvailability(['main', 'sub-agent'])).toBe(false)
    expect(isSubAgentProtocolAvailability(['main'])).toBe(false)
    expect(isSubAgentProtocolAvailability([])).toBe(false)
  })
})

describe('resolveSubAgentProtocolTools', () => {
  itReal('does not overlay spawn/scout/writes that merely include sub-agent availability', () => {
    const protocol = resolveSubAgentProtocolTools({ agentId: AGENT_ID, isSubAgent: true })
    const names = Object.keys(protocol)
    expect(names).toContain('report_to_parent')
    expect(names).toContain('update_task_status')
    expect(names).toContain('request_input')
    for (const banned of LEAF_EXCLUDED_TOOLS) {
      expect(names).not.toContain(banned)
    }
    expect(names).not.toContain('http_request')
  })
})

describe('isExclusiveScoutToolbox', () => {
  itReal('is true only for the builtin scout toolbox by itself', () => {
    expect(isExclusiveScoutToolbox([SCOUT_BOX_ID])).toBe(true)
    expect(isExclusiveScoutToolbox([])).toBe(false)
    expect(isExclusiveScoutToolbox([SCOUT_BOX_ID, 'other'])).toBe(false)
  })
})

describe('assembleTaskToolset — scout leaf', () => {
  itReal('omits write/shell/spawn/scout even when CORE and parent extras would grant them', async () => {
    const toolset = await assembleTaskToolset({
      agentId: AGENT_ID,
      toolboxIds: [SCOUT_BOX_ID],
      taskId: 'task-scout',
    })
    const names = Object.keys(toolset)

    for (const banned of [
      'write_file',
      'edit_file',
      'multi_edit',
      'run_shell',
      'spawn_self',
      'spawn_agent',
      'scout',
      'request_tool_access',
    ]) {
      expect(names).not.toContain(banned)
    }

    expect(names).toContain('grep')
    expect(names).toContain('read_file')
    expect(names).toContain('list_directory')
    expect(names).toContain('web_search')
    expect(names).toContain('browse_url')
    expect(names).toContain('extract_links')
    expect(names).toContain('report_to_parent')
    expect(names).not.toContain('http_request')
  })

  itReal('leaf:true strips writes even if the toolbox is not named scout', async () => {
    const now = Date.now()
    const allId = uuid()
    sqlite.run(
      `INSERT INTO toolboxes (id, name, description, tool_names, builtin, created_at, updated_at)
       VALUES (?, 'all', 'wildcard', ?, 1, ?, ?)`,
      [allId, JSON.stringify(['*']), now, now],
    )

    const toolset = await assembleTaskToolset({
      agentId: AGENT_ID,
      toolboxIds: [allId],
      leaf: true,
    })
    const names = Object.keys(toolset)
    for (const banned of LEAF_EXCLUDED_TOOLS) {
      expect(names).not.toContain(banned)
    }
  })
})
