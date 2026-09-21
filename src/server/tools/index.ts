import type { Tool } from '@/server/tools/tool-helper'
import type { ToolRegistration, ToolExecutionContext, ToolAvailability } from '@/server/tools/types'
import type { ToolDomain } from '@/shared/types'
import { hookRegistry } from '@/server/hooks/index'
import { createLogger } from '@/server/logger'

const log = createLogger('tools')

interface RegistryEntry {
  registration: ToolRegistration
  domain: ToolDomain
}

function availabilityEquals(actual: ToolAvailability[], expected: ToolAvailability[]): boolean {
  if (actual.length !== expected.length) return false
  return expected.every((value, i) => actual[i] === value)
}

class ToolRegistry {
  private tools = new Map<string, RegistryEntry>()

  /** Register a tool. The `domain` argument is the single source of truth
   *  for which UI category the tool belongs to — used by the Agent tools
   *  settings tab and the live tool-call renderer. TypeScript enforces it
   *  here so no tool can be registered without a category. */
  register(name: string, registration: ToolRegistration, domain: ToolDomain): void {
    this.tools.set(name, { registration, domain })
    log.debug({ toolName: name, domain }, 'Tool registered')
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name)
    if (deleted) log.debug({ toolName: name }, 'Tool unregistered')
    return deleted
  }

  /** Look up the domain for a given tool name. Returns `null` when the
   *  tool is not registered (e.g. an MCP / plugin tool — those are handled
   *  separately by the caller). */
  getDomain(name: string): ToolDomain | null {
    return this.tools.get(name)?.domain ?? null
  }

  /**
   * Resolve all tools available for a given execution context.
   * Wraps each tool's execute function with beforeToolCall/afterToolCall hooks.
   */
  resolve(ctx: ToolExecutionContext): Record<string, Tool<any, any>> {
    const target: ToolAvailability = ctx.isSubAgent ? 'sub-agent' : 'main'
    const resolved: Record<string, Tool<any, any>> = {}

    for (const [name, entry] of this.tools) {
      const reg = entry.registration
      if (!reg.availability.includes(target)) continue
      if (reg.condition && !reg.condition(ctx)) continue
      const baseTool = reg.create(ctx)
      resolved[name] = this.wrapWithHooks(name, baseTool, ctx)
    }

    log.debug({ agentId: ctx.agentId, resolvedCount: Object.keys(resolved).length }, 'Tools resolved for Agent')

    return resolved
  }

  /**
   * Resolve tools whose `availability` array is exactly `availability` (same
   * length and items). Used to layer sub-Agent protocol tools
   * (`['sub-agent']` only) without granting every native tool that merely
   * *includes* `'sub-agent'` (spawn/scout/writes/http/browser).
   */
  resolveExactAvailability(
    ctx: ToolExecutionContext,
    availability: ToolAvailability[],
  ): Record<string, Tool<any, any>> {
    const resolved: Record<string, Tool<any, any>> = {}

    for (const [name, entry] of this.tools) {
      const reg = entry.registration
      if (!availabilityEquals(reg.availability, availability)) continue
      if (reg.condition && !reg.condition(ctx)) continue
      const baseTool = reg.create(ctx)
      resolved[name] = this.wrapWithHooks(name, baseTool, ctx)
    }

    return resolved
  }

  /** Wrap a tool's execute with beforeToolCall / afterToolCall hooks */
  private wrapWithHooks(
    name: string,
    baseTool: Tool<any, any>,
    ctx: ToolExecutionContext,
  ): Tool<any, any> {
    if (!('execute' in baseTool) || typeof baseTool.execute !== 'function') {
      return baseTool
    }

    const originalExecute = baseTool.execute

    return {
      ...baseTool,
      execute: async (args: unknown, options: unknown) => {
        // beforeToolCall hook — allows inspection / modification
        await hookRegistry.execute('beforeToolCall', {
          ...ctx,
          toolName: name,
          toolArgs: args,
        })

        const result = await (originalExecute as Function)(args, options)

        // afterToolCall hook — allows logging / side-effects
        await hookRegistry.execute('afterToolCall', {
          ...ctx,
          toolName: name,
          toolArgs: args,
          toolResult: result,
        })

        return result
      },
    }
  }

  /** Check if a tool is read-only (purely reads, no mutations). */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.registration.readOnly === true
  }

  /** Check if a tool is safe to run concurrently with other tools.
   *  Tools that do not declare this flag are treated as unsafe by default
   *  and will run in their own isolated serial batch. */
  isConcurrencySafe(name: string): boolean {
    return this.tools.get(name)?.registration.concurrencySafe === true
  }

  /** Check if a tool performs irreversible operations. */
  isDestructive(name: string): boolean {
    return this.tools.get(name)?.registration.destructive === true
  }

  /** Check if `{{secret:KEY}}` placeholders in this tool's args should be
   *  expanded to real vault values before execution. Default false: the
   *  placeholder passes through as inert text (correct for tools whose
   *  output re-enters LLM context, e.g. memorize). Custom/MCP tools are
   *  handled by the executor — they always expand. */
  expandsSecrets(name: string): boolean {
    return this.tools.get(name)?.registration.expandsSecrets === true
  }

  /** Check if this tool receives expanded secrets through `options.secretEnv`
   *  (placeholders rewritten to `${HIVEKEEP_SECRET_KEY}` env references)
   *  instead of literal substitution into its args. */
  secretsViaEnv(name: string): boolean {
    return this.tools.get(name)?.registration.secretsViaEnv === true
  }

  /**
   * Best-effort extraction of a tool's LLM-facing description.
   *
   * The description lives on the `Tool` object returned by the registration's
   * `create()` factory (the SDK's `ToolRegistration` carries no static
   * description — see packages/sdk). Native factories build the tool with a
   * literal description and only touch the execution context inside `execute`,
   * so instantiating with a throwaway stub context is cheap and side-effect
   * free. Wrapped in try/catch so a factory that does read ctx at build time
   * degrades to `undefined` rather than throwing — this is metadata only.
   */
  describe(name: string): string | undefined {
    const entry = this.tools.get(name)
    if (!entry) return undefined
    try {
      const stub: ToolExecutionContext = { agentId: '', isSubAgent: false }
      const built = entry.registration.create(stub) as { description?: string }
      return typeof built.description === 'string' ? built.description : undefined
    } catch {
      return undefined
    }
  }

  /** List all registered tool names with their availability + domain (for API/UI). */
  list(): Array<{
    name: string
    domain: ToolDomain
    availability: ToolAvailability[]
    defaultDisabled: boolean
    readOnly: boolean
    concurrencySafe: boolean
    destructive: boolean
    label?: string | Record<string, string>
  }> {
    return Array.from(this.tools.entries()).map(([name, entry]) => ({
      name,
      domain: entry.domain,
      availability: entry.registration.availability,
      defaultDisabled: entry.registration.defaultDisabled ?? false,
      readOnly: entry.registration.readOnly ?? false,
      concurrencySafe: entry.registration.concurrencySafe ?? false,
      destructive: entry.registration.destructive ?? false,
      ...(entry.registration.label !== undefined ? { label: entry.registration.label } : {}),
    }))
  }

  get registeredCount(): number {
    return this.tools.size
  }
}

export const toolRegistry = new ToolRegistry()
