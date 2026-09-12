import { describe, expect, it } from 'bun:test'
import {
  isRemoteMcpTransport,
  isValidHttpUrl,
  maskSecretRecord,
  mergeSecretRecord,
  normalizeMcpTransport,
  parseArgs,
  parseSecretRecord,
  serializeSecretJson,
  validateMcpServerConfig,
} from '@/server/services/mcp-config'

describe('normalizeMcpTransport', () => {
  it('accepts stdio, http, and sse', () => {
    expect(normalizeMcpTransport('stdio')).toBe('stdio')
    expect(normalizeMcpTransport('http')).toBe('http')
    expect(normalizeMcpTransport('sse')).toBe('sse')
  })

  it('defaults unknown or missing values to stdio', () => {
    expect(normalizeMcpTransport(undefined)).toBe('stdio')
    expect(normalizeMcpTransport(null)).toBe('stdio')
    expect(normalizeMcpTransport('websocket')).toBe('stdio')
  })
})

describe('isRemoteMcpTransport / isValidHttpUrl', () => {
  it('treats http and sse as remote', () => {
    expect(isRemoteMcpTransport('http')).toBe(true)
    expect(isRemoteMcpTransport('sse')).toBe(true)
    expect(isRemoteMcpTransport('stdio')).toBe(false)
  })

  it('accepts http and https URLs only', () => {
    expect(isValidHttpUrl('https://mcp.example.com/mcp')).toBe(true)
    expect(isValidHttpUrl('http://127.0.0.1:3001/mcp')).toBe(true)
    expect(isValidHttpUrl('ftp://mcp.example.com/mcp')).toBe(false)
    expect(isValidHttpUrl('not-a-url')).toBe(false)
  })
})

describe('secret record helpers', () => {
  it('parses and masks objects, ignoring non-strings', () => {
    expect(parseSecretRecord(null)).toEqual({})
    expect(parseSecretRecord('{"A":"secret","B":1}')).toEqual({ A: 'secret' })
    expect(maskSecretRecord({ A: 'secret' })).toEqual({ A: '' })
    expect(maskSecretRecord({})).toBeNull()
  })

  it('merges empty incoming values with stored secrets', () => {
    expect(mergeSecretRecord({ KEEP: 'old', DROP: 'x' }, { KEEP: '', NEW: 'n' })).toEqual({
      KEEP: 'old',
      NEW: 'n',
    })
  })

  it('serializes empty records as null', () => {
    expect(serializeSecretJson({})).toBeNull()
    expect(serializeSecretJson({ A: 'b' })).toBe(JSON.stringify({ A: 'b' }))
  })

  it('parses args JSON arrays', () => {
    expect(parseArgs(null)).toEqual([])
    expect(parseArgs('["-y","pkg"]')).toEqual(['-y', 'pkg'])
    expect(parseArgs('{"no":"array"}')).toEqual([])
  })
})

describe('validateMcpServerConfig', () => {
  it('requires command for stdio and url for http/sse', () => {
    expect(validateMcpServerConfig({
      name: 'local',
      transport: 'stdio',
      command: '',
      url: null,
      args: null,
      env: null,
      headers: null,
    }).ok).toBe(false)

    expect(validateMcpServerConfig({
      name: 'remote',
      transport: 'http',
      command: '',
      url: null,
      args: null,
      env: null,
      headers: null,
    }).ok).toBe(false)

    expect(validateMcpServerConfig({
      name: 'remote',
      transport: 'http',
      command: '',
      url: 'https://mcp.example.com/mcp',
      args: null,
      env: null,
      headers: { Authorization: 'Bearer tok' },
    }).ok).toBe(true)
  })

  it('rejects non-http URLs', () => {
    const result = validateMcpServerConfig({
      name: 'bad',
      transport: 'sse',
      command: '',
      url: 'ws://example.com/mcp',
      args: null,
      env: null,
      headers: null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('http')
  })
})
