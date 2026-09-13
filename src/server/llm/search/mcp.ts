/**
 * MCP search provider — a generic adapter that backs `web_search` with a
 * tool on a configured MCP server.
 *
 * This is registry plumbing, not a vendor connector. The admin picks an
 * already-registered MCP server and one of its tools; Hivekeep maps the
 * normalised `SearchRequest` onto that tool's JSON Schema and parses the
 * result back into `SearchResult`. No third-party MCP is hardcoded.
 *
 * Auth lives on the MCP server (stdio env / HTTP headers). This provider
 * itself has no API key. See docs-site/features/mcp.md for which tools
 * qualify, and the gaps (OAuth, required extra fields, unstructured output).
 */

import {
  AuthError,
  InvalidRequestError,
  NetworkError,
} from '@hivekeep/sdk'
import type { AuthResult, ProviderConfig } from '@hivekeep/sdk'
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchResultEntry,
} from '@/server/llm/search/types'
import {
  findMcpServerByRef,
  invokeMcpTool,
  listMcpServerTools,
  sanitizeMcpName,
  type MCPToolDef,
} from '@/server/services/mcp'

/**
 * Runtime hooks the provider calls. Tests replace these instead of
 * `mock.module('@/server/services/mcp')`, which is process-global and
 * poisons parallel suites that import the real MCP service.
 */
export const mcpSearchRuntime = {
  findServer: findMcpServerByRef,
  listTools: listMcpServerTools,
  invoke: invokeMcpTool,
}

/** Input keys we treat as the search query, in preference order. */
export const QUERY_ARG_ALIASES = [
  'query',
  'q',
  'search_query',
  'searchQuery',
  'search',
  'keywords',
  'question',
  'prompt',
  'text',
  'input',
] as const

const COUNT_ALIASES = [
  'count', 'num_results', 'max_results', 'maxResults', 'numResults',
  'limit', 'n', 'top_k', 'topK',
] as const

const FRESHNESS_ALIASES = [
  'freshness', 'time_range', 'timeRange', 'recency', 'search_recency_filter',
] as const

const LANG_ALIASES = ['lang', 'language', 'hl', 'search_lang'] as const

const LOCATION_ALIASES = ['location', 'country', 'gl', 'region'] as const

const INCLUDE_DOMAIN_ALIASES = [
  'include_domains', 'includeDomains', 'domains', 'site',
] as const

const EXCLUDE_DOMAIN_ALIASES = ['exclude_domains', 'excludeDomains'] as const

const ANSWER_ALIASES = ['answer', 'include_answer', 'includeAnswer'] as const

export interface McpToolQualification {
  ok: boolean
  /** Schema key the query is written to. Present when `ok` is true. */
  queryKey?: string
  /** Required properties we cannot map from SearchRequest. */
  unknownRequired?: string[]
  error?: string
}

export interface MappedMcpSearchArgs {
  args: Record<string, unknown>
  queryKey: string
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    return schema.properties as Record<string, Record<string, unknown>>
  }
  return {}
}

function schemaRequired(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === 'string')
    : []
}

function findAliasKey(
  props: Record<string, unknown>,
  aliases: readonly string[],
): string | undefined {
  const keys = Object.keys(props)
  for (const alias of aliases) {
    if (alias in props) return alias
    const found = keys.find((k) => k.toLowerCase() === alias.toLowerCase())
    if (found) return found
  }
  return undefined
}

function isStringishProp(prop: Record<string, unknown> | undefined): boolean {
  if (!prop) return true
  const t = prop.type
  return t === undefined || t === 'string' || (Array.isArray(t) && t.includes('string'))
}

/**
 * Pick the input property that receives `SearchRequest.query`.
 *
 * Order: explicit `queryArg` (must exist on the schema) → alias list.
 * We do not guess from an arbitrary required string (`path`, `file`, …)
 * — set `queryArg` for non-standard names like `topic`.
 */
