/**
 * One-time migration: backfill missing providerId on agents, tasks, and crons.
 *
 * Uses the model-ID heuristic (guessProviderType) to find a matching provider,
 * then writes the provider's DB id. Runs once, guarded by an app-settings key.
 */
import { eq, and, isNull, isNotNull, notInArray } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents, tasks, crons, providers } from '@/server/db/schema'
import { getSetting, setSetting } from '@/server/services/app-settings'
import { guessProviderType } from '@/shared/model-ref'
import { createLogger } from '@/server/logger'

const log = createLogger('migrate-model-providers')

const GUARD_KEY = 'migration_model_provider_done'

/** Terminal task statuses — no need to backfill these */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled']

export async function migrateModelProviders(): Promise<void> {
  const done = await getSetting(GUARD_KEY)
  if (done === '1') return

  log.info('Starting one-time model→provider backfill migration')

  // Build a type→providerId lookup from the providers table
  const allProviders = db.select({ id: providers.id, type: providers.type }).from(providers).all()
  const typeToProviderId = new Map<string, string>()
  for (const p of allProviders) {
    // anthropic-oauth should match the 'anthropic' heuristic
    const normalizedType =
      p.type === 'anthropic-oauth' ? 'anthropic' : p.type === 'xai-oauth' ? 'xai' : p.type
    // First provider of each type wins (most installations have one per type)
    if (!typeToProviderId.has(normalizedType)) {
      typeToProviderId.set(normalizedType, p.id)
    }
  }

  let totalFixed = 0

  // 1. Agents with model but no providerId
  const orphanedAgents = db
    .select({ id: agents.id, model: agents.model, compactingConfig: agents.compactingConfig })
    .from(agents)
    .where(and(isNotNull(agents.model), isNull(agents.providerId)))
    .all()

  for (const agent of orphanedAgents) {
    if (!agent.model) continue
    const provType = guessProviderType(agent.model)
    const pid = provType ? typeToProviderId.get(provType) : undefined
    if (pid) {
      db.update(agents).set({ providerId: pid }).where(eq(agents.id, agent.id)).run()
      totalFixed++
    }
  }

  // 1b. Agents with compactingConfig.compactingModel but no compactingProviderId
  const allAgentsWithCompacting = db
    .select({ id: agents.id, compactingConfig: agents.compactingConfig })
    .from(agents)
    .where(isNotNull(agents.compactingConfig))
    .all()

  for (const agent of allAgentsWithCompacting) {
    if (!agent.compactingConfig) continue
    try {
      const cfg = JSON.parse(agent.compactingConfig) as Record<string, unknown>
      if (cfg.compactingModel && !cfg.compactingProviderId) {
        const provType = guessProviderType(cfg.compactingModel as string)
        const pid = provType ? typeToProviderId.get(provType) : undefined
        if (pid) {
          cfg.compactingProviderId = pid
          db.update(agents)
            .set({ compactingConfig: JSON.stringify(cfg) })
            .where(eq(agents.id, agent.id))
            .run()
          totalFixed++
        }
      }
    } catch { /* ignore malformed JSON */ }
  }

  // 2. Non-terminal tasks with model but no providerId
  const orphanedTasks = db
    .select({ id: tasks.id, model: tasks.model })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.model),
        isNull(tasks.providerId),
        notInArray(tasks.status, TERMINAL_STATUSES),
      ),
    )
    .all()

  for (const task of orphanedTasks) {
    if (!task.model) continue
    const provType = guessProviderType(task.model)
    const pid = provType ? typeToProviderId.get(provType) : undefined
    if (pid) {
      db.update(tasks).set({ providerId: pid }).where(eq(tasks.id, task.id)).run()
      totalFixed++
    }
  }

  // 3. Crons with model but no providerId
  const orphanedCrons = db
    .select({ id: crons.id, model: crons.model })
    .from(crons)
    .where(and(isNotNull(crons.model), isNull(crons.providerId)))
    .all()

  for (const cron of orphanedCrons) {
    if (!cron.model) continue
    const provType = guessProviderType(cron.model)
    const pid = provType ? typeToProviderId.get(provType) : undefined
    if (pid) {
      db.update(crons).set({ providerId: pid }).where(eq(crons.id, cron.id)).run()
      totalFixed++
    }
  }

  await setSetting(GUARD_KEY, '1')
  log.info({ totalFixed }, 'Model→provider backfill migration complete')
}
