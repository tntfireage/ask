import type { AgentEvent } from '../agent/types.js'
import { messages } from '../i18n.js'
import type { DiffLine } from '../tools/files.js'
import { BG_QUESTION, FG_QUESTION, displayWidth, padTo } from './style.js'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const BLUE = '\x1b[94m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const SPINNER = ['|', '/', '-', '\\']

export interface RendererOptions {
  isTTY?: boolean
  color?: boolean
  columns?: () => number
  now?: () => number
  language?: string
}

export interface TurnRenderer {
  handle(event: AgentEvent): void
  dispose(): void
  readonly hadText: boolean
}

export function renderUserMessage(
  text: string,
  out: (text: string) => void,
  options: RendererOptions = {},
): void {
  if (!options.color) {
    return
  }

  const columns = (options.columns ?? (() => 80))()
  for (const line of text.split('\n')) {
    out(
      `\x1b[48;5;${BG_QUESTION}m\x1b[38;5;${FG_QUESTION}m${padTo(
        ` ask > ${line}`,
        columns,
      )}${RESET}\n`,
    )
  }
}

class StatusLine {
  private timer: NodeJS.Timeout | null = null
  private frame = 0
  private label = ''
  private startedAt = 0

  constructor(
    private readonly out: (text: string) => void,
    private readonly enabled: boolean,
    private readonly now: () => number,
  ) {}

  start(label: string): void {
    if (!this.enabled) {
      return
    }

    this.stop()
    this.label = label
    this.startedAt = this.now()
    this.render()

    this.timer = setInterval(() => this.render(), 120)
    this.timer.unref?.()
  }

  private render(): void {
    const seconds = Math.floor((this.now() - this.startedAt) / 1000)
    this.out(`\r\x1b[2K${SPINNER[this.frame++ % SPINNER.length]} ${this.label} ${seconds}s`)
  }

  stop(): void {
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = null
    this.out('\r\x1b[2K')
  }
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

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function renderDiffLines(
  out: (text: string) => void,
  color: boolean,
  diff: DiffLine[],
): void {
  const hasOld = diff.some((line) => line.oldLine !== undefined)
  const hasNew = diff.some((line) => line.newLine !== undefined)
  const maxOld = Math.max(0, ...diff.map((line) => line.oldLine ?? 0))
  const maxNew = Math.max(0, ...diff.map((line) => line.newLine ?? 0))
  const oldWidth = hasOld ? String(maxOld).length : 0
  const newWidth = hasNew ? String(maxNew).length : 0

  for (const line of diff) {
    const oldNumber = hasOld
      ? (line.oldLine !== undefined ? String(line.oldLine) : '').padStart(
          oldWidth,
        )
      : null
    const newNumber = hasNew
      ? (line.newLine !== undefined ? String(line.newLine) : '').padStart(
          newWidth,
        )
      : null
    const columns = [oldNumber, newNumber]
      .filter((value): value is string => value !== null)
      .join(' ')
    const gutter = columns === '' ? '' : `${columns} `
    const marker = line.kind === ' ' ? ' ' : line.kind
    const code = line.kind === '-' ? RED : line.kind === '+' ? GREEN : DIM

    out(
      `${color ? DIM : ''}${gutter}${color ? RESET : ''}${color ? code : ''}| ${marker} ${line.text}${color ? RESET : ''}\n`,
    )
  }
}

export function createTurnRenderer(
  out: (text: string) => void,
  options: RendererOptions = {},
): TurnRenderer {
  const isTTY = options.isTTY ?? false
  const color = options.color ?? false
  const columns = options.columns ?? (() => process.stdout.columns || 80)
  const now = options.now ?? Date.now
  const ui = messages(options.language ?? 'zh')
  const status = new StatusLine(out, isTTY, now)

  let hadText = false
  let lastChar = ''
  let segmentStarted = false

  return {
    get hadText(): boolean {
      return hadText
    },

    handle(event: AgentEvent): void {
      switch (event.type) {
        case 'thinking':
          status.start(ui.status.thinking)
          break
        case 'text':
          status.stop()
          if (event.delta !== '') {
            if (!segmentStarted) {
              out('\n')
              segmentStarted = true
            }
            hadText = true
            out(event.delta)
            lastChar = event.delta[event.delta.length - 1]
          }
          break
        case 'tool_call':
          status.stop()
          if (event.displayKind === 'command') {
            const label = truncateToWidth(
              oneLine(event.label),
              Math.max(10, columns() - 2),
            )
            out(`\n${color ? CYAN : ''}$ ${label}${color ? RESET : ''}\n`)
          } else if (event.displayKind === 'generic') {
            const prefix = `● ${event.tool}(`
            const available = Math.max(
              10,
              columns() - displayWidth(prefix) - 1,
            )
            const label = truncateToWidth(oneLine(event.label), available)
            out(
              `\n${color ? `${BOLD}${BLUE}` : ''}${prefix}${label})${color ? RESET : ''}\n`,
            )
          }
          status.start(ui.status.running)
          segmentStarted = false
          break
        case 'tool_result': {
          status.stop()
          const display = event.display

          if (display?.kind === 'command') {
            const resultStatus =
              display.exitCode === null
                ? 'signal'
                : `exit ${display.exitCode}`
            const truncated = display.truncated
              ? ` · ${ui.status.truncated}`
              : ''
            out(
              `${color ? DIM : ''}  -> ${resultStatus} · ${display.durationMs}ms${truncated}${color ? RESET : ''}\n`,
            )
          } else if (display?.kind === 'file') {
            const suffix =
              display.tool === 'write_file'
                ? display.created
                  ? ' (新建)'
                  : ' (覆盖)'
                : ''
            out(
              `\n${color ? `${BOLD}${BLUE}` : ''}● ${display.tool}(${display.path})${suffix}${color ? RESET : ''}\n`,
            )
            if (event.ok) {
              renderDiffLines(out, color, display.diff)
            } else {
              out(`${color ? RED : ''}  ${event.summary}${color ? RESET : ''}\n`)
            }
          } else {
            const statusText = event.ok ? 'ok' : 'error'
            const summary = event.summary === '' ? '' : ` · ${event.summary}`
            out(
              `${color ? DIM : ''}  -> ${statusText} · ${event.durationMs}ms${summary}${color ? RESET : ''}\n`,
            )
          }

          segmentStarted = false
          break
        }
        case 'final':
          status.stop()
          if (hadText) {
            out(lastChar === '\n' ? '\n' : '\n\n')
          } else {
            const markdown = event.markdown
            out(
              `\n${markdown}${markdown.endsWith('\n') ? '\n' : '\n\n'}`,
            )
          }
          break
        case 'error':
          status.stop()
          if (event.kind !== 'aborted') {
            out(
              `\n${color ? RED : ''}${ui.labels.error} ${event.message}${color ? RESET : ''}\n`,
            )
          }
          break
      }
    },

    dispose(): void {
      status.stop()
    },
  }
}
