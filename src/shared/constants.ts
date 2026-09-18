// Shared constants used by both client and server
// 🤖 Hivekeep — Where AI agents collaborate!

/** UI translation languages — every code here must have a matching
 *  src/client/locales/<code>.json shipped with the app. */
export const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'de', 'pt-BR', 'zh-CN', 'ja', 'ru', 'it', 'pl'] as const

/** MCP client transports. `http` is Streamable HTTP (current spec); `sse` is the legacy remote transport. */
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const

export const CONFIGURATOR_MODEL_PREFERENCES: Record<string, readonly string[]> = {
  anthropic: ['sonnet', 'opus', 'haiku'],
  'anthropic-oauth': ['sonnet', 'opus', 'haiku'],
  openai: ['gpt-5', 'gpt-4.1', 'gpt-4o', 'o4', 'gpt-4'],
  'openai-codex': ['gpt-5', 'gpt-4.1', 'gpt-4o'],
  gemini: ['pro', 'flash'],
  openrouter: ['sonnet', 'gpt-4o', 'gpt-4.1', 'llama'],
  kilo: ['sonnet', 'gpt-5', 'opus', 'gemini', 'qwen', 'llama'],
  ollama: ['qwen3', 'gpt-oss', 'deepseek', 'glm', 'llama', 'mistral'],
  xai: ['grok-4', 'grok-3', 'grok-2', 'grok'],
  'xai-oauth': ['grok-4', 'grok-3', 'grok-2', 'grok'],
  deepseek: ['pro', 'flash', 'deepseek'],
  minimax: ['m3', 'minimax'],
  moonshot: ['k2.6', 'kimi-k2', 'kimi', 'moonshot'],
  'openai-compatible': ['qwen', 'llama', 'mistral', 'deepseek', 'gpt'],
}
