import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpCallResult } from './client.js'

export interface MappedMcpResult {
  observation: string
  summary: string
  ok: boolean
  images: string[]
}

export interface MapResultOptions {
  artifactDir: string
  maxBytes: number
}

const TRUNCATION_MARKER = '\n...[truncated]...\n'

function extensionFor(mimeType: string | undefined): string {
  switch ((mimeType ?? '').toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

function truncate(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }
  const half = Math.max(1, Math.floor(maxBytes / 2))
  const head = buffer.subarray(0, half).toString('utf8')
  const tail = buffer.subarray(buffer.length - half).toString('utf8')
  return `${head}${TRUNCATION_MARKER}${tail}`
}

function firstLine(text: string, maxLength = 120): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? ''
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line
}

export function mapMcpResult(
  result: McpCallResult,
  options: MapResultOptions,
): MappedMcpResult {
  const parts: string[] = []
  const images: string[] = []

  for (const [index, raw] of result.content.entries()) {
    if (!raw || typeof raw !== 'object') {
      parts.push(String(raw))
      continue
    }

    const item = raw as Record<string, unknown>
    const type = typeof item.type === 'string' ? item.type : ''

    if (type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }

    if (type === 'image' && typeof item.data === 'string') {
      try {
        mkdirSync(options.artifactDir, { recursive: true })
        const extension = extensionFor(
          typeof item.mimeType === 'string' ? item.mimeType : undefined,
        )
        const path = join(
          options.artifactDir,
          `image-${Date.now()}-${index}.${extension}`,
        )
        writeFileSync(path, Buffer.from(item.data, 'base64'))
        images.push(path)
        parts.push(`[image saved: ${path}]`)
      } catch (error) {
        parts.push(
          `[image could not be saved: ${
            error instanceof Error ? error.message : String(error)
          }]`,
        )
      }
      continue
    }

    if (type === 'resource' && item.resource && typeof item.resource === 'object') {
      const resource = item.resource as Record<string, unknown>
      if (typeof resource.text === 'string') {
        parts.push(`[resource] ${resource.text}`)
      } else if (typeof resource.uri === 'string') {
        parts.push(`[resource: ${resource.uri}]`)
      }
      continue
    }

    parts.push(`[unsupported content: ${type || 'unknown'}]`)
  }

  if (result.structuredContent !== undefined) {
    parts.push(`[structured] ${JSON.stringify(result.structuredContent)}`)
  }

  const body = parts.join('\n')
  const observation = truncate(
    result.isError ? `error: true\n${body}` : body,
    options.maxBytes,
  )

  return {
    observation,
    summary: firstLine(observation),
    ok: !result.isError,
    images,
  }
}