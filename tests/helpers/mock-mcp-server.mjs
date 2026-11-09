#!/usr/bin/env node
import readline from 'node:readline'

const tools = [
  {
    name: 'echo',
    description: 'Echo the provided text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'fail',
    description: 'Always fails',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Responds after five seconds',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'die',
    description: 'Returns and then exits the server',
    inputSchema: { type: 'object', properties: {} },
  },
]

process.stderr.write('mock-mcp ready\n')

const rl = readline.createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  if (line.trim() === '') {
    return
  }

  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.id === undefined) {
    return
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    })
    return
  }

  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }

  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}

    if (name === 'die') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'bye' }] },
      })
      setTimeout(() => process.exit(0), 50)
      return
    }

    if (name === 'slow') {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'slow-done' }] },
        })
      }, 5_000)
      return
    }

    if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        },
      })
      return
    }

    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `echo:${args.text ?? ''}` }],
      },
    })
    return
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  })
})