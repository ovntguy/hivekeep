import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SearchRequest } from '@/server/llm/search/types'
import type { MCPToolDef } from '@/server/services/mcp'
import {
  qualifyMcpSearchTool,
  resolveQueryArg,
  mapSearchRequestToToolArgs,
  matchMcpTool,
  parseMcpSearchOutput,
  mcpSearchProvider,
  mcpSearchRuntime,
} from './mcp'

type ServerRow = {
  id: string
  name: string
  status: string
}

const servers: ServerRow[] = []
let toolsByServer: Record<string, MCPToolDef[] | null> = {}
let invokeImpl: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> =
  async () => ({ results: [] })
const invokeCalls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = []

const realRuntime = { ...mcpSearchRuntime }

beforeEach(() => {
  servers.length = 0
  toolsByServer = {}
  invokeCalls.length = 0
  invokeImpl = async () => ({ results: [] })
  mcpSearchRuntime.findServer = async (ref: string) => {
    const needle = ref.trim()
    return servers.find((s) => s.id === needle || s.name === needle) as Awaited<ReturnType<typeof realRuntime.findServer>>
  }
  mcpSearchRuntime.listTools = async (serverId: string) => {
    if (serverId in toolsByServer) return toolsByServer[serverId] ?? null
    return []
  }
  mcpSearchRuntime.invoke = async (serverId, toolName, args) => {
    invokeCalls.push({ serverId, toolName, args })
    return invokeImpl(serverId, toolName, args)
  }
})

afterEach(() => {
  Object.assign(mcpSearchRuntime, realRuntime)
})

const querySchema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
}

function req(query: string, extra: Partial<SearchRequest> = {}): SearchRequest {
  return { query, ...extra }
}

// ─── resolveQueryArg / qualify ───────────────────────────────────────────────

describe('resolveQueryArg', () => {
  it('prefers explicit queryArg when it exists on the schema', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' }, prompt: { type: 'string' } },
    }
    expect(resolveQueryArg(schema, 'prompt')).toBe('prompt')
  })

  it('matches queryArg case-insensitively', () => {
    const schema = { type: 'object', properties: { SearchQuery: { type: 'string' } } }
    expect(resolveQueryArg(schema, 'searchquery')).toBe('SearchQuery')
  })

  it('returns undefined when explicit queryArg is missing from the schema', () => {
    expect(resolveQueryArg(querySchema, 'nope')).toBeUndefined()
  })

  it('walks the alias list in preference order', () => {
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' }, q: { type: 'string' } },
    }
    expect(resolveQueryArg(schema)).toBe('q')
  })

  it('does not guess a non-alias required string (use queryArg for topic, path, …)', () => {
    const schema = {
      type: 'object',
      properties: { topic: { type: 'string' }, limit: { type: 'number' } },
      required: ['topic'],
    }
    expect(resolveQueryArg(schema)).toBeUndefined()
    expect(resolveQueryArg(schema, 'topic')).toBe('topic')
  })
})

describe('qualifyMcpSearchTool', () => {
  it('accepts a tool whose only required input is query', () => {
    expect(qualifyMcpSearchTool(querySchema)).toEqual({ ok: true, queryKey: 'query' })
  })

  it('accepts optional unknown fields', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        country: { type: 'string' },
        mystery: { type: 'string' },
      },
      required: ['query'],
    }
    expect(qualifyMcpSearchTool(schema).ok).toBe(true)
  })

  it('rejects a tool that requires an unmappable field', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        collection: { type: 'string' },
      },
      required: ['query', 'collection'],
    }
    const q = qualifyMcpSearchTool(schema)
    expect(q.ok).toBe(false)
    expect(q.unknownRequired).toEqual(['collection'])
    expect(q.error).toContain('collection')
  })

  it('rejects a tool with no query-like input', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
    }
    const q = qualifyMcpSearchTool(schema)
    expect(q.ok).toBe(false)
    expect(q.error).toContain('path')
  })

  it('accepts a non-alias query field when queryArg is set', () => {
    const schema = {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    }
    expect(qualifyMcpSearchTool(schema).ok).toBe(false)
    expect(qualifyMcpSearchTool(schema, 'topic')).toEqual({ ok: true, queryKey: 'topic' })
  })

  it('treats count/freshness/lang as mappable required fields', () => {
    const schema = {
      type: 'object',
      properties: {
        q: { type: 'string' },
        max_results: { type: 'number' },
        time_range: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['q', 'max_results'],
    }
    expect(qualifyMcpSearchTool(schema)).toMatchObject({ ok: true, queryKey: 'q' })
  })
})

// ─── mapSearchRequestToToolArgs ──────────────────────────────────────────────

