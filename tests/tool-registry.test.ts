import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ToolRegistry,
  createBuiltinRegistry,
  createBuiltinTools,
} from '../src/tools/registry.js'
import { ToolError, type ToolDefinition } from '../src/tools/types.js'

function stubTool(name: string): ToolDefinition {
  return {
    name,
    spec: {
      type: 'function',
      function: {
        name,
        description: 'stub',
        parameters: { type: 'object', properties: {} },
      },
    },
    displayKind: 'generic',
    describe: () => name,
    execute: async () => ({ observation: `${name}:ok` }),
  }
}

const context = {
  cwd: mkdtempSync(join(tmpdir(), 'ask-registry-')),
  timeoutMs: 5_000,
  maxOutputBytes: 10_000,
}

describe('ToolRegistry', () => {
  it('registers tools and exposes their specs', () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('one'))
    registry.register(stubTool('two'))

    expect(registry.names()).toEqual(['one', 'two'])
    expect(registry.specs().map((spec) => spec.function.name)).toEqual([
      'one',
      'two',
    ])
    expect(registry.has('one')).toBe(true)
  })

  it('rejects duplicate registrations', () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('dup'))
    expect(() => registry.register(stubTool('dup'))).toThrow(ToolError)
    expect(() => registry.register(stubTool('dup'))).toThrow(/已注册/)
  })

  it('executes a tool by name', async () => {
    const registry = new ToolRegistry()
    registry.register(stubTool('echo'))

    await expect(
      registry.execute('echo', { text: 'hi' }, context),
    ).resolves.toEqual({ observation: 'echo:ok' })
  })

  it('reports unknown tools', async () => {
    const registry = new ToolRegistry()

    await expect(registry.execute('missing', {}, context)).rejects.toThrow(
      /未知工具/,
    )
    expect(registry.displayKind('missing')).toBe('generic')
    expect(registry.describe('missing', {})).toBe('')
  })
})

describe('builtin tools', () => {
  it('registers bash, edit_file and write_file', () => {
    expect(createBuiltinTools().map((tool) => tool.name)).toEqual([
      'bash',
      'edit_file',
      'write_file',
    ])
    expect(createBuiltinRegistry().specs()).toHaveLength(3)
  })

  it('runs bash through the registry', async () => {
    const registry = createBuiltinRegistry()

    const result = await registry.execute(
      'bash',
      { command: 'printf registry-ok' },
      context,
    )

    expect(result.observation).toContain('registry-ok')
    expect(result.display).toMatchObject({
      kind: 'command',
      command: 'printf registry-ok',
      exitCode: 0,
    })
  })

  it('runs file tools through the registry', async () => {
    const registry = createBuiltinRegistry()

    const written = await registry.execute(
      'write_file',
      { path: 'note.txt', content: 'hello' },
      context,
    )
    expect(written.display).toMatchObject({
      kind: 'file',
      tool: 'write_file',
      path: 'note.txt',
      created: true,
    })

    const edited = await registry.execute(
      'edit_file',
      { path: 'note.txt', old_string: 'hello', new_string: 'bye' },
      context,
    )
    expect(edited.display).toMatchObject({
      kind: 'file',
      tool: 'edit_file',
      path: 'note.txt',
      created: false,
    })
  })
})