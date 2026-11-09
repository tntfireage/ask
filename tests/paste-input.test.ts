import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPasteAwareInput } from '../src/repl/input.js'

function setup(): {
  write: (chunk: string) => void
  forwarded: () => string
  pastes: string[]
  dispose: () => void
} {
  const source = new PassThrough()
  const pastes: string[] = []
  const input = createPasteAwareInput({
    source,
    onPaste: (text) => pastes.push(text),
  })
  const chunks: string[] = []
  input.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))

  return {
    write: (chunk: string) => source.write(chunk),
    forwarded: () => chunks.join(''),
    pastes,
    dispose: () => input.dispose?.(),
  }
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createPasteAwareInput', () => {
  it('forwards ordinary keystrokes untouched', async () => {
    const ctx = setup()
    ctx.write('abc')
    await tick()

    expect(ctx.forwarded()).toBe('abc')
    expect(ctx.pastes).toEqual([])
    ctx.dispose()
  })

  it('swallows bracketed paste payloads and reports them once', async () => {
    const ctx = setup()
    ctx.write('\x1b[200~line one\nline two\x1b[201~')
    await tick()

    expect(ctx.forwarded()).toBe('')
    expect(ctx.pastes).toEqual(['line one\nline two'])
    ctx.dispose()
  })

  it('normalizes CRLF and drops the copied trailing newline', async () => {
    const ctx = setup()
    ctx.write('\x1b[200~first\r\nsecond\r\n\x1b[201~')
    await tick()

    expect(ctx.pastes).toEqual(['first\nsecond'])
    ctx.dispose()
  })

  it('handles paste markers split across chunks', async () => {
    const ctx = setup()
    ctx.write('\x1b[20')
    ctx.write('0~hello\nworld')
    ctx.write('\x1b[2')
    ctx.write('01~')
    await tick()

    expect(ctx.forwarded()).toBe('')
    expect(ctx.pastes).toEqual(['hello\nworld'])
    ctx.dispose()
  })

  it('turns a standalone LF into a newline insert instead of a submit', async () => {
    const ctx = setup()
    ctx.write('a\nb')
    await tick()

    expect(ctx.forwarded()).toBe('ab')
    expect(ctx.pastes).toEqual(['\n'])
    ctx.dispose()
  })

  it('keeps CRLF from a real Enter key as input for readline', async () => {
    const ctx = setup()
    ctx.write('a\r\nb')
    await tick()

    expect(ctx.forwarded()).toBe('a\r\nb')
    expect(ctx.pastes).toEqual([])
    ctx.dispose()
  })

  it('forwards LF as Enter when the terminal is not in raw mode', async () => {
    const source = new PassThrough()
    Object.defineProperty(source, 'isRaw', {
      configurable: true,
      value: false,
    })
    const pastes: string[] = []
    const input = createPasteAwareInput({
      source,
      onPaste: (text) => pastes.push(text),
    })
    const chunks: string[] = []
    input.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))

    source.write('text\n')
    await tick()

    expect(chunks.join('')).toBe('text\n')
    expect(pastes).toEqual([])
    input.dispose?.()
  })

  it('detects multi-line bursts without bracketed markers', async () => {
    const ctx = setup()
    ctx.write('alpha\nbeta\ngamma\n')
    await tick()

    expect(ctx.forwarded()).toBe('')
    expect(ctx.pastes).toEqual(['alpha\nbeta\ngamma'])
    ctx.dispose()
  })

  it('flushes a lone partial marker once it is known not to be a paste', async () => {
    const ctx = setup()
    ctx.write('\x1b[')
    await tick(5)
    expect(ctx.forwarded()).toBe('')

    await tick(40)
    expect(ctx.forwarded()).toBe('\x1b[')
    ctx.dispose()
  })
})
