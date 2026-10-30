import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { dataRoot } from './paths.mjs'
import { writeAnalystMcpStatus } from './runtime/analyst-mcp-status.mjs'

// Same shape profile.mjs accepts for a specialist gateway token (32 bytes, base64url).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const PROFILE_ENV_MAX = 256 * 1024

const analystBridge = process.env.CUTTLELY_ANALYST_BRIDGE === '1'

function analystStatusDir() {
    return process.env.CUTTLELY_DATA_DIR || dataRoot()
}

const harnessName = flag('--harness')
const specialistName = flag('--specialist')
// Optional --tool-revision is a cache identity for Hermes, not a gateway argument.
// Older callers without it continue to list/call the current specialist's tools.

function flag(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? '' : process.argv[index + 1] || ''
}

let buffer = Buffer.alloc(0)
// MCP stdio is newline-delimited JSON. Content-Length framing is still accepted for older callers.
let framing = 'line'
process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    // The framing loop runs until the stdin chunk is fully consumed.
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
})

async function handle(body) {
    let message
    try {
        message = JSON.parse(body)
    } catch {
        return
    }
    // JSON-RPC ids may be 0 (the Python MCP SDK starts there); only a missing id is a notification.
    const hasId = message.id !== undefined && message.id !== null
    if (!hasId && message.method) return
    if (message.method === 'initialize') {
        return send(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: `cuttlely-${harnessName}-${specialistName}`, version: '1.0.0' }
        })
    }
    if (message.method === 'tools/list') {
        try {
            const result = await postGateway('/harness/tools/list', {})
            const tools = result.tools || []
            recordAnalystStatus(tools.length)
            return send(message.id, { tools })
        } catch (error) {
            // An empty list used to stick in Hermes for the process lifetime. A JSON-RPC error
            // is a failed connect, which Hermes retries.
            recordAnalystStatus(0)
            return sendError(message.id, -32000, error.message)
        }
    }
    if (message.method === 'tools/call') {
        const params = message.params || {}
        try {
            const args = { ...(params.arguments || {}) }
            const scope = typeof args._cuttlelyScope === 'string' ? args._cuttlelyScope : ''
            delete args._cuttlelyScope
            const result = await postGateway('/harness/tools/call', { name: params.name, arguments: args, scope })
            const value = result.result
            const text = typeof value === 'string' ? value : JSON.stringify(value)
            const outcome = toolOutcome(value)
            if (outcome) {
                const messageText = typeof value === 'string' ? outcomeText(value) : outcomeText(text)
                return send(message.id, {
                    content: [{ type: 'text', text: messageText }],
                    isError: true,
                    structuredContent: { cuttlelyOutcome: outcome }
                })
            }
            return send(message.id, { content: [{ type: 'text', text }], isError: false })
        } catch (error) {
            return send(message.id, { content: [{ type: 'text', text: error.message }], isError: true })
        }
    }
    if (hasId) send(message.id, {})
}

function recordAnalystStatus(tools) {
    // No gateway token means this profile is not an analyst specialist. Do not
    // let that failed tools/list replace a specialist's ready status with 0.
    if (!analystBridge) return
    if (!String(process.env.CUTTLELY_HARNESS_GATEWAY_TOKEN || '').trim()) return
    writeAnalystMcpStatus(tools, analystStatusDir())
}

// Hermes copies this into the bridge env once, when it starts the process. A later profile
// recompile mints a new token and revokes this one. The replacement is cached here.
let gatewayToken = process.env.CUTTLELY_HARNESS_GATEWAY_TOKEN || ''

function gatewayTarget(requestPath) {
    const base = process.env.CUTTLELY_HARNESS_GATEWAY_URL || ''
    const token = gatewayToken
    if (!base || !token) throw new Error('The harness gateway is not configured for this profile.')
    let url
    try {
        url = new URL(requestPath, base.endsWith('/') ? base : `${base}/`)
    } catch {
        throw new Error('The harness gateway URL is not valid.')
    }
    if (url.hostname !== '127.0.0.1') throw new Error('The harness gateway listens on 127.0.0.1 only.')
    return { url, token }
}

function postGateway(requestPath, body) {
    return postGatewayAttempt(requestPath, body, false)
}

function postGatewayAttempt(requestPath, body, refreshed) {
    const { url, token } = gatewayTarget(requestPath)
    const payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    authorization: `Bearer ${token}`
                },
                timeout: 130000
            },
            (res) => {
                const chunks = []
                res.on('data', (chunk) => chunks.push(chunk))
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8')
                    let parsed = {}
                    try {
                        parsed = text ? JSON.parse(text) : {}
                    } catch {
                        parsed = { error: { message: text } }
                    }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed)
                        return
                    }
                    const failure = new Error(parsed?.error?.message || `Gateway returned ${res.statusCode}`)
                    // One re-read per request. A second 401, or the same token still on disk, stays a failure.
                    // A token revoked after the tool already ran is not a stale credential: retrying would run the tool again.
                    if (res.statusCode === 401 && !refreshed && parsed?.error?.code !== 'revoked_during_request') {
                        const next = readRotatedToken(token)
                        if (next) {
                            gatewayToken = next
                            postGatewayAttempt(requestPath, body, true).then(resolve, reject)
                            return
                        }
                    }
                    reject(failure)
                })
            }
        )
        req.on('error', (error) => reject(error))
        req.on('timeout', () => {
            req.destroy()
            reject(new Error('The harness gateway did not answer.'))
        })
        req.write(payload)
        req.end()
    })
}

// profile.mjs puts this specialist's .env path in CUTTLELY_HARNESS_PROFILE_ENV. The live token is OPENAI_API_KEY.
function readRotatedToken(used) {
    const file = String(process.env.CUTTLELY_HARNESS_PROFILE_ENV || '').trim()
    if (!file || !path.isAbsolute(file)) return ''
    let text = ''
    try {
        text = readProfileEnv(file)
    } catch {
        return ''
    }
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1 || trimmed.slice(0, eq) !== 'OPENAI_API_KEY') continue
        const value = trimmed.slice(eq + 1).trim()
        if (TOKEN_RE.test(value) && value !== used) return value
    }
    return ''
}

function readProfileEnv(file) {
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || !st.isFile() || st.size <= 0 || st.size > PROFILE_ENV_MAX) return ''
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
        const again = fs.fstatSync(fd)
        if (again.isSymbolicLink() || !again.isFile() || again.size <= 0 || again.size > PROFILE_ENV_MAX) return ''
        const buf = Buffer.alloc(again.size)
        let off = 0
        while (off < again.size) {
            // Position tracks the file offset. A short read must not start over at byte 0.
            const n = fs.readSync(fd, buf, off, again.size - off, off)
            if (n <= 0) break
            off += n
        }
        return buf.subarray(0, off).toString('utf8')
    } finally {
        fs.closeSync(fd)
    }
}

function toolOutcome(value) {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            return ''
        }
    }
    const outcome = parsed?.cuttlelyOutcome
    return outcome === 'expected' || outcome === 'transport' ? outcome : ''
}

function outcomeText(value) {
    try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error
    } catch {
        // The raw text is the tool result.
    }
    return value
}

function send(id, result) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result })
    const packet = framing === 'header' ? `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}` : `${payload}\n`
    fs.writeSync(1, packet)
}

function sendError(id, code, message) {
    const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message: String(message || 'The harness gateway did not answer.') }
    })
    const packet = framing === 'header' ? `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}` : `${payload}\n`
    fs.writeSync(1, packet)
}
