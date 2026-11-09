import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationSession } from '../src/agent/session.js'
import { Logger } from '../src/log/writer.js'
import { QueryHistory } from '../src/repl/history.js'
import { Repl, type HistorySelector } from '../src/repl/repl.js'
import { buildSystemPrompt } from '../src/prompts/system.js'
import type { Skill } from '../src/skills/loader.js'
import type { McpManager } from '../src/mcp/manager.js'

function tempHistoryFile(queries: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ask-repl-')), 'history')
  writeFileSync(
    path,
    queries.map((q) => JSON.stringify({ q, ts: 't' })).join('\n') + '\n',
    'utf8',
  )
  return path
}

function createRepl(options: {
  queries?: string[]
  selector?: HistorySelector
  historyPath?: string
  skills?: Skill[]
  mcpManager?: McpManager
}): {
  repl: Repl
  prefilled: string[]
  session: ConversationSession
  output: () => string
} {
  const input = new PassThrough()
  const chunks: string[] = []
  const output = {
    write: (text: string) => {
      chunks.push(text)
      return true
    },
  } as unknown as NodeJS.WritableStream
  const prefilled: string[] = []
  const session = new ConversationSession({
    systemPrompt: buildSystemPrompt('zh'),
    contextWindowTokens: 128_000,
    evictRatio: 0.95,
  })

  const repl = new Repl({
    input,
    output,
    session,
    skills: options.skills,
    mcpManager: options.mcpManager,
    loadRuntime: false,
    history: new QueryHistory(
      options.historyPath ?? tempHistoryFile(options.queries ?? []),
    ),
    logger: new Logger(join(mkdtempSync(join(tmpdir(), 'ask-repl-log-')), 'e.jsonl')),
    selector: options.selector,
    prefill: (text) => prefilled.push(text),
  })

  return {
    repl,
    prefilled,
    session,
    output: () => chunks.join(''),
  }
}

const pdfSkill: Skill = {
  name: 'pdf',
  description: 'Extract text from PDF files',
  body: '# PDF skill\n\nUse pdftotext.',
  directory: '/tmp/skills/pdf',
  source: 'user',
  files: ['SKILL.md', 'scripts/extract.sh'],
}

describe('Repl commands', () => {
  it('lists loaded skills with their source', async () => {
    const { repl, output } = createRepl({ skills: [pdfSkill] })

    await repl.handleLine('/skills')

    expect(output()).toContain('名称')
    expect(output()).toContain('pdf')
    expect(output()).toContain('user')
    expect(output()).toContain('Extract text from PDF files')
    repl.close()
  })

  it('loads a skill into the conversation manually', async () => {
    const { repl, session, output } = createRepl({ skills: [pdfSkill] })

    await repl.handleLine('/skill pdf')

    expect(output()).toContain('已加载技能: pdf')
    expect(
      session.getMessages().some((message) =>
        message.content?.includes('Use pdftotext.'),
      ),
    ).toBe(true)
    repl.close()
  })

  it('reports unknown skills and missing names', async () => {
    const { repl, output } = createRepl({ skills: [pdfSkill] })

    await repl.handleLine('/skill nope')
    expect(output()).toContain('未知技能: nope')

    await repl.handleLine('/skill')
    expect(output()).toContain('用法: /skill <name>')
    repl.close()
  })

  it('shows MCP server status', async () => {
    const manager = {
      statuses: () => [
        { name: 'mock', state: 'ready', toolCount: 2 },
        { name: 'bad', state: 'failed', toolCount: 0, error: 'boom' },
      ],
    } as unknown as McpManager
    const { repl, output } = createRepl({ mcpManager: manager })

    await repl.handleLine('/mcp')

    expect(output()).toContain('名称')
    expect(output()).toContain('mock')
    expect(output()).toContain('ready')
    expect(output()).toContain('2')
    expect(output()).toContain('bad')
    expect(output()).toContain('failed')
    expect(output()).toContain('boom')
    repl.close()
  })

  it('reports when no MCP servers are configured', async () => {
    const { repl, output } = createRepl({})

    await repl.handleLine('/mcp')

    expect(output()).toContain('未配置 MCP 服务器')
    repl.close()
  })
  it('fills the input with the selected history entry', async () => {
    let received: string[] = []
    const { repl, prefilled } = createRepl({
      queries: ['older question', 'newer question'],
      selector: {
        async select(choices) {
          received = choices
          return 'older question'
        },
      },
    })

    await repl.handleLine('/history')

    expect(received).toEqual(['newer question', 'older question'])
    expect(prefilled).toEqual(['older question'])
    repl.close()
  })

  it('leaves the input unchanged when history selection is cancelled', async () => {
    const { repl, prefilled } = createRepl({
      queries: ['question'],
      selector: { async select() { return null } },
    })

    await repl.handleLine('/history')

    expect(prefilled).toEqual([])
    repl.close()
  })

  it('clears the conversation context on /clear', async () => {
    const { repl, session } = createRepl({})
    session.addUser('previous')
    session.addAssistant('answer')

    await repl.handleLine('/clear')

    expect(session.isCleared).toBe(true)
    repl.close()
  })

  it('ignores blank lines and reports unknown slash commands', async () => {
    const { repl } = createRepl({})

    await expect(repl.handleLine('   ')).resolves.toBeUndefined()
    await expect(repl.handleLine('/nope')).resolves.toBeUndefined()
    repl.close()
  })

  it('does not print the welcome page when output is not a TTY', async () => {
    const input = new PassThrough()
    const chunks: string[] = []
    const output = {
      write: (text: string) => {
        chunks.push(text)
        return true
      },
    } as unknown as NodeJS.WritableStream

    const repl = new Repl({
      input,
      output,
      loadRuntime: false,
      history: new QueryHistory(tempHistoryFile([])),
      logger: new Logger(
        join(mkdtempSync(join(tmpdir(), 'ask-repl-log-')), 'e.jsonl'),
      ),
    })

    const done = repl.start()
    input.write('exit\n')
    await done

    const text = chunks.join('')
    expect(text).not.toContain('_    ____')
    expect(text).not.toContain('直接输入问题')
  })
})
