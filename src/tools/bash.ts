import { spawn, type ChildProcess } from 'node:child_process'

export interface BashOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface BashResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  truncated: boolean
  timedOut: boolean
  aborted: boolean
  error: string | null
}

const TRUNCATION_MARKER = '\n...[输出已截断]...\n'

class BoundedBuffer {
  private readonly half: number
  private headChunks: Buffer[] = []
  private headLength = 0
  private tailChunks: Buffer[] = []
  private tailLength = 0
  private total = 0

  constructor(private readonly cap: number) {
    this.half = Math.max(1, Math.floor(cap / 2))
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return
    }

    this.total += chunk.length
    let rest = chunk
    const headRoom = this.half - this.headLength

    if (headRoom > 0) {
      const take = Math.min(headRoom, rest.length)
      this.headChunks.push(rest.subarray(0, take))
      this.headLength += take
      rest = rest.subarray(take)
    }

    if (rest.length === 0) {
      return
    }

    this.tailChunks.push(rest)
    this.tailLength += rest.length

    while (this.tailLength > this.half) {
      const excess = this.tailLength - this.half
      const first = this.tailChunks[0]

      if (first.length <= excess) {
        this.tailChunks.shift()
        this.tailLength -= first.length
      } else {
        this.tailChunks[0] = first.subarray(excess)
        this.tailLength -= excess
      }
    }
  }

  result(): { text: string; truncated: boolean } {
    const head = Buffer.concat(this.headChunks).toString('utf8')
    const tail = Buffer.concat(this.tailChunks).toString('utf8')
    const truncated = this.total > this.cap

    if (!truncated) {
      return { text: `${head}${tail}`, truncated: false }
    }

    return {
      text: `${head}${TRUNCATION_MARKER}${tail}`,
      truncated: true,
    }
  }
}

function baseResult(startedAt: number): BashResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    durationMs: Date.now() - startedAt,
    truncated: false,
    timedOut: false,
    aborted: false,
    error: null,
  }
}

export function runBash(
  command: string,
  options: BashOptions = {},
): Promise<BashResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxOutputBytes = options.maxOutputBytes ?? 262_144
  const cwd = options.cwd ?? process.cwd()
  const startedAt = Date.now()

  return new Promise<BashResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ...baseResult(startedAt), aborted: true })
      return
    }

    let child: ChildProcess
    try {
      child = spawn(command, {
        shell: true,
        detached: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        ...baseResult(startedAt),
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const stdout = new BoundedBuffer(maxOutputBytes)
    const stderr = new BoundedBuffer(maxOutputBytes)
    let timedOut = false
    let aborted = false
    let spawnError: string | null = null
    let settled = false

    const killTree = (): void => {
      if (!child.pid) {
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程已退出
        }
      }
    }

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)

      const out = stdout.result()
      const err = stderr.result()

      resolve({
        stdout: out.text,
        stderr: err.text,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        truncated: out.truncated || err.truncated,
        timedOut,
        aborted,
        error: spawnError,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      killTree()
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      spawnError = error.message
      finish(null, null)
    })

    child.on('close', (code, signal) => {
      finish(code, signal)
    })
  })
}
