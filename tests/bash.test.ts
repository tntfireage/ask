import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBash } from '../src/tools/bash.js'

function waitForGone(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const poll = (): void => {
      try {
        process.kill(pid, 0)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ESRCH') {
          resolve(true)
          return
        }
      }
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

describe('runBash', () => {
  it('captures stdout, stderr and exit code', async () => {
    const result = await runBash("printf 'out'; printf 'err' >&2; exit 3")

    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.exitCode).toBe(3)
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('reports command-not-found as a structured result', async () => {
    const result = await runBash('definitely-not-a-command-ask-test')

    expect(result.exitCode).toBe(127)
    expect(result.error).toBeNull()
  })

  it('truncates large output and keeps head and tail', async () => {
    const result = await runBash(
      `node -e "process.stdout.write('x'.repeat(5000) + 'TAIL')"`,
      { maxOutputBytes: 1_000 },
    )

    expect(result.truncated).toBe(true)
    expect(result.stdout).toContain('...[输出已截断]...')
    expect(result.stdout).toContain('TAIL')
    expect(result.stdout.length).toBeLessThan(1_200)
  })

  it('kills the whole process group on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-bash-'))
    const pidFile = join(dir, 'pid')

    const result = await runBash(
      `sh -c 'echo $$ > "${pidFile}"; sleep 30 & sleep 30'`,
      { timeoutMs: 300 },
    )

    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(5_000)
    expect(existsSync(pidFile)).toBe(true)

    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)
    expect(await waitForGone(pid)).toBe(true)
  })

  it('kills the child tree when aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-bash-'))
    const pidFile = join(dir, 'pid')
    const controller = new AbortController()

    setTimeout(() => controller.abort(), 200)

    const result = await runBash(
      `sh -c 'echo $$ > "${pidFile}"; sleep 30'`,
      { signal: controller.signal },
    )

    expect(result.aborted).toBe(true)
    expect(result.durationMs).toBeLessThan(5_000)

    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(await waitForGone(pid)).toBe(true)
  })

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runBash('sleep 5', { signal: controller.signal })

    expect(result.aborted).toBe(true)
    expect(result.durationMs).toBeLessThan(500)
  })
})
