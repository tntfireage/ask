import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectLanguage, messages, uiLanguage } from '../src/i18n.js'

const originalAskHome = process.env.ASK_HOME

afterEach(() => {
  if (originalAskHome === undefined) {
    delete process.env.ASK_HOME
  } else {
    process.env.ASK_HOME = originalAskHome
  }
})

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ask-i18n-'))
}

describe('uiLanguage', () => {
  it('maps Chinese variants to zh and everything else to en', () => {
    expect(uiLanguage('zh')).toBe('zh')
    expect(uiLanguage('zh-CN')).toBe('zh')
    expect(uiLanguage('en')).toBe('en')
    expect(uiLanguage('ja')).toBe('en')
  })
})

describe('messages', () => {
  it('provides Chinese and English UI text', () => {
    expect(messages('zh').welcome.intro).toContain('直接输入问题')
    expect(messages('en').welcome.intro).toContain('Type a question')
    expect(messages('ja').welcome.intro).toContain('Type a question')
    expect(messages('en').repl.contextCleared).toBe('Context cleared')
    expect(messages('en').status.thinking).toBe('Thinking')
    expect(messages('zh').status.thinking).toBe('思考中')
  })
})

describe('detectLanguage', () => {
  it('reads the configured language', () => {
    const home = tempHome()
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ language: 'en' }),
    )
    process.env.ASK_HOME = home

    expect(detectLanguage()).toBe('en')
  })

  it('falls back to zh when config is unavailable', () => {
    process.env.ASK_HOME = join(tempHome(), 'missing')

    expect(detectLanguage()).toBe('zh')
  })
})
