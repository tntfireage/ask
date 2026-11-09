import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileToolError,
  editFile,
  executeFileTool,
  writeFile,
} from '../src/tools/files.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ask-files-'))
}

describe('edit_file', () => {
  it('replaces a unique string and returns a context diff', () => {
    const cwd = tempDir()
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'line1\nold\nline3\n')

    const result = editFile(
      { path: 'a.txt', old_string: 'old', new_string: 'new' },
      cwd,
    )

    expect(readFileSync(path, 'utf8')).toBe('line1\nnew\nline3\n')
    expect(result.path).toBe('a.txt')
    expect(result.created).toBe(false)
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: ' ',
          text: 'line1',
          oldLine: 1,
          newLine: 1,
        }),
        expect.objectContaining({ kind: '-', text: 'old', oldLine: 2 }),
        expect.objectContaining({ kind: '+', text: 'new', newLine: 2 }),
        expect.objectContaining({
          kind: ' ',
          text: 'line3',
          oldLine: 3,
          newLine: 3,
        }),
      ]),
    )
    expect(result.observation).toContain('已更新 a.txt')
  })

  it('handles a replacement inside a line', () => {
    const cwd = tempDir()
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'abc OLD def\n')

    const result = editFile(
      { path: 'a.txt', old_string: 'OLD', new_string: 'NEW' },
      cwd,
    )

    expect(readFileSync(path, 'utf8')).toBe('abc NEW def\n')
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: '-', text: 'abc OLD def', oldLine: 1 }),
        expect.objectContaining({ kind: '+', text: 'abc NEW def', newLine: 1 }),
      ]),
    )
  })

  it('rejects a missing match', () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')

    expect(() =>
      editFile(
        { path: 'a.txt', old_string: 'missing', new_string: 'x' },
        cwd,
      ),
    ).toThrow(FileToolError)
    expect(() =>
      editFile(
        { path: 'a.txt', old_string: 'missing', new_string: 'x' },
        cwd,
      ),
    ).toThrow(/未在文件中找到/)
  })

  it('rejects an ambiguous match', () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'a.txt'), 'same\nsame\n')

    expect(() =>
      editFile({ path: 'a.txt', old_string: 'same', new_string: 'x' }, cwd),
    ).toThrow(/多处/)
  })

  it('reports a missing file', () => {
    const cwd = tempDir()
    expect(() =>
      editFile({ path: 'nope.txt', old_string: 'a', new_string: 'b' }, cwd),
    ).toThrow(/文件不存在/)
  })
})

describe('write_file', () => {
  it('creates parent directories and the file', () => {
    const cwd = tempDir()

    const result = writeFile(
      { path: 'nested/dir/new.txt', content: 'hello\nworld' },
      cwd,
    )

    const path = join(cwd, 'nested/dir/new.txt')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('hello\nworld')
    expect(result.created).toBe(true)
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: '+', text: 'hello', newLine: 1 }),
        expect.objectContaining({ kind: '+', text: 'world', newLine: 2 }),
      ]),
    )
    expect(result.observation).toContain('已创建')
  })

  it('overwrites an existing file and reports it', () => {
    const cwd = tempDir()
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old')

    const result = writeFile({ path: 'a.txt', content: 'new' }, cwd)

    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(result.created).toBe(false)
    expect(result.observation).toContain('已覆盖')
  })

  it('rejects an empty path', () => {
    expect(() => writeFile({ path: '  ', content: 'x' }, tempDir())).toThrow(
      FileToolError,
    )
  })
})

describe('executeFileTool', () => {
  it('dispatches by tool name', () => {
    const cwd = tempDir()
    const created = executeFileTool(
      'write_file',
      { path: 'x.txt', content: 'one\ntwo' },
      cwd,
    )
    expect(created.created).toBe(true)

    const edited = executeFileTool(
      'edit_file',
      { path: 'x.txt', old_string: 'two', new_string: 'three' },
      cwd,
    )
    expect(edited.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: '+', text: 'three', newLine: 2 }),
      ]),
    )
  })
})