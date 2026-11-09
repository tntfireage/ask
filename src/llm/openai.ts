import OpenAI from 'openai'
import type { AskConfig } from '../config/config.js'
import { resolveApiKey } from '../config/config.js'
import {
  LlmError,
  type ChatChunk,
  type ChatRequest,
  type LlmAdapter,
} from './adapter.js'

export interface OpenAiAdapterOptions {
  config: AskConfig
  onError?: (error: Error) => void
  maxRetries?: number
}

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) {
    return error
  }
  if (error instanceof OpenAI.APIError) {
    return new LlmError(
      `LLM 请求失败${error.status ? ` (${error.status})` : ''}: ${error.message}`,
      error.status,
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new LlmError(`LLM 请求失败: ${message}`)
}

export class OpenAiAdapter implements LlmAdapter {
  private readonly client: OpenAI
  private readonly config: AskConfig
  private readonly onError?: (error: Error) => void

  constructor(options: OpenAiAdapterOptions) {
    this.config = options.config
    this.onError = options.onError
    this.client = new OpenAI({
      apiKey: resolveApiKey(options.config),
      baseURL: options.config.base_url,
      maxRetries: options.maxRetries ?? 2,
    })
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const pending = new Map<number, PendingToolCall>()

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: request.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: request.tools as OpenAI.Chat.ChatCompletionTool[],
          temperature: request.temperature ?? this.config.temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.signal },
      )

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (delta?.content) {
          yield { type: 'text', delta: delta.content }
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0
          const entry =
            pending.get(index) ?? { id: '', name: '', arguments: '' }

          if (toolCall.id) {
            entry.id = toolCall.id
          }
          if (toolCall.function?.name && entry.name === '') {
            entry.name = toolCall.function.name
          }
          if (toolCall.function?.arguments) {
            entry.arguments += toolCall.function.arguments
          }

          pending.set(index, entry)
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens ?? null,
          }
        }
      }

      for (const [index, entry] of [...pending.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        yield {
          type: 'tool_call',
          call: {
            id: entry.id || `call_${index}`,
            type: 'function',
            function: { name: entry.name, arguments: entry.arguments },
          },
        }
      }
    } catch (error) {
      const llmError = toLlmError(error)
      this.onError?.(llmError)
      throw llmError
    }
  }
}
