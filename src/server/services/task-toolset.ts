/**
 * Task (sub-Agent) toolset assembly.
 *
 * `executeSubAgent` and the context-preview path share this so a scout / any
 * other task cannot accidentally overlay the full native sub-agent surface.
 *
 *   mainSurface = resolveToolset (toolbox-gated, optional leaf restrictions)
 *                 minus HARD_EXCLUDED_FROM_SUBKIN
 *                 minus LEAF_EXCLUDED_TOOLS when the task is a scout leaf
 *   protocol    = tools whose availability is EXACTLY `['sub-agent']`
 *                 (report_to_parent / update_task_status / request_input /
 *                 task_todos / cron learnings) — never toolbox-gated
 *   toolset     = { ...mainSurface, ...protocol }
 */
import type { Tool } from '@/server/tools/tool-helper'
import type { ToolExecutionContext } from '@/server/tools/types'
import { toolRegistry } from '@/server/tools/index'
import { getToolbox } from '@/server/services/toolboxes'
import { resolveToolset } from '@/server/services/toolset-resolver'
import { LEAF_EXCLUDED_TOOLS, HARD_EXCLUDED_FROM_SUBKIN } from '@/shared/constants'

export { CORE_WRITE_TOOLS, LEAF_EXCLUDED_TOOLS } from '@/shared/constants'

/** True when `availability` is exactly `['sub-agent']` (protocol tools). */
export function isSubAgentProtocolAvailability(availability: readonly string[]): boolean {
  return availability.length === 1 && availability[0] === 'sub-agent'
}

/**
 * True when the frozen toolbox selection is exactly the built-in `scout`
 * toolbox. That selection is treated as an exclusive read-only leaf even if
 * the caller forgot to pass `leaf: true` at spawn.
 */
export function isExclusiveScoutToolbox(ids: string[]): boolean {
  if (ids.length !== 1) return false
  const box = getToolbox(ids[0]!)
  return !!box && box.builtin && box.name === 'scout'
}

/** Protocol-only native tools (availability exactly `['sub-agent']`). */
export function resolveSubAgentProtocolTools(
  ctx: ToolExecutionContext,
): Record<string, Tool<any, any>> {
  return toolRegistry.resolveExactAvailability({ ...ctx, isSubAgent: true }, ['sub-agent'])
}

export interface AssembleTaskToolsetOptions {
  /** Identity Agent (spawn_self parent, or spawn_agent source). */
  agentId: string
  /** Agent id used when instantiating protocol tools. Defaults to `agentId`.
   *  executeSubAgent passes `tasks.parent_agent_id` so spawn_type=other keeps
   *  report_to_parent scoped to the parent session. */
  protocolAgentId?: string
  /** Already-resolved toolbox ids (from resolveTaskToolboxIds). */
  toolboxIds: string[]
  taskId?: string
  taskDepth?: number
  channelOriginId?: string
  cronId?: string
  /** Force leaf restrictions even when the toolbox is not exclusive scout. */
  leaf?: boolean
}

/**
 * Resolve the toolset a running task actually sees. Toolbox gating applies to
 * the identity Agent's main surface; only exact-`['sub-agent']` protocol tools
 * are layered on afterwards.
 */
export async function assembleTaskToolset(
  opts: AssembleTaskToolsetOptions,
): Promise<Record<string, Tool<any, any>>> {
  const leaf = opts.leaf === true || isExclusiveScoutToolbox(opts.toolboxIds)

  const mainSurface = await resolveToolset({
    agentId: opts.agentId,
    toolboxIds: opts.toolboxIds,
    isSubAgent: false,
    taskId: opts.taskId,
    taskDepth: opts.taskDepth,
    channelOriginId: opts.channelOriginId,
    cronId: opts.cronId,
    leaf,
  })

  for (const name of HARD_EXCLUDED_FROM_SUBKIN) {
    delete mainSurface[name]
  }
  if (leaf) {
    for (const name of LEAF_EXCLUDED_TOOLS) {
      delete mainSurface[name]
    }
  }

  const protocol = resolveSubAgentProtocolTools({
    agentId: opts.protocolAgentId ?? opts.agentId,
    taskId: opts.taskId,
    taskDepth: opts.taskDepth,
    isSubAgent: true,
    channelOriginId: opts.channelOriginId,
    cronId: opts.cronId,
  })

  return { ...mainSurface, ...protocol }
}
