import { Transform } from 'node:stream'

const PASTE_START = Buffer.from('\x1b[200~')
const PASTE_END = Buffer.from('\x1b[201~')
const PARTIAL_FLUSH_MS = 20
const CR = 0x0d
const LF = 0x0a

export interface PasteAwareInput extends Transform {
  setRawMode?: (mode: boolean) => void
  dispose?: () => void
  suspendSource?: () => void
  resumeSource?: () => void
}

export interface PasteAwareInputOptions {
  source: NodeJS.ReadableStream
  onPaste: (text: string) => void
}

function normalizePaste(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '')
}

function lineEndingCount(buffer: Buffer): number {
  let count = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === CR) {
      count += 1
      if (buffer[index + 1] === LF) {
        index += 1
      }
    } else if (byte === LF) {
      count += 1
    }
  }
  return count
}

function partialStartLength(buffer: Buffer): number {
  return partialMarkerLength(buffer, PASTE_START)
}

function partialEndLength(buffer: Buffer): number {
  return partialMarkerLength(buffer, PASTE_END)
}

function partialMarkerLength(buffer: Buffer, marker: Buffer): number {
  const max = Math.min(buffer.length, marker.length - 1)
  for (let length = max; length > 0; length -= 1) {
    const suffix = buffer.subarray(buffer.length - length)
    if (suffix.equals(marker.subarray(0, length))) {
      return length
    }
  }
  return 0
}

/**
 * Wraps a terminal input stream so that bracketed-paste payloads and standalone
 * LF bytes reach the REPL as paste events instead of being interpreted by
 * readline as line submissions.
 */
export function createPasteAwareInput(
  options: PasteAwareInputOptions,
): PasteAwareInput {
  const { source, onPaste } = options

  let pending = Buffer.alloc(0)
  let inPaste = false
  let pasteChunks: Buffer[] = []
  let previousByte = -1
  let flushTimer: NodeJS.Timeout | null = null

  const clearFlush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const input = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      consume(chunk)
      callback()
    },
  }) as PasteAwareInput

  const forward = (segment: Buffer): void => {
    if (segment.length > 0) {
      input.push(segment)
    }
  }

  // A standalone LF is only an explicit line break while the terminal is in
  // raw mode. In cooked mode the tty maps Enter to LF, so it must stay a
  // submission for readline.
  const rawModeActive = (): boolean =>
    (source as { isRaw?: boolean }).isRaw !== false

  const forwardNormal = (segment: Buffer): void => {
    let start = 0
    for (let index = 0; index < segment.length; index += 1) {
      const byte = segment[index]
      if (byte === LF && previousByte !== CR && rawModeActive()) {
        forward(segment.subarray(start, index))
        start = index + 1
        onPaste('\n')
      }
      previousByte = byte
    }
    forward(segment.subarray(start))
  }

  const emitPaste = (raw: Buffer): void => {
    const text = normalizePaste(raw.toString('utf8'))
    previousByte = -1
    if (text !== '') {
      onPaste(text)
    }
  }

  const drain = (): void => {
    for (;;) {
      if (inPaste) {
        const end = pending.indexOf(PASTE_END)
        if (end === -1) {
          // Hold back only a possible partial end marker; stream the rest so
          // large pastes do not accumulate in memory.
          const keep = partialEndLength(pending)
          const flushable = pending.length - keep
          if (flushable > 0) {
            pasteChunks.push(pending.subarray(0, flushable))
            pending = pending.subarray(flushable)
          }
          return
        }
        pasteChunks.push(pending.subarray(0, end))
        pending = pending.subarray(end + PASTE_END.length)
        inPaste = false
        const raw = Buffer.concat(pasteChunks)
        pasteChunks = []
        emitPaste(raw)
        continue
      }

      const start = pending.indexOf(PASTE_START)
      if (start === -1) {
        const keep = partialStartLength(pending)
        const forwardable = pending.length - keep
        if (forwardable > 0) {
          const segment = pending.subarray(0, forwardable)
          pending = pending.subarray(forwardable)
          forwardNormal(segment)
        }
        if (pending.length > 0) {
          flushTimer = setTimeout(() => {
            flushTimer = null
            const tail = pending
            pending = Buffer.alloc(0)
            forwardNormal(tail)
          }, PARTIAL_FLUSH_MS)
          flushTimer.unref?.()
        }
        return
      }

      if (start > 0) {
        const segment = pending.subarray(0, start)
        pending = pending.subarray(start + PASTE_START.length)
        forwardNormal(segment)
      } else {
        pending = pending.subarray(PASTE_START.length)
      }
      inPaste = true
      pasteChunks = []
    }
  }

  const consume = (chunk: Buffer): void => {
    clearFlush()

    // Fallback for terminals that do not emit bracketed-paste markers: a chunk
    // carrying several line endings can only be a paste, never human typing.
    if (
      !inPaste &&
      chunk.indexOf(PASTE_START) === -1 &&
      lineEndingCount(chunk) >= 2
    ) {
      if (pending.length > 0) {
        const tail = pending
        pending = Buffer.alloc(0)
        forwardNormal(tail)
      }
      emitPaste(chunk)
      return
    }

    pending = Buffer.concat([pending, chunk])
    drain()
  }

  const isTTY = (source as { isTTY?: boolean }).isTTY === true
  Object.defineProperty(input, 'isTTY', {
    value: isTTY,
    configurable: true,
  })

  if ('isRaw' in source) {
    Object.defineProperty(input, 'isRaw', {
      configurable: true,
      get: () => (source as { isRaw?: boolean }).isRaw,
    })
  }

  const setRawMode = (source as { setRawMode?: (mode: boolean) => void })
    .setRawMode
  if (typeof setRawMode === 'function') {
    input.setRawMode = (mode: boolean): void => {
      setRawMode.call(source, mode)
    }
  }

  const onSourceError = (error: Error): void => {
    input.destroy(error)
  }

  let attached = false
  const detach = (): void => {
    if (!attached) {
      return
    }
    attached = false
    source.unpipe(input)
  }
  const attach = (): void => {
    if (attached || (source as { readableEnded?: boolean }).readableEnded) {
      return
    }
    attached = true
    source.pipe(input)
  }

  input.suspendSource = detach
  input.resumeSource = attach

  input.dispose = (): void => {
    clearFlush()
    detach()
    source.removeListener('error', onSourceError)
  }

  source.on('error', onSourceError)
  input.once('close', () => {
    clearFlush()
    detach()
    source.removeListener('error', onSourceError)
  })

  attach()

  return input
}
