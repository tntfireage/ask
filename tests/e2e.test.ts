import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildDist,
  spawnCli,
  startChatServer,
  waitForExit,
  writeConfig,
  writeNamedToolCallResponse,
  writeTextResponse,
  writeToolCallResponse,
} from './helpers/chat-server.js'

beforeAll(() => {
  buildDist()
})

function tempDir(prefix = 'ask-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function runToExit(
  run: ReturnType<typeof spawnCli>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  run.child.stdin!.write('exit\n')
  run.child.stdin!.end()
  const code = await waitForExit(run.child)
  return { code, stdout: run.stdout, stderr: run.stderr }
}

async function runAfter(
  run: ReturnType<typeof spawnCli>,
  delayMs: number,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  run.child.stdin!.write(input)
  run.child.stdin!.end()
  const code = await waitForExit(run.child)
  return { code, stdout: run.stdout, stderr: run.stderr }
}

describe('end-to-end', () => {
  it('answers with multiple tool steps and records history', async () => {
    const home = tempDir()
    const workdir = tempDir('ask-work-')
    const server = await startChatServer((_body, index, res) => {
      if (index === 0) {
        writeToolCallResponse(res, 'du -sh .')
      } else {
        writeTextResponse(
          res,
          '## 结论\n目录很小，约 4 KB。\n\n## 依据\n- `du -sh .` -> 4.0K',
        )
      }
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli(['当前目录有多大'], { home, cwd: workdir })
      const result = await runToExit(run)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('$ du -sh .')
      expect(result.stdout).toContain('exit 0')
      expect(result.stdout).toContain('## 结论')
      expect(result.stdout).toContain('## 依据')

      const history = readFileSync(join(home, 'history'), 'utf8')
      expect(history).toContain('当前目录有多大')

      const second = server.requests[1] as {
        messages: Array<{ role: string }>
      }
      expect(second.messages.some((message) => message.role === 'tool')).toBe(
        true,
      )
    } finally {
      await server.close()
    }
  })

  it('writes files through write_file and displays the change', async () => {
    const home = tempDir()
    const workdir = tempDir('ask-work-')
    const server = await startChatServer((_body, index, res) => {
      if (index === 0) {
        writeNamedToolCallResponse(res, 'write_file', {
          path: 'notes.txt',
          content: 'hello\nworld',
        })
      } else {
        writeTextResponse(res, '## 结论\n已写入 notes.txt')
      }
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli(['创建 notes.txt'], { home, cwd: workdir })
      const result = await runToExit(run)

      expect(result.code).toBe(0)
      expect(readFileSync(join(workdir, 'notes.txt'), 'utf8')).toBe(
        'hello\nworld',
      )
      expect(result.stdout).toContain('● write_file(notes.txt)')
      expect(result.stdout).toContain('+ hello')
      expect(result.stdout).toContain('+ world')
    } finally {
      await server.close()
    }
  })

  it('writes LLM failures to the normalized error log', async () => {
    const home = tempDir()
    const server = await startChatServer((_body, _index, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli(['触发一次失败'], { home })
      const result = await runToExit(run)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('[错误]')

      const logPath = join(home, 'logs', 'error.jsonl')
      expect(existsSync(logPath)).toBe(true)

      const entries = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0]).toMatchObject({
        kind: 'llm_error',
        tool: null,
      })
      expect(typeof entries[0].message).toBe('string')
      expect(entries[0].session).toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('calls an MCP stdio tool end to end', async () => {
    const home = tempDir()
    const workdir = tempDir('ask-work-')
    const server = await startChatServer((_body, index, res) => {
      if (index === 0) {
        writeNamedToolCallResponse(res, 'mcp__mock__echo', { text: 'hi' })
      } else {
        writeTextResponse(res, '## 结论\nMCP 工具已返回')
      }
    })
    writeConfig(home, server.url)
    const mockServer = join(
      process.cwd(),
      'tests/helpers/mock-mcp-server.mjs',
    )
    writeFileSync(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          mock: { command: process.execPath, args: [mockServer] },
        },
      }),
    )

    try {
      const run = spawnCli([], { home, cwd: workdir })
      const result = await runAfter(run, 800, '调用 echo\nexit\n')

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('● mcp__mock__echo({"text":"hi"})')
      expect(result.stdout).toContain('-> ok')
      expect(result.stdout).toContain('MCP 工具已返回')

      const second = server.requests[1] as {
        messages: Array<{ role: string; content: string | null }>
      }
      expect(
        second.messages.some(
          (message) =>
            message.role === 'tool' &&
            (message.content ?? '').includes('echo:hi'),
        ),
      ).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('loads skills through the tool and REPL commands', async () => {
    const home = tempDir()
    const workdir = tempDir('ask-work-')
    mkdirSync(join(home, 'skills', 'pdf'), { recursive: true })
    writeFileSync(
      join(home, 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Extract text from PDFs\n---\n# PDF skill\n\nUse pdftotext.\n',
      'utf8',
    )

    const server = await startChatServer((_body, index, res) => {
      if (index === 0) {
        writeNamedToolCallResponse(res, 'skill', { name: 'pdf' })
      } else {
        writeTextResponse(res, '## 结论\n技能已加载')
      }
    })
    writeConfig(home, server.url)

    try {
      const run = spawnCli([], { home, cwd: workdir })
      const result = await runAfter(run, 500, '使用 pdf 技能\nexit\n')

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('● skill(pdf)')
      const second = server.requests[1] as {
        messages: Array<{ role: string; content: string | null }>
      }
      expect(
        second.messages.some(
          (message) =>
            message.role === 'tool' &&
            (message.content ?? '').includes('Use pdftotext.'),
        ),
      ).toBe(true)

      const commandRun = spawnCli([], { home, cwd: workdir })
      await runAfter(
        commandRun,
        500,
        '/skills\n/skill pdf\nexit\n',
      )

      expect(commandRun.stdout).toContain('pdf')
      expect(commandRun.stdout).toContain('user')
      expect(commandRun.stdout).toContain('Extract text from PDFs')
      expect(commandRun.stdout).toContain('已加载技能: pdf')
    } finally {
      await server.close()
    }
  })
})