export function resolveQueryArg(
  schema: Record<string, unknown>,
  queryArg?: string,
): string | undefined {
  const props = schemaProperties(schema)
  const explicit = queryArg?.trim()
  if (explicit) {
    if (explicit in props) return explicit
    const ci = Object.keys(props).find((k) => k.toLowerCase() === explicit.toLowerCase())
    return ci
  }

  const aliased = findAliasKey(props, QUERY_ARG_ALIASES)
  if (aliased && isStringishProp(props[aliased])) return aliased

  return undefined
}

/** Every SearchRequest field we know how to map, plus the query key. */
function mappableKeys(schema: Record<string, unknown>, queryKey: string): Set<string> {
  const props = schemaProperties(schema)
  const keys = new Set<string>([queryKey])
  const add = (aliases: readonly string[]) => {
    const k = findAliasKey(props, aliases)
    if (k) keys.add(k)
  }
  add(COUNT_ALIASES)
  add(FRESHNESS_ALIASES)
  add(LANG_ALIASES)
  add(LOCATION_ALIASES)
  add(INCLUDE_DOMAIN_ALIASES)
  add(EXCLUDE_DOMAIN_ALIASES)
  add(ANSWER_ALIASES)
  return keys
}

/**
 * A tool qualifies when we can identify a query string argument and every
 * required input is either that query argument or another known
 * SearchRequest mapping (count / freshness / lang / location / domains /
 * answer). Unknown required fields fail closed — we will not invent values.
 */
export function qualifyMcpSearchTool(
  schema: Record<string, unknown>,
  queryArg?: string,
): McpToolQualification {
  const props = schemaProperties(schema)
  const queryKey = resolveQueryArg(schema, queryArg)
  if (!queryKey) {
    const available = Object.keys(props)
    return {
      ok: false,
      error: available.length
        ? `No query-like argument on this tool. Available inputs: ${available.join(', ')}. Set queryArg to the string field that should receive the search query.`
        : 'This tool has no input properties, so it cannot receive a search query.',
    }
  }

  const known = mappableKeys(schema, queryKey)
  const unknownRequired = schemaRequired(schema).filter((k) => !known.has(k))
  if (unknownRequired.length > 0) {
    return {
      ok: false,
      queryKey,
      unknownRequired,
      error:
        `Tool requires extra fields Hivekeep cannot fill from web_search: ${unknownRequired.join(', ')}. ` +
        `A qualifying search tool's required inputs must be the query (and optionally count / freshness / language / location / domains / answer).`,
    }
  }

  return { ok: true, queryKey }
}

