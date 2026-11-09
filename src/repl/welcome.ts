import { homedir } from 'node:os'
import { sep } from 'node:path'
import { messages } from '../i18n.js'

export const ASK_LOGO = [
  '    _      ____    _  __',
  '   / \\    / ___|  | |/ /',
  "  / _ \\   \\___ \\  | ' /",
  ' / ___ \\   ___) |  | . \\',
  '/_/   \\_\\  |____/  |_|\\_\\',
].join('\n')

export interface WelcomeInfo {
  version: string
  model: string
  baseUrl: string
  cwd: string
  home?: string
  skills?: number
  mcpServers?: number
  mcpTools?: number
}

export interface WelcomeOptions {
  color?: boolean
  language?: string
}

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const BLUE = '\x1b[94m'
const WHITE = '\x1b[97m'
const GRAY = '\x1b[90m'

function displayPath(cwd: string, home: string): string {
  if (cwd === home) {
    return '~'
  }
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

function displayHost(baseUrl: string): string {
  if (baseUrl.trim() === '') {
    return '-'
  }
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function renderWelcome(
  info: WelcomeInfo,
  options: WelcomeOptions = {},
): string {
  const color = options.color === true
  const language = options.language ?? 'zh'
  const text = messages(language).welcome
  const paint = (codes: string, value: string): string =>
    color ? `${codes}${value}${RESET}` : value

  const lines = [
    paint(`${BOLD}${BLUE}`, ASK_LOGO),
    '',
    `  ${paint(`${BOLD}${WHITE}`, `ask v${info.version}`)}`,
    '',
    `  ${paint(WHITE, text.tagline)}`,
    '',
    `  ${paint(GRAY, 'model')}   ${paint(WHITE, info.model)}`,
    `  ${paint(GRAY, 'api')}     ${paint(WHITE, displayHost(info.baseUrl))}`,
    `  ${paint(GRAY, 'cwd')}     ${paint(
      WHITE,
      displayPath(info.cwd, info.home ?? homedir()),
    )}`,
    ...(info.skills && info.skills > 0
      ? [`  ${paint(GRAY, 'skills')}  ${paint(WHITE, String(info.skills))}`]
      : []),
    ...(info.mcpServers && info.mcpServers > 0
      ? [
          `  ${paint(GRAY, 'mcp')}     ${paint(
            WHITE,
            `${info.mcpServers} servers · ${info.mcpTools ?? 0} tools`,
          )}`,
        ]
      : []),
    '',
    `  ${paint(DIM, text.intro)}`,
    `  ${paint(BLUE, '/history')} ${paint(DIM, text.historyHint)}   ${paint(
      BLUE,
      '/skills',
    )} ${paint(DIM, text.skillsHint)}   ${paint(
      BLUE,
      '/skill <name>',
    )} ${paint(DIM, text.skillHint)}   ${paint(BLUE, '/mcp')} ${paint(
      DIM,
      text.mcpHint,
    )}`,
    `  ${paint(BLUE, '/clear')} ${paint(DIM, text.clearHint)}   ${paint(
      BLUE,
      '/expand',
    )} ${paint(DIM, text.expandHint)}   ${paint(BLUE, 'exit')} ${paint(
      DIM,
      text.exitHint,
    )}`,
    '',
    '',
  ]

  return lines.join('\n')
}
