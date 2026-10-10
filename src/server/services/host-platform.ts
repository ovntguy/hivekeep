/**
 * Host OS helpers for Agent shells.
 *
 * `run_shell`, PATH probing, and the Environment prompt all need to agree on
 * whether this Hivekeep is a Windows host and which interpreter is the default.
 * Linux/macOS keep bash; native Windows 11 defaults to PowerShell.
 */

export const SHELL_KINDS = ['powershell', 'pwsh', 'cmd', 'bash'] as const
export type ShellKind = (typeof SHELL_KINDS)[number]

export function isWindowsPlatform(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function pathListSeparator(platform: string = process.platform): ';' | ':' {
  return isWindowsPlatform(platform) ? ';' : ':'
}

export function splitPathEnv(raw: string | undefined, platform: string = process.platform): string[] {
  if (!raw) return []
  return raw.split(pathListSeparator(platform)).map((p) => p.trim()).filter(Boolean)
}

export function joinPathEnv(dirs: string[], platform: string = process.platform): string {
  return dirs.filter(Boolean).join(pathListSeparator(platform))
}

/**
 * Default `run_shell` interpreter.
 *
 * On Windows, prefer PowerShell 7 (`pwsh`) when this process can actually
 * spawn it; otherwise Windows PowerShell 5.1 (`powershell.exe`). Tests that
 * pass `platform: 'win32'` while running on Linux get `powershell` without
 * probing the host.
 */
export function defaultShellKind(platform: string = process.platform): ShellKind {
  if (!isWindowsPlatform(platform)) return 'bash'
  if (process.platform !== 'win32') return 'powershell'
  return preferredWindowsPowerShell()
}

let cachedPreferredWindows: 'pwsh' | 'powershell' | null = null

export function preferredWindowsPowerShell(): 'pwsh' | 'powershell' {
  if (cachedPreferredWindows) return cachedPreferredWindows
  if (process.platform !== 'win32') {
    cachedPreferredWindows = 'powershell'
    return cachedPreferredWindows
  }
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process')
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      timeout: 2500,
      stdio: 'ignore',
    })
    cachedPreferredWindows = 'pwsh'
  } catch {
    cachedPreferredWindows = 'powershell'
  }
  return cachedPreferredWindows
}

/** Test-only. */
export function _resetPreferredWindowsPowerShell(): void {
  cachedPreferredWindows = null
}

export interface ShellSpawn {
  file: string
  args: string[]
  kind: ShellKind
}

/**
 * argv for `Bun.spawn` / `execFile`. `command` is a single argument — never
 * interpolated into a string that the interpreter would re-parse as multiple
 * tokens beyond what `-Command` / `-c` / `/c` already do.
 */
export function resolveShellSpawn(
  command: string,
  shell?: ShellKind | null,
  platform: string = process.platform,
): ShellSpawn {
  const kind = shell ?? defaultShellKind(platform)
  switch (kind) {
    case 'bash':
      return { file: 'bash', args: ['-c', command], kind }
    case 'cmd':
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command], kind }
    case 'pwsh':
      return {
        file: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
        kind,
      }
    case 'powershell':
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        kind,
      }
  }
}

/**
 * Interactive web-terminal binary. `HIVEKEEP_TERMINAL_SHELL` always wins.
 * On Windows, PowerShell is the default even if `$SHELL` is Git Bash. On
 * Linux/macOS, `$SHELL` then `/bin/bash`.
 */
export function defaultTerminalShellBinary(platform: string = process.platform): string {
  if (process.env.HIVEKEEP_TERMINAL_SHELL) return process.env.HIVEKEEP_TERMINAL_SHELL
  if (isWindowsPlatform(platform)) {
    const shell = process.env.SHELL
    if (shell && /(?:powershell|pwsh|cmd\.exe)/i.test(shell)) return shell
    return defaultShellKind(platform) === 'pwsh' ? 'pwsh' : 'powershell.exe'
  }
  if (process.env.SHELL) return process.env.SHELL
  return '/bin/bash'
}

/** Env vars a Windows child process needs on top of the Unix allow-list. */
export const WINDOWS_SAFE_ENV_VARS = [
  'USERPROFILE',
  'USERNAME',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PUBLIC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PSModulePath',
] as const
