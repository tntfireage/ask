import { describe, expect, it } from 'vitest'
import { createTurnRenderer, renderUserMessage } from '../src/repl/render.js'
import { displayWidth } from '../src/repl/style.js'

function render(events: Parameters<ReturnType<typeof createTurnRenderer>['handle']>[0][]): string {
  const output: string[] = []
  const renderer = createTurnRenderer((text) => output.push(text))
  for (const event of events) {
    renderer.handle(event)
  }
  return output.join('')
}

describe('turn renderer', () => {
  it('shows tool calls and their result summary', () => {
    const text = render([
      {
        type: 'tool_call',
        tool: 'bash',
        label: 'du -sh .',
        displayKind: 'command',
      },
      {
        type: 'tool_result',
        tool: 'bash',
        ok: true,
        durationMs: 12,
        summary: 'exit 0',
        display: {
          kind: 'command',
          command: 'du -sh .',
          exitCode: 0,
          durationMs: 12,
          truncated: false,
        },
      },
    ])

    expect(text).toContain('$ du -sh .')
    expect(text).toContain('exit 0 · 12ms')
  })

  it('marks truncated results', () => {
    const text = render([
      {
        type: 'tool_result',
        tool: 'bash',
        ok: true,
        durationMs: 3,
        summary: 'exit 0',
        display: {
          kind: 'command',
          command: 'cat big',
          exitCode: 0,
          durationMs: 3,
          truncated: true,
        },
      },
    ])

    expect(text).toContain('输出已截断')
  })

  it('collapses long tool calls to one line and keeps the result line', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text), {
      columns: () => 40,
    })
    const command =
      'find . -name "*.ts" -not -path "./node_modules/*" -type f -print'

    renderer.handle({
      type: 'tool_call',
      tool: 'bash',
      label: command,
      displayKind: 'command',
    })
    renderer.handle({
      type: 'tool_result',
      tool: 'bash',
      ok: true,
      durationMs: 22,
      summary: 'exit 0',
      display: {
        kind: 'command',
        command,
        exitCode: 0,
        durationMs: 22,
        truncated: false,
      },
    })
    renderer.dispose()

    const text = chunks.join('')
    const callLine = text
      .split('\n')
      .find((line) => line.startsWith('$ '))

    expect(callLine).toBeTruthy()
    expect(displayWidth(callLine ?? '')).toBeLessThanOrEqual(40)
    expect(callLine).toContain('...')
    expect(text).toContain('-> exit 0 · 22ms')
  })

  it('collapses long generic tool calls', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text), {
      columns: () => 30,
    })

    renderer.handle({
      type: 'tool_call',
      tool: 'mcp__mock__echo',
      label: JSON.stringify({ text: 'x'.repeat(100) }),
      displayKind: 'generic',
    })
    renderer.dispose()

    const text = chunks.join('')
    const line = text
      .split('\n')
      .find((item) => item.startsWith('● '))
    expect(line).toContain('...')
    expect(line?.endsWith(')')).toBe(true)
    expect(displayWidth(line ?? '')).toBeLessThanOrEqual(30)
  })

  it('prints the final markdown when nothing was streamed', () => {
    const text = render([{ type: 'final', markdown: '## 结论\nok' }])
    expect(text).toBe('\n## 结论\nok\n\n')
  })

  it('does not duplicate an answer that was already streamed', () => {
    const text = render([
      { type: 'text', delta: '## 结论\n' },
      { type: 'text', delta: 'ok' },
      { type: 'final', markdown: '## 结论\nok' },
    ])

    expect(text).toBe('\n## 结论\nok\n\n')
  })

  it('stays quiet for aborted turns but reports other errors', () => {
    expect(render([{ type: 'error', kind: 'aborted', message: 'x' }])).toBe('')
    expect(
      render([{ type: 'error', kind: 'llm_error', message: 'boom' }]),
    ).toContain('[错误] boom')
  })
})

describe('colored rendering', () => {
  it('paints the user question on a distinct background block', () => {
    const chunks: string[] = []
    renderUserMessage('hello', (text) => chunks.push(text), {
      color: true,
      columns: () => 20,
    })

    const text = chunks.join('')
    expect(text).toContain('\x1b[48;5;250m')
    expect(text).toContain('ask > hello')

    const firstLine = text.split('\n')[0]
    expect(displayWidth(firstLine)).toBe(20)
  })

  it('paints a multi-line question with a single prompt prefix', () => {
    const chunks: string[] = []
    renderUserMessage('first\nsecond', (text) => chunks.push(text), {
      color: true,
      columns: () => 20,
    })

    const text = chunks.join('')
    expect(text.match(/ask > /g)).toHaveLength(1)
    expect(text).toContain('ask > first')
    expect(text).toContain('       second')

    for (const line of text.split('\n').slice(0, 2)) {
      expect(displayWidth(line)).toBe(20)
    }
  })

  it('prints no question block when color is disabled', () => {
    const chunks: string[] = []
    renderUserMessage('hello', (text) => chunks.push(text), { color: false })
    expect(chunks).toEqual([])
  })

  it('renders the answer as plain text even with color enabled', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text), {
      color: true,
      columns: () => 20,
    })

    renderer.handle({ type: 'text', delta: 'hi' })
    renderer.handle({ type: 'final', markdown: 'hi' })
    renderer.dispose()

    const text = chunks.join('')
    expect(text).not.toContain('\x1b[48;5;')
    expect(text).not.toContain(' ask')
    expect(text).toContain('hi')
  })
})

