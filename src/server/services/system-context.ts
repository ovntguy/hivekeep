import { execFileSync, execSync } from 'child_process'
import { dirname, join } from 'path'
import { existsSync, readdirSync } from 'fs'
import os from 'os'
import { createLogger } from '@/server/logger'
import {
  defaultShellKind,
  isWindowsPlatform,
  joinPathEnv,
  splitPathEnv,
} from '@/server/services/host-platform'

const log = createLogger('system-context')

export interface RuntimeAvailability {
  name: string
  version: string
}

export interface SystemContext {
  platform: string
  arch: string
  runtimes: RuntimeAvailability[]
  /** Default run_shell interpreter: bash | powershell | pwsh | cmd */
  defaultShell?: string
}

let cached: SystemContext | null = null

// CLIs commonly needed by sub-Agents for builds, tests, version control and
// language tooling. Probed once per server lifetime. We deliberately probe
// through several PATH augmentation passes so non-login-shell deployments
// (systemd user services, Docker, Task Scheduler, supervisord …) still pick
// up the runtimes installed under the operator's profile.
const PROBED_TOOLS = [
  'bun',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'git',
  'python3',
  'python',
  'py',
  'docker',
  'rg',
  'curl',
  'gh',
  'pwsh',
  'powershell',
  'winget',
]

interface ProbeResult {
  version: string
  binDir: string
}

function looksLikeAbsoluteBin(binPath: string): boolean {
  if (isWindowsPlatform()) {
    return /^[a-zA-Z]:[\\/]/.test(binPath) || binPath.startsWith('\\\\')
  }
  return binPath.startsWith('/')
}

/**
 * Augment `process.env.PATH` with directories that frequently hold language
 * runtimes when the host's default PATH is the minimal service default.
 *
 * Sources, in priority order:
 *   1. `dirname(process.execPath)` — the binary running Hivekeep itself.
 *   2. `HIVEKEEP_AUGMENT_PATH` env var (operator-controlled). Uses `;` on
 *      Windows and `:` elsewhere.
 *   3. Well-known user-local bin dirs (`~/.bun/bin`, Git for Windows, WinGet
 *      links, nvm-windows, …).
 *
 * Idempotent — `getSystemContext()` caches after the first call.
 */
function augmentPath(): string[] {
  const additions: string[] = []
  const seen = new Set(splitPathEnv(process.env.PATH))

  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (seen.has(dir)) return
    if (!existsSync(dir)) return
    seen.add(dir)
    additions.push(dir)
  }

  try {
    push(dirname(process.execPath))
  } catch {
    // ignore
  }

  const operatorPaths = process.env.HIVEKEEP_AUGMENT_PATH
  if (operatorPaths) {
    for (const p of splitPathEnv(operatorPaths)) {
      push(p)
    }
  }

  const home = os.homedir()
  if (home) {
    push(join(home, '.bun', 'bin'))
    push(join(home, '.local', 'bin'))
    push(join(home, '.cargo', 'bin'))
    push(join(home, 'go', 'bin'))
    try {
      const nvmRoot = join(home, '.nvm', 'versions', 'node')
      if (existsSync(nvmRoot)) {
        for (const v of readdirSync(nvmRoot)) {
          push(join(nvmRoot, v, 'bin'))
        }
      }
    } catch {
      // nvm not installed
    }
  }

  if (isWindowsPlatform()) {
    const localAppData = process.env.LOCALAPPDATA ?? (home ? join(home, 'AppData', 'Local') : '')
    const roaming = process.env.APPDATA ?? (home ? join(home, 'AppData', 'Roaming') : '')
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
    push(join(roaming, 'npm'))
    push(join(programFiles, 'Git', 'cmd'))
    push(join(programFiles, 'Git', 'bin'))
    push(join(programFiles, 'nodejs'))
    push(join(programFiles, 'PowerShell', '7'))
    push(join(programFilesX86, 'Git', 'cmd'))
    push(process.env.NVM_SYMLINK)
    push(process.env.NVM_HOME)
    if (home) {
      push(join(home, 'scoop', 'shims'))
      push(join(home, '.fnm'))
    }
  }

  if (additions.length > 0) {
    process.env.PATH = joinPathEnv([...additions, ...splitPathEnv(process.env.PATH)])
  }
  return additions
}

function probeUnix(tool: string): ProbeResult | null {
  // `bash -lc` reads the operator's login profile so PATH additions from those
  // files (typical of bun / nvm installers) are picked up.
  try {
    const out = execSync(
      `bash -lc 'p=$(command -v ${tool} 2>/dev/null) && echo "$p" && "${tool}" --version 2>&1 | head -n1'`,
      {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null
    const binPath = lines[0]!
    const version = lines[1]!
    if (!looksLikeAbsoluteBin(binPath)) return null
    return { version, binDir: dirname(binPath) }
  } catch {
    return null
  }
}

function probeWindows(tool: string): ProbeResult | null {
  try {
    const whereOut = execFileSync('where.exe', [tool], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const binPath = whereOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
    if (!binPath || !looksLikeAbsoluteBin(binPath)) return null
    let version = 'available'
    try {
      const verOut = execFileSync(binPath, ['--version'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const first = verOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
      if (first) version = first
    } catch {
      // Some Windows CLIs (winget, powershell) don't honor --version.
    }
    return { version, binDir: dirname(binPath) }
  } catch {
    return null
  }
}

function probe(tool: string): ProbeResult | null {
  return isWindowsPlatform() ? probeWindows(tool) : probeUnix(tool)
}

/**
 * Get the host system context (platform, arch, available CLIs).
 *
 * Side effect on first call: augments `process.env.PATH`, then probes each
 * tool. Cached after the first call.
 */
export function getSystemContext(): SystemContext {
  if (cached) return cached
  const pathAdditions = augmentPath()
  if (pathAdditions.length > 0) {
    log.info({ added: pathAdditions }, 'PATH augmented before probe')
  }

  const runtimes: RuntimeAvailability[] = []
  const probedDirs = new Set<string>()
  for (const t of PROBED_TOOLS) {
    const result = probe(t)
    if (!result) continue
    runtimes.push({ name: t, version: result.version })
    probedDirs.add(result.binDir)
  }

  const existing = new Set(splitPathEnv(process.env.PATH))
  const postProbeAdditions: string[] = []
  for (const dir of probedDirs) {
    if (!existing.has(dir)) postProbeAdditions.push(dir)
  }
  if (postProbeAdditions.length > 0) {
    process.env.PATH = joinPathEnv([...postProbeAdditions, ...splitPathEnv(process.env.PATH)])
    log.info({ added: postProbeAdditions }, 'PATH augmented with detected tool dirs')
  }

  cached = {
    platform: os.platform(),
    arch: os.arch(),
    runtimes,
    defaultShell: defaultShellKind(),
  }
  log.info(
    {
      platform: cached.platform,
      arch: cached.arch,
      defaultShell: cached.defaultShell,
      runtimes: runtimes.map((r) => r.name),
    },
    'System context probed',
  )
  return cached
}

/** Reset the cache. Test-only. */
export function _resetSystemContextCache(): void {
  cached = null
}
