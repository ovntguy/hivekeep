import { describe, expect, it } from 'bun:test'
import { subprocessEnv } from '@/server/services/subprocess-env'

describe('subprocessEnv', () => {
  it('forwards PATH and HOME when set', () => {
    const env = subprocessEnv()
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH)
    if (process.env.HOME) expect(env.HOME).toBe(process.env.HOME)
  })

  it('forwards Windows profile vars when present', () => {
    const previous = process.env.USERPROFILE
    process.env.USERPROFILE = 'C:\\Users\\hivekeep'
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.PS1'
    process.env.SystemRoot = 'C:\\Windows'
    try {
      const env = subprocessEnv()
      expect(env.USERPROFILE).toBe('C:\\Users\\hivekeep')
      expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD;.PS1')
      expect(env.SystemRoot).toBe('C:\\Windows')
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previous
    }
  })

  it('does not leak ENCRYPTION_KEY or provider keys', () => {
    const previous = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'should-not-leak'
    try {
      const env = subprocessEnv()
      expect(env.ENCRYPTION_KEY).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_KEY
      else process.env.ENCRYPTION_KEY = previous
    }
  })
})
