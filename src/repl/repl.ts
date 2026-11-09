import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { search } from '@inquirer/prompts'
import { AgentLoop } from '../agent/loop.js'
import { ConversationSession } from '../agent/session.js'
import {
  ConfigError,
  askHome,
  collectConfigWarnings,
  loadConfig,
  type AskConfig,
} from '../config/config.js'
import { OpenAiAdapter } from '../llm/openai.js'
import { Logger } from '../log/writer.js'
import { loadMcpConfig } from '../mcp/config.js'
import { McpManager } from '../mcp/manager.js'
import { createMcpTools } from '../mcp/tool.js'
import { messages, detectLanguage } from '../i18n.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { loadSkills, type Skill } from '../skills/loader.js'
import { createSkillTool } from '../skills/tool.js'
import { createBuiltinRegistry, ToolRegistry } from '../tools/registry.js'
import type { ToolDefinition } from '../tools/types.js'
import { VERSION } from '../version.js'
import { QueryHistory } from './history.js'
import { createPasteAwareInput, type PasteAwareInput } from './input.js'
import {
  createTurnRenderer,
  renderUserMessage,
  type TurnRenderer,
} from './render.js'
import { supportsColor, displayWidth } from './style.js'
import { renderWelcome } from './welcome.js'

export interface HistorySelector {
  select(choices: string[]): Promise<string | null>
}

function oneLineText(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) {
    return text
  }
  let result = ''
  for (const char of text) {
    if (displayWidth(`${result}${char}`) + 3 > width) {
      break
    }
    result += char
  }
  return `${result}...`
}

export function createHistorySelector(message: string): HistorySelector {
  return {
    async select(choices: string[]): Promise<string | null> {
      if (choices.length === 0) {
        return null
      }

      try {
        const chosen = await search({
          message,
          source: (term: string | undefined) => {
            const needle = term ?? ''
            return choices
              .filter((item) => needle === '' || item.includes(needle))
              .map((item) => ({ name: item, value: item }))
          },
        })
        return chosen ?? null
      } catch {
        return null
      }
    },
  }
}

export interface ReplOptions {
  initialQuery?: string
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  history?: QueryHistory
  selector?: HistorySelector
  session?: ConversationSession
  logger?: Logger
  cwd?: string
  prefill?: (text: string) => void
  color?: boolean
  language?: string
  skills?: Skill[]
  mcpManager?: McpManager
  loadRuntime?: boolean
}

export class Repl {
  private readonly rl: Interface
  private readonly out: (text: string) => void
  private readonly rawOut: (text: string) => void
  private readonly history: QueryHistory
  private readonly selector: HistorySelector
  private readonly session: ConversationSession
  private readonly logger: Logger
  private readonly cwd: string
  private readonly prefill: (text: string) => void
  private readonly initialQuery?: string
  private readonly color: boolean
  private readonly columns: () => number
  private readonly input: NodeJS.ReadableStream
  private readonly pasteInput: PasteAwareInput | null = null
  private readonly multilineBuffer: {
    flag: symbol
    refresh: () => void
  } | null = null
  private language: string
  private skills: Skill[] = []
  private registry: ToolRegistry = createBuiltinRegistry()
  private mcpManager: McpManager | null = null
  private mcpTools: ToolDefinition[] = []
  private toolCalls: Array<{ id: number; tool: string; label: string }> = []
  private toolCallSeq = 0
  private expanded = false
  private expandedRows = 0
  private expandedCallId: number | null = null
  private trailingNewlines = 0
  private contentSincePrompt = false
  private staged: string[] = []
  private readonly runtimeEnabled: boolean

  private busy = false
  private abortController: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly terminal: boolean
  private closed = false

