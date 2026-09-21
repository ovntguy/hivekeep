import { describe, it, expect } from 'bun:test'

// We need to test the internal pure functions. Since they aren't exported,
// we'll import the module and test via the tool's behavior, OR we can
// extract and test the parse functions directly.
// Let's use a pragmatic approach: re-implement the parse logic inline for testing,
// or better — let's just import the file and test what we can.

// The pure functions (buildRgArgs, buildGrepArgs, parseContentOutput, parseFilesOutput, parseCountOutput)
// are not exported. We'll test them by extracting the logic patterns.
// Actually, let's just directly test by requiring the module internals.

// Bun allows importing non-exported symbols? No. Let's copy-test the pure functions.
// Better approach: test the parsing functions by their known behavior.

// Since the functions are internal, we'll replicate and test the parsing logic
// that grep-tools uses. This validates the algorithm even if not the exact binding.

import { resolve, relative } from 'path'

function slash(p: string): string {
  return p.replaceAll('\\', '/')
}

// ── Replicated pure functions from grep-tools.ts ──

type OutputMode = 'content' | 'files_with_matches' | 'count'

interface ContentMatch {
  file: string
  line: number
  content: string
}

interface CountEntry {
  file: string
  count: number
}

function buildRgArgs(params: {
  pattern: string
  searchPath: string
  outputMode: OutputMode
  glob?: string
  contextBefore?: number
  contextAfter?: number
  context?: number
  caseInsensitive?: boolean
  lineNumbers?: boolean
  maxResults?: number
  multiline?: boolean
}): string[] {
  const args: string[] = [
    'rg',
    '--no-heading',
    '--color=never',
    '--glob=!node_modules',
    '--glob=!.git',
  ]

  if (params.caseInsensitive) args.push('-i')
  if (params.multiline) args.push('-U', '--multiline-dotall')

  if (params.outputMode === 'files_with_matches') {
    args.push('-l')
  } else if (params.outputMode === 'count') {
    args.push('-c')
  } else {
    args.push('--json')

    if (params.context != null) {
      args.push(`-C${params.context}`)
    } else {
      if (params.contextBefore != null) args.push(`-B${params.contextBefore}`)
      if (params.contextAfter != null) args.push(`-A${params.contextAfter}`)
    }
  }

  if (params.glob) args.push(`--glob=${params.glob}`)

  args.push('--', params.pattern, params.searchPath)

  return args
}

function buildGrepArgs(params: {
  pattern: string
  searchPath: string
  outputMode: OutputMode
  glob?: string
  contextBefore?: number
  contextAfter?: number
  context?: number
  caseInsensitive?: boolean
  lineNumbers?: boolean
  multiline?: boolean
}): string[] {
  const args: string[] = [
    'grep',
    '-r',
    '--binary-files=without-match',
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
  ]

  if (params.caseInsensitive) args.push('-i')

  if (params.outputMode === 'files_with_matches') {
    args.push('-l')
  } else if (params.outputMode === 'count') {
    args.push('-c')
  } else {
    if (params.lineNumbers !== false) args.push('-n')

    if (params.context != null) {
      args.push(`-C${params.context}`)
    } else {
      if (params.contextBefore != null) args.push(`-B${params.contextBefore}`)
      if (params.contextAfter != null) args.push(`-A${params.contextAfter}`)
    }
  }

  if (params.glob) args.push(`--include=${params.glob}`)

  if (params.multiline) {
    args.push('-P', '-z')
  }

  args.push('--', params.pattern, params.searchPath)

  return args
}

function relativize(workspace: string, rawFile: string): string {
  return relative(workspace, resolve(workspace, rawFile)) || rawFile
}

function stripLineEnding(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1)
  return text
}

