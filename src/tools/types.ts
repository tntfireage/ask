import type { ToolSpec } from '../llm/adapter.js'
import type { Logger } from '../log/writer.js'
import type { DiffLine } from './files.js'

export interface ToolContext {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  logger?: Logger
}

export type ToolDisplay =
  | {
      kind: 'command'
      command: string
      exitCode: number | null
      durationMs: number
      truncated: boolean
    }
  | {
      kind: 'file'
      tool: string
      path: string
      created: boolean
      diff: DiffLine[]
    }
  | {
      kind: 'generic'
      tool: string
      title: string
      summary: string
      ok: boolean
    }

export interface ToolResult {
  observation: string
  display?: ToolDisplay
}

export type ToolDisplayKind = 'command' | 'file' | 'generic'

export interface ToolDefinition {
  name: string
  spec: ToolSpec
  displayKind: ToolDisplayKind
  describe(args: unknown): string
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}