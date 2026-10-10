/**
 * xAI (Grok) LLM provider — OpenAI-compatible REST API at
 * `https://api.x.ai/v1`.
 *
 * xAI exposes a fully OpenAI-compatible `/v1/chat/completions` endpoint, so
 * we reuse the official `openai` SDK with a `baseURL` override for the chat
 * stream (message conversion, streaming tool calls, error mapping, usage all
 * behave like OpenAI). Model discovery uses xAI's richer
 * `GET /v1/language-models` endpoint, which carries `input_modalities`,
 * `output_modalities`, per-token pricing and aliases — but, unlike
 * OpenRouter, NO context-window field. Context windows are therefore inferred
 * from family naming (small prefix table, never per-ID hardcoding), mirroring
 * `openai-key.ts`.
 *
 * Reasoning: Grok reasoning models (grok-4.3, grok-4-fast, grok-3-mini, the
 * *-reasoning variants, grok-build) accept the OpenAI-compatible
 * `reasoning_effort` parameter. Plain `grok-4` reasons internally but REJECTS
 * `reasoning_effort`, so it is deliberately NOT flagged as a thinking model.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions'
import type { ReasoningEffort } from 'openai/resources/shared'

import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
  Usage,
  FinishReason,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  ContextOverflowError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import { parseToolArguments } from '@/server/llm/core/parse-tool-args'
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  ThinkingEffort,
} from '@/server/llm/llm/types'
import { downgradeEffort } from '@/server/llm/llm/types'

export const XAI_API_BASE = 'https://api.x.ai/v1'
const BASE_URL = XAI_API_BASE

// ─── Config schema ───────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'xai-…',
    description: 'Get one at https://console.x.ai',
  },
]

// ─── xAI /v1/language-models payload (subset we read) ────────────────────────

/**
 * Entry from `GET /v1/language-models`. Prices are integers in USD cents per
 * 100 million tokens (e.g. `12500` = $1.25 / 1M tokens). No context-window
 * field is exposed — see `inferContextWindow`.
 *
 * @internal exported for tests.
 */
export interface XaiLanguageModel {
  id: string
  aliases?: string[]
  input_modalities?: string[]
  output_modalities?: string[]
  prompt_text_token_price?: number | null
  cached_prompt_text_token_price?: number | null
  completion_text_token_price?: number | null
}

// ─── Metadata-driven model classification ──────────────────────────────────

/**
 * Vision support: xAI exposes `input_modalities`. A model accepts image
 * blocks iff that array contains `"image"`.
 *
 * @internal exported for tests.
 */
export function inferImageInput(model: XaiLanguageModel): boolean {
  return model.input_modalities?.includes('image') ?? false
}

/**
 * A model is usable as a Hivekeep LLM iff it produces text output. The
 * language-models endpoint only lists chat / image-understanding models, but
 * we still guard on `output_modalities` for forward compatibility.
 *
 * @internal exported for tests.
 */
export function isTextOutputModel(model: XaiLanguageModel): boolean {
  const out = model.output_modalities
  if (!out || out.length === 0) return true
  return out.includes('text')
}

/**
 * Convert xAI pricing (USD cents per 100 million tokens) to Hivekeep's USD per
 * million tokens. `12500` → `1.25`. Drops absent / negative values.
 *
 * @internal exported for tests.
 */
export function convertPricing(model: XaiLanguageModel): LLMModel['pricing'] | undefined {
  const perMillion = (raw: number | null | undefined): number | undefined => {
    if (raw == null) return undefined
    if (!Number.isFinite(raw) || raw < 0) return undefined
    return raw / 10_000
  }
  const input = perMillion(model.prompt_text_token_price)
  const output = perMillion(model.completion_text_token_price)
  if (input == null && output == null) return undefined
  const pricing: NonNullable<LLMModel['pricing']> = {
    input: input ?? 0,
    output: output ?? 0,
  }
  const cacheRead = perMillion(model.cached_prompt_text_token_price)
  if (cacheRead != null) pricing.cacheRead = cacheRead
  return pricing
}

/**
 * Map an xAI language-model entry to a Hivekeep `LLMModel`, or null if it isn't
 * a text-output chat model. Classification is purely metadata-driven, with
 * context windows inferred from family naming.
 *
 * @internal exported for tests.
 */
