// A small web app backed by a Cuttlely flow. The browser talks only to this server; this server calls Cuttlely
// with the API key, so the key never reaches the browser.
//
//   CUTTLELY_URL=http://localhost:43117 CUTTLELY_FLOW_ID=<flow id> CUTTLELY_API_KEY=<key> node server.mjs
//
// Then open http://localhost:8080. No dependencies: Node 18 or newer.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 16 * 1024

export function config(env = process.env) {
    return {
        cuttlelyUrl: (env.CUTTLELY_URL || 'http://localhost:43117').replace(/\/+$/, ''),
        flowId: env.CUTTLELY_FLOW_ID || '',
        apiKey: env.CUTTLELY_API_KEY || '',
        port: Number(env.PORT || 8080)
    }
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('Request too large'), { status: 413 }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
            } catch {
                reject(Object.assign(new Error('Send JSON'), { status: 400 }))
            }
        })
        req.on('error', reject)
    })
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
}

// Only these fields go to Cuttlely. The browser cannot set overrideConfig or anything else on the flow.
export function predictionBody({ question }, session) {
    if (typeof question !== 'string' || !question.trim()) {
        throw Object.assign(new Error('Ask a question'), { status: 400 })
    }
    if (question.length > 2000) throw Object.assign(new Error('Keep the question under 2000 characters'), { status: 400 })
    const body = { question: question.trim(), streaming: true }
    // Cuttlely issues the chat id on the first answer. Later questions send it back with its session token.
    if (session?.chatId) body.chatId = session.chatId
    return body
}

// Cuttlely sets the session as an httpOnly cookie, `cuttlely_session=<chat id>.<token>`, on a streamed answer.
// This server reads it and keeps it, so the browser never holds the token.
export function sessionFromSetCookie(setCookies = []) {
    for (const line of setCookies) {
        const match = /^cuttlely_session=([^;]*)/.exec(line)
        if (!match) continue
        const pairs = decodeURIComponent(match[1]).split(',')
        const last = pairs[pairs.length - 1]
        const dot = last.indexOf('.')
        if (dot > 0) return { chatId: last.slice(0, dot), sessionToken: last.slice(dot + 1) }
    }
    return null
}

// One entry per browser conversation: our own random id -> Cuttlely's chat id and session token.
// In memory for the example; use your app's session store in production.
export class Conversations {
    constructor(max = 1000) {
        this.max = max
        this.map = new Map()
    }
    get(id) {
        return typeof id === 'string' ? this.map.get(id) : undefined
    }
    set(id, session) {
        this.map.delete(id)
        this.map.set(id, session)
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    }
}

async function ask(req, res, cfg, conversations) {
    const input = await readJson(req)
    let conversationId = typeof input.conversationId === 'string' ? input.conversationId : ''
    let session = conversations.get(conversationId)
    if (!session) conversationId = randomUUID()
    const body = predictionBody(input, session)
    const headers = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    if (session?.sessionToken) headers['x-cuttlely-session-token'] = session.sessionToken
    const upstream = await fetch(`${cfg.cuttlelyUrl}/api/v1/prediction/${encodeURIComponent(cfg.flowId)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    })
    if (!upstream.ok) {
        // Pass the status on, but not Cuttlely's message: it can name the flow or the server's settings.
        const status = upstream.status === 429 ? 429 : 502
        const error = upstream.status === 429 ? 'Too many questions. Try again in a minute.' : 'The assistant is not available right now.'
        console.error(`Cuttlely answered ${upstream.status}`)
        return sendJson(res, status, { error })
    }
    const sse = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Conversation-Id': conversationId }
    const type = upstream.headers.get('content-type') || ''
    if (!type.includes('text/event-stream')) {
        // The flow cannot stream (for example a harness without streaming): send the whole answer as one event.
        const json = await upstream.json()
        if (json.chatId && json.sessionToken) conversations.set(conversationId, { chatId: json.chatId, sessionToken: json.sessionToken })
        res.writeHead(200, sse)
        res.write(`message:\ndata:${JSON.stringify({ event: 'token', data: json.text || '' })}\n\n`)
        res.write(`message:\ndata:${JSON.stringify({ event: 'end', data: '[DONE]' })}\n\n`)
        return res.end()
    }
    const issued = sessionFromSetCookie(upstream.headers.getSetCookie?.() || [])
    if (issued) conversations.set(conversationId, issued)
    res.writeHead(200, sse)
    const reader = upstream.body.getReader()
    req.on('close', () => reader.cancel().catch(() => {}))
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
    }
    res.end()
}

export function createServer(cfg = config(), conversations = new Conversations()) {
    return http.createServer(async (req, res) => {
        try {
            if (req.method === 'POST' && req.url === '/api/ask') return await ask(req, res, cfg, conversations)
            if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                return res.end(await readFile(path.join(here, 'public', 'index.html')))
            }
            if (req.method === 'GET' && req.url === '/app.js') {
                res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
                return res.end(await readFile(path.join(here, 'public', 'app.js')))
            }
            sendJson(res, 404, { error: 'Not found' })
        } catch (err) {
            if (res.headersSent) return res.end()
            sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' })
        }
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cfg = config()
    if (!cfg.flowId) {
        console.error('Set CUTTLELY_FLOW_ID to the id of the flow to call.')
        process.exit(1)
    }
    createServer(cfg).listen(cfg.port, () => console.info(`Bakery helper on http://localhost:${cfg.port}`))
}
