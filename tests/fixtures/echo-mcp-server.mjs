#!/usr/bin/env node
/**
 * A dependency-free MCP server over stdio, used as the live-verification peer.
 *
 * It implements just enough of the Model Context Protocol to prove a whole
 * round trip: initialize, tools/list, tools/call. Nothing from the MCP SDK is
 * imported, so the fixture cannot accidentally agree with the client because
 * both share a broken dependency — if the harness bridge connects to this and
 * sees `mcp__echo__echo`, the wire format really is what each side thinks it is.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio
 * framing — messages are separated by newlines and contain none themselves).
 * Diagnostics go to stderr, because anything on stdout must be a protocol frame.
 *
 * Optional argv[1] names the server (`serverInfo.name`), so one fixture can back
 * more than one configured server.
 */

import process from 'node:process'

const serverName = typeof process.argv[2] === 'string' && process.argv[2] !== '' ? process.argv[2] : 'fixture-echo'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back. Used by the manager live check to prove a tool call round trip.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two integers. A second tool, so tool counting is not satisfied by a single entry.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]

/** Write one JSON-RPC message as a single line on stdout. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Answer one request. */
function handle(message) {
  const { id, method } = message
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: '0.0.1' },
        },
      })
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    case 'tools/call': {
      const params = message.params ?? {}
      const name = params.name
      const args = params.arguments ?? {}
      if (name === 'echo') {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(args.text ?? '') }] },
        })
      }
      if (name === 'add') {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] },
        })
      }
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${String(name)}` } })
    }
    case 'resources/list':
      return send({ jsonrpc: '2.0', id, result: { resources: [] } })
    case 'prompts/list':
      return send({ jsonrpc: '2.0', id, result: { prompts: [] } })
    default:
      if (id === undefined) return undefined // a notification: never answered
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(method)}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      try {
        handle(JSON.parse(line))
      } catch (error) {
        process.stderr.write(`fixture: bad frame: ${String(error)}\n`)
      }
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write(`fixture ${serverName} ready\n`)
