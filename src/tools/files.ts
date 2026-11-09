import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { ToolSpec } from '../llm/adapter.js'

export type DiffLine = {
  kind: ' ' | '-' | '+'
  text: string
  oldLine?: number
  newLine?: number
}

export interface FileChangeResult {
  path: string
  absolutePath: string
  created: boolean
  diff: DiffLine[]
  observation: string
}

export class FileToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileToolError'
  }
}

export const editFileToolSpec: ToolSpec = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      '在文件中用 new_string 精确替换唯一的 old_string。old_string 必须在文件中恰好出现一次；若有多处匹配，需要提供更多上下文使其唯一。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径；相对路径基于当前工作目录',
        },
        old_string: {
          type: 'string',
          description: '要被替换的原文，必须在文件中唯一匹配',
        },
        new_string: {
          type: 'string',
          description: '替换后的文本',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
}

export const writeFileToolSpec: ToolSpec = {
  type: 'function',
  function: {
    name: 'write_file',
    description: '创建文件或完全覆盖已有文件。适合新建文件和整体重写。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径；相对路径基于当前工作目录',
        },
        content: {
          type: 'string',
          description: '要写入的完整文件内容',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
}

function displayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath)
  if (relativePath === '') {
    return absolutePath
  }
  if (relativePath.startsWith('..')) {
    return absolutePath
  }
  return relativePath
}

function countNewlines(text: string): number {
  let count = 0
  for (const char of text) {
    if (char === '\n') {
      count += 1
    }
  }
  return count
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function diffToText(diff: DiffLine[]): string {
  return diff.map((line) => `${line.kind} ${line.text}`).join('\n')
}

function replacementDiff(
  fileText: string,
  oldString: string,
  newString: string,
  contextLines = 2,
): DiffLine[] {
  const index = fileText.indexOf(oldString)
  const startLine = countNewlines(fileText.slice(0, index))
  const oldEndLine = startLine + countNewlines(oldString)

  const newText =
    fileText.slice(0, index) +
    newString +
    fileText.slice(index + oldString.length)
  const newEndLine = startLine + countNewlines(newString)

  const oldLines = splitLines(fileText)
  const newLines = splitLines(newText)
  const diff: DiffLine[] = []

  const contextStart = Math.max(0, startLine - contextLines)
  for (let line = contextStart; line < startLine; line += 1) {
    diff.push({
      kind: ' ',
      text: oldLines[line],
      oldLine: line + 1,
      newLine: line + 1,
    })
  }

  for (let line = startLine; line <= oldEndLine && line < oldLines.length; line += 1) {
    diff.push({ kind: '-', text: oldLines[line], oldLine: line + 1 })
  }

  for (let line = startLine; line <= newEndLine && line < newLines.length; line += 1) {
    diff.push({ kind: '+', text: newLines[line], newLine: line + 1 })
  }

  const contextEnd = Math.min(
    oldLines.length - 1,
    oldEndLine + contextLines,
  )
  for (let line = oldEndLine + 1; line <= contextEnd; line += 1) {
    const newLine = newEndLine + (line - oldEndLine)
    diff.push({
      kind: ' ',
      text: oldLines[line],
      oldLine: line + 1,
      newLine: newLine + 1,
    })
  }

  return diff
}

function contentPreview(content: string, maxLines = 40): DiffLine[] {
  const lines = splitLines(content)
  const preview: DiffLine[] = lines
    .slice(0, maxLines)
    .map((text, index) => ({ kind: '+', text, newLine: index + 1 }))

  if (lines.length > maxLines) {
    preview.push({
      kind: ' ',
      text: `... (还有 ${lines.length - maxLines} 行)`,
    })
  }

  return preview
}

export function editFile(
  args: { path: string; old_string: string; new_string: string },
  cwd: string,
): FileChangeResult {
  if (args.path.trim() === '') {
    throw new FileToolError('path 不能为空')
  }
  if (args.old_string === '') {
    throw new FileToolError('old_string 不能为空')
  }

  const absolutePath = resolve(cwd, args.path)
  if (!existsSync(absolutePath)) {
    throw new FileToolError(`文件不存在: ${displayPath(cwd, absolutePath)}`)
  }
  if (statSync(absolutePath).isDirectory()) {
    throw new FileToolError(`路径是目录: ${displayPath(cwd, absolutePath)}`)
  }

  const fileText = readFileSync(absolutePath, 'utf8')
  const first = fileText.indexOf(args.old_string)
  if (first === -1) {
    throw new FileToolError('old_string 未在文件中找到')
  }
  if (fileText.indexOf(args.old_string, first + 1) !== -1) {
    throw new FileToolError(
      'old_string 匹配到多处，请提供更多上下文使其唯一',
    )
  }

  const newText =
    fileText.slice(0, first) +
    args.new_string +
    fileText.slice(first + args.old_string.length)
  writeFileSync(absolutePath, newText, 'utf8')

  const diff = replacementDiff(fileText, args.old_string, args.new_string)
  const path = displayPath(cwd, absolutePath)

  return {
    path,
    absolutePath,
    created: false,
    diff,
    observation: `已更新 ${path}\n${diffToText(diff)}`,
  }
}

export function writeFile(
  args: { path: string; content: string },
  cwd: string,
): FileChangeResult {
  if (args.path.trim() === '') {
    throw new FileToolError('path 不能为空')
  }

  const absolutePath = resolve(cwd, args.path)
  if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    throw new FileToolError(`路径是目录: ${displayPath(cwd, absolutePath)}`)
  }

  const existed = existsSync(absolutePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, args.content, 'utf8')

  const diff = contentPreview(args.content)
  const path = displayPath(cwd, absolutePath)
  const lineCount = splitLines(args.content).length

  return {
    path,
    absolutePath,
    created: !existed,
    diff,
    observation: `${existed ? '已覆盖' : '已创建'} ${path} (${lineCount} 行)\n${diffToText(diff)}`,
  }
}

export type FileToolName = 'edit_file' | 'write_file'

export function executeFileTool(
  tool: FileToolName,
  args: Record<string, unknown>,
  cwd: string,
): FileChangeResult {
  const path = typeof args.path === 'string' ? args.path : ''

  if (tool === 'edit_file') {
    return editFile(
      {
        path,
        old_string:
          typeof args.old_string === 'string' ? args.old_string : '',
        new_string:
          typeof args.new_string === 'string' ? args.new_string : '',
      },
      cwd,
    )
  }

  return writeFile(
    {
      path,
      content: typeof args.content === 'string' ? args.content : '',
    },
    cwd,
  )
}
