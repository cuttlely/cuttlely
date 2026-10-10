import fs from 'node:fs'

const tools = [
    {
        name: 'ops_status',
        description: 'Read the allowlisted ops status note.',
        inputSchema: { type: 'object', properties: {} }
    }
]

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.slice(0, headerEnd).toString('utf8')
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) {
            buffer = buffer.slice(headerEnd + 4)
            continue
        }
        const length = Number(match[1])
        const start = headerEnd + 4
        if (buffer.length < start + length) return
        const body = buffer.slice(start, start + length).toString('utf8')
        buffer = buffer.slice(start + length)
        handle(JSON.parse(body))
    }
})

function handle(message) {
    if (!message.id) return
    if (message.method === 'initialize') {
        return send(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'cuttlely-ops', version: '1.0.0' }
        })
    }
    if (message.method === 'tools/list') return send(message.id, { tools })
    if (message.method === 'tools/call') {
        return send(message.id, {
            content: [{ type: 'text', text: 'ops-status: allowlisted MCP tool responded' }],
            isError: false
        })
    }
    send(message.id, {})
}

function send(id, result) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result })
    fs.writeSync(1, `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
}
