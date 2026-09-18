import { describe, expect, it, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import {
  generatePkce,
  buildPkceAuthorizeUrl,
  parsePastedCode,
  exchangePkceCode,
  encodeTokenRequest,
  decodeJwtClaims,
  type PkceClient,
} from './_oauth-pkce'
