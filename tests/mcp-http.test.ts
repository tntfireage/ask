import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectServer, transportKindFor } from '../src/mcp/client.js'
import type { McpServerConfig } from '../src/mcp/config.js'

interface MockHttpServer {
  url: string
  close: () => Promise<void>
}

function startHttpMcpServer(): Promise<MockHttpServer> {
  const tools = [
    {
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ]
  const sessionId = 'mock-session'

  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    let message: { id?: number | string; method?: string; params?: unknown }
    try {
      message = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }

    if (message.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }

    const send = (payload: Record<string, unknown>): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }))
    }

    if (message.method === 'initialize') {
      const params = message.params as { protocolVersion?: string } | undefined
      send({
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'http-mock', version: '1.0.0' },
        },
      })
      return
    }

    if (message.method === 'tools/list') {
      send({ result: { tools } })
      return
    }

    if (message.method === 'tools/call') {
      const params = message.params as {
        name?: string
        arguments?: { text?: string }
      }
      send({
        result: {
          content: [
            {
              type: 'text',
              text: `echo:${params?.arguments?.text ?? ''}`,
            },
          ],
        },
      })
      return
    }

    send({ error: { code: -32601, message: 'method not found' } })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function httpConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    args: [],
    env: {},
    headers: {},
    url,
    disabled: false,
    timeoutMs: 5_000,
    disabledTools: [],
    ...overrides,
  }
}

describe('MCP transport selection', () => {
  it('infers stdio, SSE and Streamable HTTP', () => {
    expect(
      transportKindFor(httpConfig('https://example.com/mcp', { command: 'x' })),
    ).toBe('stdio')
    expect(transportKindFor(httpConfig('https://example.com/sse'))).toBe('sse')
    expect(transportKindFor(httpConfig('https://example.com/mcp'))).toBe(
      'streamable-http',
    )
    expect(
      transportKindFor(
        httpConfig('https://example.com/custom', { transport: 'sse' }),
      ),
    ).toBe('sse')
  })
})

describe('MCP Streamable HTTP client', () => {
  let server: MockHttpServer | null = null

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('initializes, lists tools and calls a tool over HTTP', async () => {
    server = await startHttpMcpServer()

    const connection = await connectServer(httpConfig(server.url), {
      cwd: process.cwd(),
      startupTimeoutMs: 5_000,
    })

    try {
      expect(connection.tools.map((tool) => tool.name)).toEqual(['echo'])
      const result = await connection.callTool(
        'echo',
        { text: 'hi' },
        { timeoutMs: 2_000 },
      )
      expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }])
    } finally {
      await connection.close()
    }
  })
})