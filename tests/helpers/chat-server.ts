import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

export interface ChatServer {
  url: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

export type ChatHandler = (
  body: Record<string, unknown>,
  index: number,
  res: ServerResponse,
) => void | Promise<void>

export async function startChatServer(handler: ChatHandler): Promise<ChatServer> {
  const requests: Array<Record<string, unknown>> = []

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      requests.push(body)
      void handler(body, requests.length - 1, res)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
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

const usageChunk = (promptTokens = 10): string =>
  sse({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 5,
      total_tokens: promptTokens + 5,
    },
  })

export function writeTextResponse(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const parts = text.match(/[\s\S]{1,12}/g) ?? []
  for (const part of parts) {
    res.write(chunk({ content: part }))
  }
  res.write(usageChunk())
  res.end('data: [DONE]\n\n')
}

export function writeNamedToolCallResponse(
  res: ServerResponse,
  name: string,
  args: Record<string, unknown>,
  id = 'call_1',
): void {
  const json = JSON.stringify(args)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    chunk({
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: '' },
        },
      ],
    }),
  )
  for (const part of json.match(/[\s\S]{1,8}/g) ?? []) {
    res.write(
      chunk({
        tool_calls: [{ index: 0, function: { arguments: part } }],
      }),
    )
  }
  res.write(usageChunk())
  res.end('data: [DONE]\n\n')
}

export function writeToolCallResponse(
  res: ServerResponse,
  command: string,
  id = 'call_1',
): void {
  writeNamedToolCallResponse(res, 'bash', { command }, id)
}

export function writeHangingResponse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk({ content: 'thinking' }))
}

export function writeConfig(
  home: string,
  baseUrl: string,
  language = 'zh',
): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'config.json'),
    `${JSON.stringify(
      {
        provider: 'openai-compatible',
        language,
        base_url: baseUrl,
        model: 'test-model',
        api_key: 'test-key',
        max_steps: 6,
        command_timeout_ms: 5_000,
        max_output_bytes: 262_144,
        temperature: 0,
        context_window_tokens: 128_000,
        context_evict_ratio: 0.95,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export function buildDist(): void {
  execFileSync(process.execPath, ['node_modules/.bin/tsup'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
}

export interface CliRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  child: ReturnType<typeof spawn>
}

export function spawnCli(
  args: string[],
  options: {
    home: string
    env?: Record<string, string>
    input?: string
    cwd?: string
  },
): CliRun {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli.js'), ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ASK_HOME: options.home,
      TEST_ASK_KEY: 'test-key',
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (data: string) => {
    stdout += data
  })
  child.stderr.on('data', (data: string) => {
    stderr += data
  })

  return {
    child,
    get code() {
      return child.exitCode
    },
    get signal() {
      return child.signalCode
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  } as CliRun
}

export function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('waitFor timeout'))
        return
      }
      setTimeout(poll, intervalMs)
    }
    poll()
  })
}

export function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('exit', (code) => resolve(code))
  })
}