describe('mapSearchRequestToToolArgs', () => {
  const richSchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
      time_range: { type: 'string' },
      language: { type: 'string' },
      country: { type: 'string' },
      include_domains: { type: 'array' },
      exclude_domains: { type: 'array' },
      include_answer: { type: 'boolean' },
    },
    required: ['query'],
  }

  it('writes the query to the resolved key', () => {
    const { args, queryKey } = mapSearchRequestToToolArgs(req('cats'), querySchema)
    expect(queryKey).toBe('query')
    expect(args).toEqual({ query: 'cats' })
  })

  it('maps optional SearchRequest fields only when the schema has them', () => {
    const { args } = mapSearchRequestToToolArgs(
      req('news', {
        count: 8,
        freshness: 'week',
        lang: 'fr',
        location: 'FR',
        domains: { include: ['example.com'], exclude: ['spam.test'] },
        answer: true,
      }),
      richSchema,
    )
    expect(args).toEqual({
      query: 'news',
      max_results: 8,
      time_range: 'week',
      language: 'fr',
      country: 'FR',
      include_domains: ['example.com'],
      exclude_domains: ['spam.test'],
      include_answer: true,
    })
  })

  it('drops request fields the tool schema does not declare', () => {
    const { args } = mapSearchRequestToToolArgs(
      req('x', { count: 3, freshness: 'day', lang: 'en', location: 'US', answer: true }),
      querySchema,
    )
    expect(args).toEqual({ query: 'x' })
  })

  it('clamps count to 1–20', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' }, count: { type: 'number' } },
    }
    expect(mapSearchRequestToToolArgs(req('x', { count: 99 }), schema).args.count).toBe(20)
    expect(mapSearchRequestToToolArgs(req('x', { count: 0 }), schema).args.count).toBe(1)
  })

  it('sends a default count when that field is required and the request omits it', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query', 'limit'],
    }
    expect(mapSearchRequestToToolArgs(req('x'), schema).args.limit).toBe(5)
  })

  it('joins include domains when the schema wants a string', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' }, site: { type: 'string' } },
    }
    const { args } = mapSearchRequestToToolArgs(
      req('x', { domains: { include: ['a.com', 'b.com'] } }),
      schema,
    )
    expect(args.site).toBe('a.com,b.com')
  })

  it('throws when the tool does not qualify', () => {
    expect(() => mapSearchRequestToToolArgs(req('x'), { type: 'object', properties: {} }))
      .toThrow(/no input properties/i)
  })
})

// ─── matchMcpTool ────────────────────────────────────────────────────────────

describe('matchMcpTool', () => {
  const tools: MCPToolDef[] = [
    { name: 'web_search', description: '', inputSchema: querySchema },
    { name: 'search-news', description: '', inputSchema: querySchema },
  ]

  it('matches the raw MCP tool name', () => {
    expect(matchMcpTool(tools, 'web_search', 'Brave')?.name).toBe('web_search')
  })

  it('matches a sanitised name', () => {
    expect(matchMcpTool(tools, 'search news', 'News API')?.name).toBe('search-news')
  })

  it('matches the mcp_<server>_<tool> grant name', () => {
    expect(matchMcpTool(tools, 'mcp_brave_web_search', 'Brave')?.name).toBe('web_search')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchMcpTool(tools, 'browse', 'Brave')).toBeUndefined()
  })
})

// ─── parseMcpSearchOutput ────────────────────────────────────────────────────

describe('parseMcpSearchOutput', () => {
  it('reads a { results } array with title/url/snippet', () => {
    const out = parseMcpSearchOutput({
      results: [
        { title: 'One', url: 'https://one.example', snippet: 'a' },
        { title: 'Two', url: 'https://two.example', description: 'b' },
      ],
    })
    expect(out.results).toEqual([
      { title: 'One', url: 'https://one.example', snippet: 'a', domain: 'one.example' },
      { title: 'Two', url: 'https://two.example', snippet: 'b', domain: 'two.example' },
    ])
    expect(out.answer).toBeUndefined()
  })

  it('reads Brave-style web.results and organic_results', () => {
    expect(parseMcpSearchOutput({
      web: { results: [{ title: 'W', url: 'https://w.example' }] },
    }).results[0]?.url).toBe('https://w.example')

    expect(parseMcpSearchOutput({
      organic_results: [{ title: 'O', link: 'https://o.example' }],
    }).results[0]?.url).toBe('https://o.example')
  })

  it('parses a JSON string payload', () => {
    const out = parseMcpSearchOutput(JSON.stringify({
      results: [{ title: 'J', url: 'https://j.example' }],
    }))
    expect(out.results).toHaveLength(1)
    expect(out.results[0]?.title).toBe('J')
  })

  it('parses markdown links and bare URLs', () => {
    const md = parseMcpSearchOutput('See [Docs](https://docs.example/page) for more.')
    expect(md.results).toEqual([
      { title: 'Docs', url: 'https://docs.example/page', domain: 'docs.example' },
    ])

    const bare = parseMcpSearchOutput('try https://bare.example/x now')
    expect(bare.results[0]?.url).toBe('https://bare.example/x')
  })

  it('surfaces unstructured text as an answer with a warning', () => {
    const out = parseMcpSearchOutput('No links here, just a summary of the topic.')
    expect(out.results).toEqual([])
    expect(out.answer?.text).toContain('No links here')
    expect(out.warnings?.[0]).toMatch(/raw text is in `answer`/)
  })

  it('clamps to count', () => {
    const out = parseMcpSearchOutput({
      results: [
        { url: 'https://a.example' },
        { url: 'https://b.example' },
        { url: 'https://c.example' },
      ],
    }, 2)
    expect(out.results).toHaveLength(2)
  })

  it('keeps a synthesized answer alongside structured results', () => {
    const out = parseMcpSearchOutput({
      answer: 'Cats are small.',
      results: [{ title: 'Cat', url: 'https://cat.example' }],
    })
    expect(out.answer).toEqual({ text: 'Cats are small.' })
    expect(out.results).toHaveLength(1)
  })
})

