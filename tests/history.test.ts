import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QueryHistory } from '../src/repl/history.js'

function tempHistory(content = ''): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ask-history-')), 'history')
  if (content !== '') {
    writeFileSync(path, content, 'utf8')
  }
  return path
}

describe('QueryHistory', () => {
  it('appends queries as JSONL and exposes them oldest-first', () => {
    const path = tempHistory()
    const history = new QueryHistory(path)

    history.append('first', '2026-01-01T00:00:00Z')
    history.append('second', '2026-01-01T00:01:00Z')

    expect(history.strings()).toEqual(['first', 'second'])

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0])).toEqual({
      q: 'first',
      ts: '2026-01-01T00:00:00Z',
    })
  })

  it('skips duplicate consecutive queries', () => {
    const history = new QueryHistory(tempHistory())

    expect(history.append('same')).toBe(true)
    expect(history.append('same')).toBe(false)
    expect(history.append('other')).toBe(true)
    expect(history.strings()).toEqual(['same', 'other'])
  })

  it('keeps only the most recent entries up to the limit', () => {
    const history = new QueryHistory(tempHistory(), 3)

    for (const query of ['a', 'b', 'c', 'd', 'e']) {
      history.append(query)
    }

    expect(history.strings()).toEqual(['c', 'd', 'e'])
  })

  it('ignores malformed lines when loading', () => {
    const path = tempHistory(
      [
        '{"q":"good","ts":"t"}',
        'not json',
        '{"missing":"q"}',
        '{"q":"also good","ts":"t"}',
        '',
      ].join('\n'),
    )
    const history = new QueryHistory(path)

    expect(history.strings()).toEqual(['good', 'also good'])
  })

  it('trims queries and ignores blank input', () => {
    const history = new QueryHistory(tempHistory())

    expect(history.append('   ')).toBe(false)
    history.append('  padded  ')
    expect(history.strings()).toEqual(['padded'])
  })
})
