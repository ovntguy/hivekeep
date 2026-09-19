import { describe, expect, it } from 'bun:test'
import { grokAuthPathCandidates, parseGrokAuthFile, XAI_PKCE_CLIENT } from './_xai-oauth-auth'
import { xaiOAuthProvider } from './xai-oauth'
import { fetchXaiChatModels, mapModel } from './xai'

describe('XAI_PKCE_CLIENT', () => {
  it('is a public Grok-CLI client with form-encoded OIDC endpoints', () => {
    expect(XAI_PKCE_CLIENT.clientId).toMatch(/^[0-9a-f-]{36}$/)
    expect(XAI_PKCE_CLIENT.authorizeUrl).toBe('https://auth.x.ai/oauth2/authorize')
    expect(XAI_PKCE_CLIENT.tokenUrl).toBe('https://auth.x.ai/oauth2/token')
    expect(XAI_PKCE_CLIENT.redirectUri).toBe('http://127.0.0.1:56121/callback')
    expect(XAI_PKCE_CLIENT.tokenEncoding).toBe('form')
    expect(XAI_PKCE_CLIENT.authorizeParams?.plan).toBe('generic')
    expect(XAI_PKCE_CLIENT.scopes).toContain('offline_access')
    expect(XAI_PKCE_CLIENT.scopes).toContain('api:access')
  })
})

describe('xaiOAuthProvider declaration', () => {
  it('declares SuperGrok as a subscription sign-in provider', () => {
    expect(xaiOAuthProvider.type).toBe('xai-oauth')
    expect(xaiOAuthProvider.billing).toBe('subscription')
    expect(xaiOAuthProvider.defaultMaxTools).toBe(128)
    expect(xaiOAuthProvider.oauth?.redirectStyle).toBe('loopback')
    expect(xaiOAuthProvider.oauth?.client).toBe(XAI_PKCE_CLIENT)
  })
})

describe('grokAuthPathCandidates', () => {
  it('tries env HOME, then USERPROFILE, then REAL_HOME', () => {
    expect(grokAuthPathCandidates('/home/snap', '/Users/win', '/home/real')).toEqual([
      '/home/snap/.grok/auth.json',
      '/Users/win/.grok/auth.json',
      '/home/real/.grok/auth.json',
    ])
  })

  it('dedupes when homes match', () => {
    expect(grokAuthPathCandidates('/home/u', '/home/u', '/home/u')).toEqual(['/home/u/.grok/auth.json'])
  })

  it('drops relative or empty homes and still includes USERPROFILE', () => {
    expect(grokAuthPathCandidates(undefined, '/Users/win', '/home/u')).toEqual([
      '/Users/win/.grok/auth.json',
      '/home/u/.grok/auth.json',
    ])
    expect(grokAuthPathCandidates('relative/path', undefined, '/home/u')).toEqual([
      '/home/u/.grok/auth.json',
    ])
  })

  it('never emits a relative candidate', () => {
    expect(grokAuthPathCandidates('relative/env', 'also/relative', undefined)).toEqual([])
    expect(grokAuthPathCandidates(undefined, undefined, undefined)).toEqual([])
  })
})

describe('parseGrokAuthFile', () => {
  const clientId = XAI_PKCE_CLIENT.clientId

  it('reads the Grok CLI issuer::client_id map (access token under key)', () => {
    const raw = JSON.stringify({
      [`https://auth.x.ai::${clientId}`]: {
        key: 'access-aaa',
        refresh_token: 'refresh-bbb',
        expires_at: 1_800_000_000,
      },
    })
    const parsed = parseGrokAuthFile(raw)
    expect(parsed.accessToken).toBe('access-aaa')
    expect(parsed.refreshToken).toBe('refresh-bbb')
    expect(parsed.expiresAt).toBe(1_800_000_000_000)
  })

  it('reads a flat access_token / refresh_token blob', () => {
    const parsed = parseGrokAuthFile(
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: 2_000_000_000_000,
      }),
    )
    expect(parsed).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 2_000_000_000_000 })
  })

  it('reads the pi-style access / refresh / expires shape', () => {
    const parsed = parseGrokAuthFile(
      JSON.stringify({ access: 'at2', refresh: 'rt2', expires: 1_700_000_000_000 }),
    )
    expect(parsed.accessToken).toBe('at2')
    expect(parsed.refreshToken).toBe('rt2')
    expect(parsed.expiresAt).toBe(1_700_000_000_000)
  })

  it('throws when neither nested nor flat tokens are present', () => {
    expect(() => parseGrokAuthFile('{"hello":"world"}')).toThrow(/no access\/refresh/)
  })
})

describe('fetchXaiChatModels SuperGrok fallback', () => {
  it('falls back to GET /v1/models and drops image generators when language-models is 403', async () => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (url: any) => {
      const href = String(url)
      calls.push(href)
      if (href.endsWith('/language-models')) {
        return new Response('forbidden', { status: 403 })
      }
      if (href.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'grok-4.3', object: 'model' },
              { id: 'grok-imagine-video', object: 'model' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch

    try {
      const models = await fetchXaiChatModels('oauth-token')
      expect(calls.some((u) => u.endsWith('/language-models'))).toBe(true)
      expect(calls.some((u) => u.endsWith('/models'))).toBe(true)
      expect(models.map((m) => m.id)).toEqual(['grok-4.3'])
      expect(mapModel({ id: 'grok-4.3' })?.id).toBe('grok-4.3')
    } finally {
      globalThis.fetch = original
    }
  })
})
