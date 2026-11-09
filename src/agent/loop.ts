import type { ChatChunk, LlmAdapter, ToolCall } from '../llm/adapter.js'
import type { Logger } from '../log/writer.js'
import type { ToolContext, ToolResult } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ConversationSession } from './session.js'
import type { AgentEvent } from './types.js'

export interface AgentLoopOptions {
  llm: LlmAdapter
  session: ConversationSession
  registry: ToolRegistry
  toolContext: ToolContext
  maxSteps: number
  logger?: Logger
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstLine(text: string, maxLength = 120): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? ''
  return line.length > maxLength
    ? `${line.slice(0, maxLength)}...`
    : line
}

function summarize(result: ToolResult): string {
  const display = result.display
  if (display) {
    if (display.kind === 'command') {
      return display.exitCode === null ? 'signal' : `exit ${display.exitCode}`
    }
    if (display.kind === 'file') {
      return display.path
    }
    return display.summary
  }
  return firstLine(result.observation)
}

function parseArguments(raw: string): {
  args: Record<string, unknown>
  error: string | null
} {
  try {
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { args: {}, error: '工具参数必须是 JSON 对象' }
    }
    return { args: parsed as Record<string, unknown>, error: null }
  } catch (error) {
    return { args: {}, error: `工具参数解析失败: ${errorMessage(error)}` }
  }
}

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async *run(
    userInput: string,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const { session, llm, registry, maxSteps } = this.options

    session.addUser(userInput)

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal.aborted) {
        yield { type: 'error', kind: 'aborted', message: '回合已中止' }
        return
      }

      yield { type: 'thinking' }
      session.evictIfNeeded()

      let assistantText = ''
      const toolCalls: ToolCall[] = []

      try {
        const stream = llm.chat({
          messages: session.getMessages(),
          tools: registry.specs(),
          signal,
        })

        for await (const chunk of stream as AsyncIterable<ChatChunk>) {
          if (chunk.type === 'text') {
            assistantText += chunk.delta
            yield { type: 'text', delta: chunk.delta }
          } else if (chunk.type === 'tool_call') {
            toolCalls.push(chunk.call)
          } else if (chunk.type === 'usage') {
            session.recordUsage(chunk.promptTokens)
          }
        }
      } catch (error) {
        yield {
          type: 'error',
          kind: signal.aborted ? 'aborted' : 'llm_error',
          message: signal.aborted ? '回合已中止' : errorMessage(error),
        }
        return
      }

      if (signal.aborted) {
        yield { type: 'error', kind: 'aborted', message: '回合已中止' }
        return
      }

      if (toolCalls.length === 0) {
        session.addAssistant(assistantText)
        yield { type: 'final', markdown: assistantText }
        return
      }

      session.addAssistant(
        assistantText === '' ? null : assistantText,
        toolCalls,
      )

      for (const call of toolCalls) {
        const name = call.function.name
        const parsed = parseArguments(call.function.arguments)
        const args = parsed.args
        const label =
          registry.describe(name, args) ||
          firstLine(call.function.arguments) ||
          name
        const displayKind = registry.displayKind(name)

        yield { type: 'tool_call', tool: name, label, displayKind }

        if (parsed.error) {
          this.options.logger?.write({
            kind: 'parse_error',
            tool: name,
            command: call.function.arguments,
            message: parsed.error,
          })
          yield {
            type: 'tool_result',
            tool: name,
            ok: false,
            durationMs: 0,
            summary: parsed.error,
          }
          session.addToolResult(
            call.id,
            `${name} 失败: ${parsed.error}`,
          )
          continue
        }

        const startedAt = Date.now()

        try {
          const result = await registry.execute(name, args, {
            ...this.options.toolContext,
            signal,
          })
          const durationMs = Date.now() - startedAt

          yield {
            type: 'tool_result',
            tool: name,
            ok: true,
            durationMs,
            summary: summarize(result),
            display: result.display,
          }
          session.addToolResult(call.id, result.observation)
        } catch (error) {
          const message = errorMessage(error)
          const durationMs = Date.now() - startedAt

          yield {
            type: 'tool_result',
            tool: name,
            ok: false,
            durationMs,
            summary: message,
          }
          session.addToolResult(call.id, `${name} 失败: ${message}`)
        }
      }
    }

    yield {
      type: 'error',
      kind: 'max_steps',
      message: `已达到最大步数 ${maxSteps}`,
    }
  }
}