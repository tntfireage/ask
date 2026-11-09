import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../src/agent/loop.js'
import { ConversationSession } from '../src/agent/session.js'
import type { AgentEvent } from '../src/agent/types.js'
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  LlmAdapter,
} from '../src/llm/adapter.js'
import {
  buildSystemPrompt,
  finalAnswerSections,
} from '../src/prompts/system.js'
import { ToolRegistry, bashToolSpec } from '../src/tools/registry.js'
import {
  editFileToolSpec,
  writeFileToolSpec,
} from '../src/tools/files.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../src/tools/types.js'

const SYSTEM_PROMPT = buildSystemPrompt('zh')

const toolContext: ToolContext = {
  cwd: '/tmp',
  timeoutMs: 5_000,
  maxOutputBytes: 10_000,
}

function bashRegistry(
  execute: (args: Record<string, unknown>) => Promise<ToolResult>,
): ToolRegistry {
  const registry = new ToolRegistry()
  const definition: ToolDefinition = {
    name: 'bash',
    spec: bashToolSpec,
    displayKind: 'command',
    describe: (args) =>
      String((args as Record<string, unknown>)?.command ?? ''),
    execute,
  }
  registry.register(definition)
  return registry
}

function emptyRegistry(): ToolRegistry {
  return new ToolRegistry()
}

class ScriptedLlm implements LlmAdapter {
  calls: ChatRequest[] = []

  constructor(private readonly script: ChatChunk[][]) {}

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const index = Math.min(this.calls.length, this.script.length - 1)
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    })
    for (const chunk of this.script[index]) {
      yield chunk
    }
  }
}

async function collect(loop: AgentLoop, input: string, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of loop.run(input, signal)) {
    events.push(event)
  }
  return events
}

function toolCall(command: string, id = 'call_1'): ChatChunk {
  return {
    type: 'tool_call',
    call: {
      id,
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command }) },
    },
  }
}

