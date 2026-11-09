import { describe, expect, it } from 'vitest'
import { ASK_LOGO, renderWelcome } from '../src/repl/welcome.js'

describe('welcome page', () => {
  it('renders logo, version, model, host, cwd and shortcuts', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      cwd: '/Users/me/projects/ask',
      home: '/Users/me',
    })

    expect(text).toContain(ASK_LOGO)
    expect(text).toContain('ask v0.1.0')
    expect(text).toContain('极简的命令行AI工具')
    expect(text).toContain('自动执行无需确认')
    expect(text).toContain('model   deepseek-flash')
    expect(text).toContain('api     api.deepseek.com')
    expect(text).toContain('cwd     ~/projects/ask')
    expect(text).toContain('/history')
    expect(text).toContain('/skills')
    expect(text).toContain('/skill <name>')
    expect(text).toContain('/mcp')
    expect(text).toContain('/clear')
    expect(text).toContain('exit')
  })

  it('shows only the host and never the full endpoint', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      cwd: '/tmp',
      home: '/home/user',
    })

    expect(text).toContain('api     api.example.com')
    expect(text).not.toContain('/v1')
    expect(text).not.toContain('sk-')
  })

  it('abbreviates the home directory', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'm',
      baseUrl: '',
      cwd: '/home/user',
      home: '/home/user',
    })

    expect(text).toContain('cwd     ~')
    expect(text).toContain('api     -')
  })

  it('applies ANSI colors when enabled', () => {
    const text = renderWelcome(
      {
        version: '0.1.0',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        cwd: '/tmp',
        home: '/home/user',
      },
      { color: true },
    )

    expect(text).toContain('\x1b[94m')
    expect(text).toContain('\x1b[90m')
    expect(text).toContain('\x1b[0m')
    expect(text).toContain('ask v0.1.0')
    expect(text).toContain('model')
  })

  it('emits no ANSI codes when color is disabled', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'm',
      baseUrl: 'https://api.example.com',
      cwd: '/tmp',
      home: '/home/user',
    })

    expect(text).not.toContain('\x1b[')
  })

  it('shows the skills and MCP counts', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'm',
      baseUrl: 'https://api.example.com',
      cwd: '/tmp',
      home: '/home/user',
      skills: 3,
      mcpServers: 2,
      mcpTools: 5,
    })

    expect(text).toContain('skills  3')
    expect(text).toContain('mcp     2 servers · 5 tools')
  })

  it('ends with a blank line before the prompt', () => {
    const text = renderWelcome({
      version: '0.1.0',
      model: 'm',
      baseUrl: 'https://api.example.com',
      cwd: '/tmp',
      home: '/home/user',
    })

    expect(text.endsWith('\n\n')).toBe(true)
  })

  it('uses English hints for en and unsupported languages', () => {
    for (const language of ['en', 'ja']) {
      const text = renderWelcome(
        {
          version: '0.1.0',
          model: 'm',
          baseUrl: 'https://api.example.com',
          cwd: '/tmp',
          home: '/home/user',
        },
        { language },
      )

      expect(text).toContain('Type a question and press Enter')
      expect(text).toContain('minimalist command-line AI tool')
      expect(text).toContain('without confirmation')
      expect(text).toContain('/history')
      expect(text).not.toContain('直接输入问题')
    }
  })
})
