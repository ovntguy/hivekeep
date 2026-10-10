import { describe, expect, it } from 'bun:test'
import {
  applyExtraBody,
  assistantMessage,
  EXTRA_BODY_RESERVED_KEYS,
  mapModel,
  parseExtraBody,
  type OpenAICompatibleModel,
} from './openai-compatible'

// Representative fixtures drawn from a generic OpenAI-compatible /models
// payload: the bare OpenAI listing `{object:'list', data:[{id, ...}]}`.

const qwen: OpenAICompatibleModel = {
  id: 'qwen2.5-7b-instruct',
  object: 'model',
  owned_by: 'local',
}

// ─── mapModel (metadata comes from the registry, not heuristics) ─────────────

describe('mapModel', () => {
  it('returns the bare model — no name-based context/thinking/vision guesses', () => {
    const m = mapModel(qwen)!
    expect(m.id).toBe('qwen2.5-7b-instruct')
    expect(m.name).toBe('qwen2.5-7b-instruct')
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    // Metadata is filled by the model registry (models.dev), not here.
    expect(m.contextWindow).toBeUndefined()
    expect(m.thinking).toBeUndefined()
    expect(m.supportsImageInput).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

// ─── assistantMessage (plain — NO vendor reasoning_content replay) ───────────

describe('assistantMessage', () => {
  // Unlike DeepSeek, a generic OpenAI-compatible server must NOT receive a
  // `reasoning_content` field — vanilla servers 400 on the unknown key.
  it('does NOT attach reasoning_content to a tool-call message', () => {
    const msg = assistantMessage([
      { type: 'thinking', text: 'I should call the weather tool.' },
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: unknown[]; reasoning_content?: string }
    expect(msg.tool_calls).toHaveLength(1)
    expect('reasoning_content' in msg).toBe(false)
  })

  it('serialises tool-use args to a JSON string', () => {
    const msg = assistantMessage([
      { type: 'tool-use', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
    ]) as { tool_calls?: { function: { name: string; arguments: string } }[] }
    expect(msg.tool_calls?.[0]?.function.name).toBe('get_weather')
    expect(JSON.parse(msg.tool_calls![0]!.function.arguments)).toEqual({ city: 'Paris' })
  })

  it('keeps a plain text message as bare content', () => {
    const msg = assistantMessage([{ type: 'text', text: 'Hi.' }]) as {
      content?: string
      reasoning_content?: string
    }
    expect(msg.content).toBe('Hi.')
    expect('reasoning_content' in msg).toBe(false)
  })
})

// ─── listModels payload parsing ──────────────────────────────────────────────

describe('listModels payload shape', () => {
  // The provider's listModels reads `payload.data` from the OpenAI-style
  // `{object:'list', data:[{id}]}` response. Verify mapModel handles the full
  // listing (including a degenerate id-less entry) the way listModels does.
  it('maps every model in a {data:[{id}]} listing, dropping id-less entries', () => {
    const payload: { object: string; data: OpenAICompatibleModel[] } = {
      object: 'list',
      data: [{ id: 'llama-3.1-8b' }, qwen, { id: '' }],
    }
    const mapped = payload.data.map(mapModel).filter((m): m is NonNullable<typeof m> => m !== null)
    expect(mapped.map((m) => m.id)).toEqual(['llama-3.1-8b', 'qwen2.5-7b-instruct'])
  })
})

describe('extraBody', () => {
  it('parses llama.cpp DRY sampling knobs', () => {
    expect(
      parseExtraBody(
        '{"dry_multiplier":0.8,"dry_base":1.75,"dry_allowed_length":2,"dry_penalty_last_n":-1}',
      ),
    ).toEqual({
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: -1,
    })
  })

  it('treats empty extraBody as no extras', () => {
    expect(parseExtraBody(undefined)).toEqual({})
    expect(parseExtraBody('')).toEqual({})
    expect(parseExtraBody('   ')).toEqual({})
  })

  it('rejects non-object JSON', () => {
    expect(() => parseExtraBody('[]')).toThrow(/JSON object/)
    expect(() => parseExtraBody('"nope"')).toThrow(/JSON object/)
    expect(() => parseExtraBody('{')).toThrow(/JSON object/)
  })

  it('merges extras but keeps host fields', () => {
    const params = {
      model: 'qwen2.5-7b-instruct',
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: true,
      temperature: 0,
    }
    const merged = applyExtraBody(params, {
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: -1,
      temperature: 0.7,
      prompt: '<your_prompt_here>',
      stream: false,
      model: 'hijack',
    })
    expect(merged['dry_multiplier']).toBe(0.8)
    expect(merged['dry_base']).toBe(1.75)
    expect(merged['dry_allowed_length']).toBe(2)
    expect(merged['dry_penalty_last_n']).toBe(-1)
    expect(merged['temperature']).toBe(0)
    expect(merged['stream']).toBe(true)
    expect(merged['model']).toBe('qwen2.5-7b-instruct')
    expect(merged).not.toHaveProperty('prompt')
    expect(EXTRA_BODY_RESERVED_KEYS.has('temperature')).toBe(true)
  })
})
