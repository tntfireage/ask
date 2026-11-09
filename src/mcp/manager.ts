import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { askHome } from '../config/config.js'
import {
  connectServer,
  type McpCallResult,
  type McpConnection,
  type McpToolInfo,
} from './client.js'
import type { McpServerConfig } from './config.js'

export type McpServerState =
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'closed'

export interface McpServerStatus {
  name: string
  state: McpServerState
  toolCount: number
  error?: string
}

export interface McpToolDescriptor {
  server: string
  tool: McpToolInfo
}

export interface McpManagerOptions {
  servers: Record<string, McpServerConfig>
  cwd: string
  startupTimeoutMs?: number
  logDir?: string
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>()
  private readonly statusMap = new Map<string, McpServerStatus>()
  private readonly logStreams = new Map<string, WriteStream>()
  private closed = false

  constructor(private readonly options: McpManagerOptions) {
    for (const [name, config] of Object.entries(options.servers)) {
      this.statusMap.set(name, {
        name,
        state: config.disabled ? 'disabled' : 'starting',
        toolCount: 0,
      })
    }
  }

  async start(): Promise<void> {
    const logDir = this.options.logDir ?? join(askHome(), 'logs', 'mcp')
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
    } catch {
      // 日志目录不可写不影响启动
    }

    const entries = Object.entries(this.options.servers).filter(
      ([, config]) => !config.disabled,
    )

    await Promise.all(
      entries.map(([name, config]) => this.startServer(name, config, logDir)),
    )
  }

  private async startServer(
    name: string,
    config: McpServerConfig,
    logDir: string,
  ): Promise<void> {
    try {
      const log = createWriteStream(join(logDir, `${safeName(name)}.log`), {
        flags: 'a',
      })
      this.logStreams.set(name, log)

      const connection = await connectServer(config, {
        cwd: config.cwd ?? this.options.cwd,
        startupTimeoutMs:
          this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        onStderr: (text) => log.write(text),
      })

      if (this.closed) {
        await connection.close()
        this.statusMap.set(name, {
          name,
          state: 'closed',
          toolCount: 0,
        })
        return
      }

      connection.onClose((error) => {
        this.connections.delete(name)
        if (this.closed) {
          return
        }
        this.statusMap.set(name, {
          name,
          state: 'failed',
          toolCount: 0,
          error: error
            ? error.message
            : 'server closed unexpectedly',
        })
      })

      this.connections.set(name, connection)
      this.statusMap.set(name, {
        name,
        state: 'ready',
        toolCount: connection.tools.length,
      })
    } catch (error) {
      this.statusMap.set(name, {
        name,
        state: 'failed',
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  tools(): McpToolDescriptor[] {
    const descriptors: McpToolDescriptor[] = []
    for (const name of [...this.connections.keys()].sort()) {
      const connection = this.connections.get(name)
      if (!connection) {
        continue
      }
      for (const tool of connection.tools) {
        descriptors.push({ server: name, tool })
      }
    }
    return descriptors
  }

  statuses(): McpServerStatus[] {
    return [...this.statusMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }

  isAvailable(server: string): boolean {
    return this.connections.has(server)
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<McpCallResult> {
    const connection = this.connections.get(server)
    if (!connection) {
      throw new Error(`MCP server unavailable: ${server}`)
    }
    return connection.callTool(tool, args, options)
  }

  async close(): Promise<void> {
    this.closed = true
    const connections = [...this.connections.values()]
    this.connections.clear()

    await Promise.all(
      connections.map(async (connection) => {
        try {
          await connection.close()
        } catch {
          // ignore
        }
      }),
    )

    for (const status of this.statusMap.values()) {
      if (status.state !== 'disabled') {
        status.state = 'closed'
        status.toolCount = 0
      }
    }

    for (const stream of this.logStreams.values()) {
      stream.end()
    }
    this.logStreams.clear()
  }
}