function coerceForProp(prop: Record<string, unknown> | undefined, value: unknown): unknown {
  const t = prop?.type
  if (t === 'string' && typeof value !== 'string') {
    if (Array.isArray(value)) return value.join(',')
    return String(value)
  }
  if ((t === 'number' || t === 'integer') && typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (t === 'boolean' && typeof value !== 'boolean') {
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
  }
  return value
}

/**
 * Map a normalised SearchRequest onto a tool's input schema. Only keys
 * that exist on the schema are set. Unknown request fields are dropped
 * (same contract as SearchRequest.extra: tolerate, don't reject).
 */
export function mapSearchRequestToToolArgs(
  request: SearchRequest,
  schema: Record<string, unknown>,
  queryArg?: string,
): MappedMcpSearchArgs {
  const qualified = qualifyMcpSearchTool(schema, queryArg)
  if (!qualified.ok || !qualified.queryKey) {
    throw new InvalidRequestError(qualified.error ?? 'MCP search tool does not qualify.')
  }

  const props = schemaProperties(schema)
  const args: Record<string, unknown> = {
    [qualified.queryKey]: request.query,
  }

  const set = (aliases: readonly string[], value: unknown | undefined) => {
    if (value === undefined) return
    const key = findAliasKey(props, aliases)
    if (!key) return
    args[key] = coerceForProp(props[key], value)
  }

  if (request.count !== undefined) {
    set(COUNT_ALIASES, Math.max(1, Math.min(20, request.count)))
  } else if (findAliasKey(props, COUNT_ALIASES) && schemaRequired(schema).includes(findAliasKey(props, COUNT_ALIASES)!)) {
    set(COUNT_ALIASES, 5)
  }

  if (request.freshness && request.freshness !== 'all') {
    set(FRESHNESS_ALIASES, request.freshness)
  }
  set(LANG_ALIASES, request.lang)
  set(LOCATION_ALIASES, request.location)

  const include = request.domains?.include
  const exclude = request.domains?.exclude
  if (include?.length) {
    const key = findAliasKey(props, INCLUDE_DOMAIN_ALIASES)
    if (key) {
      const prop = props[key]
      args[key] = coerceForProp(
        prop,
        prop?.type === 'string' ? include.join(',') : include,
      )
    }
  }
  if (exclude?.length) {
    const key = findAliasKey(props, EXCLUDE_DOMAIN_ALIASES)
    if (key) {
      const prop = props[key]
      args[key] = coerceForProp(
        prop,
        prop?.type === 'string' ? exclude.join(',') : exclude,
      )
    }
  }

  if (request.answer !== undefined) set(ANSWER_ALIASES, request.answer)

  return { args, queryKey: qualified.queryKey }
}

/**
 * Match a configured tool name against a server's catalogue.
 * Accepts the raw MCP name, a sanitised name, or the grant name
 * `mcp_<server>_<tool>`.
 */
export function matchMcpTool(
  tools: MCPToolDef[],
  requested: string,
  serverName: string,
): MCPToolDef | undefined {
  const needle = requested.trim()
  if (!needle) return undefined

  const exact = tools.find((t) => t.name === needle)
  if (exact) return exact

  const san = sanitizeMcpName(needle)
  const bySanitised = tools.find((t) => sanitizeMcpName(t.name) === san)
  if (bySanitised) return bySanitised

  const prefix = `mcp_${sanitizeMcpName(serverName)}_`
  if (san.startsWith(prefix)) {
    const rest = san.slice(prefix.length)
    return tools.find((t) => sanitizeMcpName(t.name) === rest)
  }

  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function pickString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

function pickPublishedAt(rec: Record<string, unknown>): number | undefined {
  for (const k of ['publishedAt', 'published_at', 'published_date', 'publishedDate', 'date', 'page_age']) {
    const v = rec[k]
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v > 1e12 ? v : v * 1000
    }
    if (typeof v === 'string') {
      const ms = Date.parse(v)
      if (Number.isFinite(ms)) return ms
    }
  }
  return undefined
}

function pickDomain(url: string, rec?: Record<string, unknown>): string | undefined {
  const fromRec = rec ? pickString(rec, ['domain', 'hostname', 'source']) : undefined
  if (fromRec) return fromRec
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function mapEntry(raw: unknown): SearchResultEntry | undefined {
  if (typeof raw === 'string') {
    const url = raw.trim()
    if (!/^https?:\/\//i.test(url)) return undefined
    return { title: url, url, ...(pickDomain(url) ? { domain: pickDomain(url)! } : {}) }
  }
  const rec = asRecord(raw)
  if (!rec) return undefined
  const url = pickString(rec, ['url', 'link', 'href', 'uri'])
  if (!url || !/^https?:\/\//i.test(url)) return undefined
  const title = pickString(rec, ['title', 'name', 'headline']) ?? url
  const snippet = pickString(rec, ['snippet', 'description', 'content', 'text', 'summary', 'excerpt'])
  const publishedAt = pickPublishedAt(rec)
  const domain = pickDomain(url, rec)
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(domain ? { domain } : {}),
  }
}

function collectResultArrays(value: unknown, depth = 0): unknown[] {
  if (depth > 3) return []
  if (Array.isArray(value)) return value
  const rec = asRecord(value)
  if (!rec) return []

  for (const key of ['results', 'organic_results', 'items', 'hits', 'web_results']) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[]
  }
  const web = asRecord(rec.web)
  if (web && Array.isArray(web.results)) return web.results
  const data = rec.data
  if (Array.isArray(data)) return data
  const dataRec = asRecord(data)
  if (dataRec) return collectResultArrays(dataRec, depth + 1)
  return []
}

function parseMarkdownResults(text: string): SearchResultEntry[] {
  const entries: SearchResultEntry[] = []
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = md.exec(text)) !== null) {
    const title = m[1]!.trim()
    const url = m[2]!.trim()
    entries.push({ title, url, ...(pickDomain(url) ? { domain: pickDomain(url)! } : {}) })
  }
  if (entries.length > 0) return entries

  const bare = text.match(/https?:\/\/[^\s<>"']+/g) ?? []
  for (const url of bare) {
    const cleaned = url.replace(/[),.;]+$/, '')
    entries.push({
      title: cleaned,
      url: cleaned,
      ...(pickDomain(cleaned) ? { domain: pickDomain(cleaned)! } : {}),
    })
  }
  return entries
}

function pickAnswerText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const rec = asRecord(value)
  if (!rec) return undefined
  return pickString(rec, ['answer', 'summary', 'text', 'message', 'content'])
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const start = trimmed[0]
  if (start !== '{' && start !== '[') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Best-effort conversion of an MCP tool result into `SearchResult`.
 *
 * Handles structured JSON (arrays / `{ results }` / Brave-style
 * `{ web: { results } }`), markdown `[title](url)` lists, bare URLs,
 * and unstructured text (surfaced as `answer`).
 */
export function parseMcpSearchOutput(output: unknown, count?: number): SearchResult {
  let value = output
  if (typeof value === 'string') {
    const parsed = tryParseJson(value)
    if (parsed !== undefined) value = parsed
  }

  const warnings: string[] = []
  let results = collectResultArrays(value).map(mapEntry).filter((e): e is SearchResultEntry => !!e)

  if (results.length === 0 && typeof output === 'string') {
    results = parseMarkdownResults(output)
  } else if (results.length === 0 && typeof value === 'string') {
    results = parseMarkdownResults(value)
  }

  if (results.length === 0) {
    const single = mapEntry(value)
    if (single) results = [single]
  }

  if (count !== undefined) {
    results = results.slice(0, Math.max(1, count))
  }

  const answerText = results.length === 0 ? pickAnswerText(value) ?? pickAnswerText(output) : pickAnswerText(value)
  const out: SearchResult = { results }

  if (results.length === 0 && answerText) {
    out.answer = { text: answerText }
    warnings.push(
      'MCP tool did not return parseable result URLs — the raw text is in `answer`. Use browse_url if you have a specific page to read.',
    )
  } else if (results.length === 0) {
    warnings.push(
      'MCP tool returned no parseable search results (expected JSON entries with url, a results array, or markdown links).',
    )
  } else if (answerText && answerText !== output) {
    out.answer = { text: answerText }
  }

  if (warnings.length) out.warnings = warnings
  return out
}

function readConfigField(config: ProviderConfig, key: string): string {
  return (config[key] ?? '').trim()
}

function requireServerAndTool(config: ProviderConfig): { server: string; tool: string; queryArg?: string } {
  const server = readConfigField(config, 'server')
  const tool = readConfigField(config, 'tool')
  if (!server) {
    throw new InvalidRequestError('Missing MCP server (config.server). Use the server name or id from Settings → MCP.')
  }
  if (!tool) {
    throw new InvalidRequestError('Missing MCP tool (config.tool). Use the raw tool name or the mcp_<server>_<tool> grant name.')
  }
  const queryArg = readConfigField(config, 'queryArg')
  return { server, tool, ...(queryArg ? { queryArg } : {}) }
}

export const mcpSearchProvider: SearchProvider = {
  type: 'mcp',
  displayName: 'MCP',
  reactIcon: 'lu/LuPlug',
  noApiKey: true,
  configSchema: [
    {
      key: 'server',
      type: 'text',
      label: 'MCP server',
      required: true,
      placeholder: 'Name or id from Settings → MCP',
      description:
        'Already-registered MCP server that exposes a search tool. Name or id. Auth stays on that server (stdio env / HTTP headers) — this provider has no API key of its own.',
    },
    {
      key: 'tool',
      type: 'text',
      label: 'Search tool',
      required: true,
      placeholder: 'web_search',
      description:
        'Tool on that server to call. Raw MCP name (e.g. web_search) or the grant name mcp_<server>_<tool>. The tool must take a query-like string and must not require extra fields Hivekeep cannot fill.',
    },
    {
      key: 'queryArg',
      type: 'text',
      label: 'Query argument',
      required: false,
      placeholder: 'query',
      description:
        'Optional. Input field that receives the search query. Auto-detected from query, q, search, and similar names when omitted.',
    },
  ],
  capabilities: {
    // Unstructured MCP text is surfaced as `answer`. Other SearchRequest
    // knobs are mapped when the tool schema has a matching key, but we
    // cannot advertise them — the chosen tool may ignore them.
    supportsAnswer: true,
    supportsFreshness: false,
    supportsDomainFilter: false,
    supportsLanguage: false,
    supportsLocation: false,
  },

  async authenticate(config): Promise<AuthResult> {
    let target: { server: string; tool: string; queryArg?: string }
    try {
      target = requireServerAndTool(config)
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    const row = await mcpSearchRuntime.findServer(target.server)
    if (!row) {
      return {
        valid: false,
        error: `No MCP server matches "${target.server}". Register one in Settings → MCP, then use its name or id.`,
      }
    }
    if (row.status !== 'active') {
      return {
        valid: false,
        error: `MCP server "${row.name}" is ${row.status}. Approve or activate it before using it as a search backend.`,
      }
    }

    const tools = await mcpSearchRuntime.listTools(row.id)
    if (!tools) {
      return {
        valid: false,
        error: `Could not connect to MCP server "${row.name}". Check its command/URL, credentials, and that it completes the MCP handshake.`,
      }
    }

    const tool = matchMcpTool(tools, target.tool, row.name)
    if (!tool) {
      const names = tools.map((t) => t.name).join(', ') || '(none)'
      return {
        valid: false,
        error: `Tool "${target.tool}" not found on MCP server "${row.name}". Available: ${names}.`,
      }
    }

    const qualified = qualifyMcpSearchTool(tool.inputSchema, target.queryArg)
    if (!qualified.ok) {
      return { valid: false, error: qualified.error }
    }

    return { valid: true, accountLabel: `${row.name} / ${tool.name}` }
  },

  async search(request, config): Promise<SearchResult> {
    const target = requireServerAndTool(config)

    const row = await mcpSearchRuntime.findServer(target.server)
    if (!row) {
      throw new InvalidRequestError(
        `No MCP server matches "${target.server}". Register one in Settings → MCP.`,
      )
    }
    if (row.status !== 'active') {
      throw new AuthError(
        `MCP server "${row.name}" is ${row.status} and cannot serve web_search.`,
      )
    }

    const tools = await mcpSearchRuntime.listTools(row.id)
    if (!tools) {
      throw new NetworkError(
        `Could not connect to MCP server "${row.name}".`,
      )
    }

    const tool = matchMcpTool(tools, target.tool, row.name)
    if (!tool) {
      throw new InvalidRequestError(
        `Tool "${target.tool}" not found on MCP server "${row.name}".`,
      )
    }

    const { args } = mapSearchRequestToToolArgs(request, tool.inputSchema, target.queryArg)

    let raw: unknown
    try {
      raw = await mcpSearchRuntime.invoke(row.id, tool.name, args, request.signal)
    } catch (err) {
      throw new NetworkError(
        `MCP search tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    return parseMcpSearchOutput(raw, request.count)
  },
}
