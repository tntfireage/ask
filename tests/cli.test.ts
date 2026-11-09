import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildDist,
  spawnCli,
  startChatServer,
  waitFor,
  waitForExit,
  writeConfig,
  writeHangingResponse,
  writeTextResponse,
} from './helpers/chat-server.js'

beforeAll(() => {
  buildDist()
})

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ask-cli-'))
}

async function finish(
  run: ReturnType<typeof spawnCli>,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (input !== undefined) {
    run.child.stdin!.write(input)
  }
  run.child.stdin!.end()
  const code = await waitForExit(run.child)
  return { code, stdout: run.stdout, stderr: run.stderr }
}

describe('ask CLI', () => {
  it('prints the version without requiring config', async () => {
    const run = spawnCli(['--version'], { home: tempHome() })
    const result = await finish(run)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('0.1.0')
  })

  it('localizes help text from the configured language', async () => {
    const home = tempHome()
    writeConfig(home, 'http://127.0.0.1:1/v1', 'en')

    const run = spawnCli(['--help'], { home })
    const result = await finish(run)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Ask anything in natural language')
    expect(result.stdout).toContain('Edit model config')
  })

  it('exits non-zero with guidance when config is missing', async () => {
    const run = spawnCli([], { home: tempHome() })
    const result = await finish(run, 'exit\n')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('配置文件不存在')
    expect(result.stderr).toContain('ask model')
  })

  it('creates the config through ask model', async () => {
    const home = tempHome()
    const editor = join(home, 'editor.sh')
    writeFileSync(editor, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(editor, 0o755)

    const run = spawnCli(['model'], { home, env: { EDITOR: editor } })
    const result = await finish(run)

    expect(result.code).toBe(0)
    expect(existsSync(join(home, 'config.json'))).toBe(true)
  })

  it('creates the MCP config through ask mcp', async () => {
    const home = tempHome()
    const editor = join(home, 'editor.sh')
    writeFileSync(editor, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(editor, 0o755)

    const run = spawnCli(['mcp'], {
      home,
      env: { ASK_EDITOR: editor },
    })
    const result = await finish(run)

    expect(result.code).toBe(0)
    expect(existsSync(join(home, 'mcp.json'))).toBe(true)
  })

  it('enters the REPL and exits on exit', async () => {
    const home = tempHome()
    writeConfig(home, 'http://127.0.0.1:1/v1')

    const run = spawnCli([], { home })
    const result = await finish(run, 'exit\n')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ask> ')
  })

  it('answers a one-shot question, then stays in the REPL, and records history', async () => {
    const home = tempHome()
    const server = await startChatServer((_body, _index, res) => {
      writeTextResponse(res, '## 结论\n目录很小')
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli(['当前目录有多大'], { home })
      const result = await finish(run, 'exit\n')

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('## 结论')
      expect(result.stdout).toContain('目录很小')

      const history = readFileSync(join(home, 'history'), 'utf8')
      expect(history).toContain('当前目录有多大')
    } finally {
      await server.close()
    }
  })

  it('drops earlier context from requests after /clear', async () => {
    const home = tempHome()
    const server = await startChatServer((_body, _index, res) => {
      writeTextResponse(res, 'ok')
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli([], { home })
      const result = await finish(run, 'first question\n/clear\nsecond question\nexit\n')

      expect(result.code).toBe(0)
      expect(server.requests.length).toBeGreaterThanOrEqual(2)

      const second = server.requests[1] as {
        messages: Array<{ role: string; content: string | null }>
      }
      expect(second.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
      ])
      expect(second.messages[1].content).toBe('second question')
    } finally {
      await server.close()
    }
  })

  it('aborts a running turn on SIGINT and keeps the session alive', async () => {
    const home = tempHome()
    const server = await startChatServer((_body, _index, res) => {
      writeHangingResponse(res)
    })
    writeConfig(home, server.url)

    const run = spawnCli([], { home })

    try {
      run.child.stdin!.write('slow question\n')
      await waitFor(() => server.requests.length === 1)

      run.child.kill('SIGINT')
      await waitFor(() => run.stdout.includes('已中止'), 5_000)

      expect(run.child.exitCode).toBeNull()

      run.child.stdin!.write('exit\n')
      run.child.stdin!.end()
      const code = await waitForExit(run.child)

      expect(code).toBe(0)
    } finally {
      run.child.kill('SIGKILL')
      await server.close()
    }
  })
})
