/**
 * models.dev lookup + matching for the model registry.
 *
 * Loads the bundled snapshot (`models-dev-snapshot.json`, produced by
 * `scripts/fetch-models-dev.ts`) and resolves a Hivekeep `(providerType, modelId)`
 * to a models.dev entry, then maps that entry onto our `LLMModel` metadata fields.
 *
 * This module is pure data — no DB, no network. The DB registry (admin overrides)
 * and the runtime resync layer build on top of it (see `model-metadata.md`).
 */

import { readFileSync } from 'node:fs'

import type { ThinkingEffort } from '@/server/llm/llm/types'
import { THINKING_EFFORT_ORDER } from '@/server/llm/llm/types'

/** Trimmed per-model shape stored in the snapshot (see fetch-models-dev.ts). */
export interface ModelsDevModel {
  name?: string
  family?: string
  context?: number
  output?: number
  input?: string[]
  reasoning?: boolean
  reasoning_efforts?: string[]
  tool_call?: boolean
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

type Snapshot = Record<string, Record<string, ModelsDevModel>>

let snapshotCache: Snapshot | null = null
function snapshot(): Snapshot {
  if (!snapshotCache) {
    const url = new URL('./models-dev-snapshot.json', import.meta.url)
    snapshotCache = JSON.parse(readFileSync(url, 'utf8')) as Snapshot
  }
  return snapshotCache
}

export function __setSnapshotForTests(s: Snapshot | null): void {
  snapshotCache = s
}

export function setSnapshot(s: Snapshot): void {
  snapshotCache = s
}

const PROVIDER_ID_MAP: Record<string, string> = {
  moonshot: 'moonshotai',
  gemini: 'google',
  ollama: 'ollama-cloud',
  'anthropic-oauth': 'anthropic',
  'openai-codex': 'openai',
  'xai-oauth': 'xai',
}
export function toModelsDevProviderId(providerType: string): string {
  return PROVIDER_ID_MAP[providerType] ?? providerType
}
