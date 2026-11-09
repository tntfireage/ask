import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'
import {
  ensureConfigTemplate,
  pickEditor,
  runModelCommand,
} from '../src/config/model.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ask-model-'))
}

function fakeEditor(dir: string): { editor: string; marker: string } {
  const marker = join(dir, 'editor-args.txt')
  const editor = join(dir, 'fake-editor.sh')
  writeFileSync(editor, `#!/bin/sh\necho "$1" > "${marker}"\n`, 'utf8')
  chmodSync(editor, 0o755)
  return { editor, marker }
}

describe('ask model', () => {
  it('creates a template that parses with defaults, then opens the editor', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    const { editor, marker } = fakeEditor(dir)
    const messages: string[] = []

    const code = runModelCommand({
      path,
      env: { ...process.env, ASK_EDITOR: editor } as NodeJS.ProcessEnv,
      out: (text) => messages.push(text),
      err: (text) => messages.push(text),
    })

    expect(code).toBe(0)
    expect(existsSync(path)).toBe(true)
    expect(loadConfig(path).max_steps).toBe(12)
    expect(readFileSync(marker, 'utf8').trim()).toBe(path)
    expect(messages.join('')).toContain('已创建配置模板')
  })

  it('does not overwrite an existing config', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    writeFileSync(path, '{"model":"custom"}\n', 'utf8')
    const { editor } = fakeEditor(dir)

    const code = runModelCommand({
      path,
      env: { ...process.env, ASK_EDITOR: editor } as NodeJS.ProcessEnv,
      out: () => {},
      err: () => {},
    })

    expect(code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('{"model":"custom"}\n')
  })

  it('ensureConfigTemplate reports whether it created the file', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    expect(ensureConfigTemplate(path)).toBe(true)
    expect(ensureConfigTemplate(path)).toBe(false)
  })

  it('returns non-zero when the editor cannot start', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    const errors: string[] = []

    const code = runModelCommand({
      path,
      env: {
        ...process.env,
        ASK_EDITOR: join(dir, 'does-not-exist'),
      } as NodeJS.ProcessEnv,
      out: () => {},
      err: (text) => errors.push(text),
    })

    expect(code).not.toBe(0)
    expect(errors.join('')).toMatch(/无法启动编辑器/)
  })

  it('uses system open on macOS and honors ASK_EDITOR overrides', () => {
    const env = { PATH: process.env.PATH } as NodeJS.ProcessEnv

    expect(pickEditor(env, 'darwin')).toBe('open')
    expect(pickEditor({ ...env, ASK_EDITOR: 'nano' }, 'darwin')).toBe('nano')
    expect(pickEditor({ ...env, EDITOR: 'ed' }, 'linux')).toBe('ed')
  })

  it('localizes model command output', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    const { editor } = fakeEditor(dir)
    const messages: string[] = []

    const code = runModelCommand({
      path,
      language: 'en',
      env: { ...process.env, ASK_EDITOR: editor } as NodeJS.ProcessEnv,
      out: (text) => messages.push(text),
      err: (text) => messages.push(text),
    })

    expect(code).toBe(0)
    expect(messages.join('')).toContain('Created config template')
    expect(messages.join('')).toContain('Opening config')
  })
})
