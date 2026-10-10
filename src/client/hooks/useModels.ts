import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { AgentThinkingEffort } from '@/shared/types'

/** Model as returned by GET /api/providers/models */
export interface ProviderModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
  /** LLM-family only — chat accepts image attachments. (Tri-state: true /
   *  false = explicitly not / undefined = unknown.) */
  supportsImageInput?: boolean
  /** LLM-family only — chat accepts PDF attachments. Same tri-state. */
  supportsPdfInput?: boolean
  /** Image-family only — how many source images the model accepts
   *  (0 = text-to-image, 1 = single-image edit, N>1 = multi-reference). */
  maxImageInputs?: number
  /** Maximum input/context tokens. Populated when the provider's API exposes it. */
  contextWindow?: number
  /** Maximum output tokens. Populated when the provider's API exposes it. */
  maxOutput?: number
  /** LLM-family only — reasoning support after registry enrichment.
   *  Absent = not a reasoning model (or unknown); `efforts: []` = reasoning
   *  toggle-only (no granularity). Drives the effort selectors. */
  thinking?: { efforts: AgentThinkingEffort[]; note?: string }
  /** LLM-family only — effective tools-per-request cap (model override,
   *  else provider default, else 128). `0` means the model cannot call tools. */
  maxTools?: number
}

/**
 * Shared hook to fetch all available provider models.
 * Replaces inline fetches in GeneralSettings, StepProviders, and useAgents.
 */
export function useModels() {
  const [models, setModels] = useState<ProviderModel[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchModels = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await api.get<{ models: ProviderModel[] }>('/providers/models')
      setModels(data.models)
    } catch (err) {
      console.error('Failed to fetch models:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Refresh model list when providers change
  useSSE({
    'provider:created': () => fetchModels(),
    'provider:updated': () => fetchModels(),
    'provider:deleted': () => fetchModels(),
  })

  const llmModels = useMemo(() => models.filter((m) => m.capability === 'llm'), [models])
  const imageModels = useMemo(() => models.filter((m) => m.capability === 'image'), [models])
  const embeddingModels = useMemo(() => models.filter((m) => m.capability === 'embedding'), [models])

  return {
    models,
    llmModels,
    imageModels,
    embeddingModels,
    isLoading,
    refetch: fetchModels,
  }
}
