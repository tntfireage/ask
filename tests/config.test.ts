import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  collectConfigWarnings,
  defaultConfigJson,
  loadConfig,
  resolveApiKey,
} from '../src/config/config.js'

function tempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-config-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, content, 'utf8')
  return path
}

describe('config', () => {
  it('applies defaults for a minimal config', () => {
    const path = tempConfig(
      JSON.stringify({ base_url: 'https://example.test/v1', model: 'm' }),
    )
    const config = loadConfig(path)

    expect(config.max_steps).toBe(12)
    expect(config.language).toBe('zh')
    expect(config.command_timeout_ms).toBe(30_000)
    expect(config.max_output_bytes).toBe(262_144)
    expect(config.temperature).toBe(0)
    expect(config.context_window_tokens).toBe(128_000)
    expect(config.context_evict_ratio).toBe(0.95)
    expect(config.api_key).toBeNull()
  })

  it('reports invalid JSON with the file path', () => {
    const path = tempConfig('{ not json')
    expect(() => loadConfig(path)).toThrow(ConfigError)
    expect(() => loadConfig(path)).toThrow(/不是合法 JSON/)
    expect(() => loadConfig(path)).toThrow(/config\.json/)
  })

  it('reports field-level validation errors', () => {
    const path = tempConfig(JSON.stringify({ max_steps: -1 }))
    expect(() => loadConfig(path)).toThrow(/max_steps/)
  })

  it('uses the configured api_key', () => {
    const path = tempConfig(JSON.stringify({ api_key: 'plaintext' }))
    const config = loadConfig(path)
    expect(resolveApiKey(config)).toBe('plaintext')
  })

  it('throws an actionable error when no key exists', () => {
    const path = tempConfig(JSON.stringify({ api_key: null }))
    const config = loadConfig(path)
    expect(() => resolveApiKey(config)).toThrow(/api_key/)
    expect(() => resolveApiKey(config)).toThrow(/ask model/)
  })

  it('reports a missing key in English for en configs', () => {
    const path = tempConfig(
      JSON.stringify({ language: 'en', api_key: null }),
    )
    const config = loadConfig(path)
    expect(() => resolveApiKey(config)).toThrow(/No API key/)
  })

  it('rejects the removed api_key_env field with a migration hint', () => {
    const path = tempConfig(JSON.stringify({ api_key_env: 'ASK_API_KEY' }))
    expect(() => loadConfig(path)).toThrow(/api_key_env 已移除/)
  })

  it('warns when the config file is readable by others', () => {
    const path = tempConfig(JSON.stringify({ api_key: 'plaintext' }))
    chmodSync(path, 0o644)
    const config = loadConfig(path)
    expect(collectConfigWarnings(config, path).join('\n')).toMatch(/chmod 600/)
  })

  it('template parses with all defaults', () => {
    const path = tempConfig(defaultConfigJson())
    const config = loadConfig(path)
    expect(config.context_evict_ratio).toBe(0.95)
  })

  it('normalizes a base_url that includes the chat endpoint', () => {
    const path = tempConfig(
      JSON.stringify({
        base_url: 'https://api.deepseek.com/chat/completions/',
      }),
    )
    expect(loadConfig(path).base_url).toBe('https://api.deepseek.com')
  })

  it('keeps the version path when normalizing', () => {
    const path = tempConfig(
      JSON.stringify({
        base_url: 'https://api.openai.com/v1/chat/completions',
      }),
    )
    expect(loadConfig(path).base_url).toBe('https://api.openai.com/v1')
  })

  it('accepts a language code and trims it', () => {
    const path = tempConfig(JSON.stringify({ language: '  en  ' }))
    expect(loadConfig(path).language).toBe('en')
  })

  it('rejects a language value with spaces', () => {
    const path = tempConfig(JSON.stringify({ language: 'zh CN' }))
    expect(() => loadConfig(path)).toThrow(/language/)
  })
})
