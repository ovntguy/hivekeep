import { describe, expect, it, beforeAll } from 'bun:test'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'
import { startProviderSignIn } from '@/server/services/provider-signin'

beforeAll(() => {
  registerBuiltinLLMProviders()
})

describe('startProviderSignIn (declaration-driven, generic)', () => {
  it('starts a PKCE flow for any provider that declares .oauth', () => {
    const a = startProviderSignIn('anthropic-oauth')
    expect(a).not.toBeNull()
    expect(a!.verifier.length).toBeGreaterThanOrEqual(43)
    expect(a!.state.length).toBeGreaterThan(0)
    expect(a!.redirectStyle).toBe('page')
    const url = new URL(a!.authorizeUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(a!.state)
  })

  it('reflects the provider-declared redirectStyle (loopback for Codex and SuperGrok)', () => {
    const c = startProviderSignIn('openai-codex')
    expect(c).not.toBeNull()
    expect(c!.redirectStyle).toBe('loopback')

    const x = startProviderSignIn('xai-oauth')
    expect(x).not.toBeNull()
    expect(x!.redirectStyle).toBe('loopback')
    const url = new URL(x!.authorizeUrl)
    expect(url.hostname).toBe('auth.x.ai')
    expect(url.searchParams.get('plan')).toBe('generic')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback')
  })

  it('returns null for a provider with no sign-in declaration', () => {
    expect(startProviderSignIn('openai-key')).toBeNull()
    expect(startProviderSignIn('does-not-exist')).toBeNull()
  })
})