describe('file edit rendering', () => {
  it('shows the file path, line numbers and line diff', () => {
    const text = render([
      {
        type: 'tool_result',
        tool: 'edit_file',
        ok: true,
        durationMs: 4,
        summary: 'src/a.ts',
        display: {
          kind: 'file',
          tool: 'edit_file',
          path: 'src/a.ts',
          created: false,
          diff: [
            { kind: ' ', text: 'context', oldLine: 1, newLine: 1 },
            { kind: '-', text: 'old', oldLine: 2 },
            { kind: '+', text: 'new', newLine: 2 },
          ],
        },
      },
    ])

    expect(text).toContain('● edit_file(src/a.ts)')
    expect(text).toContain('1 1 |   context')
    expect(text).toContain('2   | - old')
    expect(text).toContain('  2 | + new')
  })

  it('labels write_file create and overwrite states', () => {
    expect(
      render([
        {
          type: 'tool_result',
          tool: 'write_file',
          ok: true,
          durationMs: 2,
          summary: 'a.txt',
          display: {
            kind: 'file',
            tool: 'write_file',
            path: 'a.txt',
            created: true,
            diff: [{ kind: '+', text: 'hi' }],
          },
        },
      ]),
    ).toContain('● write_file(a.txt) (新建)')

    expect(
      render([
        {
          type: 'tool_result',
          tool: 'write_file',
          ok: true,
          durationMs: 2,
          summary: 'a.txt',
          display: {
            kind: 'file',
            tool: 'write_file',
            path: 'a.txt',
            created: false,
            diff: [],
          },
        },
      ]),
    ).toContain('(覆盖)')
  })

  it('shows file tool errors', () => {
    const text = render([
      {
        type: 'tool_result',
        tool: 'edit_file',
        ok: false,
        durationMs: 2,
        summary: 'old_string 未在文件中找到',
        display: {
          kind: 'file',
          tool: 'edit_file',
          path: 'a.txt',
          created: false,
          diff: [],
        },
      },
    ])

    expect(text).toContain('old_string 未在文件中找到')
  })
})

describe('progress status', () => {
  it('renders generic MCP tool calls and results', () => {
    const text = render([
      {
        type: 'tool_call',
        tool: 'mcp__mock__echo',
        label: '{"text":"hi"}',
        displayKind: 'generic',
      },
      {
        type: 'tool_result',
        tool: 'mcp__mock__echo',
        ok: true,
        durationMs: 5,
        summary: 'echo:hi',
        display: {
          kind: 'generic',
          tool: 'mcp__mock__echo',
          title: 'mock/echo',
          summary: 'echo:hi',
          ok: true,
        },
      },
    ])

    expect(text).toContain('● mcp__mock__echo({"text":"hi"})')
    expect(text).toContain('-> ok · 5ms · echo:hi')
  })
  it('shows thinking and running labels on a TTY', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text), {
      isTTY: true,
      now: () => 1_000,
    })

    renderer.handle({ type: 'thinking' })
    expect(chunks.join('')).toContain('思考中')

    renderer.handle({
      type: 'tool_call',
      tool: 'bash',
      label: 'ls',
      displayKind: 'command',
    })
    expect(chunks.join('')).toContain('运行中')

    renderer.handle({
      type: 'tool_result',
      tool: 'bash',
      ok: true,
      durationMs: 5,
      summary: 'exit 0',
      display: {
        kind: 'command',
        command: 'ls',
        exitCode: 0,
        durationMs: 5,
        truncated: false,
      },
    })
    renderer.handle({ type: 'final', markdown: 'done' })
    renderer.dispose()

    expect(chunks.join('')).toContain('\r\x1b[2K')
  })

  it('emits nothing for thinking when not a TTY', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text))

    renderer.handle({ type: 'thinking' })
    renderer.dispose()

    expect(chunks).toEqual([])
  })

  it('localizes status and error labels', () => {
    const chunks: string[] = []
    const renderer = createTurnRenderer((text) => chunks.push(text), {
      isTTY: true,
      language: 'en',
      now: () => 1_000,
    })

    renderer.handle({ type: 'thinking' })
    renderer.handle({
      type: 'tool_call',
      tool: 'bash',
      label: 'ls',
      displayKind: 'command',
    })
    renderer.handle({
      type: 'tool_result',
      tool: 'bash',
      ok: true,
      durationMs: 5,
      summary: 'exit 0',
      display: {
        kind: 'command',
        command: 'ls',
        exitCode: 0,
        durationMs: 5,
        truncated: true,
      },
    })
    renderer.handle({ type: 'error', kind: 'llm_error', message: 'boom' })
    renderer.dispose()

    const text = chunks.join('')
    expect(text).toContain('Thinking')
    expect(text).toContain('Running')
    expect(text).toContain('truncated')
    expect(text).toContain('[Error] boom')
  })
})
