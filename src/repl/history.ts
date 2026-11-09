import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { historyPath } from '../config/config.js'

export interface HistoryEntry {
  q: string
  ts: string
}

function parseLine(line: string): HistoryEntry | null {
  try {
    const value = JSON.parse(line) as { q?: unknown; ts?: unknown }
    if (typeof value.q !== 'string' || value.q.trim() === '') {
      return null
    }
    return {
      q: value.q,
      ts: typeof value.ts === 'string' ? value.ts : '',
    }
  } catch {
    return null
  }
}

export class QueryHistory {
  private entries: HistoryEntry[]

  constructor(
    private readonly path: string = historyPath(),
    private readonly limit: number = 2_000,
  ) {
    this.entries = this.load()
  }

  private load(): HistoryEntry[] {
    try {
      const raw = readFileSync(this.path, 'utf8')
      return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map(parseLine)
        .filter((entry): entry is HistoryEntry => entry !== null)
        .slice(-this.limit)
    } catch {
      return []
    }
  }

  getEntries(): HistoryEntry[] {
    return [...this.entries]
  }

  strings(): string[] {
    return this.entries.map((entry) => entry.q)
  }

  append(query: string, ts: string = new Date().toISOString()): boolean {
    const trimmed = query.trim()
    if (trimmed === '') {
      return false
    }

    const last = this.entries[this.entries.length - 1]
    if (last && last.q === trimmed) {
      return false
    }

    this.entries.push({ q: trimmed, ts })
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit)
    }

    this.persist()
    return true
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const content =
        this.entries.map((entry) => JSON.stringify(entry)).join('\n') +
        (this.entries.length > 0 ? '\n' : '')
      writeFileSync(this.path, content, { mode: 0o600 })
    } catch {
      // 历史写入失败不影响当前回合
    }
  }
}
