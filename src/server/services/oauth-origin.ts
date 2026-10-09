import type { Context } from 'hono'

/**
 * Loopback OAuth redirect origin when PUBLIC_URL is a private LAN IP.
 *
 * Hivekeep for Windows sets PUBLIC_URL to the LAN URL (http://192.168.x.y:port)
 * so a phone gets working links, while the desktop window keeps talking to
 * http://127.0.0.1:port. Google and Microsoft accept plain-http redirect URIs
 * only on loopback and reject raw private IPs, and the OAuth callback needs the
 * session cookie of the origin that started the flow. So a request that reached
 * this server directly on loopback keeps its own loopback origin for the OAuth
 * redirect URI, but only when PUBLIC_URL is http:// on a private IPv4 literal.
 *
 * "Directly on loopback" is judged from the socket, not from headers:
 *   - the TCP peer address (Bun server.requestIP) must be a loopback address,
 *   - the Host header must name a loopback host on this server's own listening
 *     port (Bun server.port), and
 *   - no proxy header may be present (X-Forwarded-Host, X-Forwarded-Proto,
 *     Forwarded, X-Forwarded-For, X-Real-IP).
 * Anything else, including a missing Bun server (in-process app.fetch), falls
 * back to the existing PUBLIC_URL resolution. Hostname or https PUBLIC_URLs are
 * never affected, so reverse-proxy deployments behave exactly as before.
 */

export const PROXY_HEADERS = ['x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-forwarded-for', 'x-real-ip'] as const

const LOOPBACK_HOST = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::(\d{1,5}))?$/i

export interface DirectRequest {
  /** TCP peer address from the server socket. */
  remoteAddress: string | undefined
  /** Raw Host header. */
  host: string | undefined
  /** Port this server is listening on. */
  serverPort: number | undefined
  /** True when any proxy header is present. */
  proxied: boolean
}

export function isPrivateIPv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  if (m.slice(1).some((p) => Number(p) > 255)) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.trim().toLowerCase()
  if (a === '::1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
  return !!m && m.slice(1).every((p) => Number(p) <= 255)
}

export function loopbackOriginForLanPublicUrl(publicUrl: string | undefined, req: DirectRequest): string | null {
  if (!publicUrl || req.proxied) return null
  if (!isLoopbackAddress(req.remoteAddress)) return null
  if (!req.host || !req.serverPort) return null
  const h = req.host.trim().toLowerCase()
  const m = LOOPBACK_HOST.exec(h)
  if (!m) return null
  const hostPort = m[2] === undefined ? 80 : Number(m[2])
  if (hostPort !== req.serverPort) return null
  let configured: URL
  try {
    configured = new URL(publicUrl)
  } catch {
    return null
  }
  if (configured.protocol !== 'http:' || !isPrivateIPv4(configured.hostname)) return null
  return `http://${h}`
}

interface BunServerLike {
  port?: number
  requestIP?: (req: Request) => { address: string } | null
}

/** The Bun server passed as the 2nd fetch() argument (hono/bun convention), or null. */
function bunServer(env: unknown): BunServerLike | null {
  if (!env || typeof env !== 'object') return null
  const candidate = ('server' in env ? (env as { server: unknown }).server : env) as BunServerLike | null
  if (!candidate || typeof candidate.requestIP !== 'function') return null
  return candidate
}

/** Read the direct-request facts for a Hono context served by Bun.serve. */
export function directRequestInfo(c: Context): DirectRequest {
  // has(), not a truthy value: an empty proxy header still means a proxy is in the path.
  const headers = c.req.raw.headers
  const proxied = PROXY_HEADERS.some((name) => headers.has(name))
  const server = bunServer(c.env)
  let remoteAddress: string | undefined
  try {
    remoteAddress = server?.requestIP?.(c.req.raw)?.address
  } catch {
    remoteAddress = undefined
  }
  const serverPort = typeof server?.port === 'number' ? server.port : undefined
  return { remoteAddress, host: c.req.header('host'), serverPort, proxied }
}

/** Used first by the OAuth routes' publicOrigin(). Null means "use the usual resolution". */
export function loopbackOAuthOrigin(c: Context): string | null {
  return loopbackOriginForLanPublicUrl(process.env.PUBLIC_URL, directRequestInfo(c))
}
