import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { logPath } from '../config/config.js'
import type { BashResult } from '../tools/bash.js'

export type LogKind =
  | 'timeout'
  | 'spawn_error'
  | 'signal'
  | 'not_found'
  | 'llm_error'
  | 'config_error'
  | 'parse_error'
  | 'uncaught'

export interface LogEntry {
  ts: string
  session: string
  kind: LogKind
  tool: string | null
  command: string | null
  exit_code: number | null
  signal: string | null
  duration_ms: number | null
  truncated: boolean | null
  stderr: string | null
  message: string
  stack: string | null
}

export type LogInput = Omit<LogEntry, 'ts' | 'session'>

export class Logger {
  readonly session: string

  constructor(
    private readonly path: string = logPath(),
    session: string = randomUUID(),
  ) {
    this.session = session
  }

  write(input: Partial<LogInput> & Pick<LogInput, 'kind' | 'message'>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        session: this.session,
        kind: input.kind,
        tool: input.tool ?? null,
        command: input.command ?? null,
        exit_code: input.exit_code ?? null,
        signal: input.signal ?? null,
        duration_ms: input.duration_ms ?? null,
        truncated: input.truncated ?? null,
        stderr: input.stderr ?? null,
        message: input.message,
        stack: input.stack ?? null,
      }
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      // 日志写入是 best-effort，不能影响回合
    }
  }
}

export function classifyBashResult(result: BashResult): LogKind | null {
  if (result.aborted) {
    return null
  }
  if (result.timedOut) {
    return 'timeout'
  }
  if (result.error) {
    return 'spawn_error'
  }
  if (result.signal) {
    return 'signal'
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    return 'not_found'
  }
  return null
}

function messageFor(kind: LogKind, result: BashResult): string {
  switch (kind) {
    case 'timeout':
      return `命令超时 (${result.durationMs}ms)`
    case 'spawn_error':
      return result.error ?? '命令启动失败'
    case 'signal':
      return `命令被信号 ${result.signal} 终止`
    case 'not_found':
      return `命令未找到或不可执行 (exit ${result.exitCode})`
    default:
      return kind
  }
}

export function logBashAnomaly(
  logger: Logger,
  command: string,
  result: BashResult,
): LogKind | null {
  const kind = classifyBashResult(result)
  if (!kind) {
    return null
  }

  logger.write({
    kind,
    tool: 'bash',
    command,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    truncated: result.truncated,
    stderr: result.stderr === '' ? null : result.stderr.slice(-2_000),
    message: messageFor(kind, result),
  })

  return kind
}
