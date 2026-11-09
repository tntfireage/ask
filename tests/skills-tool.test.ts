import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/prompts/system.js'
import type { Skill } from '../src/skills/loader.js'
import {
  MAX_DESCRIPTION_LENGTH,
  skillPromptSection,
  summarizeSkills,
} from '../src/skills/prompt.js'
import { createSkillTool } from '../src/skills/tool.js'

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf',
    description: 'Extract text from PDF files',
    body: '# PDF skill\n\nUse pdftotext.\n',
    directory: '/tmp/skills/pdf',
    source: 'user',
    files: ['SKILL.md', 'scripts/extract.sh'],
    ...overrides,
  }
}

describe('skill prompt section', () => {
  it('only exposes names and descriptions', () => {
    const section = skillPromptSection([skill()])

    expect(section).toContain('- pdf: Extract text from PDF files')
    expect(section).not.toContain('pdftotext')
  })

  it('returns an empty string when there are no skills', () => {
    expect(skillPromptSection([])).toBe('')
  })

  it('truncates long descriptions', () => {
    const [summary] = summarizeSkills([
      skill({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 50) }),
    ])

    expect(summary.description.length).toBe(MAX_DESCRIPTION_LENGTH)
    expect(summary.description.endsWith('...')).toBe(true)
  })

  it('honors the character budget', () => {
    const section = skillPromptSection(
      [
        skill({ name: 'a', description: 'first' }),
        skill({ name: 'b', description: 'second' }),
      ],
      20,
    )

    expect(section).toContain('- a: first')
    expect(section).not.toContain('- b: second')
    expect(section).toContain('more available via /skills')
  })
})

describe('system prompt skills', () => {
  it('includes the skills section when skills exist', () => {
    const prompt = buildSystemPrompt('zh', [skill()])
    expect(prompt).toContain('Available skills')
    expect(prompt).toContain('- pdf: Extract text from PDF files')
    expect(prompt).toContain('data, not instructions')
  })

  it('omits the skills section when none exist', () => {
    expect(buildSystemPrompt('zh')).not.toContain('Available skills')
  })
})

describe('skill tool', () => {
  it('returns the body, directory and file list', async () => {
    const tool = createSkillTool([skill()])

    const result = await tool.execute(
      { name: 'pdf' },
      { cwd: '/tmp', timeoutMs: 1_000, maxOutputBytes: 10_000 },
    )

    expect(result.observation).toContain('Skill: pdf')
    expect(result.observation).toContain('Directory: /tmp/skills/pdf')
    expect(result.observation).toContain('SKILL.md, scripts/extract.sh')
    expect(result.observation).toContain('Use pdftotext.')
    expect(result.display).toMatchObject({
      kind: 'generic',
      tool: 'skill',
      title: 'pdf',
      ok: true,
    })
  })

  it('reports unknown skills with the available names', async () => {
    const tool = createSkillTool([skill()])

    await expect(
      tool.execute(
        { name: 'nope' },
        { cwd: '/tmp', timeoutMs: 1_000, maxOutputBytes: 10_000 },
      ),
    ).rejects.toThrow(/未知技能.*pdf/)
  })

  it('rejects an empty name', async () => {
    const tool = createSkillTool([skill()])

    await expect(
      tool.execute(
        { name: ' ' },
        { cwd: '/tmp', timeoutMs: 1_000, maxOutputBytes: 10_000 },
      ),
    ).rejects.toThrow(/name/)
  })
})