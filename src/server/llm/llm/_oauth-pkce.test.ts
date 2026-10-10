import { describe, expect, it, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import {
  generatePkce,
  buildPkceAuthorizeUrl,
  parsePastedCode,
  exchangePkceCode,
  encodeTokenRequest,
  decodeJwtClaims,
  type PkceClient,
} from './_oauth-pkce'

const CLIENT: PkceClient = {
  clientId: 'test-client',
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  redirectUri: 'https://example.com/callback',
  scopes: ['a', 'b'],
  authorizeParams: { code: 'true' },
  includeStateInExchange: true,
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('generatePkce', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier).not.toMatch(/[+/=]/) // base64url alphabet only
    const expected = b64url(createHash('sha256').update(verifier).digest())
    expect(challenge).toBe(expected)
  })

  it('mints a unique verifier each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe('buildPkceAuthorizeUrl', () => {
  it('includes all PKCE + client params', () => {
    const url = new URL(buildPkceAuthorizeUrl({ client: CLIENT, challenge: 'CHALLENGE', state: 'STATE' }))
    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback')
    expect(url.searchParams.get('scope')).toBe('a b')
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('code')).toBe('true') // extra authorizeParams
  })
})

describe('parsePastedCode', () => {
  it('accepts a bare code', () => {
    expect(parsePastedCode('abc123')).toEqual({ code: 'abc123' })
  })

  it('splits Anthropic <code>#<state>', () => {
    expect(parsePastedCode('thecode#thestate')).toEqual({ code: 'thecode', state: 'thestate' })
  })

  it('extracts code + state from a full redirect URL', () => {
    expect(parsePastedCode('http://localhost:1455/auth/callback?code=xyz&state=st')).toEqual({
      code: 'xyz',
      state: 'st',
    })
  })

  it('trims whitespace and tolerates empty input', () => {
    expect(parsePastedCode('  pad  ')).toEqual({ code: 'pad' })
    expect(parsePastedCode('')).toEqual({ code: '' })
  })
})

describe('exchangePkceCode', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('posts a PKCE authorization_code grant and parses tokens', async () => {
    let captured: { url: string; body: any } | null = null
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) }
      return new Response(
        JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: 'ID' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const before = Date.now()
    const tokens = await exchangePkceCode({ client: CLIENT, code: 'CODE', verifier: 'VERIFIER', state: 'ST' })

    expect(captured!.url).toBe('https://auth.example.com/oauth/token')
    expect(captured!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'CODE',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      code_verifier: 'VERIFIER',
      state: 'ST',
    })
    expect(tokens.accessToken).toBe('AT')
    expect(tokens.refreshToken).toBe('RT')
    expect(tokens.idToken).toBe('ID')
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it('omits state from the token body unless the client opts in (OpenAI rejects it)', async () => {
    let captured: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const noState: PkceClient = { ...CLIENT, includeStateInExchange: false }
    await exchangePkceCode({ client: noState, code: 'CODE', verifier: 'V', state: 'ST' })
    expect(captured).not.toHaveProperty('state')
    expect(captured).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', code_verifier: 'V' })
  })

  it('posts application/x-www-form-urlencoded when the client declares tokenEncoding form', async () => {
    let captured: { contentType: string; body: string } | null = null
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = {
        contentType: String(init.headers['Content-Type'] ?? init.headers['content-type'] ?? ''),
        body: String(init.body),
      }
      return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const formClient: PkceClient = { ...CLIENT, tokenEncoding: 'form', includeStateInExchange: false }
    await exchangePkceCode({ client: formClient, code: 'CODE', verifier: 'VERIFIER' })
    expect(captured!.contentType).toContain('application/x-www-form-urlencoded')
    const params = new URLSearchParams(captured!.body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('CODE')
    expect(params.get('code_verifier')).toBe('VERIFIER')
    expect(params.get('client_id')).toBe('test-client')
  })

  it('throws with the upstream status + body on failure', async () => {
    globalThis.fetch = (async () =>
      new Response('bad_grant', { status: 400 })) as unknown as typeof fetch
    await expect(
      exchangePkceCode({ client: CLIENT, code: 'CODE', verifier: 'V' }),
    ).rejects.toThrow(/400/)
  })

  it('throws when no access_token is returned', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ refresh_token: 'RT' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    await expect(
      exchangePkceCode({ client: CLIENT, code: 'CODE', verifier: 'V' }),
    ).rejects.toThrow(/no access_token/)
  })
})

describe('encodeTokenRequest', () => {
  it('defaults to JSON', () => {
    const encoded = encodeTokenRequest(CLIENT, { a: '1' })
    expect(encoded.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(encoded.body)).toEqual({ a: '1' })
  })

  it('encodes form-urlencoded when asked', () => {
    const encoded = encodeTokenRequest({ ...CLIENT, tokenEncoding: 'form' }, { a: '1', b: 'two words' })
    expect(encoded.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(encoded.body).toBe('a=1&b=two+words')
  })
})

describe('decodeJwtClaims', () => {
  it('decodes the payload segment', () => {
    const payload = { sub: '42', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1' } }
    const seg = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const jwt = `header.${seg}.sig`
    expect(decodeJwtClaims(jwt)).toEqual(payload)
  })

  it('returns null for a malformed token', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeNull()
  })
})