export function mapModel(model: XaiLanguageModel): LLMModel | null {
  if (!model.id) return null
  if (!isTextOutputModel(model)) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
    // OpenAI-compatible upstreams cache prompts transparently; xAI forwards
    // cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  // Image input + pricing come from the real xAI API (kept as seed hints);
  // context window + reasoning are filled by the registry from models.dev.
  if (inferImageInput(model)) out.supportsImageInput = true
  const pricing = convertPricing(model)
  if (pricing) out.pricing = pricing
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing xAI API key')
  return apiKey
}

function mapFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'],
): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    case null:
      return 'unknown'
    default:
      return 'unknown'
  }
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers?.['retry-after'])
      return new RateLimitError(message, retryAfter, err)
    }
    if (status === 400 && /context.length|maximum context|too long/i.test(message)) {
      return new ContextOverflowError(message, undefined, undefined, err)
    }
    if (status && status >= 400 && status < 500) {
      return new InvalidRequestError(message, err)
    }
    if (status && status >= 500) {
      return new ProviderServerError(message, status, err)
    }
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) {
    return new NetworkError(err.message, err)
  }
  return new NetworkError(String(err))
}

/** @internal exported for the SuperGrok OAuth provider. */
export const mapXaiApiError = mapApiError

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}


function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

// ─── Message conversion (hivekeep → OpenAI-compatible) ─────────────────────────

function systemPromptToMessage(
  system: ChatRequest['system'],
): ChatCompletionSystemMessageParam | undefined {
  if (!system || system.length === 0) return undefined
  const text = system.map((b) => b.text).join('\n\n')
  if (!text) return undefined
  return { role: 'system', content: text }
}

function userBlocksToContent(
  blocks: HivekeepMessage['content'],
): ChatCompletionUserMessageParam['content'] | null {
  const parts: ChatCompletionContentPart[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      const dataUrl = `data:${b.mediaType};base64,${uint8ToBase64(b.data)}`
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

function assistantMessage(
  blocks: HivekeepMessage['content'],
): ChatCompletionAssistantMessageParam {
  let text = ''
  const toolCalls: ChatCompletionMessageToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      text += b.text
    } else if (b.type === 'tool-use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
        },
      })
    }
  }
  const msg: ChatCompletionAssistantMessageParam = { role: 'assistant' }
  if (text) msg.content = text
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

function messagesToOpenAI(
  messages: HivekeepMessage[],
  system: ChatCompletionSystemMessageParam | undefined,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (system) out.push(system)

  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(assistantMessage(m.content))
      continue
    }
    const userContent = userBlocksToContent(m.content)
    if (userContent !== null) {
      out.push({ role: 'user', content: userContent })
    }
    for (const b of m.content) {
      if (b.type === 'tool-result') {
        const toolMsg: ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.content,
        }
        out.push(toolMsg)
      }
    }
  }
  return out
}

function toolsToOpenAI(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

// ─── Streaming (OpenAI-compatible chunks → ChatChunk) ────────────────────────

interface ToolCallState {
  id: string
  name: string
  args: string
}

async function* streamChat(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  let stream
  try {
    stream = await client.chat.completions.create(params, { signal })
  } catch (err) {
    throw mapApiError(err)
  }

  const toolsByIndex = new Map<number, ToolCallState>()
  let finishReason: ChatCompletionChunk.Choice['finish_reason'] = null
  let usage: Usage = {}

  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
        }
      }

      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta as
        | (ChatCompletionChunk.Choice['delta'] & {
            reasoning_content?: string | null
            reasoning?: string | null
          })
        | undefined
      // xAI surfaces reasoning summaries as `delta.reasoning_content` for
      // reasoning models; tolerate `delta.reasoning` for forward compat.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) {
        yield { type: 'thinking-delta', text: reasoning }
      }
      if (delta?.content) {
        yield { type: 'text-delta', text: delta.content }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          let state = toolsByIndex.get(idx)
          if (!state) {
            state = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
            toolsByIndex.set(idx, state)
          }
          if (tc.id) state.id = tc.id
          if (tc.function?.name) state.name = tc.function.name
          if (tc.function?.arguments) state.args += tc.function.arguments
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }
  } catch (err) {
    throw mapApiError(err)
  }

  for (const [idx, state] of toolsByIndex) {
    if (!state.name) continue
    yield {
      type: 'tool-use',
      id: state.id || `call_${idx}`,
      name: state.name,
      args: parseToolArguments(state.args),
    }
  }

  yield {
    type: 'finish',
    reason: mapFinishReason(finishReason),
    usage,
  }
}

