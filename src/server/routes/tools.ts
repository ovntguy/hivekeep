import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { toolRegistry } from '@/server/tools/index'
import { HARD_EXCLUDED_FROM_SUBKIN } from '@/shared/constants'
import { listAllMCPCatalogTools } from '@/server/services/mcp'
import { listCustomTools, resolveCustomToolDisplay } from '@/server/services/custom-tools'
import { customToolHasRenderer, customToolRendererVersion } from '@/server/services/custom-tool-renderer'
import { resolveDomainMeta } from '@/server/services/tool-domains'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'
import type { ToolCatalogEntry, ToolDomain } from '@/shared/types'

const log = createLogger('tools-routes')

/**
 * Tool-level metadata routes. Currently exposes the registry's
 * `name → domain` map so the UI can render tool-call badges and tool
 * settings without duplicating the map on the client. The domain is
 * declared once, at registration time in `src/server/tools/register.ts`.
 */
export const toolsRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/tools/domains — full registry snapshot of name → domain.
// Plugin tools (registered dynamically) are included so the rendering
// layer can colour their badges correctly too. Cheap call; safe to fetch
// once at app boot and cache for the session.
toolsRoutes.get('/domains', (c) => {
  const map: Record<string, ToolDomain> = {}
  for (const t of toolRegistry.list()) map[t.name] = t.domain
  // Custom tools are not in the registry (resolved separately, MCP-style); add
  // their name→domain so the client colours their tool-call badges correctly.
  try {
    for (const ct of listCustomTools()) map[`custom_${ct.slug}`] = ct.domainSlug
  } catch {
    // best-effort: a custom-tools read failure must not break badge colouring.
  }
  return c.json(map)
})

// GET /api/tools/domain-meta — render-ready visual metadata for every tool
// domain (built-in + custom): icon name, Tailwind triple, and label/labelKey.
// The client hydrates this once and resolves any domain (incl. user-created)
// without hardcoding TOOL_DOMAIN_META for custom slugs.
toolsRoutes.get('/domain-meta', (c) => {
  return c.json({ domains: resolveDomainMeta() })
})

/** Resolve the current user's UI language (user_profiles.language). Best-effort:
 *  returns null when the user/profile can't be read, so callers fall back to the
 *  base (untranslated) display. */
function currentUserLocale(c: { get: (k: 'user') => { id: string } | undefined }): string | null {
  try {
    const u = c.get('user')
    if (!u) return null
    const profile = db
      .select({ language: userProfiles.language })
      .from(userProfiles)
      .where(eq(userProfiles.userId, u.id))
      .get()
    return profile?.language ?? null
  } catch {
    return null
  }
}

// GET /api/tools/custom-tool-names — `custom_<slug>` → { name, hasRenderer } for
// the CURRENT user's UI language. The client hydrates this once at boot and uses
// it to (a) show a human name for custom tool-calls instead of the raw
// custom_<slug>, and (b) decide whether to attempt loading a result renderer (so
// it only fetches /renderer.js for tools that actually ship one).
// `name` is UI-ONLY — translations never alter the tool definition seen by the LLM.
// `hasRenderer` is a cheap on-disk file-presence check (renderer.tsx/.jsx/.js).
// `rendererVersion` is the renderer file's mtimeMs (null when none): the client
// folds it into the versioned, immutable `/renderer.js?v=<version>` URL so the
// module is cached forever cross-session AND an edit (new mtime) busts the cache.
toolsRoutes.get('/custom-tool-names', (c) => {
  try {
    const locale = currentUserLocale(c)
    const map: Record<string, { name: string; hasRenderer: boolean; rendererVersion: number | null }> = {}
    for (const ct of listCustomTools()) {
      const rendererVersion = customToolRendererVersion(ct.slug)
      map[`custom_${ct.slug}`] = {
        name: resolveCustomToolDisplay(ct, locale).name,
        hasRenderer: rendererVersion !== null,
        rendererVersion,
      }
    }
    return c.json(map)
  } catch (err) {
    // Best-effort: a read failure must not break the chat UI (it falls back to
    // the i18n key / raw slug name).
    log.warn({ err }, 'tools/custom-tool-names: failed to resolve names')
    return c.json({})
  }
})

