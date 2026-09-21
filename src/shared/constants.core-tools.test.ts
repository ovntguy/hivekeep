import { describe, it, expect } from 'bun:test'
import { CORE_TOOLS, LEAF_EXCLUDED_TOOLS, CORE_WRITE_TOOLS, HARD_EXCLUDED_FROM_SUBKIN } from '@/shared/constants'

describe('CORE_TOOLS', () => {
  it('includes the protocol minimum that the sub-Agent runner assumes', () => {
    for (const required of [
      'read_file',
      'edit_file',
      'multi_edit',
      'run_shell',
      'grep',
      'list_directory',
      'update_task_status',
      'request_input',
      'prompt_human',
      'prompt_secret',
    ]) {
      expect(CORE_TOOLS).toContain(required)
    }
  })

  it('contains no duplicate entries', () => {
    expect(new Set(CORE_TOOLS).size).toBe(CORE_TOOLS.length)
  })
})

describe('LEAF_EXCLUDED_TOOLS', () => {
  it('strips workspace writes, shell, spawn, scout, and request_tool_access', () => {
    for (const name of [
      'write_file',
      'edit_file',
      'multi_edit',
      'run_shell',
      'spawn_self',
      'spawn_agent',
      'scout',
      'request_tool_access',
    ]) {
      expect(LEAF_EXCLUDED_TOOLS).toContain(name)
    }
    expect(CORE_WRITE_TOOLS).toEqual(['write_file', 'edit_file', 'multi_edit', 'run_shell'])
  })

  it('does not globally ban spawn_self from ordinary sub-Agents', () => {
    expect(CORE_TOOLS).not.toContain('spawn_self')
    expect(CORE_TOOLS).not.toContain('scout')
    expect(HARD_EXCLUDED_FROM_SUBKIN).not.toContain('spawn_self')
    expect(HARD_EXCLUDED_FROM_SUBKIN).not.toContain('spawn_agent')
    expect(HARD_EXCLUDED_FROM_SUBKIN).not.toContain('scout')
  })
})
