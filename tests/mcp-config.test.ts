import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultMcpConfigJson,
  loadMcpConfig,
  projectMcpConfigPath,
} from '../src/mcp/config.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ask-mcp-config-'))
}

function writeMcp(path: string, servers: Record<string, unknown>): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), 'utf8')
}

describe('loadMcpConfig', () => {
  it('merges user and project servers, with project overriding', () => {
    const home = tempDir()
    const cwd = tempDir()
    mkdirSync(home, { recursive: true })
    writeMcp(join(home, 'mcp.json'), {
      shared: { command: 'user-command' },
      userOnly: { command: 'user-only' },
    })
    writeMcp(projectMcpConfigPath(cwd), {
      shared: { command: 'project-command' },
      projectOnly: { command: 'project-only' },
    })

    const result = loadMcpConfig({ cwd, home })

    expect(result.servers.shared.command).toBe('project-command')
    expect(result.servers.userOnly.command).toBe('user-only')
    expect(result.servers.projectOnly.command).toBe('project-only')
    expect(result.warnings).toEqual([])
  })

  it('keeps disabled servers in the config', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), {
      off: { command: 'x', disabled: true },
    })

    const config = loadMcpConfig({ cwd, home })
    expect(config.servers.off.disabled).toBe(true)
  })

  it('applies defaults for optional fields', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), { s: { command: 'x' } })

    const server = loadMcpConfig({ cwd, home }).servers.s
    expect(server.args).toEqual([])
    expect(server.env).toEqual({})
    expect(server.disabled).toBe(false)
    expect(server.timeoutMs).toBe(30_000)
    expect(server.disabledTools).toEqual([])
  })

  it('skips invalid servers and warns', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), {
      good: { command: 'x' },
      bad: { args: ['no-command'] },
    })

    const result = loadMcpConfig({ cwd, home })
    expect(Object.keys(result.servers)).toEqual(['good'])
    expect(result.warnings.join('\n')).toContain('Skipped MCP server "bad"')
  })

  it('loads stdio and HTTP servers', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), {
      local: { command: 'x' },
      remote: { url: 'https://example.com/mcp' },
    })

    const result = loadMcpConfig({ cwd, home })
    expect(Object.keys(result.servers)).toEqual(['local', 'remote'])
    expect(result.servers.remote.url).toBe('https://example.com/mcp')
    expect(result.warnings).toEqual([])
  })

  it('reads a shared user/project file only once', () => {
    const home = tempDir()
    writeMcp(join(home, 'mcp.json'), {
      remote: { url: 'https://example.com/mcp' },
    })

    const result = loadMcpConfig({ cwd: home, home })
    expect(result.servers.remote.url).toBe('https://example.com/mcp')
    expect(result.warnings).toEqual([])
  })

  it('rejects a server with both command and url', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), {
      both: { command: 'x', url: 'https://example.com/mcp' },
    })

    const result = loadMcpConfig({ cwd, home })
    expect(result.servers).toEqual({})
    expect(result.warnings.join('\n')).toContain('mutually exclusive')
  })

  it('returns nothing when disabled', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeMcp(join(home, 'mcp.json'), { s: { command: 'x' } })

    expect(loadMcpConfig({ cwd, home, enabled: false }).servers).toEqual({})
  })

  it('provides an empty template', () => {
    expect(JSON.parse(defaultMcpConfigJson())).toEqual({ mcpServers: {} })
  })
})