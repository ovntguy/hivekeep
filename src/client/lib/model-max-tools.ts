/**
 * Look up the effective per-request tool cap for a model already listed
 * by GET /api/providers/models (`maxTools` is resolved server-side:
 * model override → provider defaultMaxTools → 128).
 */
export function listedModelMaxTools(
  models: ReadonlyArray<{ id: string; providerId: string; maxTools?: number }>,
  modelId?: string,
  providerId?: string | null,
): number | undefined {
  if (!modelId) return undefined
  return models.find((m) => m.id === modelId && (!providerId || m.providerId === providerId))?.maxTools
}
