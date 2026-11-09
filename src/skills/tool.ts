import type { ToolSpec } from '../llm/adapter.js'
import { ToolError, type ToolDefinition, type ToolResult } from '../tools/types.js'
import type { Skill } from './loader.js'

export const SKILL_TOOL_NAME = 'skill'

const MAX_BODY_BYTES = 64 * 1024

export const skillToolSpec: ToolSpec = {
  type: 'function',
  function: {
    name: SKILL_TOOL_NAME,
    description:
      '按名称加载本地技能说明。返回技能正文、技能目录绝对路径与目录内文件清单。当任务与某个技能描述匹配时调用。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要加载的技能名称',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
}

function truncateBody(body: string): string {
  if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) {
    return body
  }
  const sliced = Buffer.from(body, 'utf8')
    .subarray(0, MAX_BODY_BYTES)
    .toString('utf8')
  return `${sliced}\n...[skill body truncated]...`
}

export function createSkillTool(skills: Skill[]): ToolDefinition {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const available = skills.map((skill) => skill.name).join(', ')

  return {
    name: SKILL_TOOL_NAME,
    spec: skillToolSpec,
    displayKind: 'generic',
    describe(args) {
      return typeof args === 'object' && args !== null
        ? String((args as Record<string, unknown>).name ?? '')
        : ''
    },
    async execute(args): Promise<ToolResult> {
      const name =
        typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') {
        throw new ToolError('缺少非空的 name 字段')
      }

      const skill = byName.get(name)
      if (!skill) {
        throw new ToolError(
          `未知技能: ${name}${available === '' ? '' : `。可用: ${available}`}`,
        )
      }

      const body = truncateBody(skill.body)
      const files = skill.files.length === 0 ? '(none)' : skill.files.join(', ')
      const observation = [
        `Skill: ${skill.name}`,
        `Source: ${skill.source}`,
        `Directory: ${skill.directory}`,
        `Files: ${files}`,
        '---',
        body,
      ].join('\n')

      return {
        observation,
        display: {
          kind: 'generic',
          tool: SKILL_TOOL_NAME,
          title: skill.name,
          summary: `${skill.source} · ${skill.files.length} files`,
          ok: true,
        },
      }
    },
  }
}