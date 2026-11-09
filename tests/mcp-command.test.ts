import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMcpCommand } from '../src/mcp/commands.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ask-mcp-command-'))
}

function fakeEditor(dir: string): { editor: string; marker: string } {
  const marker = join(dir, 'editor-args.txt')
  const editor = join(dir, 'fake-editor.sh')
  writeFileSync(editor, `#!/bin/sh\necho "$1" > "${marker}"\n`, 'utf8')
  chmodSync(editor, 0o755)
  return { editor, marker }
}

describe('ask mcp', () => {
  it('creates a template and opens it', () => {
    const dir = tempDir()
    const path = join(dir, 'mcp.json')
    const { editor, marker } = fakeEditor(dir)
    const messages: string[] = []

    const code = runMcpCommand({
      path,
      env: { ...process.env, ASK_EDITOR: editor } as NodeJS.ProcessEnv,
      language: 'en',
      out: (text) => messages.push(text),
      err: (text) => messages.push(text),
    })

    expect(code).toBe(0)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: {} })
    expect(readFileSync(marker, 'utf8').trim()).toBe(path)
    expect(messages.join('')).toContain('Created MCP config template')
  })

  it('does not overwrite an existing config', () => {
    const dir = tempDir()
    const path = join(dir, 'mcp.json')
    writeFileSync(path, '{"mcpServers":{"x":{"command":"y"}}}\n', 'utf8')
    const { editor } = fakeEditor(dir)

    const code = runMcpCommand({
      path,
      env: { ...process.env, ASK_EDITOR: editor } as NodeJS.ProcessEnv,
      out: () => {},
      err: () => {},
    })

    expect(code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(
      '{"mcpServers":{"x":{"command":"y"}}}\n',
    )
  })
})