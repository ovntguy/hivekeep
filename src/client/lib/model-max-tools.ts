/**
 * Look up the effective per-request tool cap for a model already listed
 * by GET /api/providers/models (`maxTools` is resolved server-side:
 * model override → provider defaultMaxTools → 128).
 *
 * A listed model with no `maxTools` field (older server, plugin catalogue)
 * still gets 128 so the composer badge never drops back to a bare count.
 * `0` is a real cap (no tool calling) and is not replaced.
 */
export const FALLBACK_MAX_LLM_TOOLS = 128

type ListedModel = {
  id: string
  providerId: string
  name?: string
  maxTools?: number
}

function findListedModel(
  models: ReadonlyArray<ListedModel>,
  modelId: string,
  providerId?: string | null,
): ListedModel | undefined {
  if (providerId) {
    const exact = models.find((m) => m.id === modelId && m.providerId === providerId)
    if (exact) return exact
    const byName = models.find((m) => m.name === modelId && m.providerId === providerId)
    if (byName) return byName
  }
  return models.find((m) => m.id === modelId) ?? models.find((m) => m.name === modelId)
}

export function listedModelMaxTools(
  models: ReadonlyArray<ListedModel>,
  modelId?: string,
  providerId?: string | null,
): number | undefined {
  if (!modelId) return undefined
  const match = findListedModel(models, modelId, providerId)
  if (!match) return undefined
  return match.maxTools ?? FALLBACK_MAX_LLM_TOOLS
}
