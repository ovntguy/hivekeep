import { describe, expect, it } from 'bun:test'
import { listedModelMaxTools } from './model-max-tools'

const models = [
  { id: 'gpt-4o', providerId: 'p-openai', maxTools: 128 },
  { id: 'claude-sonnet', providerId: 'p-anthropic', maxTools: 512 },
  { id: 'gpt-4o', providerId: 'p-azure', maxTools: 128 },
  { id: 'completion-only', providerId: 'p-openai', maxTools: 0 },
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
})
