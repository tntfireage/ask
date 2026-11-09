import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { VERSION } from '../version.js'
import type { McpServerConfig } from './config.js'

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: unknown[]
  structuredContent?: unknown
  isError: boolean
}

export interface McpConnectOptions {
  cwd: string
  startupTimeoutMs?: number
  onStderr?: (text: string) => void
}

export interface McpCallOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface McpConnection {
  readonly tools: McpToolInfo[]
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallResult>
  close(): Promise<void>
  onClose(handler: (error?: Error) => void): void
}

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse'

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

export function transportKindFor(config: McpServerConfig): McpTransportKind {
  if (config.command) {
    return 'stdio'
  }
  if (config.transport) {
    return config.transport
  }
  if (config.url) {
    try {
      return new URL(config.url).pathname.endsWith('/sse')
        ? 'sse'
        : 'streamable-http'
    } catch {
      return 'streamable-http'
    }
  }
  return 'stdio'
}

function createTransport(
  config: McpServerConfig,
  options: McpConnectOptions,
  kind: McpTransportKind,
): Transport {
  if (kind === 'stdio') {
    if (!config.command) {
      throw new Error('MCP stdio server requires a command')
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...getDefaultEnvironment(),
        ...config.env,
      },
      cwd: config.cwd ?? options.cwd,
      stderr: 'pipe',
    })
  }

  if (!config.url) {
    throw new Error(`MCP ${kind} server requires a url`)
  }

  const url = new URL(config.url)
  const requestInit: RequestInit = {
    headers: config.headers,
  }

  return kind === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

async function connectWith(
  transport: Transport,
  options: McpConnectOptions,
): Promise<McpConnection> {
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

  const client = new Client(
    { name: 'ask', version: VERSION },
    { capabilities: {} },
  )

  let closeHandler: ((error?: Error) => void) | null = null
  client.onclose = () => closeHandler?.()
  client.onerror = (error: Error) => closeHandler?.(error)

  try {
    await client.connect(transport, { timeout: startupTimeoutMs })
    const listed = await client.listTools(undefined, {
      timeout: startupTimeoutMs,
    })

    const tools: McpToolInfo[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: 'object', properties: {} },
    }))

    return {
      tools,
      async callTool(name, args, callOptions) {
        const result = (await client.callTool(
          { name, arguments: args },
          undefined,
          {
            timeout: callOptions.timeoutMs,
            signal: callOptions.signal,
          },
        )) as {
          content?: unknown[]
          structuredContent?: unknown
          isError?: boolean
        }

        return {
          content: Array.isArray(result.content) ? result.content : [],
          structuredContent: result.structuredContent,
          isError: result.isError === true,
        }
      },
      async close() {
        try {
          await client.close()
        } catch {
          // 已关闭或传输已断开
        }
      },
      onClose(handler) {
        closeHandler = handler
      },
    }
  } catch (error) {
    try {
      await client.close()
    } catch {
      // ignore
    }
    throw error
  }
}

export async function connectServer(
  config: McpServerConfig,
  options: McpConnectOptions,
): Promise<McpConnection> {
  const kind = transportKindFor(config)
  const transport = createTransport(config, options, kind)

  if (kind === 'stdio') {
    if (config.command && options.onStderr) {
      const stdio = transport as StdioClientTransport
      if (stdio.stderr) {
        stdio.stderr.on('data', (chunk: Buffer) => {
          options.onStderr?.(chunk.toString('utf8'))
        })
      }
    }
    return connectWith(transport, options)
  }

  try {
    return await connectWith(transport, options)
  } catch (primaryError) {
    if (config.transport) {
      throw primaryError
    }

    const fallbackKind: McpTransportKind =
      kind === 'sse' ? 'streamable-http' : 'sse'
    const fallback = createTransport(config, options, fallbackKind)

    try {
      return await connectWith(fallback, options)
    } catch (fallbackError) {
      const first =
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError)
      const second =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError)
      throw new Error(
        `${kind} failed: ${first}; ${fallbackKind} failed: ${second}`,
      )
    }
  }
}