// GET /api/tools/catalog — Agent-agnostic catalog of every grantable tool across
// all four sources (native / plugin / MCP / custom), used to populate the
// toolbox editor. Unlike GET /api/agents/:id/tools this carries no per-Agent
// enabled state — it is a pure metadata listing of what a toolbox can reference
// by name. Nothing is filtered out (it is a catalog); each entry instead
// carries `hardExcludedFromSubAgent` so the UI can warn that the tool can never
// run inside a task even if a toolbox lists it (see HARD_EXCLUDED_FROM_SUBKIN
// in services/tasks.ts). `label` is the author-supplied (possibly locale-keyed)
// display label; `description` is the LLM-facing description, best-effort
// extracted from the tool factory (may be absent for some tools).
//
// Sources:
//   - native : registry tools whose name has no `plugin_` prefix.
//   - plugin : registry tools registered under the `plugin_<plugin>_*` prefix.
//   - mcp    : every tool from ALL global active MCP servers (no per-Agent gate),
//              named `mcp_<sanitizeName(server)>_<sanitizeName(tool)>`.
//   - custom : GLOBAL scripts (no per-Agent gate), named `custom_<slug>`, each
//              carrying its own (possibly custom) domain + an `enabled` flag.
const HARD_EXCLUDED_SET = new Set<string>(HARD_EXCLUDED_FROM_SUBKIN)

/** A registry tool registered by a plugin is prefixed `plugin_<plugin>_` at
 *  activation (see services/plugins.ts). Native tools never carry that prefix,
 *  so the prefix alone distinguishes the two sources reliably. */
function isPluginToolName(name: string): boolean {
  return name.startsWith('plugin_')
}

toolsRoutes.get('/catalog', async (c) => {
  // ── native + plugin (both from the registry) ────────────────────────────────
  const registryEntries: ToolCatalogEntry[] = toolRegistry.list().map((t) => ({
    name: t.name,
    source: isPluginToolName(t.name) ? 'plugin' : 'native',
    domain: t.domain,
    label: t.label ?? null,
    description: toolRegistry.describe(t.name) ?? null,
    defaultDisabled: t.defaultDisabled,
    readOnly: t.readOnly,
    destructive: t.destructive,
    hardExcludedFromSubAgent: HARD_EXCLUDED_SET.has(t.name),
  }))

  // ── MCP (all global active servers, no per-Agent gate) ─────────────────────────
  let mcpEntries: ToolCatalogEntry[] = []
  try {
    const mcp = await listAllMCPCatalogTools()
    mcpEntries = mcp.map((m) => ({
      name: m.name,
      source: 'mcp' as const,
      domain: 'mcp' as ToolDomain,
      label: null,
      description: m.description ?? null,
      // MCP tools are always grantable inside tasks (not in the native hard-floor).
      defaultDisabled: false,
      readOnly: false,
      destructive: false,
      hardExcludedFromSubAgent: false,
      mcpServerName: m.serverName,
    }))
  } catch (err) {
    // The catalog is best-effort: a flaky MCP server must not take down the
    // toolbox editor. Log and continue with whatever else resolved.
    log.warn({ err }, 'tools/catalog: failed to enumerate MCP tools')
  }

  // ── custom (GLOBAL — no per-Agent gate) ────────────────────────────────────────
  // `label`/`description` are localized for the current user's UI language so the
  // toolbox editor shows a human name instead of the raw custom_<slug>. This is
  // UI metadata only — the LLM still receives the base description + raw schema.
  let customEntries: ToolCatalogEntry[] = []
  try {
    const locale = currentUserLocale(c)
    customEntries = listCustomTools().map((ct) => {
      const display = resolveCustomToolDisplay(ct, locale)
      return {
        name: `custom_${ct.slug}`,
        source: 'custom' as const,
        domain: ct.domainSlug as ToolDomain,
        label: display.name,
        description: display.description || ct.description || null,
        defaultDisabled: false,
        readOnly: false,
        destructive: false,
        hardExcludedFromSubAgent: false,
        enabled: ct.enabled,
      }
    })
  } catch (err) {
    log.warn({ err }, 'tools/catalog: failed to enumerate custom tools')
  }

  const tools: ToolCatalogEntry[] = [...registryEntries, ...mcpEntries, ...customEntries]
  return c.json({ tools })
})