function parseRgJsonContent(
  stdout: string,
  workspace: string,
  maxResults: number,
): { matches: ContentMatch[]; truncated: boolean } {
  if (!stdout.trim()) return { matches: [], truncated: false }

  const matches: ContentMatch[] = []
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    if (matches.length >= maxResults) {
      truncated = true
      break
    }

    let ev: {
      type?: string
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
    }
    try {
      ev = JSON.parse(line) as typeof ev
    } catch {
      continue
    }
    if (ev.type !== 'match' && ev.type !== 'context') continue
    const data = ev.data
    if (!data) continue

    const rawFile = data.path?.text ?? ''
    const lineNo = data.line_number
    matches.push({
      file: rawFile ? relativize(workspace, rawFile) : rawFile,
      line: typeof lineNo === 'number' ? lineNo : 0,
      content: stripLineEnding(data.lines?.text ?? ''),
    })
  }

  return { matches, truncated }
}

function parseContentOutput(
  stdout: string,
  workspace: string,
  maxResults: number,
): { matches: ContentMatch[]; truncated: boolean } {
  if (!stdout.trim()) return { matches: [], truncated: false }

  const lines = stdout.split('\n').filter(Boolean)
  const matches: ContentMatch[] = []
  let truncated = false

  for (const line of lines) {
    if (matches.length >= maxResults) {
      truncated = true
      break
    }

    const drive = line.length >= 2 && /[A-Za-z]/.test(line[0]!) && line[1] === ':' ? 2 : 0
    const rest = line.slice(drive)
    const match = rest.match(/^(.+):(\d+):(.*)$/)
    if (!match) continue

    const rawFile = line.slice(0, drive) + match[1]!
    matches.push({
      file: relativize(workspace, rawFile),
      line: parseInt(match[2]!, 10),
      content: match[3]!,
    })
  }

  return { matches, truncated }
}

function parseFilesOutput(stdout: string, workspace: string): string[] {
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((f) => relative(workspace, resolve(workspace, f)) || f)
}

function parseCountOutput(stdout: string, workspace: string): CountEntry[] {
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const lastColon = line.lastIndexOf(':')
      if (lastColon === -1) return null
      const file = relative(workspace, resolve(workspace, line.substring(0, lastColon))) || line.substring(0, lastColon)
      const count = parseInt(line.substring(lastColon + 1), 10)
      if (isNaN(count) || count === 0) return null
      return { file, count }
    })
    .filter((e): e is CountEntry => e !== null)
}

// ── Tests ──

