/**
 * Provider config vault bridge. OAuth-based anthropic-oauth / openai-codex / xai-oauth are left untouched.
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
export const VAULT_REF_PREFIX = '$vault:'
