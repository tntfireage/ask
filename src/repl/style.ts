export const BG_QUESTION = 250
export const FG_QUESTION = 232

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) {
    return 0
  }
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0
  }
  if (codePoint >= 0x0300 && codePoint <= 0x036f) {
    return 0
  }
  if (codePoint >= 0x200b && codePoint <= 0x200f) {
    return 0
  }
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) {
    return 0
  }
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return 2
    }
  }
  return 1
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of stripAnsi(text)) {
    width += codePointWidth(char.codePointAt(0) ?? 0)
  }
  return width
}

export function padTo(text: string, columns: number): string {
  const width = displayWidth(text)
  if (width >= columns) {
    return text
  }
  return `${text}${' '.repeat(columns - width)}`
}

export function supportsColor(stream: { isTTY?: boolean }): boolean {
  if ('NO_COLOR' in process.env) {
    return false
  }
  if (process.env.TERM === 'dumb') {
    return false
  }
  return stream.isTTY === true
}