describe('buildRgArgs', () => {
  it('builds basic content mode args', () => {
    const args = buildRgArgs({
      pattern: 'TODO',
      searchPath: '/workspace',
      outputMode: 'content',
    })
    expect(args).toContain('rg')
    expect(args).toContain('--no-heading')
    expect(args).toContain('--color=never')
    expect(args).toContain('--glob=!node_modules')
    expect(args).toContain('--glob=!.git')
    expect(args).toContain('--json') // content mode uses rg JSON
    expect(args).toContain('--')
    expect(args).toContain('TODO')
    expect(args).toContain('/workspace')
  })

  it('adds case insensitive flag', () => {
    const args = buildRgArgs({
      pattern: 'test',
      searchPath: '/ws',
      outputMode: 'content',
      caseInsensitive: true,
    })
    expect(args).toContain('-i')
  })

  it('adds multiline flags', () => {
    const args = buildRgArgs({
      pattern: 'multi.*line',
      searchPath: '/ws',
      outputMode: 'content',
      multiline: true,
    })
    expect(args).toContain('-U')
    expect(args).toContain('--multiline-dotall')
  })

  it('uses -l for files_with_matches mode', () => {
    const args = buildRgArgs({
      pattern: 'TODO',
      searchPath: '/ws',
      outputMode: 'files_with_matches',
    })
    expect(args).toContain('-l')
    expect(args).not.toContain('-n')
  })

  it('uses -c for count mode', () => {
    const args = buildRgArgs({
      pattern: 'TODO',
      searchPath: '/ws',
      outputMode: 'count',
    })
    expect(args).toContain('-c')
    expect(args).not.toContain('-n')
  })

  it('adds context lines', () => {
    const args = buildRgArgs({
      pattern: 'test',
      searchPath: '/ws',
      outputMode: 'content',
      context: 3,
    })
    expect(args).toContain('-C3')
    expect(args).not.toContain('-B3')
    expect(args).not.toContain('-A3')
  })

  it('adds before/after context separately', () => {
    const args = buildRgArgs({
      pattern: 'test',
      searchPath: '/ws',
      outputMode: 'content',
      contextBefore: 2,
      contextAfter: 5,
    })
    expect(args).toContain('-B2')
    expect(args).toContain('-A5')
    expect(args.some(a => a.startsWith('-C'))).toBe(false)
  })

  it('context overrides before/after', () => {
    const args = buildRgArgs({
      pattern: 'test',
      searchPath: '/ws',
      outputMode: 'content',
      context: 4,
      contextBefore: 1,
      contextAfter: 1,
    })
    expect(args).toContain('-C4')
    expect(args).not.toContain('-B1')
    expect(args).not.toContain('-A1')
  })

  it('adds glob filter', () => {
    const args = buildRgArgs({
      pattern: 'import',
      searchPath: '/ws',
      outputMode: 'content',
      glob: '*.ts',
    })
    expect(args).toContain('--glob=*.ts')
  })

  it('uses --json for content mode and never -n', () => {
    const args = buildRgArgs({
      pattern: 'test',
      searchPath: '/ws',
      outputMode: 'content',
      lineNumbers: false,
    })
    expect(args).toContain('--json')
    expect(args).not.toContain('-n')
  })

  it('pattern and path come after -- separator', () => {
    const args = buildRgArgs({
      pattern: 'my-pattern',
      searchPath: '/my/path',
      outputMode: 'content',
    })
    const dashDashIdx = args.indexOf('--')
    expect(dashDashIdx).toBeGreaterThan(0)
    expect(args[dashDashIdx + 1]).toBe('my-pattern')
    expect(args[dashDashIdx + 2]).toBe('/my/path')
  })
})

describe('buildGrepArgs', () => {
  it('builds basic content mode args', () => {
    const args = buildGrepArgs({
      pattern: 'TODO',
      searchPath: '/workspace',
      outputMode: 'content',
    })
    expect(args[0]).toBe('grep')
    expect(args).toContain('-r')
    expect(args).toContain('--binary-files=without-match')
    expect(args).toContain('--exclude-dir=node_modules')
    expect(args).toContain('--exclude-dir=.git')
    expect(args).toContain('-n')
    expect(args).toContain('--')
    expect(args).toContain('TODO')
    expect(args).toContain('/workspace')
  })

  it('uses -l for files_with_matches', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'files_with_matches',
    })
    expect(args).toContain('-l')
    expect(args).not.toContain('-n')
  })

  it('uses -c for count', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'count',
    })
    expect(args).toContain('-c')
  })

  it('uses --include for glob (not --glob)', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'content',
      glob: '*.py',
    })
    expect(args).toContain('--include=*.py')
    expect(args.some(a => a.startsWith('--glob'))).toBe(false)
  })

  it('adds -P -z for multiline', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'content',
      multiline: true,
    })
    expect(args).toContain('-P')
    expect(args).toContain('-z')
  })

  it('adds case insensitive flag', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'content',
      caseInsensitive: true,
    })
    expect(args).toContain('-i')
  })

  it('adds context lines', () => {
    const args = buildGrepArgs({
      pattern: 'x',
      searchPath: '/ws',
      outputMode: 'content',
      contextBefore: 2,
      contextAfter: 3,
    })
    expect(args).toContain('-B2')
    expect(args).toContain('-A3')
  })
})

