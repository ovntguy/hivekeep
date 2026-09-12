import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { fullMockDrizzleOrm, fullMockSchema } from '../../test-helpers'

type ServerRow = {
  id: string
  name: string
  command: string
  args: string | null
  env: string | null
  transport: string
  url: string | null
  headers: string | null
  status: string
}

let servers: ServerRow[] = []
let lastHttpCtor: { url: string; opts: unknown } | null = null
let lastSseCtor: { url: string; opts: unknown } | null = null
let lastStdioCtor: { command: string; args: string[]; env?: Record<string, string> } | null = null
let killedPids: number[] = []
let closeCalls = 0
let connectCalls = 0
let callToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []
let failNextCall = false

const mockClient = {
  connect: async () => {
    connectCalls += 1
  },
  listTools: async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo a message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }),
  callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
    callToolCalls.push(req)
    if (failNextCall) {
      failNextCall = false
      throw new Error('connection reset')
    }
    return { content: [{ type: 'text', text: `echo:${req.arguments.text}` }] }
  },
  close: async () => {
    closeCalls += 1
  },
}

mock.module('@/server/db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => Promise.resolve(servers[0]),
        }),
        all: () => Promise.resolve(servers),
      }),
    }),
  },
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  mcpServers: { _name: 'mcp_servers', id: 'id' },
  agentMcpServers: { _name: 'agent_mcp_servers' },
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

mock.module('@/server/lib/process', () => ({
  augmentedPath: '/usr/bin',
  killProcessTree: async (pid: number) => {
    killedPids.push(pid)
  },
}))

mock.module('@/server/tools/tool-helper', () => ({
  tool: (def: unknown) => def,
}))

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockClient.connect
    listTools = mockClient.listTools
    callTool = mockClient.callTool
    close = mockClient.close
  },
}))

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class StdioClientTransport {
    pid = 4242
    constructor(opts: { command: string; args: string[]; env?: Record<string, string> }) {
      lastStdioCtor = opts
    }
  },
}))

mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
    constructor(url: URL, opts?: unknown) {
      lastHttpCtor = { url: url.toString(), opts }
    }
  },
}))

mock.module('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class SSEClientTransport {
    constructor(url: URL, opts?: unknown) {
      lastSseCtor = { url: url.toString(), opts }
    }
  },
}))

const {
  createMcpTransport,
  disconnectAll,
  disconnectServer,
  getConnectionStatus,
  resolveMCPTools,
  testConnection,
} = await import('./mcp')

beforeEach(async () => {
  await disconnectAll()
  servers = []
  lastHttpCtor = null
  lastSseCtor = null
  lastStdioCtor = null
  killedPids = []
  closeCalls = 0
  connectCalls = 0
  callToolCalls = []
  failNextCall = false
})

describe('createMcpTransport', () => {
  it('builds Streamable HTTP with request headers', () => {
    const { kind } = createMcpTransport({
      name: 'Remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: JSON.stringify({ Authorization: 'Bearer secret' }),
    })
    expect(kind).toBe('http')
    expect(lastHttpCtor?.url).toBe('https://mcp.example.com/mcp')
    expect(lastHttpCtor?.opts).toEqual({
      requestInit: { headers: { Authorization: 'Bearer secret' } },
    })
    expect(lastStdioCtor).toBeNull()
  })

  it('builds SSE without headers when none are stored', () => {
    const { kind } = createMcpTransport({
      name: 'Legacy',
      transport: 'sse',
      url: 'https://legacy.example.com/sse',
    })
    expect(kind).toBe('sse')
    expect(lastSseCtor?.url).toBe('https://legacy.example.com/sse')
    expect(lastSseCtor?.opts).toBeUndefined()
  })

  it('builds stdio with command and env', () => {
    const { kind } = createMcpTransport({
      name: 'Local',
      transport: 'stdio',
      command: 'npx',
      args: JSON.stringify(['-y', 'pkg']),
      env: JSON.stringify({ TOKEN: 'abc' }),
    })
    expect(kind).toBe('stdio')
    expect(lastStdioCtor?.command).toBe('npx')
    expect(lastStdioCtor?.args).toEqual(['-y', 'pkg'])
    expect(lastStdioCtor?.env?.TOKEN).toBe('abc')
  })
})

describe('HTTP connect / listTools / callTool', () => {
  function remoteServer(overrides: Partial<ServerRow> = {}): ServerRow {
    return {
      id: 'srv-http',
      name: 'Remote',
      command: '',
      args: null,
      env: null,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: JSON.stringify({ Authorization: 'Bearer tok' }),
      status: 'active',
      ...overrides,
    }
  }

  it('connects over Streamable HTTP and reports discovered tools', async () => {
    servers = [remoteServer()]
    const status = await getConnectionStatus('srv-http')
    expect(status).toEqual({ connected: true, toolCount: 1 })
    expect(connectCalls).toBe(1)
    expect(lastHttpCtor?.url).toBe('https://mcp.example.com/mcp')
  })

  async function callResolved(tools: Awaited<ReturnType<typeof resolveMCPTools>>, name: string, args: Record<string, unknown>) {
    const resolved = tools[name]
    if (!resolved?.execute) throw new Error(`missing tool ${name}`)
    return resolved.execute(args, { messages: [], toolCallId: 't1' } as never)
  }

  it('exposes mcp_<server>_<tool> and forwards callTool', async () => {
    servers = [remoteServer()]
    const tools = await resolveMCPTools('agent-1')
    expect(Object.keys(tools)).toEqual(['mcp_remote_echo'])
    const result = await callResolved(tools, 'mcp_remote_echo', { text: 'hi' })
    expect(result).toBe('echo:hi')
    expect(callToolCalls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }])
  })

  it('reconnects once after a failed HTTP tool call', async () => {
    servers = [remoteServer()]
    const tools = await resolveMCPTools('agent-1')
    failNextCall = true
    const result = await callResolved(tools, 'mcp_remote_echo', { text: 'retry' })
    expect(result).toBe('echo:retry')
    expect(connectCalls).toBe(2)
    expect(callToolCalls).toHaveLength(2)
  })

  it('does not kill a process tree when disconnecting HTTP', async () => {
    servers = [remoteServer()]
    await testConnection('srv-http')
    await disconnectServer('srv-http')
    expect(killedPids).toEqual([])
    expect(closeCalls).toBeGreaterThan(0)
  })

  it('kills the stdio process tree on disconnect', async () => {
    servers = [{
      id: 'srv-stdio',
      name: 'Local',
      command: 'npx',
      args: null,
      env: null,
      transport: 'stdio',
      url: null,
      headers: null,
      status: 'active',
    }]
    await getConnectionStatus('srv-stdio')
    await disconnectServer('srv-stdio')
    expect(killedPids).toEqual([4242])
  })

  it('skips pending_approval servers', async () => {
    servers = [remoteServer({ status: 'pending_approval' })]
    const status = await getConnectionStatus('srv-http')
    expect(status.connected).toBe(false)
    expect(connectCalls).toBe(0)
  })
})
