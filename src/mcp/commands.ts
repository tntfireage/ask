import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pickEditor } from '../config/model.js'
import { messages } from '../i18n.js'
import { defaultMcpConfigJson, mcpConfigPath } from './config.js'

export interface McpCommandOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  out?: (text: string) => void
  err?: (text: string) => void
  language?: string
}

function ensureTemplate(path: string): boolean {
  if (existsSync(path)) {
    return false
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, defaultMcpConfigJson(), { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // 权限收紧失败不影响可用性
  }
  return true
}

export function runMcpCommand(options: McpCommandOptions = {}): number {
  const path = options.path ?? mcpConfigPath()
  const env = options.env ?? process.env
  const out = options.out ?? ((text: string) => process.stdout.write(text))
  const err = options.err ?? ((text: string) => process.stderr.write(text))
  const text = messages(options.language ?? 'zh').mcp

  let created = false
  try {
    created = ensureTemplate(path)
  } catch (error) {
    err(`${text.createFailed(path, (error as Error).message)}\n`)
    return 1
  }

  if (created) {
    out(`${text.createdTemplate(path)}\n`)
  }
  out(`${text.opening(path)}\n`)

  const editor = pickEditor(env)
  const result = spawnSync(editor, [path], {
    env,
    stdio: 'inherit',
    shell: editor.includes(' '),
  })

  if (result.error) {
    err(`${text.editorFailed(editor, result.error.message)}\n`)
    return 1
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    err(`${text.editorExit(editor, result.status)}\n`)
    return result.status
  }

  return 0
}