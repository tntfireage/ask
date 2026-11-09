import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapMcpResult } from '../src/mcp/result.js'

const artifactDir = mkdtempSync(join(tmpdir(), 'ask-mcp-artifacts-'))

describe('mapMcpResult', () => {
  it('maps text content', () => {
    const mapped = mapMcpResult(
      {
        content: [{ type: 'text', text: 'hello' }],
        isError: false,
      },
      { artifactDir, maxBytes: 1_000 },
    )

    expect(mapped.observation).toBe('hello')
    expect(mapped.summary).toBe('hello')
    expect(mapped.ok).toBe(true)
    expect(mapped.images).toEqual([])
  })

  it('marks error results', () => {
    const mapped = mapMcpResult(
      {
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      },
      { artifactDir, maxBytes: 1_000 },
    )

    expect(mapped.ok).toBe(false)
    expect(mapped.observation).toContain('error: true')
    expect(mapped.observation).toContain('boom')
  })

  it('saves image content and returns the path', () => {
    const data = Buffer.from('fake-png').toString('base64')
    const mapped = mapMcpResult(
      {
        content: [{ type: 'image', data, mimeType: 'image/png' }],
        isError: false,
      },
      { artifactDir, maxBytes: 1_000 },
    )

    expect(mapped.images).toHaveLength(1)
    const path = mapped.images[0]
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path)).toEqual(Buffer.from('fake-png'))
    expect(mapped.observation).toContain('[image saved:')
    expect(path.endsWith('.png')).toBe(true)
  })

  it('maps resources and structured content', () => {
    const mapped = mapMcpResult(
      {
        content: [
          { type: 'resource', resource: { text: 'resource text' } },
          { type: 'resource', resource: { uri: 'file:///tmp/a' } },
        ],
        structuredContent: { ok: 1 },
        isError: false,
      },
      { artifactDir, maxBytes: 1_000 },
    )

    expect(mapped.observation).toContain('[resource] resource text')
    expect(mapped.observation).toContain('[resource: file:///tmp/a]')
    expect(mapped.observation).toContain('[structured] {"ok":1}')
  })

  it('truncates oversized observations', () => {
    const mapped = mapMcpResult(
      {
        content: [{ type: 'text', text: 'x'.repeat(5_000) }],
        isError: false,
      },
      { artifactDir, maxBytes: 200 },
    )

    expect(mapped.observation).toContain('[truncated]')
    expect(Buffer.byteLength(mapped.observation)).toBeLessThan(300)
  })
})