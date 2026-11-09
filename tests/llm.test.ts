import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { AskConfig } from '../src/config/config.js'
import { ConfigError } from '../src/config/config.js'
import { LlmError, type ChatChunk } from '../src/llm/adapter.js'
import { OpenAiAdapter } from '../src/llm/openai.js'

function configFor(baseUrl: string): AskConfig {
  return {
    provider: 'openai-compatible',
    language: 'zh',
    base_url: baseUrl,
    model: 'test-model',
    api_key: 'test-key',
    max_steps: 12,
    command_timeout_ms: 30_000,
    max_output_bytes: 262_144,
    temperature: 0,
    context_window_tokens: 128_000,
    context_evict_ratio: 0.95,
    skills: { enabled: true, project: true },
    mcp: { enabled: true, maxTools: 128 },
  }
}

interface MockServer {
  url: string
  close: () => Promise<void>
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MockServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chunk(delta: unknown, usage?: unknown): string {
  return sse({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...(usage ? { usage } : {}),
  })
}

const messages = [{ role: 'user' as const, content: 'hi' }]
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  },
]

async function collect(adapter: OpenAiAdapter): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = []
  for await (const item of adapter.chat({ messages, tools })) {
    chunks.push(item)
  }
  return chunks
}

describe('OpenAiAdapter', () => {
  it('streams text deltas and usage', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ content: 'Hello' }))
      res.write(chunk({ content: ' world' }))
      res.write(
        chunk(
          {},
          { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        ),
      )
      res.end('data: [DONE]\n\n')
    })

    try {
      const adapter = new OpenAiAdapter({
        config: configFor(server.url),
      })
      const chunks = await collect(adapter)

      expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['Hello', ' world'])
      expect(chunks).toContainEqual({
        type: 'usage',
        promptTokens: 11,
        completionTokens: 2,
      })
    } finally {
      await server.close()
    }
  })

  it('assembles fragmented tool calls', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '' },
            },
          ],
        }),
      )
      res.write(
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '{"command":"ls' } },
          ],
        }),
      )
      res.write(
        chunk({
          tool_calls: [{ index: 0, function: { arguments: ' -la"}' } }],
        }),
      )
      res.end('data: [DONE]\n\n')
    })

    try {
      const adapter = new OpenAiAdapter({
        config: configFor(server.url),
      })
      const chunks = await collect(adapter)
      const call = chunks.find((c) => c.type === 'tool_call')

      expect(call).toEqual({
        type: 'tool_call',
        call: {
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls -la"}' },
        },
      })
    } finally {
      await server.close()
    }
  })

  it('surfaces non-2xx responses and calls onError', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'boom' } }))
    })
    const errors: Error[] = []

    try {
      const adapter = new OpenAiAdapter({
        config: configFor(server.url),
        onError: (error) => errors.push(error),
        maxRetries: 0,
      })

      await expect(collect(adapter)).rejects.toBeInstanceOf(LlmError)
      await expect(collect(adapter)).rejects.toThrow(/500/)
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('surfaces connection failures', async () => {
    const adapter = new OpenAiAdapter({
      config: configFor('http://127.0.0.1:1/v1'),
      maxRetries: 0,
    })

    await expect(collect(adapter)).rejects.toBeInstanceOf(LlmError)
  })

  it('requires a key before any request', () => {
    const config = { ...configFor('http://127.0.0.1:1/v1'), api_key: null }
    expect(() => new OpenAiAdapter({ config })).toThrow(ConfigError)
  })
})