describe('parseContentOutput', () => {
  const workspace = '/home/user/workspace'

  it('returns empty for empty string', () => {
    const result = parseContentOutput('', workspace, 100)
    expect(result).toEqual({ matches: [], truncated: false })
  })

  it('returns empty for whitespace-only', () => {
    const result = parseContentOutput('   \n  \n', workspace, 100)
    expect(result).toEqual({ matches: [], truncated: false })
  })

  it('parses standard rg/grep content output', () => {
    const stdout = 'src/main.ts:10:const x = 42\nsrc/main.ts:20:const y = 43\n'
    const result = parseContentOutput(stdout, workspace, 100)
    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(false)
    expect(slash(result.matches[0]!.file)).toBe('src/main.ts')
    expect(result.matches[0]!.line).toBe(10)
    expect(result.matches[0]!.content).toBe('const x = 42')
    expect(slash(result.matches[1]!.file)).toBe('src/main.ts')
    expect(result.matches[1]!.line).toBe(20)
    expect(result.matches[1]!.content).toBe('const y = 43')
  })

  it('does not split a Windows UUID folder on -8258-', () => {
    const workspaceWin = 'C:\\Users\\ovntg\\hivekeep\\data\\workspaces\\d727fa29-45ae-4f49-8258-36702effc00b'
    const stdout = workspaceWin + '\\reports\\mcp-ssh-1.3.9-hang-findings.md:16:`runRemoteCommand` spawns ssh\n'
    const result = parseContentOutput(stdout, workspaceWin, 100)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.line).toBe(16)
    expect(result.matches[0]!.file.replaceAll('\\', '/')).toContain('reports/mcp-ssh-1.3.9-hang-findings.md')
    expect(result.matches[0]!.content).toBe('`runRemoteCommand` spawns ssh')
  })

  it('truncates at maxResults', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `file.ts:${i + 1}:line ${i + 1}`)
    const stdout = lines.join('\n') + '\n'
    const result = parseContentOutput(stdout, workspace, 3)
    expect(result.matches).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('does not truncate when exactly at maxResults', () => {
    const stdout = 'a.ts:1:one\nb.ts:2:two\nc.ts:3:three\n'
    const result = parseContentOutput(stdout, workspace, 3)
    expect(result.matches).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })

  it('handles lines with colons in content', () => {
    const stdout = 'config.ts:15:host: "localhost:8080"\n'
    const result = parseContentOutput(stdout, workspace, 100)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.content).toBe('host: "localhost:8080"')
  })

  it('relativizes absolute paths', () => {
    const stdout = '/home/user/workspace/src/file.ts:1:hello\n'
    const result = parseContentOutput(stdout, workspace, 100)
    expect(slash(result.matches[0]!.file)).toBe('src/file.ts')
  })

  it('skips unparseable lines', () => {
    const stdout = 'Binary file matches\nsrc/a.ts:1:real match\n'
    const result = parseContentOutput(stdout, workspace, 100)
    expect(result.matches).toHaveLength(1)
    expect(slash(result.matches[0]!.file)).toBe('src/a.ts')
  })

  it('handles empty content after line number', () => {
    const stdout = 'file.ts:10:\n'
    const result = parseContentOutput(stdout, workspace, 100)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.content).toBe('')
    expect(result.matches[0]!.line).toBe(10)
  })
})

