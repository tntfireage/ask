export interface SkillSummary {
  name: string
  description: string
}

export const MAX_DESCRIPTION_LENGTH = 200

export function summarizeSkills(
  skills: SkillSummary[],
): SkillSummary[] {
  return skills.map((skill) => {
    const description = skill.description.replace(/\s+/g, ' ').trim()
    return {
      name: skill.name,
      description:
        description.length > MAX_DESCRIPTION_LENGTH
          ? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
          : description,
    }
  })
}

export function skillPromptSection(
  skills: SkillSummary[],
  maxChars = 4_000,
): string {
  if (skills.length === 0) {
    return ''
  }

  const summaries = summarizeSkills(skills)
  const lines = [
    'Available skills (invoke the `skill` tool with the name when the task matches):',
  ]
  let used = 0
  let included = 0

  for (const skill of summaries) {
    const line = `- ${skill.name}: ${skill.description}`
    if (used + line.length + 1 > maxChars) {
      break
    }
    lines.push(line)
    used += line.length + 1
    included += 1
  }

  if (included < summaries.length) {
    lines.push(`... (${summaries.length - included} more available via /skills)`)
  }

  return lines.join('\n')
}