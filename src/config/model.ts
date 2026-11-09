import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { messages } from '../i18n.js'
import { configPath, defaultConfigJson } from './config.js'

export interface ModelCommandOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  out?: (text: string) => void
  err?: (text: string) => void
  language?: string
}

export function ensureConfigTemplate(
  path: string = configPath(),
  content: string = defaultConfigJson(),
): boolean {
  if (existsSync(path)) {
    return false
  }

  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })

  try {
    chmodSync(dir, 0o700)
    chmodSync(path, 0o600)
  } catch {
    // 权限收紧失败不影响可用性
  }

  return true
}

function commandExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync('which', [name], { env, stdio: 'ignore' })
  return result.status === 0
}

export function pickEditor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.ASK_EDITOR?.trim()
  if (override) {
    return override
  }

  if (platform === 'darwin' && commandExists('open', env)) {
    return 'open'
  }

  const explicit = env.EDITOR?.trim() || env.VISUAL?.trim()
  if (explicit) {
    return explicit
  }

  for (const candidate of ['nano', 'vi', 'vim']) {
    if (commandExists(candidate, env)) {
      return candidate
    }
  }

  return 'vi'
}

export function runModelCommand(options: ModelCommandOptions = {}): number {
  const path = options.path ?? configPath()
  const env = options.env ?? process.env
  const out = options.out ?? ((text: string) => process.stdout.write(text))
  const err = options.err ?? ((text: string) => process.stderr.write(text))
  const text = messages(options.language ?? 'zh').model

  let created = false
  try {
    created = ensureConfigTemplate(path)
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
