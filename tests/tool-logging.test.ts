import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Logger } from '../src/log/writer.js'
import { executeBashTool } from '../src/tools/registry.js'

function context(logPath: string, timeoutMs = 5_000) {
  return {
    cwd: process.cwd(),
    timeoutMs,
    maxOutputBytes: 10_000,
    logger: new Logger(logPath),
  }
}

function readKinds(path: string): string[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).kind)
}

describe('bash tool logging integration', () => {
  it('logs timeout and not-found but not grep-style non-zero exits', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ask-tool-')), 'error.jsonl')

    await executeBashTool('sh -c "sleep 30"', context(path, 200))
    await executeBashTool('definitely-not-a-command-ask', context(path))
    await executeBashTool('exit 1', context(path))
    await executeBashTool('kill -TERM $$', context(path))

    expect(readKinds(path)).toEqual(['timeout', 'not_found', 'signal'])
  })
})
