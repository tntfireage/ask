import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../src/mcp/config.js'
import { McpManager } from '../src/mcp/manager.js'

const serverPath = join(process.cwd(), 'tests/helpers/mock-mcp-server.mjs')

function mockServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    command: process.execPath,
    args: [serverPath],
    env: {},
    headers: {},
    disabled: false,
    timeoutMs: 5_000,
    disabledTools: [],
    ...overrides,
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timeout')
}

describe('McpManager', () => {
  it('starts servers, lists tools and closes them', async () => {
    const manager = new McpManager({
      servers: { mock: mockServer() },
      cwd: process.cwd(),
      logDir: '/tmp/ask-mcp-manager-test',
    })

    await manager.start()

    const statuses = manager.statuses()
    expect(statuses).toEqual([
      { name: 'mock', state: 'ready', toolCount: 4 },
    ])
    expect(manager.tools().map((item) => `${item.server}:${item.tool.name}`)).toEqual([
      'mock:echo',
      'mock:fail',
      'mock:slow',
      'mock:die',
    ])

    const result = await manager.callTool(
      'mock',
      'echo',
      { text: 'hello' },
      { timeoutMs: 2_000 },
    )
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hello' }])

    await manager.close()
    expect(manager.statuses()[0].state).toBe('closed')
  })

  it('marks disabled and failed servers without blocking others', async () => {
    const manager = new McpManager({
      servers: {
        good: mockServer(),
        off: mockServer({ disabled: true }),
        bad: mockServer({ command: 'definitely-not-a-command' }),
      },
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
      logDir: '/tmp/ask-mcp-manager-test',
    })

    await manager.start()

    const statuses = Object.fromEntries(
      manager.statuses().map((status) => [status.name, status]),
    )
    expect(statuses.good.state).toBe('ready')
    expect(statuses.off.state).toBe('disabled')
    expect(statuses.bad.state).toBe('failed')
    expect(statuses.bad.error).toBeTruthy()
    expect(manager.tools().every((item) => item.server === 'good')).toBe(true)

    await manager.close()
  })

  it('marks a crashed server as failed', async () => {
    const manager = new McpManager({
      servers: { mock: mockServer() },
      cwd: process.cwd(),
      logDir: '/tmp/ask-mcp-manager-test',
    })

    await manager.start()
    await manager.callTool('mock', 'die', {}, { timeoutMs: 2_000 })

    await waitFor(
      () => manager.statuses()[0].state === 'failed',
      3_000,
    )
    expect(manager.isAvailable('mock')).toBe(false)

    await manager.close()
  })
})