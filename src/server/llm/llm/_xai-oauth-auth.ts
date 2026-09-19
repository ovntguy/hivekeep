/**
 * xAI SuperGrok OAuth credentials.
 *
 * Instead of an API key, this provider uses OAuth tokens from:
 *   1. The in-app PKCE sign-in (vault), via the generic getVaultOAuthToken.
 *   2. The official Grok CLI auth file (~/.grok/auth.json), refreshed in place.
 *
 * xAI runs a standard OIDC server at auth.x.ai. There is no public developer
 * console to register a third-party OAuth client, so — like Grok CLI, OpenCode,
 * Hermes, and pi-xai-supergrok — we reuse the public Grok-CLI client id
 * (not a secret). The `plan=generic` authorize param is load-bearing: loopback
 * OAuth against this client is rejected without it.
 *
 * Token endpoints speak application/x-www-form-urlencoded (OAuth2 default),
 * not JSON like Anthropic/Codex.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { REAL_HOME, normalizeAbsoluteHome } from '@/server/llm/llm/_home-paths'
import { createLogger } from '@/server/logger'
import type { ProviderConfig } from '@/server/llm/core/types'
import { encodeTokenRequest, type PkceClient } from '@/server/llm/llm/_oauth-pkce'
import { getVaultOAuthToken } from '@/server/llm/llm/_oauth-vault-access'

const log = createLogger('provider:xai-oauth')

/** Public Grok-CLI OAuth client_id. Not a secret — xAI only allowlists this
 *  client for loopback PKCE. Override with HIVEKEEP_XAI_OAUTH_CLIENT_ID. */
const CLIENT_ID =
  process.env.HIVEKEEP_XAI_OAUTH_CLIENT_ID?.trim() || 'b1a00492-073a-47ea-816f-4c329264a828'

const AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const REDIRECT_URI = 'http://127.0.0.1:56121/callback'
const BUFFER_MS = 5 * 60 * 1000

/**
 * PKCE public-client descriptor for the in-app "Sign in with SuperGrok" flow.
 * Mirrors the Grok CLI's own OAuth client. The registered redirect is a fixed
 * loopback URL the headless server can't actually serve — the user copies the
 * `code`/`state` out of the failed-to-load redirect URL and pastes it back
 * (parsePastedCode handles the full-URL form).
 */
export const XAI_PKCE_CLIENT: PkceClient = {
  clientId: CLIENT_ID,
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  redirectUri: REDIRECT_URI,
  scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
  authorizeParams: { plan: 'generic', referrer: 'hivekeep' },
  tokenEncoding: 'form',
}

/**
 * Candidate Grok CLI auth.json paths, tried in order: env HOME (macOS /Users
 * vs the /home/$USER fallback), then USERPROFILE (native Windows — Git Bash
 * HOME is `/c/Users/...`, which is not a native path), then REAL_HOME
 * (snap-adjusted). Relative or empty homes are dropped.
 * @internal exported for tests.
 */
export function grokAuthPathCandidates(
  envHome?: string,
  userProfile?: string,
  realHome?: string,
): string[] {
  const paths: string[] = []
  for (const home of [envHome, userProfile, realHome]) {
    const base = normalizeAbsoluteHome(home)
    if (!base) continue
    const p = join(base, '.grok', 'auth.json')
    if (!paths.includes(p)) paths.push(p)
  }
  return paths
}

function grokAuthCandidates(): string[] {
  return grokAuthPathCandidates(process.env.HOME, process.env.USERPROFILE, REAL_HOME)
}

const CANDIDATE_PATHS = grokAuthCandidates()

interface ParsedGrokAuth {
  accessToken: string
  refreshToken: string
  expiresAt?: number
}

/**
 * Parse a Grok CLI / SuperGrok auth file. Accepts:
 *   - Grok CLI map: `{ "https://auth.x.ai::<client_id>": { key, refresh_token, expires_at } }`
 *   - Flat OAuth: `{ access_token, refresh_token, expires_at? }`
 *   - pi-style: `{ access, refresh, expires }`
 *
 * @internal exported for tests.
 */
