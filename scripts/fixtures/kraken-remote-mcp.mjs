import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { once } from 'node:events'

export const tool = {
    name: 'ops_status',
    description: 'Read the allowlisted ops status note.',
    inputSchema: { type: 'object', properties: {} }
}
export const good = 'ops-status: allowlisted MCP tool responded'

// HTTP and legacy SSE share the same deterministic operation. An unexpected outbound
// method, endpoint, argument or credential fails the fixture instead of contacting a provider.
export async function statusResponder(mode, token) {
    const streams = new Map()
    const seen = []
    const control = { tool, wait: false, redirect: false, path: '/events', answer: good }
    const server = http.createServer(async (req, res) => {
        seen.push({ method: req.method, url: req.url, authorized: req.headers.authorization === 'Bearer ' + token })
        res.on('error', () => {})
        if (req.headers.authorization !== 'Bearer ' + token) {
            res.writeHead(401)
            res.end()
            return
        }
        if (control.redirect && req.url === '/stream') {
            res.writeHead(307, { location: '/unapproved' })
            res.end()
            return
        }
        if (mode === 'sse' && req.url === '/stream') {
            if (req.method !== 'GET') {
                res.writeHead(405)
                res.end()
                return
            }
            const session = randomUUID()
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
            streams.set(session, res)
            res.write('event: endpoint\ndata: ' + control.path + '?sessionId=' + session + '\n\n')
            res.on('close', () => streams.delete(session))
            return
        }
        if (mode === 'http' && req.method === 'DELETE') {
            res.writeHead(200)
            res.end()
            return
        }
        if (mode === 'http' && req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
        }
        if (mode === 'sse' && !req.url.startsWith('/events?sessionId=')) {
            res.writeHead(404)
            res.end()
            return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = JSON.parse(raw)
        const session = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
        let result
        if (body.method === 'initialize')
            result = {
                protocolVersion: body.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' }
            }
        if (body.method === 'tools/list') result = { tools: [control.tool, { name: 'other', inputSchema: { type: 'object' } }] }
        if (body.method === 'tools/call') {
            seen.push({ name: body.params.name, args: body.params.arguments })
            assert.equal(body.params.name, 'ops_status')
            assert.deepEqual(body.params.arguments, {})
            if (control.wait) {
                control.onCall?.()
                return
            }
            result = { content: [{ type: 'text', text: control.answer }] }
        }
        if (!result) {
            res.writeHead(202)
            res.end()
            return
        }
        const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
        if (mode === 'sse') {
            res.writeHead(202)
            res.end()
            streams.get(session)?.write('event: message\ndata: ' + reply + '\n\n')
        } else {
            res.writeHead(200, {
                'content-type': 'application/json',
                ...(body.method === 'initialize' ? { 'mcp-session-id': randomUUID() } : {})
            })
            res.end(reply)
        }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const close = async () => {
        const stopped = once(server, 'close')
        server.close()
        server.closeAllConnections()
        await stopped
    }
    const origin = 'http://127.0.0.1:' + server.address().port
    return { control, seen, origin, close }
}
