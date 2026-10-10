import { MCP_TRANSPORTS } from '@/shared/constants'
import type { McpTransport } from '@/shared/types'

const MAX_NAME_LEN = 200
const MAX_COMMAND_LEN = 500
const MAX_URL_LEN = 2000
const MAX_ARGS = 50
const MAX_ARG_LEN = 1000
const MAX_SECRET_ENTRIES = 50
const MAX_SECRET_KEY_LEN = 100
const MAX_SECRET_VALUE_LEN = 10_000

export { MCP_TRANSPORTS }
export type { McpTransport }

export function normalizeMcpTransport(value: unknown): McpTransport {
  if (value === 'http' || value === 'sse' || value === 'stdio') return value
  return 'stdio'
}

export function isRemoteMcpTransport(transport: McpTransport): boolean {
  return transport === 'http' || transport === 'sse'
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseSecretRecord(json: string | null | undefined): Record<string, string> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

export function parseArgs(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function maskSecretRecord(record: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!record) return null
  const keys = Object.keys(record)
  if (keys.length === 0) return null
  return Object.fromEntries(keys.map((key) => [key, '']))
}

/** Merge incoming secrets with stored ones. Empty incoming values keep the existing secret. */
export function mergeSecretRecord(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value || existing[key] || ''
  }
  return merged
}

export interface McpServerConfig {
  name: string
  transport: McpTransport
  command: string
  url: string | null
  args: string[] | null
  env: Record<string, string> | null
  headers: Record<string, string> | null
}

export function validateSecretRecord(
  record: Record<string, string> | null | undefined,
  label: string,
): string | null {
  if (!record) return null
  const entries = Object.entries(record)
  if (entries.length > MAX_SECRET_ENTRIES) {
    return `maximum ${MAX_SECRET_ENTRIES} ${label} allowed`
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_SECRET_KEY_LEN) {
      return `${label} key "${key.slice(0, 20)}..." must be ${MAX_SECRET_KEY_LEN} characters or fewer`
    }
    if (typeof value === 'string' && value.length > MAX_SECRET_VALUE_LEN) {
      return `${label} value for "${key}" must be ${MAX_SECRET_VALUE_LEN} characters or fewer`
    }
  }
  return null
}

export function validateMcpServerConfig(
  config: McpServerConfig,
): { ok: true } | { ok: false; message: string } {
  const name = config.name.trim()
  if (!name) return { ok: false, message: 'name is required' }
  if (name.length > MAX_NAME_LEN) return { ok: false, message: `name must be ${MAX_NAME_LEN} characters or fewer` }

  if (!MCP_TRANSPORTS.includes(config.transport)) {
    return { ok: false, message: 'transport must be stdio, http, or sse' }
  }

  if (isRemoteMcpTransport(config.transport)) {
    const url = config.url?.trim() ?? ''
    if (!url) return { ok: false, message: 'url is required for HTTP MCP servers' }
    if (url.length > MAX_URL_LEN) return { ok: false, message: `url must be ${MAX_URL_LEN} characters or fewer` }
    if (!isValidHttpUrl(url)) return { ok: false, message: 'url must be an http or https URL' }
  } else {
    const command = config.command.trim()
    if (!command) return { ok: false, message: 'command is required for local MCP servers' }
    if (command.length > MAX_COMMAND_LEN) {
      return { ok: false, message: `command must be ${MAX_COMMAND_LEN} characters or fewer` }
    }
  }

  if (config.args) {
    if (config.args.length > MAX_ARGS) return { ok: false, message: `maximum ${MAX_ARGS} arguments allowed` }
    if (config.args.some((arg) => arg.length > MAX_ARG_LEN)) {
      return { ok: false, message: `each argument must be ${MAX_ARG_LEN} characters or fewer` }
    }
  }

  const envError = validateSecretRecord(config.env, 'env')
  if (envError) return { ok: false, message: envError }

  const headerError = validateSecretRecord(config.headers, 'header')
  if (headerError) return { ok: false, message: headerError }

  return { ok: true }
}

export function serializeSecretJson(record: Record<string, string> | null | undefined): string | null {
  if (!record) return null
  return Object.keys(record).length > 0 ? JSON.stringify(record) : null
}
