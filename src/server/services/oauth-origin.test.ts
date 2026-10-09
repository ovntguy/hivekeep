import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  PROXY_HEADERS,
  isLoopbackAddress,
  isPrivateIPv4,
  loopbackOAuthOrigin,
  loopbackOriginForLanPublicUrl,
} from '@/server/services/oauth-origin'

const LAN = 'http://192.168.50.61:3000'
const direct = (over: Partial<Parameters<typeof loopbackOriginForLanPublicUrl>[1]> = {}) => ({
  remoteAddress: '127.0.0.1',
  host: '127.0.0.1:3000',
  serverPort: 3000,
  proxied: false,
  ...over,
})

describe('loopbackOriginForLanPublicUrl', () => {
  it('keeps a direct loopback request on its own origin when PUBLIC_URL is a private-IPv4 http URL', () => {
    expect(loopbackOriginForLanPublicUrl(LAN, direct())).toBe('http://127.0.0.1:3000')
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: '[::1]:3000', remoteAddress: '::1' }))).toBe('http://[::1]:3000')
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ remoteAddress: '::ffff:127.0.0.1' }))).toBe('http://127.0.0.1:3000')
    expect(loopbackOriginForLanPublicUrl('http://10.0.0.4:3000', direct())).toBe('http://127.0.0.1:3000')
  })

  it('ignores a spoofed loopback Host from a LAN socket', () => {
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ remoteAddress: '192.168.50.20' }))).toBeNull()
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ remoteAddress: undefined }))).toBeNull()
  })

  it('requires the Host port to equal the listening port', () => {
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: '127.0.0.1:3001' }))).toBeNull()
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: '127.0.0.1' }))).toBeNull()
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ serverPort: undefined }))).toBeNull()
  })

  it('does nothing for proxied requests, LAN Host, or hostname/https/public PUBLIC_URLs', () => {
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ proxied: true }))).toBeNull()
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: '192.168.50.61:3000' }))).toBeNull()
    expect(loopbackOriginForLanPublicUrl('https://hive.example.com', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl('http://hive.example.com', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl('https://192.168.50.61', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl('http://8.8.8.8:3000', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl('http://100.64.1.2:3000', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl(undefined, direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl('not a url', direct())).toBeNull()
    expect(loopbackOriginForLanPublicUrl(LAN, direct({ host: undefined }))).toBeNull()
  })
})

describe('isPrivateIPv4 / isLoopbackAddress', () => {
  it('accepts RFC 1918 only', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.50.61']) expect(isPrivateIPv4(ip)).toBe(true)
    for (const ip of ['172.15.0.1', '127.0.0.1', '8.8.8.8', '100.64.0.1', '192.168.1.256', 'hive.example.com'])
      expect(isPrivateIPv4(ip)).toBe(false)
  })
  it('accepts loopback socket addresses only', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip)).toBe(true)
    for (const ip of ['192.168.50.20', '::ffff:192.168.50.20', '0.0.0.0', '', undefined]) expect(isLoopbackAddress(ip)).toBe(false)
  })
})

describe('loopbackOAuthOrigin (Hono context)', () => {
  const saved = process.env.PUBLIC_URL
  beforeEach(() => {
    process.env.PUBLIC_URL = LAN
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_URL
    else process.env.PUBLIC_URL = saved
  })

  const app = new Hono()
  app.get('/o', (c) => c.json({ origin: loopbackOAuthOrigin(c) }))
  const fakeServer = (address: string, port = 3000) => ({ port, requestIP: () => ({ address, family: 'IPv4', port: 55555 }) })
  const call = async (server: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(new Request('http://127.0.0.1:3000/o', { headers: { host: '127.0.0.1:3000', ...headers } }), server)
    return ((await res.json()) as { origin: string | null }).origin
  }

  it('uses the socket address, not the Host header', async () => {
    expect(await call(fakeServer('127.0.0.1'))).toBe('http://127.0.0.1:3000')
    expect(await call(fakeServer('192.168.50.20'))).toBeNull()
  })

  it('requires the Host port to match server.port', async () => {
    expect(await call(fakeServer('127.0.0.1', 3107))).toBeNull()
  })

  for (const name of PROXY_HEADERS) {
    it(`treats ${name} as proxied`, async () => {
      expect(await call(fakeServer('127.0.0.1'), { [name]: name === 'forwarded' ? 'for=127.0.0.1' : '127.0.0.1' })).toBeNull()
    })
  }

  for (const name of PROXY_HEADERS) {
    it(`treats an empty ${name} as proxied`, async () => {
      const req = new Request('http://127.0.0.1:3000/o', { headers: { host: '127.0.0.1:3000', [name]: '' } })
      expect(req.headers.has(name)).toBe(true)
      const res = await app.fetch(req, fakeServer('127.0.0.1'))
      expect(((await res.json()) as { origin: string | null }).origin).toBeNull()
    })
  }

  it('covers all five proxy headers', () => {
    expect([...PROXY_HEADERS].sort()).toEqual(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
  })

  it('falls back when there is no Bun server (in-process app.fetch)', async () => {
    expect(await call(undefined)).toBeNull()
    expect(await call({})).toBeNull()
  })

  it('leaves hostname and https PUBLIC_URLs unchanged', async () => {
    process.env.PUBLIC_URL = 'https://hive.example.com'
    expect(await call(fakeServer('127.0.0.1'))).toBeNull()
    process.env.PUBLIC_URL = 'http://hive.example.com'
    expect(await call(fakeServer('127.0.0.1'))).toBeNull()
  })
})

describe('loopbackOAuthOrigin over a real Bun.serve socket', () => {
  it('returns the loopback origin for a direct request and null for a wrong Host port', async () => {
    const saved = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = LAN
    const app = new Hono()
    app.get('/o', (c) => c.json({ origin: loopbackOAuthOrigin(c) }))
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req, srv) => app.fetch(req, srv) })
    try {
      const port = server.port as number
      const ok = (await (await fetch(`http://127.0.0.1:${port}/o`)).json()) as { origin: string | null }
      expect(ok.origin).toBe(`http://127.0.0.1:${port}`)
      const wrong = (await (
        await fetch(`http://127.0.0.1:${port}/o`, { headers: { host: `127.0.0.1:${port + 1}` } })
      ).json()) as { origin: string | null }
      expect(wrong.origin).toBeNull()
      const proxied = (await (
        await fetch(`http://127.0.0.1:${port}/o`, { headers: { 'x-forwarded-for': '192.168.50.20' } })
      ).json()) as { origin: string | null }
      expect(proxied.origin).toBeNull()
    } finally {
      server.stop(true)
      if (saved === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = saved
    }
  })
})
