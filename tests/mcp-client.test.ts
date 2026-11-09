import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectServer } from '../src/mcp/client.js'
import type { McpServerConfig } from '../src/mcp/config.js'

const serverPath = join(process.cwd(), 'tests/helpers/mock-mcp-server.mjs')

function mockConfig(): McpServerConfig {
  return {
    command: process.execPath,
    args: [serverPath],
    env: {},
    headers: {},
    disabled: false,
    timeoutMs: 5_000,
    disabledTools: [],
  }
}

describe('MCP stdio client', () => {
  it('initializes and lists tools', async () => {
    const stderr: string[] = []
    const connection = await connectServer(mockConfig(), {
      cwd: process.cwd(),
      startupTimeoutMs: 5_000,
      onStderr: (text) => stderr.push(text),
    })

    try {
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        'echo',
        'fail',
        'slow',
        'die',
      ])
      expect(connection.tools[0].description).toContain('Echo')
      expect(stderr.join('')).toContain('mock-mcp ready')
    } finally {
      await connection.close()
    }
  })

  it('calls tools and reports errors', async () => {
    const connection = await connectServer(mockConfig(), {
      cwd: process.cwd(),
      startupTimeoutMs: 5_000,
    })

    try {
      const echoed = await connection.callTool(
        'echo',
        { text: 'hello' },
        { timeoutMs: 2_000 },
      )
      expect(echoed.isError).toBe(false)
      expect(echoed.content).toEqual([{ type: 'text', text: 'echo:hello' }])

      const failed = await connection.callTool('fail', {}, { timeoutMs: 2_000 })
      expect(failed.isError).toBe(true)
    } finally {
      await connection.close()
    }
  })

  it('enforces call timeouts', async () => {
    const connection = await connectServer(mockConfig(), {
      cwd: process.cwd(),
      startupTimeoutMs: 5_000,
    })

    try {
      await expect(
        connection.callTool('slow', {}, { timeoutMs: 150 }),
      ).rejects.toThrow()
    } finally {
      await connection.close()
    }
  })

  it('propagates aborts', async () => {
    const connection = await connectServer(mockConfig(), {
      cwd: process.cwd(),
      startupTimeoutMs: 5_000,
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    try {
      await expect(
        connection.callTool('slow', {}, {
          timeoutMs: 5_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow()
    } finally {
      await connection.close()
    }
  })
})