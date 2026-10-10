/**
 * Unit tests for the two provider-tunable knobs introduced in the SDK:
 *   - `LLMProvider.defaultMaxTools`  → read by `getMaxToolsForProvider`
 *   - `LLMProvider.billing`          → read by `providerPriority`
 *
 * Both replaced provider-specific switches in the engine / resolver,
 * so the host now relies entirely on the provider declaring the right
 * value on itself. Coverage here keeps a future SDK shape change from
 * silently breaking the tool-cap or auto-resolution paths.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import {
  getMaxToolsForProvider,
  getMaxToolsForRequest,
} from '@/server/services/tool-cap'
import { providerPriority } from '@/server/llm/core/provider-priority'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'

// The registry is empty until the host calls registerBuiltinLLMProviders
// at startup. Tests live below that boot path, so we replay it once.
beforeAll(() => {
  registerBuiltinLLMProviders()
})

describe('getMaxToolsForProvider', () => {
  it('reads defaultMaxTools from the built-in OpenAI provider (128)', () => {
    expect(getMaxToolsForProvider('openai')).toBe(128)
  })

  it('reads defaultMaxTools from the built-in OpenAI Codex provider (128)', () => {
    expect(getMaxToolsForProvider('openai-codex')).toBe(128)
  })

  it('reads defaultMaxTools from the built-in xAI SuperGrok provider (128)', () => {
    expect(getMaxToolsForProvider('xai-oauth')).toBe(128)
  })

  it('reads defaultMaxTools from the built-in Anthropic provider (512)', () => {
    expect(getMaxToolsForProvider('anthropic')).toBe(512)
  })

  it('reads defaultMaxTools from the built-in Anthropic OAuth provider (512)', () => {
    expect(getMaxToolsForProvider('anthropic-oauth')).toBe(512)
  })

  it('falls back to the conservative default for an unknown provider type', () => {
    // 128 matches DEFAULT_MAX_LLM_TOOLS in agent-engine.ts. Bumping that
    // constant requires bumping this assertion in lockstep.
    expect(getMaxToolsForProvider('plugin:made-up-vendor')).toBe(128)
  })

  it('falls back when providerType is null (no Agent model selected yet)', () => {
    expect(getMaxToolsForProvider(null)).toBe(128)
  })
})

describe('getMaxToolsForRequest (per-model override)', () => {
  it('honours `model.maxTools: 0` even when the provider declares a non-zero default', () => {
    // Anthropic declares 512, but a hypothetical Anthropic-hosted
    // text-completion model could mark itself non-tool-capable.
    expect(getMaxToolsForRequest('anthropic', { maxTools: 0 })).toBe(0)
  })

  it('honours a per-model cap below the provider default', () => {
    expect(getMaxToolsForRequest('anthropic', { maxTools: 32 })).toBe(32)
  })

  it('honours a per-model cap above the provider default', () => {
    // Trust the provider's declaration — Hivekeep caps based on what the
    // provider says, not on a stricter ceiling.
    expect(getMaxToolsForRequest('openai', { maxTools: 256 })).toBe(256)
  })

  it('falls back to the provider default when the model declines (undefined maxTools)', () => {
    expect(getMaxToolsForRequest('anthropic', { maxTools: undefined })).toBe(512)
    expect(getMaxToolsForRequest('openai', {})).toBe(128)
  })

  it('falls back through provider default to global default when no model is supplied', () => {
    expect(getMaxToolsForRequest('anthropic', null)).toBe(512)
    expect(getMaxToolsForRequest('plugin:made-up-vendor', null)).toBe(128)
    expect(getMaxToolsForRequest(null, null)).toBe(128)
  })

  it('treats per-model `maxTools: 0` as a hard signal (no fallback to provider)', () => {
    // The whole point: a plugin marketplace (Replicate, …) can flag a
    // completion-only model with `maxTools: 0` and the engine respects
    // it even though the provider's own `defaultMaxTools` is generous.
    expect(getMaxToolsForRequest('anthropic-oauth', { maxTools: 0 })).toBe(0)
    expect(getMaxToolsForRequest('openai', { maxTools: 0 })).toBe(0)
  })
})

describe('providerPriority (auto-resolution tie-breaker)', () => {
  it('subscription providers (Anthropic OAuth, OpenAI Codex, SuperGrok) outrank per-token', () => {
    expect(providerPriority('anthropic-oauth')).toBe(1)
    expect(providerPriority('openai-codex')).toBe(1)
    expect(providerPriority('xai-oauth')).toBe(1)
  })

  it('per-token providers (Anthropic key, OpenAI key) sort last', () => {
    expect(providerPriority('anthropic')).toBe(2)
    expect(providerPriority('openai')).toBe(2)
  })

  it('unknown provider types default to per-token priority (most conservative)', () => {
    expect(providerPriority('plugin:made-up-vendor')).toBe(2)
  })

  it('subscriptions strictly beat per-token in the sort order', () => {
    expect(providerPriority('anthropic-oauth')).toBeLessThan(providerPriority('anthropic'))
    expect(providerPriority('openai-codex')).toBeLessThan(providerPriority('openai'))
    expect(providerPriority('xai-oauth')).toBeLessThan(providerPriority('xai'))
  })
})
