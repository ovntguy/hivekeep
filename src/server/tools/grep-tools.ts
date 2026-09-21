import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { resolve, relative } from 'path'
import { existsSync, statSync } from 'fs'
import { createLogger } from '@/server/logger'
import { resolveAndValidate } from '@/server/tools/filesystem-tools'
import { noteCall, grepSignature } from '@/server/services/tool-call-tracker'
import type { ToolRegistration } from '@/server/tools/types'
import { resolveToolWorkspace } from '@/server/tools/workspace'

const log = createLogger('grep-tools')

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_RESULTS = 100

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

/**
 * Build ripgrep arguments from tool parameters.
 */
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
    // Content mode: --json so paths with hyphens/UUIDs/drive letters are never
    // split on ":line:" / "-line-". Line numbers come from the JSON events.
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

/**
 * Build grep fallback arguments.
 */
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

/**
 * Parse ripgrep --json NDJSON for content mode (match + context events).
 * Paths come from data.path.text — never split on hyphens or drive colons.
 */
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

/**
 * Parse GNU grep (fallback) content output: "file:line:content".
 * Colon-only — never treat "-digits-" as a delimiter (Windows UUID folders
 * like d727fa29-45ae-4f49-8258-36702effc00b would otherwise split at 8258).
 * Skip a leading drive letter so the next colon is the grep separator.
 */
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

/**
 * Parse rg/grep output for files_with_matches mode.
 */
function parseFilesOutput(stdout: string, workspace: string): string[] {
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((f) => relative(workspace, resolve(workspace, f)) || f)
}

/**
 * Parse rg/grep output for count mode.
 * Format: "file:count"
 */
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

/**
 * Execute a command with timeout, returning stdout, stderr, and exit code.
 */
async function execCommand(
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill()
      reject(new Error('Search timeout'))
    }, timeout),
  )

  const exitCode = await Promise.race([proc.exited, timeoutPromise])
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  return { stdout, stderr, exitCode }
}

// ── grep ──────────────────────────────────────────────────

export const grepTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Regex search in file contents (glob filtering, context lines, modes: content/files_with_matches/count). **Use this instead of run_shell with grep/rg/find.** Respects .gitignore, skips node_modules/.git/binaries. **Prefer one broad search to many narrow ones**: use regex alternation `(foo|bar|baz)` or character classes instead of 3 sequential greps. **Parallel-safe**: multiple grep calls in one assistant turn run concurrently.',
      inputSchema: z.object({
        pattern: z.string().describe('Regex pattern to search for'),
        path: z
          .string()
          .optional()
          .describe('File or directory to search in (relative to workspace or absolute). Defaults to workspace root.'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe('Output format. "content" (default): matching lines. "files_with_matches": file paths only. "count": match counts per file.'),
        glob: z
          .string()
          .optional()
          .describe('Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}")'),
        context_before: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Lines to show before each match'),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Lines to show after each match'),
        context: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Lines before AND after each match (overrides context_before/after)'),
        case_insensitive: z.boolean().optional().describe('Case insensitive search. Default: false'),
        line_numbers: z.boolean().optional().describe('Show line numbers in content mode. Default: true'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`Max results to return. Default: ${DEFAULT_MAX_RESULTS}`),
        multiline: z.boolean().optional().describe('Enable multiline matching. Default: false'),
      }),
      execute: async ({
        pattern,
        path: searchPath,
        output_mode,
        glob,
        context_before,
        context_after,
        context,
        case_insensitive,
        line_numbers,
        max_results,
        multiline,
      }) => {
        const workspace = resolveToolWorkspace(ctx)
        const outputMode: OutputMode = output_mode ?? 'content'
        const maxResults = max_results ?? DEFAULT_MAX_RESULTS

        try {
          // Resolve search path
          const absSearchPath = searchPath
            ? resolveAndValidate(searchPath, workspace)
            : workspace

          // Verify path exists
          if (!existsSync(absSearchPath)) {
            return { success: false, error: `Path not found: ${searchPath ?? '.'}` }
          }

          const commonParams = {
            pattern,
            searchPath: absSearchPath,
            outputMode,
            glob,
            contextBefore: context_before,
            contextAfter: context_after,
            context,
            caseInsensitive: case_insensitive,
            lineNumbers: line_numbers,
            maxResults,
            multiline,
          }

          let result: { stdout: string; stderr: string; exitCode: number }
          let usedRg = true

          // Try rg first, fall back to grep
          try {
            const rgArgs = buildRgArgs(commonParams)
            result = await execCommand(rgArgs, workspace, DEFAULT_TIMEOUT)
          } catch (err: any) {
            // rg not found or timeout — try grep fallback
            if (err.message === 'Search timeout') throw err
            usedRg = false
            const grepArgs = buildGrepArgs(commonParams)
            result = await execCommand(grepArgs, workspace, DEFAULT_TIMEOUT)
          }

          const { stdout, stderr, exitCode } = result

          const dup = noteCall(
            ctx.taskId,
            'grep',
            grepSignature({
              pattern,
              path: searchPath,
              glob,
              output_mode: outputMode,
              context,
              context_before,
              context_after,
              multiline,
            }),
          )
          const dupFields = dup.previousCallCount > 0
            ? {
                duplicate: true as const,
                previousCallCount: dup.previousCallCount,
                hint: `You already ran grep with this exact (pattern, path, glob, output_mode, context) ${dup.previousCallCount} time(s) earlier in this task — the results are upstream. If you need a different angle, broaden the pattern or change the output_mode rather than repeating the same query.`,
              }
            : {}

          // Exit code 1 = no matches (normal for grep/rg)
          if (exitCode === 1) {
            if (outputMode === 'content') {
              return { success: true, matches: [], matchCount: 0, truncated: false, ...dupFields }
            }
            if (outputMode === 'files_with_matches') {
              return { success: true, files: [], fileCount: 0, ...dupFields }
            }
            return { success: true, counts: [], totalCount: 0, ...dupFields }
          }

          // Exit code >= 2 = error
          if (exitCode >= 2) {
            return { success: false, error: stderr.trim() || `Search failed (exit code ${exitCode})` }
          }

          // Parse output based on mode
          if (outputMode === 'content') {
            const { matches, truncated } = usedRg
              ? parseRgJsonContent(stdout, workspace, maxResults)
              : parseContentOutput(stdout, workspace, maxResults)
            log.info(
              { agentId: ctx.agentId, pattern, matchCount: matches.length },
              'Grep search completed',
            )
            return { success: true, matches, matchCount: matches.length, truncated, ...dupFields }
          }

          if (outputMode === 'files_with_matches') {
            const files = parseFilesOutput(stdout, workspace)
            log.info(
              { agentId: ctx.agentId, pattern, fileCount: files.length },
              'Grep search completed',
            )
            return { success: true, files, fileCount: files.length, ...dupFields }
          }

          // count mode
          const counts = parseCountOutput(stdout, workspace)
          const totalCount = counts.reduce((sum, e) => sum + e.count, 0)
          log.info(
            { agentId: ctx.agentId, pattern, totalCount },
            'Grep search completed',
          )
          return { success: true, counts, totalCount, ...dupFields }
        } catch (err: any) {
          log.error({ agentId: ctx.agentId, pattern, err }, 'Grep search failed')
          return { success: false, error: err.message }
        }
      },
    }),
}
