import assert from 'node:assert/strict'
import http from 'node:http'
import { after, describe, it } from 'node:test'
import { createOrchestrateProxy } from './orchestrate-live-proxy.mjs'

function listen(server, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        server.listen(0, host, () => {
            const addr = server.address()
            if (!addr || typeof addr === 'string') return reject(new Error('no port'))
            resolve(addr.port)
        })
    })
}

function close(server) {
    return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

const seen = { method: '', path: '', headers: {}, body: '' }
const target = http.createServer((req, res) => {
    seen.method = req.method
    seen.path = req.url
    seen.headers = { ...req.headers }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
        seen.body = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.flushHeaders()
        res.write('event: thread.message.delta\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
        res.end()
    })
})

const targetPort = await listen(target)
const proxy = createOrchestrateProxy(`http://127.0.0.1:${targetPort}`)
const proxyPort = await listen(proxy)

after(async () => {
    await close(proxy)
    await close(target)
})

function call(method, path, headers = {}, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: proxyPort, method, path, headers }, (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
    })
}

describe('orchestrate live proxy', () => {
    it('forwards GET and POST A2A paths with Accept, and still 404s other routes', async () => {
        const card = await call('GET', '/api/v1/a2a/11111111-1111-4111-8111-111111111111/.well-known/agent-card.json', {
            authorization: 'Bearer test-key',
            'x-api-key': 'test-key',
            accept: 'application/json'
        })
        assert.equal(card.status, 200)
        assert.equal(seen.method, 'GET')
        assert.equal(seen.path, '/api/v1/a2a/11111111-1111-4111-8111-111111111111/.well-known/agent-card.json')
        assert.equal(seen.headers.accept, 'application/json')
        assert.equal(seen.headers.authorization, 'Bearer test-key')

        const rpc = await call(
            'POST',
            '/api/v1/a2a/11111111-1111-4111-8111-111111111111',
            { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': 'test-key' },
            '{"jsonrpc":"2.0","id":1,"method":"message/stream","params":{}}'
        )
        assert.equal(rpc.status, 200)
        assert.equal(seen.method, 'POST')
        assert.equal(seen.path, '/api/v1/a2a/11111111-1111-4111-8111-111111111111')
        assert.equal(seen.headers.accept, 'text/event-stream')
        assert.equal((await call('GET', '/api/v1/a2a/11111111-1111-4111-8111-111111111111')).status, 404)
        assert.equal((await call('POST', '/api/v1/a2a/11111111-1111-4111-8111-111111111111/extra')).status, 404)
    })

    it('forwards POST /api/v1/orchestrate/* with the body and the four headers, and 404s everything else', async () => {
        const body = '{"messages":[{"role":"user","content":"Hi"}]}'
        const res = await call(
            'POST',
            '/api/v1/orchestrate/11111111-1111-4111-8111-111111111111/chat/completions',
            {
                authorization: 'Bearer test-key',
                'x-api-key': 'test-key',
                'x-ibm-thread-id': 'Ada-01',
                'content-type': 'application/json',
                cookie: 'cuttlely_session=should-not-pass',
                'x-cuttlely-session-token': 'tok'
            },
            body
        )
        assert.equal(res.status, 200)
        assert.match(res.body, /thread\.message\.delta/)
        assert.equal(seen.method, 'POST')
        assert.equal(seen.path, '/api/v1/orchestrate/11111111-1111-4111-8111-111111111111/chat/completions')
        assert.equal(seen.body, body)
        assert.equal(seen.headers.authorization, 'Bearer test-key')
        assert.equal(seen.headers['x-api-key'], 'test-key')
        assert.equal(seen.headers['x-ibm-thread-id'], 'Ada-01')
        assert.equal(seen.headers['content-type'], 'application/json')
        assert.equal(seen.headers.cookie, undefined)
        assert.equal(seen.headers['x-cuttlely-session-token'], undefined)

        assert.equal((await call('GET', '/api/v1/orchestrate/x')).status, 404)
        assert.equal((await call('POST', '/api/v1/prediction/x')).status, 404)
        assert.equal((await call('PUT', '/api/v1/orchestrate/x')).status, 404)
        assert.equal((await call('POST', '/api/v1/orchestrate')).status, 404)
    })

    it('pipes SSE without buffering the body', async () => {
        const slow = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.flushHeaders()
            res.write('event: thread.message.delta\ndata: {"n":1}\n\n')
            setTimeout(() => {
                res.write('event: thread.message.delta\ndata: {"n":2}\n\n')
                res.end()
            }, 80)
        })
        const slowPort = await listen(slow)
        const slowProxy = createOrchestrateProxy(`http://127.0.0.1:${slowPort}`)
        const slowProxyPort = await listen(slowProxy)
        try {
            const arrived = []
            await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: '127.0.0.1',
                        port: slowProxyPort,
                        method: 'POST',
                        path: '/api/v1/orchestrate/flow',
                        headers: { 'content-type': 'application/json' }
                    },
                    (res) => {
                        res.on('data', (chunk) => arrived.push({ at: Date.now(), text: chunk.toString('utf8') }))
                        res.on('end', resolve)
                    }
                )
                req.on('error', reject)
                req.end('{}')
            })
            assert.equal(arrived.length >= 2, true)
            assert.match(arrived[0].text, /"n":1/)
            assert.equal(
                arrived.slice(1).some((row) => row.text.includes('"n":2')),
                true
            )
            assert.equal(arrived[arrived.length - 1].at - arrived[0].at >= 40, true)
        } finally {
            await close(slowProxy)
            await close(slow)
        }
    })
})
