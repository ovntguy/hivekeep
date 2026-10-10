import { describe, expect, it } from 'bun:test'
import { listedModelMaxTools } from './model-max-tools'

const models = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'p-openai', maxTools: 128 },
  { id: 'claude-sonnet', name: 'Claude Sonnet', providerId: 'p-anthropic', maxTools: 512 },
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'p-azure', maxTools: 128 },
  { id: 'completion-only', name: 'Completion', providerId: 'p-openai', maxTools: 0 },
  { id: 'openrouter/auto', name: 'AutoRouter', providerId: 'p-or' },
]

describe('listedModelMaxTools', () => {
  it('returns the listed cap for the selected model', () => {
    expect(listedModelMaxTools(models, 'claude-sonnet', 'p-anthropic')).toBe(512)
  })

  it('disambiguates the same model id across providers', () => {
    expect(listedModelMaxTools(models, 'gpt-4o', 'p-azure')).toBe(128)
  })

  it('treats maxTools 0 as a real cap (no tool calling)', () => {
    expect(listedModelMaxTools(models, 'completion-only', 'p-openai')).toBe(0)
  })

  it('returns undefined when the model is missing or unset', () => {
    expect(listedModelMaxTools(models, 'nope', 'p-openai')).toBeUndefined()
    expect(listedModelMaxTools(models, undefined, 'p-openai')).toBeUndefined()
  })

  it('defaults a listed model with no maxTools to 128', () => {
    expect(listedModelMaxTools(models, 'openrouter/auto', 'p-or')).toBe(128)
  })

  it('still finds the cap when providerId is stale', () => {
    expect(listedModelMaxTools(models, 'claude-sonnet', 'p-wrong')).toBe(512)
  })

  it('matches the picker display name when that is what the agent stored', () => {
    expect(listedModelMaxTools(models, 'AutoRouter', 'p-or')).toBe(128)
  })
})
