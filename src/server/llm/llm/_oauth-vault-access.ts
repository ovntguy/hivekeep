/**
 * Generic vault-backed OAuth access-token accessor.
 *
 * Any provider that DECLARES `oauth` (built-in or plugin) and was connected via
 * the in-app sign-in stores its rotating token bundle in the vault. This module
 * is the single place that reads that bundle, refreshes it on expiry via the
 * declared `PkceClient`'s `refresh_token` grant, writes it back, and caches the
 * access token in-process — replacing the per-provider copies that used to live
 * in `_anthropic-oauth-auth.ts` / `_codex-auth.ts`.
 *
 * It resolves the PKCE client from the provider's declaration
 * (`getLLMProvider(type).oauth.client`), keyed off the reserved
 * `__providerType` in the runtime config — so it works identically for the
 * built-ins and for a plugin provider, with no provider id hardcoded.
 *
 * The host's plugin context exposes this via `ctx.oauth.getAccessToken()`
 * (namespace-gated to the plugin's own providers — see plugins.ts).
 */
import { getLLMProvider } from '@/server/llm/llm/registry'
import { decodeJwtClaims, encodeTokenRequest, type PkceClient } from '@/server/llm/llm/_oauth-pkce'
import {
  readTokenBundle,
  writeTokenBundle,
  vaultKeyFromConfig,
  PROVIDER_TYPE_KEY,
  type OAuthTokenBundle,
} from '@/server/llm/llm/_oauth-token-store'
import { createLogger } from '@/server/logger'
import type { ProviderConfig } from '@/server/llm/core/types'

const log = createLogger('oauth-vault-access')
const BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

export interface VaultOAuthToken {
  accessToken: string
  /** Provider-specific durable fields persisted in the bundle (e.g. Codex's
   *  ChatGPT account id). */
  extra?: Record<string, string>
}

// Shared in-process cache + single-flight lock, keyed by the vault key so
// concurrent calls for the same provider coalesce into one refresh.
const cache = new Map<string, { accessToken: string; expiresAt: number; extra?: Record<string, string> }>()
const locks = new Map<string, Promise<VaultOAuthToken>>()

/** Expiry (Unix ms) from a JWT's `exp`, or 0 when not a JWT / no claim. */
function jwtExpiry(token: string | undefined): number {
  if (!token) return 0
  const claims = decodeJwtClaims(token)
  const exp = claims?.exp
  return typeof exp === 'number' ? exp * 1000 : 0
}

interface RefreshResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

async function refreshGrant(client: PkceClient, refreshToken: string): Promise<RefreshResponse> {
  const encoded = encodeTokenRequest(client, {
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: refreshToken,
  })
  const resp = await fetch(client.tokenUrl, {
    method: 'POST',
    headers: encoded.headers,
    body: encoded.body,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`OAuth token refresh failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  return resp.json() as Promise<RefreshResponse>
}

async function doRefresh(vaultKey: string, hint: OAuthTokenBundle, client: PkceClient): Promise<VaultOAuthToken> {
  // Re-read in case another worker refreshed it meanwhile.
  const bundle = (await readTokenBundle(vaultKey)) ?? hint
  const now = Date.now()
  // Expiry source: explicit (Anthropic's expires_in) or the access_token JWT
  // (Codex). Either covers both providers without special-casing.
  const exp = bundle.expiresAt || jwtExpiry(bundle.accessToken)
  if (exp && exp - now > BUFFER_MS && bundle.accessToken) {
    cache.set(vaultKey, { accessToken: bundle.accessToken, expiresAt: exp, extra: bundle.extra })
    return { accessToken: bundle.accessToken, extra: bundle.extra }
  }

  const data = await refreshGrant(client, bundle.refreshToken)
  if (!data.access_token) throw new Error('OAuth refresh returned no access_token.')
  const newExp = data.expires_in ? now + data.expires_in * 1000 : jwtExpiry(data.access_token)
  const next: OAuthTokenBundle = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? bundle.refreshToken, // both providers rotate it
    ...(newExp ? { expiresAt: newExp } : {}),
    ...(bundle.extra ? { extra: bundle.extra } : {}),
  }
  await writeTokenBundle(vaultKey, next)
  cache.set(vaultKey, { accessToken: data.access_token, expiresAt: newExp || now + BUFFER_MS, extra: bundle.extra })
  log.info({ vaultKey }, 'OAuth token refreshed (vault)')
  return { accessToken: data.access_token, extra: bundle.extra }
}

/**
 * Resolve a fresh vault-backed OAuth access token for the provider described by
 * `config` (its `__providerType` selects the declared `oauth.client`). Returns
 * null when the provider wasn't set up via sign-in (no vault bundle) so the
 * caller can fall back to its own path (e.g. a CLI credentials file).
 */
export async function getVaultOAuthToken(config: ProviderConfig): Promise<VaultOAuthToken | null> {
  const vaultKey = vaultKeyFromConfig(config)
  if (!vaultKey) return null

  // Hot path: a still-fresh cached token needs no vault read.
  const cached = cache.get(vaultKey)
  if (cached && cached.expiresAt - Date.now() > BUFFER_MS) {
    return { accessToken: cached.accessToken, extra: cached.extra }
  }

  const bundle = await readTokenBundle(vaultKey)
  if (!bundle) return null

  const type = config[PROVIDER_TYPE_KEY]
  const client = type ? getLLMProvider(type)?.oauth?.client : undefined
  if (!client) {
    throw new Error(`Provider "${type ?? '?'}" has no declared OAuth client to refresh its token.`)
  }

  let lock = locks.get(vaultKey)
  if (!lock) {
    lock = doRefresh(vaultKey, bundle, client).finally(() => locks.delete(vaultKey))
    locks.set(vaultKey, lock)
  }
  return lock
}