export function parseGrokAuthFile(raw: string, preferredClientId: string = CLIENT_ID): ParsedGrokAuth {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Grok auth file is not a JSON object')
  }
  const obj = parsed as Record<string, unknown>

  const preferredKey = `https://auth.x.ai::${preferredClientId}`
  const nested = obj[preferredKey] ?? Object.entries(obj).find(([k]) => k.startsWith('https://auth.x.ai::'))?.[1]
  if (nested && typeof nested === 'object') {
    const entry = nested as Record<string, unknown>
    const access = stringField(entry, 'key') ?? stringField(entry, 'access_token') ?? stringField(entry, 'access')
    const refresh = stringField(entry, 'refresh_token') ?? stringField(entry, 'refresh')
    if (access && refresh) {
      return { accessToken: access, refreshToken: refresh, expiresAt: expiryField(entry) }
    }
  }

  const access = stringField(obj, 'access_token') ?? stringField(obj, 'access')
  const refresh = stringField(obj, 'refresh_token') ?? stringField(obj, 'refresh')
  if (access && refresh) {
    return { accessToken: access, refreshToken: refresh, expiresAt: expiryField(obj) }
  }

  throw new Error('Grok auth file has no access/refresh token pair')
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** expires_at may be Unix seconds or ms; `expires` is an absolute ms timestamp. */
function expiryField(obj: Record<string, unknown>): number | undefined {
  const raw = obj.expires_at ?? obj.expiresAt ?? obj.expires
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  // Values that look like seconds (before year ~2001 in ms, or typical JWT exp).
  return raw < 1e12 ? raw * 1000 : raw
}

function resolveCredsPath(overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    if (!existsSync(overridePath)) {
      throw new Error(`Grok credentials file not found at: ${overridePath}`)
    }
    return overridePath
  }

  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Grok CLI credentials file not found. Searched: ${CANDIDATE_PATHS.join(', ')}. ` +
      'Sign in from Hivekeep, run `grok login`, or provide the path explicitly.',
  )
}

const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>()
const refreshLocks = new Map<string, Promise<string>>()

function ensureFresh(cacheKey: string, refresh: () => Promise<string>): Promise<string> {
  const cached = accessTokenCache.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > BUFFER_MS) {
    return Promise.resolve(cached.accessToken)
  }
  let lock = refreshLocks.get(cacheKey)
  if (!lock) {
    lock = refresh().finally(() => refreshLocks.delete(cacheKey))
    refreshLocks.set(cacheKey, lock)
  }
  return lock
}

async function refreshFromFile(credsPath: string): Promise<string> {
  const raw = readFileSync(credsPath, 'utf8')
  const parsed = parseGrokAuthFile(raw)
  const now = Date.now()
  if (parsed.expiresAt && parsed.expiresAt - now > BUFFER_MS && parsed.accessToken) {
    accessTokenCache.set(credsPath, { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt })
    return parsed.accessToken
  }

  const encoded = encodeTokenRequest(XAI_PKCE_CLIENT, {
    grant_type: 'refresh_token',
    client_id: XAI_PKCE_CLIENT.clientId,
    refresh_token: parsed.refreshToken,
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: encoded.headers,
    body: encoded.body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`xAI OAuth token refresh failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = (await resp.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) throw new Error('xAI OAuth refresh returned no access_token')

  const expiresAt = data.expires_in ? now + data.expires_in * 1000 : now + 3600 * 1000
  const nextRefresh = data.refresh_token ?? parsed.refreshToken

  try {
    const original = JSON.parse(raw) as Record<string, unknown>
    const preferredKey = `https://auth.x.ai::${XAI_PKCE_CLIENT.clientId}`
    if (original[preferredKey] && typeof original[preferredKey] === 'object') {
      const entry = original[preferredKey] as Record<string, unknown>
      if ('key' in entry) entry.key = data.access_token
      else entry.access_token = data.access_token
      entry.refresh_token = nextRefresh
      entry.expires_at = Math.floor(expiresAt / 1000)
    } else if ('access' in original) {
      original.access = data.access_token
      original.refresh = nextRefresh
      original.expires = expiresAt
    } else {
      original.access_token = data.access_token
      original.refresh_token = nextRefresh
      original.expires_at = expiresAt
    }
    writeFileSync(credsPath, JSON.stringify(original, null, 2))
  } catch (err) {
    log.warn({ err }, 'Could not write refreshed Grok auth file')
  }

  accessTokenCache.set(credsPath, { accessToken: data.access_token, expiresAt })
  log.info('xAI OAuth token refreshed successfully (file)')
  return data.access_token
}

/**
 * Get a fresh OAuth access token for api.x.ai.
 *
 * Resolution order:
 *   1. Vault — in-app SuperGrok sign-in.
 *   2. Grok CLI file — `~/.grok/auth.json` (or `authFilePath`).
 */
export async function getXaiOAuthAccessToken(config: ProviderConfig = {}): Promise<string> {
  const vault = await getVaultOAuthToken(config)
  if (vault) return vault.accessToken
  const credsPath = resolveCredsPath(config['authFilePath'] || undefined)
  return ensureFresh(credsPath, () => refreshFromFile(credsPath))
}
