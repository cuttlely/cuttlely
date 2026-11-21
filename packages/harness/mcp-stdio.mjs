// MCP stdio uses newline-delimited JSON; older Content-Length callers remain supported.
// No listeners are attached here, so importing a server can stay side-effect free.
export function createMcpStdio(handle, write) {
    let buffer = Buffer.alloc(0)
    let framing = 'line'
    function receive(chunk) {
        buffer = Buffer.concat([buffer, chunk])
        // Consume every complete message and retain partial bytes for the next read.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const text = buffer.toString('utf8', 0, Math.min(buffer.length, 32)).trimStart()
            if (/^Content-Length:/i.test(text)) {
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
                framing = 'header'
                handle(body)
                continue
            }
            const newline = buffer.indexOf('\n')
            if (newline === -1) return
            const line = buffer.slice(0, newline).toString('utf8').trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            framing = 'line'
            handle(line)
        }
    }

    function send(message) {
        const payload = JSON.stringify(message)
        const packet = framing === 'header' ? `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}` : `${payload}\n`
        write(packet)
    }

    return { receive, send }
}
