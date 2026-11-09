import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkills } from '../src/skills/loader.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ask-skills-'))
}

function writeSkill(
  root: string,
  name: string,
  options: { description?: string | null; body?: string; file?: string } = {},
): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  const description =
    options.description === undefined ? `${name} skill` : options.description
  const frontmatter =
    description === null
      ? `---\nname: ${name}\n---\n`
      : `---\nname: ${name}\ndescription: ${description}\n---\n`
  writeFileSync(
    join(directory, 'SKILL.md'),
    `${frontmatter}${options.body ?? `# ${name}\n`}`,
    'utf8',
  )
  if (options.file) {
    const filePath = join(directory, options.file)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'echo hi\n', 'utf8')
  }
  return directory
}

describe('loadSkills', () => {
  it('loads user and project skills, with project overriding by name', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeSkill(join(home, 'skills'), 'alpha', { body: '# user alpha\n' })
    writeSkill(join(home, 'skills'), 'shared', { body: '# user shared\n' })
    writeSkill(join(cwd, '.ask', 'skills'), 'beta', { body: '# project beta\n' })
    writeSkill(join(cwd, '.ask', 'skills'), 'shared', {
      body: '# project shared\n',
    })

    const result = loadSkills({ cwd, home })

    expect(result.skills.map((skill) => skill.name)).toEqual([
      'alpha',
      'beta',
      'shared',
    ])
    const shared = result.skills.find((skill) => skill.name === 'shared')
    expect(shared?.source).toBe('project')
    expect(shared?.body).toContain('project shared')
    expect(result.warnings.join('\n')).not.toContain('overrides')
  })

  it('skips skills without a description', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeSkill(join(home, 'skills'), 'bad', { description: null })
    writeSkill(join(home, 'skills'), 'good', { description: 'ok' })

    const result = loadSkills({ cwd, home })

    expect(result.skills.map((skill) => skill.name)).toEqual(['good'])
    expect(result.warnings.join('\n')).toContain('missing description')
  })

  it('honors enabled and project toggles', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeSkill(join(home, 'skills'), 'user')
    writeSkill(join(cwd, '.ask', 'skills'), 'project')

    expect(loadSkills({ cwd, home, enabled: false }).skills).toEqual([])
    const withoutProject = loadSkills({ cwd, home, project: false })
    expect(withoutProject.skills.map((skill) => skill.name)).toEqual(['user'])
  })

  it('limits the number of loaded skills', () => {
    const home = tempDir()
    const cwd = tempDir()
    for (const name of ['a', 'b', 'c']) {
      writeSkill(join(home, 'skills'), name)
    }

    const result = loadSkills({ cwd, home, maxSkills: 2 })
    expect(result.skills.map((skill) => skill.name)).toEqual(['a', 'b'])
  })

  it('lists files inside the skill directory', () => {
    const home = tempDir()
    const cwd = tempDir()
    writeSkill(join(home, 'skills'), 'pdf', { file: 'scripts/extract.sh' })

    const skill = loadSkills({ cwd, home }).skills[0]
    expect(skill.files).toContain('SKILL.md')
    expect(skill.files).toContain('scripts/extract.sh')
    expect(skill.directory).toContain('pdf')
  })

  it('does not scan the same directory twice when cwd is home', () => {
    const home = tempDir()
    writeSkill(join(home, 'skills'), 'pdf')

    const result = loadSkills({ cwd: home, home })
    expect(result.skills).toHaveLength(1)
    expect(result.warnings.join('\n')).not.toContain('overrides')
  })
})