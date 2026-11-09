import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'

type FakeTerminalInput = PassThrough & {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

describe('readline history integration', () => {
  it('loads persisted history and recalls it with the up arrow', async () => {
    const input = new PassThrough() as FakeTerminalInput
    input.isTTY = true
    input.setRawMode = () => input
    const output = new PassThrough()

    const rl = createInterface({
      input,
      output,
      terminal: true,
      // Node 的 history 选项按“最近的在最前”解释
      history: ['newer question', 'older question'],
      historySize: 2_000,
      prompt: '',
    })

    const lines: string[] = []
    rl.on('line', (line: string) => lines.push(line))
    rl.prompt()

    // 上箭头 -> 回车
    input.write('\x1b[A')
    input.write('\n')

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(lines).toEqual(['newer question'])
    rl.close()
  })
})
