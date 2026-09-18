/**
 * Provider config ↔ vault bridge.
 *
 * Hivekeep keeps the single source of truth for every provider secret in the
 * vault (`vault_secrets`). A provider's `configEncrypted` blob stores a
 * **reference** (`$vault:<key>`) for each `secret`-typed config field instead
 * of the raw value — so rotating a key is a one-line vault update, and the
 * same secret can be referenced from several places without copies.
 *
 * This generalises the pattern channels already use (`channel_<platform>_<id>_<field>`).
 *
 * Two directions:
 *  - WRITE: `vaultifyProviderConfig()` moves raw secret fields into the vault
 *    and returns the config-with-references to encrypt + store.
 *  - READ:  `loadProviderConfig()` is the single chokepoint every consumer
 *    must use instead of decrypting `configEncrypted` by hand — it decrypts,
 *    parses, and hydrates `$vault:` references back to their real values
 *    just-in-time, right before the provider client is built.
 *
 * Non-secret fields (baseUrl, region, custom-model lists…) stay inline.
 * Provider types whose `configSchema` declares no `secret` field (e.g. the
 * OAuth-based anthropic-oauth / openai-codex / xai-oauth) are left untouched.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { decrypt, encrypt } from '@/server/services/encryption'
import {
  createSecret,
  getSecretByKey,
  getSecretValue,
  updateSecretValueByKey,
  deleteSecret,
} from '@/server/services/vault'
import { getSecretFieldKeys } from '@/server/providers/index'
import { createLogger } from '@/server/logger'
import type { ProviderConfig } from '@/server/llm/core/types'
import {
  PROVIDER_ID_KEY,
  PROVIDER_TYPE_KEY,
  oauthVaultKey,
  deleteTokenBundle,
} from '@/server/llm/llm/_oauth-token-store'

const log = createLogger('provider-config')

/** Prefix marking a config value as a vault reference rather than a literal. */
export const VAULT_REF_PREFIX = '$vault:'

type ProviderRowLike = { id?: string; type?: string; configEncrypted: string | null }

export function isVaultRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VAULT_REF_PREFIX)
}

/** Strip the `$vault:` prefix → the bare vault key. */
export function vaultRefKey(ref: string): string {
  return ref.slice(VAULT_REF_PREFIX.length)
}

/** Canonical vault key for a provider's secret field. Mirrors the channel
 *  convention (`channel_<platform>_<id>_<field>`). */
export function providerVaultKey(type: string, providerId: string, field: string): string {
  return `provider_${type}_${providerId}_${field}`
}

/**
 * Resolve a parsed config object — which may contain `$vault:` references —
 * to a flat `{ key: realValue }` map ready to hand to a provider's
 * `authenticate()` / `chat()` / `embed()` / … call.
 *
 * A reference whose vault entry is missing (deleted out from under us)
 * resolves to `undefined` — the field is omitted so the provider fails with
 * its normal "missing credentials" error rather than leaking the ref string.
 */
export async function hydrateProviderConfig(
  parsed: Record<string, unknown>,
): Promise<ProviderConfig> {
  const out: ProviderConfig = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (isVaultRef(v)) {
      const value = await getSecretValue(vaultRefKey(v))
      if (value != null) out[k] = value
      else log.warn({ field: k, vaultKey: vaultRefKey(v) }, 'Provider config references a missing vault secret')
    } else if (typeof v === 'string') {
      out[k] = v
    }
  }
  return out
}

/**
 * THE chokepoint. Decrypt + parse + hydrate a provider row's config.
 * Every consumer must call this instead of `JSON.parse(await decrypt(row.configEncrypted))`.
 */
export async function loadProviderConfig(row: ProviderRowLike): Promise<ProviderConfig> {
  const base: ProviderConfig = {}
  // Thread the provider row identity through as reserved runtime-only keys so
  // mode-aware accessors (e.g. the OAuth providers' vault-backed token store)
  // can locate per-provider state. These never persist — `vaultifyProviderConfig`
  // strips `__`-prefixed keys before writing.
  if (row.id) base[PROVIDER_ID_KEY] = row.id
  if (row.type) base[PROVIDER_TYPE_KEY] = row.type
  if (!row.configEncrypted) return base
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await decrypt(row.configEncrypted)) as Record<string, unknown>
  } catch {
    return base
  }
  return { ...base, ...(await hydrateProviderConfig(parsed)) }
}

