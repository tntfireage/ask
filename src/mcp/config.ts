import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { askHome, samePath } from '../config/config.js'

export const McpServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().min(1).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    transport: z.enum(['stdio', 'streamable-http', 'sse']).optional(),
    disabled: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(30_000),
    disabledTools: z.array(z.string()).default([]),
  })
  .superRefine((value, context) => {
    if (!value.command && !value.url) {
      context.addIssue({
        code: 'custom',
        message: 'command or url is required',
      })
    }
    if (value.command && value.url) {
      context.addIssue({
        code: 'custom',
        message: 'command and url are mutually exclusive',
      })
    }
  })

export type McpServerConfig = z.infer<typeof McpServerSchema>

export interface McpConfigResult {
  servers: Record<string, McpServerConfig>
  warnings: string[]
}

export interface LoadMcpConfigOptions {
  cwd: string
  home?: string
  enabled?: boolean
}

export function mcpConfigPath(home?: string): string {
  return join(home ?? askHome(), 'mcp.json')
}

export function projectMcpConfigPath(cwd: string): string {
  return join(cwd, '.ask', 'mcp.json')
}

export function defaultMcpConfigJson(): string {
  return `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
}

function readConfigFile(
  path: string,
  warnings: string[],
): Record<string, McpServerConfig> {
  if (!existsSync(path)) {
    return {}
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    warnings.push(
      `Failed to read MCP config ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return {}
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    warnings.push(
      `MCP config is not valid JSON (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return {}
  }

  const serversValue =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>).mcpServers
      : undefined

  if (!serversValue || typeof serversValue !== 'object' || Array.isArray(serversValue)) {
    warnings.push(`MCP config has no mcpServers object: ${path}`)
    return {}
  }

  const servers: Record<string, McpServerConfig> = {}

  for (const [name, value] of Object.entries(
    serversValue as Record<string, unknown>,
  )) {
    const parsed = McpServerSchema.safeParse(value)
    if (!parsed.success) {
      warnings.push(
        `Skipped MCP server "${name}" (${path}): ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      )
      continue
    }
    servers[name] = parsed.data
  }

  return servers
}

export function loadMcpConfig(
  options: LoadMcpConfigOptions,
): McpConfigResult {
  if (options.enabled === false) {
    return { servers: {}, warnings: [] }
  }

  const warnings: string[] = []
  const home = options.home ?? askHome()

  const userPath = mcpConfigPath(home)
  const projectPath = projectMcpConfigPath(options.cwd)

  const userServers = readConfigFile(userPath, warnings)
  const projectServers = samePath(userPath, projectPath)
    ? {}
    : readConfigFile(projectPath, warnings)

  return {
    servers: { ...userServers, ...projectServers },
    warnings,
  }
}