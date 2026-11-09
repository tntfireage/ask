import { createHash } from 'node:crypto'
import type { ToolSpec } from '../llm/adapter.js'
import type { ToolDefinition, ToolResult } from '../tools/types.js'
import type { McpCallResult } from './client.js'
import type { McpServerConfig } from './config.js'
import type { McpManager, McpToolDescriptor } from './manager.js'
import { mapMcpResult } from './result.js'

export interface McpToolSource {
  tools(): McpToolDescriptor[]
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<McpCallResult>
}

export interface CreateMcpToolsOptions {
  manager: McpToolSource
  servers: Record<string, McpServerConfig>
  maxTools: number
  artifactDir: string
  maxOutputBytes: number
}

export interface McpToolsResult {
  tools: ToolDefinition[]
  warnings: string[]
}

const MAX_TOOL_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 500

export function sanitizeMcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_')

  if (sanitized.length <= MAX_TOOL_NAME_LENGTH) {
    return sanitized
  }

  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${sanitized.slice(
    0,
    MAX_TOOL_NAME_LENGTH - hash.length - 1,
  )}_${hash}`
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base
  }

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `_${index}`
    const candidate = `${base.slice(
      0,
      MAX_TOOL_NAME_LENGTH - suffix.length,
    )}${suffix}`
    if (!used.has(candidate)) {
      return candidate
    }
  }

  throw new Error(`Cannot create a unique MCP tool name for ${base}`)
}

function describeArguments(args: unknown): string {
  try {
    const text = JSON.stringify(args)
    if (text === undefined) {
      return ''
    }
    return text.length > 120 ? `${text.slice(0, 120)}...` : text
  } catch {
    return ''
  }
}

function descriptionFor(server: string, tool: McpToolDescriptor['tool']): string {
  const text = `[${server}] ${tool.description}`.trim()
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
    : text
}

function parametersFor(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object' && schema.properties) {
    return schema
  }
  return { type: 'object', properties: {} }
}

export function createMcpTools(
  options: CreateMcpToolsOptions,
): McpToolsResult {
  const warnings: string[] = []
  const descriptors = options.manager.tools()
  const tools: ToolDefinition[] = []
  const usedNames = new Set<string>()

  for (const descriptor of descriptors) {
    if (tools.length >= options.maxTools) {
      warnings.push(
        `Only the first ${options.maxTools} MCP tools are registered (found ${descriptors.length})`,
      )
      break
    }

    const serverConfig = options.servers[descriptor.server]
    if (
      serverConfig?.disabledTools.includes(descriptor.tool.name) === true
    ) {
      continue
    }

    const name = uniqueName(
      sanitizeMcpToolName(descriptor.server, descriptor.tool.name),
      usedNames,
    )
    usedNames.add(name)

    const spec: ToolSpec = {
      type: 'function',
      function: {
        name,
        description: descriptionFor(descriptor.server, descriptor.tool),
        parameters: parametersFor(descriptor.tool.inputSchema),
      },
    }

    const server = descriptor.server
    const toolName = descriptor.tool.name
    const timeoutMs = serverConfig?.timeoutMs ?? 30_000

    tools.push({
      name,
      spec,
      displayKind: 'generic',
      describe: describeArguments,
      async execute(args, context): Promise<ToolResult> {
        const result = await options.manager.callTool(server, toolName, args, {
          timeoutMs,
          signal: context.signal,
        })
        const mapped = mapMcpResult(result, {
          artifactDir: options.artifactDir,
          maxBytes: options.maxOutputBytes,
        })

        return {
          observation: mapped.observation,
          display: {
            kind: 'generic',
            tool: name,
            title: `${server}/${toolName}`,
            summary: mapped.summary,
            ok: mapped.ok,
          },
        }
      },
    })
  }

  return { tools, warnings }
}