/**
 * List chat models using a bearer token (API key or SuperGrok OAuth access token).
 *
 * Prefers `GET /v1/language-models` (modalities + pricing). Some SuperGrok
 * tiers 403 that richer catalogue; fall back to `GET /v1/models` so the
 * subscription path still lists grok-* ids.
 *
 * @internal exported for the SuperGrok OAuth provider.
 */
export async function fetchXaiChatModels(token: string): Promise<LLMModel[]> {
  const headers = { Authorization: `Bearer ${token}` }

  const langRes = await fetch(`${BASE_URL}/language-models`, { headers })
  if (langRes.ok) {
    const payload = (await langRes.json()) as { models?: XaiLanguageModel[] }
    const models: LLMModel[] = []
    for (const raw of payload.models ?? []) {
      const mapped = mapModel(raw)
      if (mapped) models.push(mapped)
    }
    return models
  }

  // SuperGrok OAuth is known to 403 /language-models on some tiers. The
  // OpenAI-compatible /models listing is the documented fallback.
  if (langRes.status === 401 || langRes.status === 403 || langRes.status === 404) {
    const modelsRes = await fetch(`${BASE_URL}/models`, { headers })
    if (!modelsRes.ok) {
      if (modelsRes.status === 401 || modelsRes.status === 403) {
        throw new AuthError(
          `xAI rejected the credential (HTTP ${modelsRes.status}). SuperGrok OAuth API access may be restricted to certain tiers — use an API key if this persists.`,
        )
      }
      throw new ProviderServerError(
        `xAI /models returned HTTP ${modelsRes.status}`,
        modelsRes.status,
      )
    }
    const payload = (await modelsRes.json()) as {
      data?: Array<{ id?: string; object?: string }>
    }
    const models: LLMModel[] = []
    for (const raw of payload.data ?? []) {
      if (!raw.id) continue
      // Drop image/video generators that appear on the mixed /models list.
      if (/imagine|image|video/i.test(raw.id)) continue
      const mapped = mapModel({ id: raw.id })
      if (mapped) models.push(mapped)
    }
    return models
  }

  throw new ProviderServerError(
    `xAI /language-models returned HTTP ${langRes.status}`,
    langRes.status,
  )
}

/**
 * Stream a chat completion against api.x.ai using a bearer token.
 * @internal exported for the SuperGrok OAuth provider.
 */
export function streamXaiChat(
  token: string,
  model: LLMModel,
  request: ChatRequest,
): AsyncIterable<ChatChunk> {
  const client = new OpenAI({ apiKey: token, baseURL: BASE_URL })
  const system = systemPromptToMessage(request.system)

  const params: ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages: messagesToOpenAI(request.messages, system),
    stream: true,
    stream_options: { include_usage: true },
  }

  const tools = toolsToOpenAI(request.tools)
  if (tools) params.tools = tools

  if (request.maxOutputTokens != null) {
    params.max_tokens = request.maxOutputTokens
  }
  if (request.temperature != null) {
    params.temperature = request.temperature
  }

  if (request.thinkingEffort && model.thinking?.efforts?.length) {
    const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
    if (chosen) {
      const effort = chosen === 'max' ? 'high' : chosen
      params.reasoning_effort = effort as ReasoningEffort
    }
  }

  if (request.metadata?.userId) {
    params.user = request.metadata.userId
  }

  return streamChat(client, params, request.signal)
}

// ─── Provider implementation ─────────────────────────────────────────

export const xaiProvider: LLMProvider = {
  type: 'xai',
  displayName: 'xAI',
  configSchema: CONFIG_SCHEMA,
  // xAI documents a 128-tool cap on its OpenAI-compatible endpoint.
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /v1/api-key is a lightweight credential probe — 200 means the key
      // is valid, 401/403 means it isn't.
      const res = await fetch(`${BASE_URL}/api-key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid xAI API key' }
      }
      return { valid: false, error: `xAI returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    try {
      return await fetchXaiChatModels(getApiKey(config))
    } catch (err) {
      throw mapApiError(err)
    }
  },

  chat(model, request, config) {
    return streamXaiChat(getApiKey(config), model, request)
  },
}