function fileToolCall(
  name: 'edit_file' | 'write_file',
  args: Record<string, unknown>,
  id = 'call_file',
): ChatChunk {
  return {
    type: 'tool_call',
    call: {
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  }
}

describe('AgentLoop', () => {
  it('runs tool calls and then produces a final answer', async () => {
    const llm = new ScriptedLlm([
      [toolCall('ls')],
      [{ type: 'text', delta: '## 结论\nok' }],
    ])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const loop = new AgentLoop({
      llm,
      session,
      registry: bashRegistry(async (args) => ({
        observation: 'file.txt\n',
        display: {
          kind: 'command',
          command: String(args.command),
          exitCode: 0,
          durationMs: 5,
          truncated: false,
        },
      })),
      toolContext,
      maxSteps: 5,
    })

    const events = await collect(loop, '当前目录有什么')
    const types = events.map((event) => event.type)

    expect(types).toEqual([
      'thinking',
      'tool_call',
      'tool_result',
      'thinking',
      'text',
      'final',
    ])
    expect(events[1]).toEqual({
      type: 'tool_call',
      tool: 'bash',
      label: 'ls',
      displayKind: 'command',
    })
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      tool: 'bash',
      ok: true,
      display: { kind: 'command', exitCode: 0 },
    })
    expect(events.at(-1)).toEqual({
      type: 'final',
      markdown: '## 结论\nok',
    })
  })

  it('stops with an error at the step budget', async () => {
    const llm = new ScriptedLlm([[toolCall('ls')], [toolCall('ls')]])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const loop = new AgentLoop({
      llm,
      session,
      registry: bashRegistry(async () => ({ observation: '' })),
      toolContext,
      maxSteps: 2,
    })

    const events = await collect(loop, 'loop forever')
    const last = events.at(-1)

    expect(last).toMatchObject({ type: 'error', kind: 'max_steps' })
    expect(llm.calls).toHaveLength(2)
  })

  it('carries prior turns into later requests', async () => {
    const llm = new ScriptedLlm([
      [{ type: 'text', delta: '第一次回答' }],
      [{ type: 'text', delta: '第二次回答' }],
    ])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const loop = new AgentLoop({
      llm,
      session,
      registry: emptyRegistry(),
      toolContext,
      maxSteps: 3,
    })

    await collect(loop, '第一个问题')
    await collect(loop, '第二个问题')

    const secondRequest = llm.calls[1]
    const roles = secondRequest.messages.map((message: ChatMessage) => message.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
    expect(secondRequest.messages[1].content).toBe('第一个问题')
    expect(secondRequest.messages[2].content).toBe('第一次回答')
    expect(secondRequest.messages[3].content).toBe('第二个问题')
  })

  it('reports aborted without starting a request when already aborted', async () => {
    const llm = new ScriptedLlm([[{ type: 'text', delta: 'unused' }]])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const loop = new AgentLoop({
      llm,
      session,
      registry: emptyRegistry(),
      toolContext,
      maxSteps: 3,
    })

    const controller = new AbortController()
    controller.abort()
    const events = await collect(loop, 'anything', controller.signal)

    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'aborted' })
    expect(llm.calls).toHaveLength(0)
  })

  it('does not request again after abort during tool execution', async () => {
    const llm = new ScriptedLlm([[toolCall('sleep')], [{ type: 'text', delta: 'never' }]])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const controller = new AbortController()
    const loop = new AgentLoop({
      llm,
      session,
      registry: bashRegistry(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return {
          observation: 'aborted',
          display: {
            kind: 'command',
            command: 'sleep',
            exitCode: null,
            durationMs: 150,
            truncated: false,
          },
        }
      }),
      toolContext,
      maxSteps: 3,
    })

    setTimeout(() => controller.abort(), 30)
    const events = await collect(loop, 'run', controller.signal)

    expect(llm.calls).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'aborted' })
  })

  it('dispatches edit_file and feeds the diff back to the model', async () => {
    const llm = new ScriptedLlm([
      [
        fileToolCall('edit_file', {
          path: 'a.txt',
          old_string: 'old',
          new_string: 'new',
        }),
      ],
      [{ type: 'text', delta: 'done' }],
    ])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const received: Array<{ tool: string; args: Record<string, unknown> }> = []
    const registry = new ToolRegistry()
    registry.register({
      name: 'edit_file',
      spec: editFileToolSpec,
      displayKind: 'file',
      describe: (args) =>
        String((args as Record<string, unknown>)?.path ?? ''),
      execute: async (args) => {
        received.push({ tool: 'edit_file', args })
        return {
          observation: '已更新 a.txt',
          display: {
            kind: 'file',
            tool: 'edit_file',
            path: 'a.txt',
            created: false,
            diff: [
              { kind: '-', text: 'old' },
              { kind: '+', text: 'new' },
            ],
          },
        }
      },
    })

    const loop = new AgentLoop({
      llm,
      session,
      registry,
      toolContext,
      maxSteps: 3,
    })

    const events = await collect(loop, 'edit it')
    const types = events.map((event) => event.type)

    expect(types).toEqual([
      'thinking',
      'tool_call',
      'tool_result',
      'thinking',
      'text',
      'final',
    ])
    expect(received).toEqual([
      {
        tool: 'edit_file',
        args: { path: 'a.txt', old_string: 'old', new_string: 'new' },
      },
    ])
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      tool: 'edit_file',
      label: 'a.txt',
      displayKind: 'file',
    })
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      tool: 'edit_file',
      ok: true,
      display: {
        kind: 'file',
        tool: 'edit_file',
        path: 'a.txt',
        created: false,
      },
    })
    expect(
      llm.calls[1].messages.some(
        (message) => message.role === 'tool' && message.content === '已更新 a.txt',
      ),
    ).toBe(true)
  })

  it('reports file tool failures back to the model', async () => {
    const llm = new ScriptedLlm([
      [fileToolCall('write_file', { path: 'a.txt', content: 'x' })],
      [{ type: 'text', delta: 'done' }],
    ])
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 128_000,
      evictRatio: 0.95,
    })
    const registry = new ToolRegistry()
    registry.register({
      name: 'write_file',
      spec: writeFileToolSpec,
      displayKind: 'file',
      describe: (args) =>
        String((args as Record<string, unknown>)?.path ?? ''),
      execute: async () => {
        throw new Error('old_string 未在文件中找到')
      },
    })

    const loop = new AgentLoop({
      llm,
      session,
      registry,
      toolContext,
      maxSteps: 3,
    })

    const events = await collect(loop, 'edit it')
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      tool: 'write_file',
      displayKind: 'file',
    })
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      tool: 'write_file',
      ok: false,
      summary: 'old_string 未在文件中找到',
    })
    expect(
      llm.calls[1].messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content === 'write_file 失败: old_string 未在文件中找到',
      ),
    ).toBe(true)
  })
})

