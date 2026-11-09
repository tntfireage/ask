import type { ChatMessage, ToolCall } from '../llm/adapter.js'

export interface SessionOptions {
  systemPrompt: string
  contextWindowTokens: number
  evictRatio: number
}

interface UsageAnchor {
  messageCount: number
  promptTokens: number
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }

  return cjk + Math.ceil(other / 4)
}

function messageText(message: ChatMessage): string {
  const parts: string[] = [message.content ?? '']
  for (const call of message.tool_calls ?? []) {
    parts.push(call.function.name, call.function.arguments)
  }
  return parts.join(' ')
}

export class ConversationSession {
  private messages: ChatMessage[]
  private usageAnchor: UsageAnchor | null = null

  constructor(private options: SessionOptions) {
    this.messages = [{ role: 'system', content: options.systemPrompt }]
  }

  setLimits(contextWindowTokens: number, evictRatio: number): void {
    this.options = {
      ...this.options,
      contextWindowTokens,
      evictRatio,
    }
  }

  setSystemPrompt(prompt: string): void {
    if (this.messages.length === 0) {
      this.messages.push({ role: 'system', content: prompt })
      return
    }
    this.messages[0] = { role: 'system', content: prompt }
  }

  getMessages(): ChatMessage[] {
    return this.messages
  }

  get isCleared(): boolean {
    return this.messages.length === 1
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content })
  }

  addAssistant(content: string | null, toolCalls?: ToolCall[]): void {
    const message: ChatMessage = { role: 'assistant', content }
    if (toolCalls && toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }
    this.messages.push(message)
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, content })
  }

  clear(): void {
    this.messages = this.messages.slice(0, 1)
    this.usageAnchor = null
  }

  recordUsage(promptTokens: number): void {
    this.usageAnchor = {
      messageCount: this.messages.length,
      promptTokens,
    }
  }

  estimateAll(): number {
    return this.messages.reduce(
      (total, message) => total + estimateTokens(messageText(message)) + 4,
      0,
    )
  }

  estimatedContext(): number {
    if (!this.usageAnchor) {
      return this.estimateAll()
    }

    const remaining = this.messages.slice(this.usageAnchor.messageCount)
    const remainingTokens = remaining.reduce(
      (total, message) => total + estimateTokens(messageText(message)) + 4,
      0,
    )

    return this.usageAnchor.promptTokens + remainingTokens
  }

  shouldEvict(): boolean {
    const threshold = this.options.contextWindowTokens * this.options.evictRatio
    return this.estimatedContext() >= threshold
  }

  evictOldestTurn(): boolean {
    const firstUser = this.messages.findIndex(
      (message, index) => index > 0 && message.role === 'user',
    )
    if (firstUser === -1) {
      return false
    }

    const nextUser = this.messages.findIndex(
      (message, index) => index > firstUser && message.role === 'user',
    )
    if (nextUser === -1) {
      return false
    }

    this.messages.splice(firstUser, nextUser - firstUser)
    this.usageAnchor = null
    return true
  }

  evictIfNeeded(): number {
    let dropped = 0
    while (this.shouldEvict() && this.evictOldestTurn()) {
      dropped += 1
    }
    return dropped
  }
}
