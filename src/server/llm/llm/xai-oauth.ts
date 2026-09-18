/**
 * xAI SuperGrok OAuth provider (Grok.com / X Premium+ subscription).
 *
 * Same OpenAI-compatible api.x.ai surface as the API-key `xai` provider, but
 * billed against a SuperGrok (or X Premium+) plan via OAuth PKCE instead of a
 * metered key. Auth/refresh lives in `_xai-oauth-auth.ts` (underscore-prefixed
 * so the registry's `import.meta.glob` skips it). Chat + model listing reuse
 * the helpers exported from `xai.ts`.
 */

import { createLogger } from '@/server/logger'
import type { ConfigField, ProviderConfig, AuthResult } from '@/server/llm/core/types'
import { HivekeepProviderError } from '@/server/llm/core/types'
import type { LLMProvider, LLMModel } from '@/server/llm/llm/types'
import { fetchXaiChatModels, mapXaiApiError, streamXaiChat } from '@/server/llm/llm/xai'
import { getXaiOAuthAccessToken, XAI_PKCE_CLIENT } from '@/server/llm/llm/_xai-oauth-auth'

const log = createLogger('xai-oauth')

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    // 'signin' = tokens obtained via the in-app PKCE flow and stored in the
    // vault; 'cli' = read the Grok CLI creds file. Set by the sign-in route.
    key: 'authMode',
    type: 'text',
    label: 'Authentication mode',
    placeholder: 'cli',
    description:
      "Either 'signin' (in-app SuperGrok login) or 'cli' (read the Grok CLI credentials file).",
  },
  {
    key: 'authFilePath',
    type: 'path',
    label: 'Credentials file (optional)',
    placeholder: '~/.grok/auth.json',
    description:
      'Leave empty to auto-detect the Grok CLI credentials. Override only when running in a non-standard environment.',
  },
]

function wrapError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  return mapXaiApiError(err)
}

export const xaiOAuthProvider: LLMProvider = {
  type: 'xai-oauth',
  displayName: 'xAI (SuperGrok)',
  configSchema: CONFIG_SCHEMA,
  // Same upstream as xaiProvider — xAI's 128-tool cap applies.
  defaultMaxTools: 128,
  // SuperGrok / X Premium+ is a subscription — auto-resolution prefers it over
  // a metered xai API-key row when both serve the same grok model.
  billing: 'subscription',
  oauth: { client: XAI_PKCE_CLIENT, redirectStyle: 'loopback' },

  async authenticate(config: ProviderConfig): Promise\u003cAuthResult\u003e {
    try {
      const token = await getXaiOAuthAccessToken(config)
      const models = await fetchXaiChatModels(token)
      if (models.length === 0) {
        return {
          valid: false,
          error:
            'Signed in, but xAI listed no chat models. SuperGrok OAuth API access may be restricted to certain tiers — use the xAI API-key provider if this persists.',
        }
      }
      return { valid: true }
    } catch (err) {
      const mapped = wrapError(err)
      log.warn({ error: mapped.message }, 'SuperGrok OAuth authenticate failed')
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise\u003cLLMModel[]\u003e {
    try {
      const token = await getXaiOAuthAccessToken(config)
      return await fetchXaiChatModels(token)
    } catch (err) {
      throw wrapError(err)
    }
  },

  chat(model, request, config) {
    return (async function* () {
      const token = await getXaiOAuthAccessToken(config)
      yield* streamXaiChat(token, model, request)
    })()
  },
}
