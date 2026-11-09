import type { ToolDisplay, ToolDisplayKind } from '../tools/types.js'

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; delta: string }
  | {
      type: 'tool_call'
      tool: string
      label: string
      displayKind: ToolDisplayKind
    }
  | {
      type: 'tool_result'
      tool: string
      ok: boolean
      durationMs: number
      summary: string
      display?: ToolDisplay
    }
  | { type: 'final'; markdown: string }
  | { type: 'error'; kind: string; message: string }