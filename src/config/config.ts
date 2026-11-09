import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const SkillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  project: z.boolean().default(true),
})

export const McpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxTools: z.number().int().positive().default(128),
})

export const ConfigSchema = z.object({
  provider: z.string().min(1).default('openai-compatible'),
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,32}$/)
    .default('zh'),
  base_url: z.string().min(1).default('https://api.openai.com/v1'),
  model: z.string().min(1).default('gpt-4o-mini'),
  api_key: z.string().min(1).nullable().default(null),
  max_steps: z.number().int().positive().default(12),
  command_timeout_ms: z.number().int().positive().default(30_000),
  max_output_bytes: z.number().int().positive().default(262_144),
  temperature: z.number().min(0).max(2).default(0),
  context_window_tokens: z.number().int().positive().default(128_000),
  context_evict_ratio: z.number().gt(0).max(1).default(0.95),
  skills: SkillsConfigSchema.default({ enabled: true, project: true }),
  mcp: McpConfigSchema.default({ enabled: true, maxTools: 128 }),
})

export type AskConfig = z.infer<typeof ConfigSchema>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function askHome(): string {
  return process.env.ASK_HOME && process.env.ASK_HOME.trim() !== ''
    ? process.env.ASK_HOME
    : join(homedir(), '.ask')
}

export function configPath(): string {
  return join(askHome(), 'config.json')
}

export function historyPath(): string {
  return join(askHome(), 'history')
}

export function logPath(): string {
  return join(askHome(), 'logs', 'error.jsonl')
}

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

export function defaultConfigJson(): string {
  return `${JSON.stringify(
    {
      provider: 'openai-compatible',
      language: 'zh',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      api_key: null,
      max_steps: 12,
      command_timeout_ms: 30_000,
      max_output_bytes: 262_144,
      temperature: 0,
      context_window_tokens: 128_000,
      context_evict_ratio: 0.95,
      skills: { enabled: true, project: true },
      mcp: { enabled: true, maxTools: 128 },
    },
    null,
    2,
  )}\n`
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `  - ${path}: ${issue.message}`
    })
    .join('\n')
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const withoutEndpoint = trimmed.replace(/\/chat\/completions$/i, '')
  return withoutEndpoint === '' ? trimmed : withoutEndpoint
}

export function loadConfig(path: string = configPath()): AskConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`配置文件不存在: ${path}\n运行 ask model 创建并编辑配置。`)
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`无法读取配置文件 ${path}: ${(error as Error).message}`)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(
      `配置文件不是合法 JSON (${path}): ${(error as Error).message}`,
    )
  }

  const record = data as Record<string, unknown>
  const chinese = prefersChinese(record?.language)
  if (record && typeof record === 'object' && 'api_key_env' in record) {
    throw new ConfigError(
      chinese
        ? `配置项 api_key_env 已移除，请在 ${path} 中直接填写 api_key（运行 ask model 编辑）。`
        : `The api_key_env field has been removed. Set api_key directly in ${path} (run ask model to edit).`,
    )
  }

  const parsed = ConfigSchema.safeParse(data)
  if (!parsed.success) {
    throw new ConfigError(
      `${chinese ? '配置校验失败' : 'Config validation failed'} (${path}):\n${formatIssues(
        parsed.error,
      )}`,
    )
  }

  return {
    ...parsed.data,
    base_url: normalizeBaseUrl(parsed.data.base_url),
  }
}

function prefersChinese(language: unknown): boolean {
  return (
    typeof language !== 'string' ||
    language.trim() === '' ||
    language.trim().toLowerCase().startsWith('zh')
  )
}

export function resolveApiKey(config: AskConfig): string {
  if (config.api_key && config.api_key.trim() !== '') {
    return config.api_key.trim()
  }

  throw new ConfigError(
    prefersChinese(config.language)
      ? `未找到 API 密钥：请在 ${configPath()} 中填写 api_key（运行 ask model 编辑）。`
      : `No API key found. Set api_key in ${configPath()} (run ask model to edit).`,
  )
}

export function collectConfigWarnings(
  config: AskConfig,
  path: string = configPath(),
): string[] {
  const warnings: string[] = []

  if (config.api_key && config.api_key.trim() !== '') {
    try {
      const mode = statSync(path).mode & 0o777
      if ((mode & 0o077) !== 0) {
        warnings.push(
          prefersChinese(config.language)
            ? `配置文件权限为 ${mode.toString(8)}，可能被其他用户读取，建议执行 chmod 600 ${path}`
            : `Config file permissions are ${mode.toString(8)}; other users may read it. Run chmod 600 ${path}`,
        )
      }
    } catch {
      // 权限检查失败不阻塞启动
    }
  }

  return warnings
}
