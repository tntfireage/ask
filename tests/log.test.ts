import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Logger,
  classifyBashResult,
  logBashAnomaly,
} from '../src/log/writer.js'
import type { BashResult } from '../src/tools/bash.js'

function result(overrides: Partial<BashResult> = {}): BashResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 12,
    truncated: false,
    timedOut: false,
    aborted: false,
    error: null,
    ...overrides,
  }
}

function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'ask-log-')), 'logs', 'error.jsonl')
}

describe('logger', () => {
  it('writes a complete normalized JSON line', () => {
    const path = tempLog()
    const logger = new Logger(path, 'session-1')

    logger.write({
      kind: 'timeout',
      tool: 'bash',
      command: 'sleep 30',
      duration_ms: 30000,
      message: 'command timed out',
    })

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)

    const entry = JSON.parse(lines[0]) as Record<string, unknown>
    expect(entry).toMatchObject({
      session: 'session-1',
      kind: 'timeout',
      tool: 'bash',
      command: 'sleep 30',
      duration_ms: 30000,
      message: 'command timed out',
    })
    expect(typeof entry.ts).toBe('string')
    for (const key of [
      'ts',
      'session',
      'kind',
      'tool',
      'command',
      'exit_code',
      'signal',
      'duration_ms',
      'truncated',
      'stderr',
      'message',
      'stack',
    ]) {
      expect(entry).toHaveProperty(key)
    }
  })

  it('does not throw when the log path is unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-log-'))
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'x')
    const logger = new Logger(join(blocker, 'nested', 'error.jsonl'))

    expect(() =>
      logger.write({ kind: 'llm_error', message: 'boom' }),
    ).not.toThrow()
  })

  it('classifies only anomalies', () => {
    expect(classifyBashResult(result({ exitCode: 1 }))).toBeNull()
    expect(classifyBashResult(result({ exitCode: 0 }))).toBeNull()
    expect(classifyBashResult(result({ exitCode: 3, stderr: 'x' }))).toBeNull()
    expect(classifyBashResult(result({ timedOut: true }))).toBe('timeout')
    expect(classifyBashResult(result({ error: 'ENOENT' }))).toBe('spawn_error')
    expect(classifyBashResult(result({ signal: 'SIGTERM' }))).toBe('signal')
    expect(classifyBashResult(result({ exitCode: 127 }))).toBe('not_found')
    expect(classifyBashResult(result({ exitCode: 126 }))).toBe('not_found')
    expect(classifyBashResult(result({ aborted: true }))).toBeNull()
  })

  it('does not log ordinary non-zero exits but logs anomalies', () => {
    const path = tempLog()
    const logger = new Logger(path)

    expect(logBashAnomaly(logger, 'grep x', result({ exitCode: 1 }))).toBeNull()
    expect(
      logBashAnomaly(logger, 'sleep 30', result({ timedOut: true })),
    ).toBe('timeout')

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).kind).toBe('timeout')
  })
})
