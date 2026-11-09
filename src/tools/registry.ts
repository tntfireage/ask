import type { ToolSpec } from '../llm/adapter.js'
import { logBashAnomaly, type Logger } from '../log/writer.js'
import { runBash, type BashResult } from './bash.js'
import {
  editFileToolSpec,
  executeFileTool,
  writeFileToolSpec,
  type FileToolName,
} from './files.js'
import {
  ToolError,
  type ToolContext,
  type ToolDefinition,
  type ToolDisplayKind,
  type ToolResult,
} from './types.js'

export const BASH_TOOL_NAME = 'bash'

export const bashToolSpec: ToolSpec = {
  type: 'function',
  function: {
    name: BASH_TOOL_NAME,
    description:
      '在当前工作目录执行一条 shell 命令，返回标准输出、标准错误与退出码。用于回答关于本机文件、目录、代码与系统状态的问题。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

export type BashToolContext = ToolContext

export async function executeBashTool(
  command: string,
  context: ToolContext,
): Promise<BashResult> {
  const result = await runBash(command, {
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
  })

  if (context.logger) {
    logBashAnomaly(context.logger, command, result)
  }

  return result
}

export function formatBashObservation(result: BashResult): string {
  const lines = [
    `exit_code: ${result.exitCode === null ? 'null' : result.exitCode}`,
    `signal: ${result.signal ?? 'null'}`,
    `duration_ms: ${result.durationMs}`,
    `timed_out: ${result.timedOut}`,
    `aborted: ${result.aborted}`,
    `truncated: ${result.truncated}`,
  ]

  if (result.error) {
    lines.push(`error: ${result.error}`)
  }
  if (result.stdout !== '') {
    lines.push('stdout:', result.stdout)
  }
  if (result.stderr !== '') {
    lines.push('stderr:', result.stderr)
  }

  return lines.join('\n')
}

function stringField(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function safeDescribe(args: unknown, fallback: string): string {
  if (args && typeof args === 'object') {
    const value = (args as Record<string, unknown>).path
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
    const command = (args as Record<string, unknown>).command
    if (typeof command === 'string' && command.trim() !== '') {
      return command
    }
  }
  return fallback
}

const bashTool: ToolDefinition = {
  name: BASH_TOOL_NAME,
  spec: bashToolSpec,
  displayKind: 'command',
  describe(args) {
    return safeDescribe(args, '')
  },
  async execute(args, context): Promise<ToolResult> {
    const command = stringField(args, 'command')
    if (command.trim() === '') {
      throw new ToolError('工具参数缺少非空的 command 字段')
    }

    const result = await executeBashTool(command, context)

    return {
      observation: formatBashObservation(result),
      display: {
        kind: 'command',
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
      },
    }
  },
}

function createFileTool(
  name: FileToolName,
  spec: ToolSpec,
): ToolDefinition {
  return {
    name,
    spec,
    displayKind: 'file',
    describe(args) {
      return safeDescribe(args, '(unknown)')
    },
    execute(args, context): Promise<ToolResult> {
      const result = executeFileTool(name, args, context.cwd)
      return Promise.resolve({
        observation: result.observation,
        display: {
          kind: 'file',
          tool: name,
          path: result.path,
          created: result.created,
          diff: result.diff,
        },
      })
    },
  }
}

const editFileTool = createFileTool('edit_file', editFileToolSpec)
const writeFileTool = createFileTool('write_file', writeFileToolSpec)

export function createBuiltinTools(): ToolDefinition[] {
  return [bashTool, editFileTool, writeFileTool]
}

export const toolSpecs: ToolSpec[] = createBuiltinTools().map(
  (tool) => tool.spec,
)

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new ToolError(`工具已注册: ${definition.name}`)
    }
    this.tools.set(definition.name, definition)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec)
  }

  displayKind(name: string): ToolDisplayKind {
    return this.tools.get(name)?.displayKind ?? 'generic'
  }

  describe(name: string, args: unknown): string {
    const tool = this.tools.get(name)
    if (!tool) {
      return ''
    }
    try {
      return tool.describe(args)
    } catch {
      return ''
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new ToolError(`未知工具: ${name}`)
    }
    return tool.execute(args, context)
  }
}

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of createBuiltinTools()) {
    registry.register(tool)
  }
  return registry
}

export { executeFileTool }