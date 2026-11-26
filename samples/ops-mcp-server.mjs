const tool = {
    name: 'ops_status',
    description: 'Read the allowlisted ops status note.',
    inputSchema: { type: 'object', properties: {} }
}

// Keep this example runnable with Node alone when an operator copies it to an MCP host.
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    let newline
    while ((newline = buffer.indexOf(10)) !== -1) {
        const line = buffer.toString('utf8', 0, newline).trim()
        const header = /^Content-Length:\s*(\d+)$/i.exec(line)
        let body = line
        if (header) {
            const separator = buffer.indexOf('\r\n\r\n')
            if (separator < 0) return
            const start = separator + 4
            const end = start + Number(header[1])
            if (buffer.length < end) return
            body = buffer.toString('utf8', start, end)
            buffer = buffer.subarray(end)
        } else {
            buffer = buffer.subarray(newline + 1)
        }
        if (!body) continue
        const response = handle(body)
        if (response) {
            const json = JSON.stringify(response)
            process.stdout.write(header ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`)
        }
    }
})

function handle(body) {
    let request
    try {
        request = JSON.parse(body)
    } catch {
        return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
    }
    if (request?.id == null) return
    const response = { jsonrpc: '2.0', id: request.id }
    switch (request.method) {
        case 'initialize':
            response.result = {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'cuttlely-ops', version: '1.0.0' }
            }
            break
        case 'ping':
            response.result = {}
            break
        case 'tools/list':
            response.result = { tools: [tool] }
            break
        case 'tools/call':
            if (request.params?.name === tool.name) {
                response.result = { content: [{ type: 'text', text: 'ops-status: allowlisted MCP tool responded' }], isError: false }
            } else {
                response.error = { code: -32602, message: 'Unknown tool' }
            }
            break
        default:
            response.error = { code: -32601, message: 'Method not found' }
    }
    return response
}