// ─── provider metadata / authenticate / search ───────────────────────────────

describe('mcpSearchProvider', () => {
  it('registers as type mcp with no API key', () => {
    expect(mcpSearchProvider.type).toBe('mcp')
    expect(mcpSearchProvider.noApiKey).toBe(true)
    expect(mcpSearchProvider.capabilities.supportsAnswer).toBe(true)
    expect(mcpSearchProvider.capabilities.supportsFreshness).toBe(false)
    expect(mcpSearchProvider.configSchema.map((f) => f.key)).toEqual(['server', 'tool', 'queryArg'])
  })

  it('authenticate fails when server/tool config is missing', async () => {
    const missingServer = await mcpSearchProvider.authenticate({})
    expect(missingServer.valid).toBe(false)
    expect(missingServer.error).toMatch(/Missing MCP server/)

    const missingTool = await mcpSearchProvider.authenticate({ server: 'Search' })
    expect(missingTool.valid).toBe(false)
    expect(missingTool.error).toMatch(/Missing MCP tool/)
  })

  it('authenticate fails when the server is unknown or not active', async () => {
    const unknown = await mcpSearchProvider.authenticate({ server: 'Nope', tool: 'web_search' })
    expect(unknown.valid).toBe(false)
    expect(unknown.error).toMatch(/No MCP server matches/)

    servers.push({ id: 's1', name: 'Search', status: 'pending_approval' })
    const pending = await mcpSearchProvider.authenticate({ server: 'Search', tool: 'web_search' })
    expect(pending.valid).toBe(false)
    expect(pending.error).toMatch(/pending_approval/)
  })

  it('authenticate fails when the tool is missing or does not qualify', async () => {
    servers.push({ id: 's1', name: 'Search', status: 'active' })
    toolsByServer.s1 = [
      { name: 'echo', description: '', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ]

    const missing = await mcpSearchProvider.authenticate({ server: 'Search', tool: 'web_search' })
    expect(missing.valid).toBe(false)
    expect(missing.error).toMatch(/not found/)

    toolsByServer.s1 = [
      { name: 'write_file', description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ]
    const write = await mcpSearchProvider.authenticate({ server: 'Search', tool: 'write_file' })
    expect(write.valid).toBe(false)
    expect(write.error).toMatch(/No query-like argument/)
  })

  it('authenticate succeeds for a qualifying tool and returns an account label', async () => {
    servers.push({ id: 's1', name: 'Hosted Search', status: 'active' })
    toolsByServer.s1 = [
      { name: 'web_search', description: 'Search the web', inputSchema: querySchema },
    ]
    const ok = await mcpSearchProvider.authenticate({ server: 'Hosted Search', tool: 'web_search' })
    expect(ok).toEqual({ valid: true, accountLabel: 'Hosted Search / web_search' })
  })

  it('search invokes the MCP tool with mapped args and parses results', async () => {
    servers.push({ id: 's1', name: 'Hosted Search', status: 'active' })
    toolsByServer.s1 = [
      { name: 'web_search', description: '', inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, max_results: { type: 'number' } },
        required: ['query'],
      } },
    ]
    invokeImpl = async () => ({
      results: [{ title: 'Hivekeep', url: 'https://hivekeep.example', snippet: 'self-hosted agents' }],
    })

    const result = await mcpSearchProvider.search(
      req('hivekeep agents', { count: 3 }),
      { server: 'Hosted Search', tool: 'mcp_hosted_search_web_search' },
    )

    expect(invokeCalls).toEqual([{
      serverId: 's1',
      toolName: 'web_search',
      args: { query: 'hivekeep agents', max_results: 3 },
    }])
    expect(result.results).toEqual([
      {
        title: 'Hivekeep',
        url: 'https://hivekeep.example',
        snippet: 'self-hosted agents',
        domain: 'hivekeep.example',
      },
    ])
  })

  it('search throws when the server cannot be reached', async () => {
    servers.push({ id: 's1', name: 'Down', status: 'active' })
    toolsByServer.s1 = null
    await expect(mcpSearchProvider.search(req('x'), { server: 'Down', tool: 'web_search' }))
      .rejects.toThrow(/Could not connect/)
  })
})