describe('ConversationSession', () => {
  it('evicts the oldest complete turn, keeping tool calls with their results', () => {
    const session = new ConversationSession({
      systemPrompt: 'sys',
      contextWindowTokens: 100,
      evictRatio: 0.5,
    })

    session.addUser('u'.repeat(200))
    session.addAssistant(null, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      },
    ])
    session.addToolResult('call_1', 'r'.repeat(200))
    session.addUser('second')
    session.addAssistant('ok')

    expect(session.evictIfNeeded()).toBe(1)

    const roles = session.getMessages().map((message) => message.role)
    expect(roles).toEqual(['system', 'user', 'assistant'])
    expect(session.getMessages().some((message) => message.role === 'tool')).toBe(false)
  })

  it('never drops the last remaining turn', () => {
    const session = new ConversationSession({
      systemPrompt: 'sys',
      contextWindowTokens: 10,
      evictRatio: 0.5,
    })

    session.addUser('u'.repeat(200))

    expect(session.evictIfNeeded()).toBe(0)
    expect(session.getMessages()).toHaveLength(2)
  })

  it('clear resets to the system prompt', () => {
    const session = new ConversationSession({
      systemPrompt: 'sys',
      contextWindowTokens: 100,
      evictRatio: 0.5,
    })
    session.addUser('hello')
    session.addAssistant('hi')
    session.clear()

    expect(session.getMessages()).toHaveLength(1)
    expect(session.getMessages()[0].role).toBe('system')
  })

  it('anchors estimates on provider-reported usage', () => {
    const session = new ConversationSession({
      systemPrompt: 'sys',
      contextWindowTokens: 100,
      evictRatio: 0.9,
    })
    session.addUser('hello')
    session.recordUsage(50)

    expect(session.estimatedContext()).toBe(50)
    expect(session.shouldEvict()).toBe(false)
  })
})

describe('system prompt', () => {
  it('defines the final answer structure and tool rules', () => {
    for (const section of finalAnswerSections('zh')) {
      expect(SYSTEM_PROMPT).toContain(section)
    }
    expect(SYSTEM_PROMPT).toContain('## 结论')
    expect(SYSTEM_PROMPT).toContain('## 依据')
    expect(SYSTEM_PROMPT).toContain('bash')
    expect(SYSTEM_PROMPT).toContain('"zh"')
  })

  it('asks for concise answers without filler', () => {
    expect(SYSTEM_PROMPT).toContain('No preamble')
    expect(SYSTEM_PROMPT).toContain('No filler phrases')
    expect(SYSTEM_PROMPT).toContain(
      'Do not write explanatory text before a tool call',
    )
    expect(SYSTEM_PROMPT).toContain('general knowledge')
  })

  it('localizes headings and injects the response language', () => {
    const english = buildSystemPrompt('en')
    expect(english).toContain('## Conclusion')
    expect(english).toContain('## Evidence')
    expect(english).toContain('"en"')
    expect(english).not.toContain('## 结论')

    const japanese = buildSystemPrompt('ja')
    expect(japanese).toContain('"ja"')
    expect(japanese).toContain('translate these headings')
  })

  it('replaces the system prompt on the session', () => {
    const session = new ConversationSession({
      systemPrompt: SYSTEM_PROMPT,
      contextWindowTokens: 100,
      evictRatio: 0.5,
    })

    session.setSystemPrompt('new prompt')

    expect(session.getMessages()[0]).toEqual({
      role: 'system',
      content: 'new prompt',
    })
  })
})
