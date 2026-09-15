import { describe, expect, it } from 'bun:test'
import {
  defaultShellKind,
  defaultTerminalShellBinary,
  isWindowsPlatform,
  joinPathEnv,
  pathListSeparator,
  resolveShellSpawn,
  splitPathEnv,
} from '@/server/services/host-platform'

describe('host-platform', () => {
  it('treats win32 as Windows and linux/darwin as not', () => {
    expect(isWindowsPlatform('win32')).toBe(true)
    expect(isWindowsPlatform('linux')).toBe(false)
    expect(isWindowsPlatform('darwin')).toBe(false)
  })

  it('uses ; as the PATH separator on Windows and : elsewhere', () => {
    expect(pathListSeparator('win32')).toBe(';')
    expect(pathListSeparator('linux')).toBe(':')
    expect(splitPathEnv('C:\\Git\\cmd;C:\\nodejs', 'win32')).toEqual(['C:\\Git\\cmd', 'C:\\nodejs'])
    expect(joinPathEnv(['C:\\a', 'C:\\b'], 'win32')).toBe('C:\\a;C:\\b')
    expect(joinPathEnv(['/usr/bin', '/bin'], 'linux')).toBe('/usr/bin:/bin')
  })

  it('defaults run_shell to PowerShell on Windows and bash elsewhere', () => {
    expect(defaultShellKind('win32')).toBe('powershell')
    expect(defaultShellKind('linux')).toBe('bash')
    expect(defaultShellKind('darwin')).toBe('bash')
  })

  it('builds PowerShell / cmd / bash spawn argv', () => {
    const ps = resolveShellSpawn('Get-Date', 'powershell', 'win32')
    expect(ps.file).toBe('powershell.exe')
    expect(ps.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-Date',
    ])

    const pwsh = resolveShellSpawn('Get-Date', 'pwsh', 'win32')
    expect(pwsh.file).toBe('pwsh')
    expect(pwsh.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-Date'])

    const cmd = resolveShellSpawn('echo hi', 'cmd', 'win32')
    expect(cmd.file).toBe('cmd.exe')
    expect(cmd.args).toEqual(['/d', '/s', '/c', 'echo hi'])

    const bash = resolveShellSpawn('echo hi', undefined, 'linux')
    expect(bash.file).toBe('bash')
    expect(bash.args).toEqual(['-c', 'echo hi'])
  })

  it('defaults the interactive terminal to PowerShell on Windows even if SHELL is Git Bash', () => {
    const previous = process.env.SHELL
    const override = process.env.HIVEKEEP_TERMINAL_SHELL
    delete process.env.HIVEKEEP_TERMINAL_SHELL
    process.env.SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe'
    try {
      expect(defaultTerminalShellBinary('win32')).toBe('powershell.exe')
    } finally {
      if (previous === undefined) delete process.env.SHELL
      else process.env.SHELL = previous
      if (override === undefined) delete process.env.HIVEKEEP_TERMINAL_SHELL
      else process.env.HIVEKEEP_TERMINAL_SHELL = override
    }
  })
})