  constructor(options: ReplOptions = {}) {
    const rawInput = options.input ?? process.stdin
    const output = options.output ?? process.stdout

    this.history = options.history ?? new QueryHistory()
    this.language = options.language ?? detectLanguage()
    this.skills = options.skills ?? []
    this.mcpManager = options.mcpManager ?? null
    this.runtimeEnabled = options.loadRuntime ?? true
    this.rebuildRegistry()
    this.selector =
      options.selector ??
      createHistorySelector(messages(this.language).repl.historyMessage)
    this.session =
      options.session ??
      new ConversationSession({
        systemPrompt: buildSystemPrompt(this.language),
        contextWindowTokens: 128_000,
        evictRatio: 0.95,
      })
    this.logger = options.logger ?? new Logger()
    this.cwd = options.cwd ?? process.cwd()
    this.initialQuery = options.initialQuery

    const outputStream = output as NodeJS.WriteStream
    this.columns = () => {
      const columns = outputStream.columns
      return typeof columns === 'number' && columns > 0 ? columns : 80
    }
    this.color = options.color ?? supportsColor(outputStream)
    this.out = (text: string) => {
      output.write(text)
      if (text.length === 0) {
        return
      }
      const trailing = text.match(/\n*$/)?.[0].length ?? 0
      this.trailingNewlines = trailing
      if (text.trim() !== '') {
        this.contentSincePrompt = true
      }
    }
    this.rawOut = (text: string) => {
      output.write(text)
    }

    const terminal = (output as { isTTY?: boolean }).isTTY === true
    this.terminal = terminal

    let input = rawInput
    if (terminal && (rawInput as { isTTY?: boolean }).isTTY === true) {
      const pasteInput = createPasteAwareInput({
        source: rawInput,
        onPaste: (text) => this.handlePaste(text),
      })
      input = pasteInput
      this.pasteInput = pasteInput
    }
    this.input = input

    this.rl = createInterface({
      input,
      output,
      terminal,
      history: [...this.history.strings()].reverse(),
      historySize: 2_000,
      prompt: 'ask> ',
    })

    const multilineFlag = Object.getOwnPropertySymbols(this.rl).find(
      (symbol) => symbol.description === '_isMultiline',
    )
    const refreshLine = (
      this.rl as unknown as { _refreshLine?: unknown }
    )._refreshLine
    if (multilineFlag && typeof refreshLine === 'function') {
      this.multilineBuffer = {
        flag: multilineFlag,
        refresh: refreshLine as () => void,
      }
    }

    this.prefill =
      options.prefill ??
      ((text: string) => {
        if (this.insertIntoInput(text)) {
          return
        }
        if (!text.includes('\n')) {
          this.rl.write(text)
          return
        }
        this.handlePaste(text)
      })

    this.rl.once('close', () => {
      this.closed = true
      this.disableBracketedPaste()
    })

    if (terminal) {
      this.rl.on('SIGINT', this.onSigint)
    } else {
      process.on('SIGINT', this.onSigint)
      this.rl.once('close', () => {
        process.removeListener('SIGINT', this.onSigint)
      })
    }
  }

  private readonly onSigint = (): void => {
    if (this.busy && this.abortController) {
      this.abortController.abort()
      this.out(`\n${messages(this.language).repl.aborted}\n`)
      return
    }
    this.rl.close()
  }

  close(): void {
    this.rl.close()
    void this.shutdownMcp()
  }

  private safePrompt(): void {
    if (this.closed) {
      return
    }
    if (
      this.terminal &&
      this.contentSincePrompt &&
      this.trailingNewlines < 2
    ) {
      this.out('\n')
    }
    try {
      this.rl.prompt()
      this.contentSincePrompt = false
      this.trailingNewlines = 0
    } catch {
      this.closed = true
    }
  }

  private enableBracketedPaste(): void {
    if (this.pasteInput) {
      this.rawOut('\x1b[?2004h')
    }
  }

  private disableBracketedPaste(): void {
    if (!this.pasteInput) {
      return
    }
    this.rawOut('\x1b[?2004l')
    this.pasteInput.dispose?.()
  }

  /**
   * Inserts pasted text into the readline buffer without submitting it, keeping
   * embedded line breaks. Falls back to staging for Node versions whose
   * readline does not support multi-line editing.
   */
  private handlePaste(text: string): void {
    if (this.closed) {
      return
    }

    if (this.insertIntoInput(text)) {
      return
    }

    if (text === '\n') {
      return
    }

    this.staged.push(text)
    const lines = text.split('\n').length
    this.out(`${messages(this.language).repl.pasteStaged(lines)}\n`)
    this.safePrompt()
  }

  private insertIntoInput(text: string): boolean {
    if (!this.multilineBuffer) {
      return false
    }

    const rl = this.rl as unknown as { line: string; cursor: number }
    const before = rl.line.slice(0, rl.cursor)
    const after = rl.line.slice(rl.cursor)
    const next = `${before}${text}${after}`
    rl.line = next
    rl.cursor = before.length + text.length
    ;(this.rl as unknown as Record<symbol, unknown>)[
      this.multilineBuffer.flag
    ] = next.includes('\n')
    this.multilineBuffer.refresh.call(this.rl)
    return true
  }

