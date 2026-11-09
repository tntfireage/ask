import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../src/mcp/config.js'
import type { McpToolDescriptor } from '../src/mcp/manager.js'
import {
  createMcpTools,
  sanitizeMcpToolName,
  type McpToolSource,
} from '../src/mcp/tool.js'

function serverConfig(
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    command: 'x',
    args: [],
    env: {},
    headers: {},
    disabled: false,
    timeoutMs: 5_000,
    disabledTools: [],
    ...overrides,
  }
}

function descriptor(
  server: string,
  name: string,
  overrides: Partial<McpToolDescriptor['tool']> = {},
): McpToolDescriptor {
  return {
    server,
    tool: {
      name,
      description: `${name} description`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
      ...overrides,
    },
  }
}

function managerFor(descriptors: McpToolDescriptor[]): McpToolSource {
  return {
    tools: () => descriptors,
    callTool: async (server, tool) => ({
      content: [{ type: 'text', text: `${server}/${tool}` }],
      isError: false,
    }),
  }
}

const artifactDir = mkdtempSync(join(tmpdir(), 'ask-mcp-tools-'))

describe('MCP tool names', () => {
  it('namespaces and sanitizes names', () => {
    expect(sanitizeMcpToolName('github', 'search.issues')).toBe(
      'mcp__github__search_issues',
    )
    expect(sanitizeMcpToolName('my server', 'read/file')).toBe(
      'mcp__my_server__read_file',
    )
  })

  it('keeps long names within 64 characters', () => {
    const name = sanitizeMcpToolName(
      'server-with-a-very-long-name',
      'tool-with-a-very-long-name-too',
    )
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.startsWith('mcp__')).toBe(true)
  })
})

describe('createMcpTools', () => {
  it('creates tool definitions with schemas and descriptions', () => {
    const result = createMcpTools({
      manager: managerFor([descriptor('github', 'search')]),
      servers: { github: serverConfig() },
      maxTools: 10,
      artifactDir,
      maxOutputBytes: 10_000,
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('mcp__github__search')
    expect(result.tools[0].spec.function.description).toContain('[github]')
    expect(result.tools[0].spec.function.parameters).toMatchObject({
      type: 'object',
    })
  })

  it('applies disabledTools and the global cap', () => {
    const disabled = createMcpTools({
      manager: managerFor([
        descriptor('s', 'keep'),
        descriptor('s', 'drop'),
      ]),
      servers: { s: serverConfig({ disabledTools: ['drop'] }) },
      maxTools: 10,
      artifactDir,
      maxOutputBytes: 10_000,
    })
    expect(disabled.tools.map((tool) => tool.name)).toEqual([
      'mcp__s__keep',
    ])

    const capped = createMcpTools({
      manager: managerFor([
        descriptor('s', 'one'),
        descriptor('s', 'two'),
      ]),
      servers: { s: serverConfig() },
      maxTools: 1,
      artifactDir,
      maxOutputBytes: 10_000,
    })
    expect(capped.tools).toHaveLength(1)
    expect(capped.warnings.join('\n')).toContain('Only the first 1')
  })

  it('executes through the manager and maps the result', async () => {
    const result = createMcpTools({
      manager: managerFor([descriptor('s', 'echo')]),
      servers: { s: serverConfig() },
      maxTools: 10,
      artifactDir,
      maxOutputBytes: 10_000,
    })

    const toolResult = await result.tools[0].execute(
      { text: 'hi' },
      { cwd: '/tmp', timeoutMs: 1_000, maxOutputBytes: 10_000 },
    )

    expect(toolResult.observation).toBe('s/echo')
    expect(toolResult.display).toMatchObject({
      kind: 'generic',
      tool: 'mcp__s__echo',
      title: 's/echo',
      ok: true,
    })
  })
})