/**
 * WRITE path. Given a raw config (with real secret values) for a provider
 * being created or updated, move every `secret`-typed field into the vault
 * and return the config-with-references to encrypt + persist.
 *
 * Idempotent and rotation-friendly: the vault key is deterministic
 * (`provider_<type>_<id>_<field>`), so an update reuses the existing entry
 * (value replaced in place) rather than creating duplicates. A field already
 * holding a `$vault:` ref, or an empty/absent secret, is passed through
 * untouched (so a PATCH that doesn't re-send the key keeps the stored one).
 */
export async function vaultifyProviderConfig(
  type: string,
  providerId: string,
  rawConfig: Record<string, unknown>,
  createdByAgentId?: string,
): Promise<Record<string, unknown>> {
  const secretFields = new Set(getSecretFieldKeys(type))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawConfig)) {
    // Reserved runtime-only keys (e.g. __providerId) must never be persisted —
    // they're re-injected on every load() and would otherwise round-trip into
    // the stored config via a PATCH that re-vaultifies loadProviderConfig output.
    if (k.startsWith('__')) continue
    if (!secretFields.has(k) || isVaultRef(v)) {
      out[k] = v
      continue
    }
    if (typeof v !== 'string' || v === '') {
      // Empty/non-string secret → don't store; drop the field so it doesn't
      // clobber an existing ref when the caller merges before persisting.
      continue
    }
    const key = providerVaultKey(type, providerId, k)
    const existing = await getSecretByKey(key)
    if (existing) await updateSecretValueByKey(key, v)
    else await createSecret(key, v, createdByAgentId, `${k} for provider ${type}`)
    out[k] = VAULT_REF_PREFIX + key
  }
  return out
}

/**
 * Delete every vault secret referenced by a provider's config. Call this when
 * deleting the provider so its `provider_*` vault entries don't dangle.
 */
export async function deleteProviderVaultSecrets(row: ProviderRowLike): Promise<void> {
  // CLI-free OAuth providers store their token bundle under a deterministic
  // key that isn't referenced inline in the config, so clean it up explicitly.
  if (row.id && row.type) {
    await deleteTokenBundle(oauthVaultKey(row.type, row.id))
  }
  if (!row.configEncrypted) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await decrypt(row.configEncrypted)) as Record<string, unknown>
  } catch {
    return
  }
  for (const v of Object.values(parsed)) {
    if (!isVaultRef(v)) continue
    const secret = await getSecretByKey(vaultRefKey(v))
    if (secret) await deleteSecret(secret.id)
  }
}

/**
 * One-time, idempotent boot migration: move any provider whose secrets are
 * still stored inline into the vault, rewriting the config to references.
 * Safe to run on every boot — already-migrated rows (config already contains
 * a `$vault:` ref) are skipped.
 */
export async function migrateProviderConfigsToVault(): Promise<void> {
  const rows = await db.select().from(providers).all()
  let migrated = 0
  for (const row of rows) {
    if (!row.configEncrypted) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(await decrypt(row.configEncrypted)) as Record<string, unknown>
    } catch {
      continue
    }
    if (Object.values(parsed).some(isVaultRef)) continue // already migrated
    const vaulted = await vaultifyProviderConfig(row.type, row.id, parsed)
    if (!Object.values(vaulted).some(isVaultRef)) continue // nothing secret to move
    await db
      .update(providers)
      .set({ configEncrypted: await encrypt(JSON.stringify(vaulted)), updatedAt: new Date() })
      .where(eq(providers.id, row.id))
    migrated++
    log.info({ providerId: row.id, type: row.type }, 'Migrated provider secrets to vault')
  }
  if (migrated > 0) log.info({ count: migrated }, 'Provider config → vault migration complete')
}
