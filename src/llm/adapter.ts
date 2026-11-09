export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools: ToolSpec[]
  temperature?: number
  signal?: AbortSignal
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; promptTokens: number; completionTokens: number | null }

export interface LlmAdapter {
  chat(request: ChatRequest): AsyncIterable<ChatChunk>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
