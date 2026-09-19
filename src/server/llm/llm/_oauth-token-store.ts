/**
 * Vault-backed OAuth token store for CLI-free subscription providers.
 *
 * When a provider (anthropic-oauth / openai-codex / xai-oauth) is set up via the in-app
 * "Sign in" flow rather than by reading the CLI's credentials file, its OAuth
 * tokens must live somewhere Hivekeep owns. We store them as a single JSON
 * bundle in the encrypted vault (`vault_secrets`, AES-256-GCM at rest) under a
 * deterministic key derived from the provider row — mirroring the
 * `provider_<type>_<id>_<field>` convention used by `provider-config.ts`.
 *
 * The bundle holds the rotating refresh token, so refresh write-back persists
 * here (NOT to `~/.claude` / `~/.codex`). The access token is short-lived and
 * cached in-process by each provider's auth module; only durable state lives
 * in the bundle.
 *
 * The provider row id + type reach the auth module as the reserved
 * `__providerId` / `__providerType` keys injected into the runtime
 * `ProviderConfig` by `loadProviderConfig()`.
 */
import {
  createSecret,
  getSecretByKey,
  getSecretValue,
  updateSecretValueByKey,
  deleteSecret,
} from '@/server/services/vault'
import { createLogger } from '@/server/logger'

const log = createLogger('oauth-token-store')

/** Reserved runtime-only config keys threaded through `loadProviderConfig`. */
export const PROVIDER_ID_KEY = '__providerId'
export const PROVIDER_TYPE_KEY = '__providerType'

/** Persisted OAuth bundle. Provider-specific extras live in `extra`. */
export interface OAuthTokenBundle {
  accessToken: string
  refreshToken: string
  /** Absolute expiry, Unix ms (0 / absent = unknown, force a refresh). */
  expiresAt?: number
  /** Provider-specific opaque fields (e.g. Codex ChatGPT account id). */
  extra?: Record<string, string>
}

/** Vault key for a provider's OAuth bundle. */
export function oauthVaultKey(type: string, providerId: string): string {
  return `provider_${type}_${providerId}_oauth`
}

/**
 * Resolve the `(type, providerId)` for the current call from a runtime config.
 * Returns null in CLI-file mode (no provider row threaded) so the caller falls
 * back to the on-disk credentials path.
 */
export function vaultKeyFromConfig(config: Record<string, string | undefined>): string | null {
  const id = config[PROVIDER_ID_KEY]
  const type = config[PROVIDER_TYPE_KEY]
  if (!id || !type) return null
  return oauthVaultKey(type, id)
}

export async function readTokenBundle(vaultKey: string): Promise<OAuthTokenBundle | null> {
  const raw = await getSecretValue(vaultKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as OAuthTokenBundle
    if (!parsed.accessToken && !parsed.refreshToken) return null
    return parsed
  } catch {
    log.warn({ vaultKey }, 'OAuth token bundle is not valid JSON')
    return null
  }
}

/**
 * Persist (create or update) a token bundle. Idempotent on the deterministic
 * key — an update replaces the value in place rather than duplicating.
 */
export async function writeTokenBundle(vaultKey: string, bundle: OAuthTokenBundle): Promise<void> {
  const value = JSON.stringify(bundle)
  const existing = await getSecretByKey(vaultKey)
  if (existing) await updateSecretValueByKey(vaultKey, value)
  else await createSecret(vaultKey, value, undefined, 'OAuth tokens (CLI-free sign-in)')
}

/** Remove a provider's OAuth bundle (called on provider delete). */
export async function deleteTokenBundle(vaultKey: string): Promise<void> {
  const existing = await getSecretByKey(vaultKey)
  if (existing) await deleteSecret(existing.id)
}