  private async flushStaged(): Promise<void> {
    if (this.staged.length === 0) {
      return
    }
    const query = this.staged.join('\n').trim()
    this.staged = []
    if (query === '') {
      return
    }
    await this.runQuery(query, { echoed: true, inputLineErased: true })
  }

  async start(): Promise<number> {
    const closed = new Promise<number>((resolve) => {
      this.rl.once('close', () => {
        void this.queue.finally(() => resolve(0))
      })
    })

    this.rl.once('close', () => {
      void this.queue.finally(() => this.shutdownMcp())
    })

    this.rl.on('line', (line: string) => {
      this.queue = this.queue
        .then(() => this.handleLine(line))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.out(
            `\n${messages(this.language).repl.errorPrefix} ${message}\n`,
          )
          this.safePrompt()
        })
    })

    if (this.terminal) {
      this.enableBracketedPaste()
      this.input.on(
        'keypress',
        (
          _char: string,
          key: { ctrl?: boolean; name?: string; sequence?: string },
        ) => {
          const isCtrlE =
            key?.sequence === '\x05' ||
            (key?.ctrl === true && key.name === 'e')
          if (isCtrlE && !this.busy && this.rl.line === '') {
            this.toggleExpanded(false)
            this.safePrompt()
          }
        },
      )

      this.showWelcome()
    }

    if (this.runtimeEnabled) {
      void this.loadSkillsRuntime()
      void this.loadMcpRuntime()
    }

    if (this.initialQuery && this.initialQuery.trim() !== '') {
      await this.runQuery(this.initialQuery.trim())
    }

    if (this.closed) {
      await this.queue
      await this.shutdownMcp()
      return closed
    }

    this.safePrompt()
    return closed
  }

  private async loadSkillsRuntime(): Promise<void> {
    try {
      const config = loadConfig()
      const result = loadSkills({
        cwd: this.cwd,
        enabled: config.skills.enabled,
        project: config.skills.project,
      })
      for (const warning of result.warnings) {
        this.logger.write({ kind: 'config_error', message: warning })
      }
      this.skills = result.skills
      this.rebuildRegistry()
    } catch (error) {
      this.logger.write({
        kind: 'config_error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async loadMcpRuntime(): Promise<void> {
    try {
      const config = loadConfig()
      const mcpConfig = loadMcpConfig({
        cwd: this.cwd,
        enabled: config.mcp.enabled,
      })
      for (const warning of mcpConfig.warnings) {
        this.logger.write({ kind: 'config_error', message: warning })
      }

      if (Object.keys(mcpConfig.servers).length === 0) {
        return
      }

      const manager = new McpManager({
        servers: mcpConfig.servers,
        cwd: this.cwd,
        startupTimeoutMs: 10_000,
      })
      this.mcpManager = manager
      await manager.start()

      if (this.closed || this.mcpManager !== manager) {
        await manager.close()
        this.mcpManager = null
        return
      }

      for (const status of manager.statuses()) {
        if (status.state === 'failed') {
          this.logger.write({
            kind: 'config_error',
            message: `MCP ${status.name}: ${status.error ?? 'failed'}`,
          })
        }
      }

      if (this.closed) {
        await manager.close()
        this.mcpManager = null
        return
      }

      const toolsResult = createMcpTools({
        manager,
        servers: mcpConfig.servers,
        maxTools: config.mcp.maxTools,
        artifactDir: join(askHome(), 'mcp-artifacts'),
        maxOutputBytes: config.max_output_bytes,
      })
      for (const warning of toolsResult.warnings) {
        this.logger.write({ kind: 'config_error', message: warning })
      }
      this.mcpTools = toolsResult.tools
      this.rebuildRegistry()
    } catch (error) {
      this.logger.write({
        kind: 'config_error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private rebuildRegistry(): void {
    this.registry = createBuiltinRegistry()
    if (this.skills.length > 0) {
      this.registry.register(createSkillTool(this.skills))
    }
    for (const tool of this.mcpTools) {
      try {
        this.registry.register(tool)
      } catch {
        // 同名工具已在注册表中
      }
    }
  }

  private async shutdownMcp(): Promise<void> {
    if (!this.mcpManager) {
      return
    }
    try {
      await this.mcpManager.close()
    } catch {
      // 关闭失败不影响退出
    }
    this.mcpManager = null
  }

  private eraseEchoedInput(line: string): void {
    if (!this.terminal || !this.color) {
      return
    }

    const columns = this.columns()
    const lines = line.split('\n')
    let rows = 0
    for (let index = 0; index < lines.length; index += 1) {
      const prefix = index === 0 ? 'ask> ' : '| '
      rows += Math.max(
        1,
        Math.ceil(displayWidth(`${prefix}${lines[index]}`) / columns),
      )
    }

    let sequence = ''
    for (let index = 0; index < rows; index += 1) {
      sequence += '\x1b[1A\r\x1b[2K'
    }
    this.out(sequence)
  }

  private showWelcome(): void {
    let model = messages(this.language).welcome.unconfiguredModel
    let baseUrl = ''

    try {
      const config = loadConfig()
      model = config.model
      baseUrl = config.base_url
      this.language = config.language
    } catch {
      // 配置问题会在首次提问时给出更完整的提示
    }

    this.out(
      renderWelcome(
        {
          version: VERSION,
          model,
          baseUrl,
          cwd: this.cwd,
          skills: this.skills.length,
          mcpServers: (this.mcpManager?.statuses() ?? []).filter(
            (status) => status.state === 'ready',
          ).length,
          mcpTools: this.mcpTools.length,
        },
        { color: this.color, language: this.language },
      ),
    )
  }

  async handleLine(raw: string): Promise<void> {
    const line = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    let inputLineErased = false

    if (line !== '' && !line.startsWith('/expand') && this.expanded) {
      this.collapseExpanded(true)
      inputLineErased = true
    }

    if (line === '') {
      await this.flushStaged()
      this.safePrompt()
      return
    }

    if (line === 'exit') {
      this.rl.close()
      return
    }

    if (line === '/expand' || line.startsWith('/expand ')) {
      this.handleExpandCommand(line)
      this.safePrompt()
      return
    }

    if (line === '/clear') {
      this.session.clear()
      this.out(`${messages(this.language).repl.contextCleared}\n`)
      this.safePrompt()
      return
    }

    if (line === '/history') {
      await this.showHistory()
      return
    }

    if (line === '/skills') {
      this.showSkills()
      return
    }

    if (line === '/mcp') {
      this.showMcp()
      return
    }

    if (line === '/skill') {
      this.out(`${messages(this.language).repl.skillUsage}\n`)
      this.safePrompt()
      return
    }

    if (line.startsWith('/skill ')) {
      this.loadSkill(line.slice('/skill '.length).trim())
      return
    }

    if (line.startsWith('/')) {
      this.out(`${messages(this.language).repl.unknownCommand(line)}\n`)
      this.safePrompt()
      return
    }

    let query = line
    if (this.staged.length > 0) {
      const staged = this.staged.join('\n')
      this.staged = []
      query = `${staged}\n${line}`
    }

    await this.runQuery(query, { echoed: true, inputLineErased })
    this.safePrompt()
  }

  private toggleExpanded(includeInputLine: boolean): void {
    if (this.expanded) {
      this.collapseExpanded(includeInputLine)
      return
    }
    const last = this.toolCalls[this.toolCalls.length - 1]
    if (last) {
      this.printExpanded(last)
    }
  }

  private handleExpandCommand(line: string): void {
    const args = line.slice('/expand'.length).trim()

    if (args === '') {
      this.toggleExpanded(true)
      return
    }

    if (args === 'list' || args === '?') {
      this.showToolCallList()
      return
    }

    if (!/^\d+$/.test(args)) {
      this.out(`${messages(this.language).repl.expandUsage}\n`)
      return
    }

    const id = Number(args)
    const record = this.toolCalls.find((item) => item.id === id)
    if (!record) {
      this.out(`${messages(this.language).repl.expandNotFound(id)}\n`)
      return
    }

    if (this.expanded) {
      this.collapseExpanded(true)
    }
    this.printExpanded(record)
  }

  private showToolCallList(): void {
    if (this.expanded) {
      this.collapseExpanded(true)
    }

    if (this.toolCalls.length === 0) {
      this.out(`${messages(this.language).repl.expandNoCalls}\n`)
      return
    }

    const columns = this.columns()
    for (const record of this.toolCalls) {
      const prefix = `#${record.id}  ${record.tool}  `
      const preview = truncateToWidth(
        oneLineText(record.label),
        Math.max(20, columns - displayWidth(prefix)),
      )
      this.out(`${prefix}${preview}\n`)
    }
  }

  private printExpanded(call: {
    id: number
    tool: string
    label: string
  }): void {
    const text =
      call.tool === 'bash'
        ? `$ ${call.label}`
        : `● ${call.tool}(${call.label})`

    if (!this.terminal) {
      this.out(`${text}\n`)
      return
    }

    this.out('\r\x1b[2K')
    const columns = this.columns()
    let rows = 1
    this.out('[expanded]\n')

    const lines = text.split('\n')
    const maxLines = 100
    for (const line of lines.slice(0, maxLines)) {
      const rendered = `  ${line}`
      this.out(`${rendered}\n`)
      rows += Math.max(1, Math.ceil(displayWidth(rendered) / columns))
    }
    if (lines.length > maxLines) {
      this.out(`  ... (${lines.length - maxLines} more lines)\n`)
      rows += 1
    }

    this.expandedRows = rows
    this.expanded = true
    this.expandedCallId = call.id
  }

  private collapseExpanded(includeInputLine: boolean): void {
    if (!this.expanded) {
      return
    }

    this.out('\r\x1b[2K')
    if (includeInputLine) {
      this.out('\x1b[1A\r\x1b[2K')
    }
    for (let index = 0; index < this.expandedRows; index += 1) {
      this.out('\x1b[1A\r\x1b[2K')
    }

    this.expanded = false
    this.expandedRows = 0
    this.expandedCallId = null
  }

  private showMcp(): void {
    const statuses = this.mcpManager?.statuses() ?? []
    if (statuses.length === 0) {
      this.out(`${messages(this.language).repl.mcpNoServers}\n`)
      this.safePrompt()
      return
    }

    const headers = messages(this.language).repl.mcpTable
    const nameWidth = Math.max(
      displayWidth(headers.name),
      ...statuses.map((status) => displayWidth(status.name)),
    )
    const stateWidth = Math.max(
      displayWidth(headers.state),
      ...statuses.map((status) => displayWidth(status.state)),
    )
    const toolsWidth = Math.max(
      displayWidth(headers.tools),
      ...statuses.map((status) => String(status.toolCount).length),
    )
    const errorWidth = Math.max(
      20,
      this.columns() - nameWidth - stateWidth - toolsWidth - 6,
    )

    const pad = (text: string, width: number): string =>
      `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`

    this.out(
      `${pad(headers.name, nameWidth)}  ${pad(
        headers.state,
        stateWidth,
      )}  ${pad(headers.tools, toolsWidth)}  ${headers.error}\n`,
    )

    for (const status of statuses) {
      this.out(
        `${pad(status.name, nameWidth)}  ${pad(
          status.state,
          stateWidth,
        )}  ${pad(String(status.toolCount), toolsWidth)}  ${truncateToWidth(
          oneLineText(status.error ?? ''),
          errorWidth,
        )}\n`,
      )
    }

    this.safePrompt()
  }

  private showSkills(): void {
    if (this.skills.length === 0) {
      this.out(`${messages(this.language).repl.skillsEmpty}\n`)
      this.safePrompt()
      return
    }

    const headers = messages(this.language).repl.skillTable
    const nameWidth = Math.max(
      displayWidth(headers.name),
      ...this.skills.map((skill) => displayWidth(skill.name)),
    )
    const sourceWidth = Math.max(
      displayWidth(headers.source),
      ...this.skills.map((skill) => displayWidth(skill.source)),
    )
    const descriptionWidth = Math.max(
      20,
      this.columns() - nameWidth - sourceWidth - 4,
    )

    const pad = (text: string, width: number): string =>
      `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`

    const truncate = (text: string, width: number): string => {
      if (displayWidth(text) <= width) {
        return text
      }
      let result = ''
      for (const char of text) {
        if (displayWidth(result + char) + 3 > width) {
          break
        }
        result += char
      }
      return `${result}...`
    }

    this.out(
      `${pad(headers.name, nameWidth)}  ${pad(
        headers.source,
        sourceWidth,
      )}  ${headers.description}\n`,
    )
    for (const skill of this.skills) {
      this.out(
        `${pad(skill.name, nameWidth)}  ${pad(
          skill.source,
          sourceWidth,
        )}  ${truncate(skill.description, descriptionWidth)}\n`,
      )
    }
    this.safePrompt()
  }

  private loadSkill(name: string): void {
    if (name === '') {
      this.out(`${messages(this.language).repl.skillUsage}\n`)
      this.safePrompt()
      return
    }

    const skill = this.skills.find((item) => item.name === name)
    if (!skill) {
      this.out(`${messages(this.language).repl.skillNotFound(name)}\n`)
      this.safePrompt()
      return
    }

    const files = skill.files.length === 0 ? '(none)' : skill.files.join(', ')
    this.session.addUser(
      [
        `[skill: ${skill.name}]`,
        `Directory: ${skill.directory}`,
        `Files: ${files}`,
        '---',
        skill.body,
      ].join('\n'),
    )
    this.out(
      `${messages(this.language).repl.skillLoaded(name)} (${skill.body.length} chars)\n`,
    )
    this.safePrompt()
  }

  private async showHistory(): Promise<void> {
    const choices = this.history
      .getEntries()
      .map((entry) => entry.q)
      .reverse()

    if (choices.length === 0) {
      this.out(`${messages(this.language).repl.emptyHistory}\n`)
      this.safePrompt()
      return
    }

    this.rl.pause()
    this.pasteInput?.suspendSource?.()
    let chosen: string | null = null
    try {
      chosen = await this.selector.select(choices)
    } finally {
      this.pasteInput?.resumeSource?.()
      try {
        this.pasteInput?.setRawMode?.(true)
      } catch {
        // 输入流可能已关闭
      }
      this.rl.resume()
    }

    this.safePrompt()
    if (chosen && !this.closed) {
      this.prefill(chosen)
    }
  }

  private async runQuery(
    query: string,
    options: { echoed?: boolean; inputLineErased?: boolean } = {},
  ): Promise<void> {
    this.history.append(query)
    if (options.echoed && options.inputLineErased !== true) {
      this.eraseEchoedInput(query)
    }
    renderUserMessage(query, this.out, {
      color: this.color,
      columns: this.columns,
    })

    let config: AskConfig
    try {
      config = loadConfig()
    } catch (error) {
      this.reportConfigError(error)
      return
    }

    for (const warning of collectConfigWarnings(config)) {
      this.out(`${messages(this.language).repl.warningPrefix}${warning}\n`)
    }

    this.session.setLimits(
      config.context_window_tokens,
      config.context_evict_ratio,
    )

    const controller = new AbortController()
    this.abortController = controller
    this.busy = true
    this.language = config.language
    this.session.setSystemPrompt(
      buildSystemPrompt(config.language, this.skills),
    )
    let renderer: TurnRenderer | undefined

    try {
      const adapter = this.createAdapter(config)
      if (!adapter) {
        return
      }

      const loop = new AgentLoop({
        llm: adapter,
        session: this.session,
        registry: this.registry,
        toolContext: {
          cwd: this.cwd,
          timeoutMs: config.command_timeout_ms,
          maxOutputBytes: config.max_output_bytes,
          logger: this.logger,
        },
        maxSteps: config.max_steps,
      })

      renderer = createTurnRenderer(this.out, {
        isTTY: this.terminal,
        color: this.color,
        columns: this.columns,
        language: this.language,
      })
      for await (const event of loop.run(query, controller.signal)) {
        if (
          event.type === 'tool_call' &&
          event.displayKind !== 'file'
        ) {
          this.toolCallSeq += 1
          this.toolCalls.push({
            id: this.toolCallSeq,
            tool: event.tool,
            label: event.label,
          })
          if (this.toolCalls.length > 100) {
            this.toolCalls.shift()
          }
        }
        renderer.handle(event)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.out(`\n[错误] ${message}\n`)
    } finally {
      renderer?.dispose()
      this.busy = false
      this.abortController = null
    }
  }

  private createAdapter(config: AskConfig): OpenAiAdapter | null {
    try {
      return new OpenAiAdapter({
        config,
        onError: (error: Error) => {
          this.logger.write({
            kind: 'llm_error',
            message: error.message,
            stack: error.stack ?? null,
          })
        },
      })
    } catch (error) {
      this.reportConfigError(error)
      return null
    }
  }

  private reportConfigError(error: unknown): void {
    if (error instanceof ConfigError) {
      this.out(`${error.message}\n`)
      this.logger.write({
        kind: 'config_error',
        message: error.message,
      })
      return
    }

    throw error
  }
}