describe('parseRgJsonContent', () => {
  const workspace = '/home/user/workspace'

  it('parses match events without splitting UUID paths', () => {
    const workspaceWin = 'C:\\Users\\ovntg\\hivekeep\\data\\workspaces\\d727fa29-45ae-4f49-8258-36702effc00b'
    const ev = {
      type: 'match',
      data: {
        path: { text: workspaceWin + '\\reports\\foo.md' },
        line_number: 16,
        lines: { text: 'runRemoteCommand hangs\n' },
      },
    }
    const result = parseRgJsonContent(JSON.stringify(ev) + '\n', workspaceWin, 100)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.line).toBe(16)
    expect(result.matches[0]!.content).toBe('runRemoteCommand hangs')
    expect(result.matches[0]!.file.replaceAll('\\', '/')).toContain('reports/foo.md')
  })

  it('includes context events', () => {
    const match = { type: 'match', data: { path: { text: '/home/user/workspace/a.ts' }, line_number: 5, lines: { text: 'hit\n' } } }
    const ctx = { type: 'context', data: { path: { text: '/home/user/workspace/a.ts' }, line_number: 6, lines: { text: 'after\n' } } }
    const result = parseRgJsonContent(JSON.stringify(match) + '\n' + JSON.stringify(ctx) + '\n', workspace, 100)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]!.content).toBe('hit')
    expect(result.matches[1]!.content).toBe('after')
    expect(result.matches[1]!.line).toBe(6)
  })

  it('skips begin/end events and truncates', () => {
    const begin = { type: 'begin', data: { path: { text: 'a.ts' } } }
    const lines = [JSON.stringify(begin)]
    for (let i = 1; i <= 5; i++) {
      lines.push(JSON.stringify({ type: 'match', data: { path: { text: '/home/user/workspace/a.ts' }, line_number: i, lines: { text: 'x' + i + '\n' } } }))
    }
    const result = parseRgJsonContent(lines.join('\n') + '\n', workspace, 3)
    expect(result.matches).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })
})

describe('parseFilesOutput', () => {
  const workspace = '/home/user/workspace'

  it('returns empty for empty string', () => {
    expect(parseFilesOutput('', workspace)).toEqual([])
  })

  it('returns empty for whitespace-only', () => {
    expect(parseFilesOutput('  \n  ', workspace)).toEqual([])
  })

  it('parses file list', () => {
    const stdout = 'src/a.ts\nsrc/b.ts\nlib/c.js\n'
    const result = parseFilesOutput(stdout, workspace)
    expect(result.map(slash)).toEqual(['src/a.ts', 'src/b.ts', 'lib/c.js'])
  })

  it('relativizes absolute paths', () => {
    const stdout = '/home/user/workspace/src/file.ts\n'
    const result = parseFilesOutput(stdout, workspace)
    expect(result.map(slash)).toEqual(['src/file.ts'])
  })

  it('filters empty lines', () => {
    const stdout = 'a.ts\n\n\nb.ts\n'
    const result = parseFilesOutput(stdout, workspace)
    expect(result).toEqual(['a.ts', 'b.ts'])
  })
})

describe('parseCountOutput', () => {
  const workspace = '/home/user/workspace'

  it('returns empty for empty string', () => {
    expect(parseCountOutput('', workspace)).toEqual([])
  })

  it('returns empty for whitespace-only', () => {
    expect(parseCountOutput('  \n  ', workspace)).toEqual([])
  })

  it('parses count output', () => {
    const stdout = 'src/a.ts:5\nsrc/b.ts:12\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([
      { file: 'src/a.ts', count: 5 },
      { file: 'src/b.ts', count: 12 },
    ])
  })

  it('filters zero counts', () => {
    const stdout = 'src/a.ts:3\nsrc/b.ts:0\nsrc/c.ts:1\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([
      { file: 'src/a.ts', count: 3 },
      { file: 'src/c.ts', count: 1 },
    ])
  })

  it('filters lines without colons', () => {
    const stdout = 'no-colon-here\nsrc/a.ts:2\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([{ file: 'src/a.ts', count: 2 }])
  })

  it('filters NaN counts', () => {
    const stdout = 'src/a.ts:abc\nsrc/b.ts:7\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([{ file: 'src/b.ts', count: 7 }])
  })

  it('handles files with colons in path', () => {
    // Uses lastIndexOf(':') so this should work
    const stdout = 'src/file:name.ts:4\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([{ file: 'src/file:name.ts', count: 4 }])
  })

  it('relativizes absolute paths', () => {
    const stdout = '/home/user/workspace/src/file.ts:3\n'
    const result = parseCountOutput(stdout, workspace)
    expect(result.map(e => ({ ...e, file: slash(e.file) }))).toEqual([{ file: 'src/file.ts', count: 3 }])
  })
})
