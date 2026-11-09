import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, join, relative } from 'node:path'
import YAML from 'yaml'
import { askHome, samePath } from '../config/config.js'

export type SkillSource = 'user' | 'project'

export interface Skill {
  name: string
  description: string
  body: string
  directory: string
  source: SkillSource
  files: string[]
}

export interface SkillLoadResult {
  skills: Skill[]
  warnings: string[]
}

export interface LoadSkillsOptions {
  cwd: string
  home?: string
  enabled?: boolean
  project?: boolean
  maxSkills?: number
}

const MAX_FILES = 50
const MAX_FILE_DEPTH = 3

function listFiles(directory: string, base: string): string[] {
  const files: string[] = []

  const walk = (current: string, depth: number): void => {
    if (depth > MAX_FILE_DEPTH || files.length >= MAX_FILES) {
      return
    }

    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        return
      }
      if (entry.isSymbolicLink()) {
        continue
      }
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, depth + 1)
      } else if (entry.isFile()) {
        files.push(relative(base, absolute))
      }
    }
  }

  walk(directory, 0)
  return files
}

function parseFrontmatter(raw: string): {
  metadata: Record<string, unknown> | null
  body: string
  error: string | null
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    return { metadata: null, body: raw, error: null }
  }

  try {
    const parsed: unknown = YAML.parse(match[1])
    return {
      metadata:
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : {},
      body: raw.slice(match[0].length),
      error: null,
    }
  } catch (error) {
    return {
      metadata: null,
      body: raw,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function readSkill(
  directory: string,
  source: SkillSource,
  warnings: string[],
): Skill | null {
  const skillFile = join(directory, 'SKILL.md')
  const displayPath = `${source}:${skillFile}`

  let raw: string
  try {
    raw = readFileSync(skillFile, 'utf8')
  } catch {
    return null
  }

  const parsed = parseFrontmatter(raw)
  if (parsed.error) {
    warnings.push(`Skipped ${displayPath}: invalid frontmatter (${parsed.error})`)
    return null
  }

  const metadata = parsed.metadata ?? {}
  const directoryName = basename(directory)
  const nameValue = metadata.name
  const name =
    typeof nameValue === 'string' && nameValue.trim() !== ''
      ? nameValue.trim()
      : directoryName

  const descriptionValue = metadata.description
  const description =
    typeof descriptionValue === 'string'
      ? descriptionValue.replace(/\s+/g, ' ').trim()
      : ''
  if (description === '') {
    warnings.push(`Skipped ${displayPath}: missing description`)
    return null
  }

  return {
    name,
    description,
    body: parsed.body,
    directory,
    source,
    files: listFiles(directory, directory),
  }
}

function scanDirectory(
  root: string,
  source: SkillSource,
  warnings: string[],
): Skill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return []
  }

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    warnings.push(
      `Failed to read skill directory ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return []
  }

  const skills: Skill[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue
    }
    const skill = readSkill(join(root, entry.name), source, warnings)
    if (skill) {
      skills.push(skill)
    }
  }
  return skills
}

export function loadSkills(options: LoadSkillsOptions): SkillLoadResult {
  if (options.enabled === false) {
    return { skills: [], warnings: [] }
  }

  const warnings: string[] = []
  const byName = new Map<string, Skill>()

  const userRoot = join(options.home ?? askHome(), 'skills')
  const projectRoot = join(options.cwd, '.ask', 'skills')

  for (const skill of scanDirectory(userRoot, 'user', warnings)) {
    byName.set(skill.name, skill)
  }

  if (options.project !== false && !samePath(userRoot, projectRoot)) {
    for (const skill of scanDirectory(projectRoot, 'project', warnings)) {
      byName.set(skill.name, skill)
    }
  }

  let skills = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const maxSkills = options.maxSkills ?? 50
  if (skills.length > maxSkills) {
    skills = skills.slice(0, maxSkills)
  }

  return { skills, warnings }
}