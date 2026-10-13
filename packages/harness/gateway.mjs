import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { noteAnalystGatewayCall, recordAnalystResult } from './analyst-capture.mjs'
import { isAnalystQueryTool } from './context.mjs'
import { SQL_TOOL_REFUSED, enforcesTables, runsSql } from './sql-tools.mjs'
import { analystScopeKey, withAnalystScope } from './runtime/analyst-store.mjs'
import { executeSpecialistTool, isFlowiseMcpBinding, prepareModule, readyToolSpecs } from './bridge.mjs'
import { HarnessError } from './errors.mjs'
import { withModelFallback } from './fallback.mjs'
import { cachedPromptTokens, invokeChat, resolveModel } from './model.mjs'
import { hermesHome } from './paths.mjs'
import { sessionChat } from './specialist-run.mjs'
import { getHarness } from './store.mjs'

const DEFAULT_PORT = 43118
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const tokens = new Map()
const servers = []
const inflight = new Set()
let tokensLoaded = false
let contextFor = null

export function setGatewayContext(next) {
    contextFor = typeof next === 'function' ? next : null
}

export function gatewayListenPort() {
    const raw = process.env.CUTTLELY_HARNESS_GATEWAY_PORT
    if (raw == null || raw === '') return DEFAULT_PORT
    const port = Number(raw)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('CUTTLELY_HARNESS_GATEWAY_PORT must be a TCP port.')
    }
    return port
}

export function gatewayOrigin() {
    ensureListening(gatewayListenPort())
    return `http://127.0.0.1:${gatewayListenPort()}`
}

export function gatewayUrl() {
    return `${gatewayOrigin()}/v1`
}

export function registerProfileToken({ token, harnessName, specialistName, modelKey, profileName }) {
    loadTokensOnce()
    // One token per profile directory. Recompiling bakery--shell replaces only that token.
    // A try profile (try{id}--shell) never evicts the published one, or another try.
    const directory = profileName || ''
    if (directory) {
        for (const [existing, meta] of [...tokens]) {
            if (meta.profileName === directory && existing !== token) tokens.delete(existing)
        }
    }
    tokens.set(token, { harnessName, specialistName, modelKey: modelKey || '', profileName: directory })
}

export function forgetProfileToken(token) {
    if (token) tokens.delete(token)
}

export function startGateway(options = {}) {
    const host = options.host ?? '127.0.0.1'
    if (host !== '127.0.0.1') return Promise.reject(new Error('The harness gateway listens on 127.0.0.1 only.'))
    const port = options.port == null ? gatewayListenPort() : Number(options.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error('The harness gateway port is invalid.'))
    if (port !== 0) return Promise.resolve(ensureListening(port).handle)
    loadTokensOnce()
    return new Promise((resolve, reject) => {
        const server = http.createServer(onRequest)
        const fail = (error) => reject(error)
        server.once('error', fail)
        server.listen(0, '127.0.0.1', () => {
            server.off('error', fail)
            server.unref()
            const assigned = server.address().port
            watchServer(server, assigned)
            resolve(trackServer(server, assigned).handle)
        })
    })
}

export function trackGatewayCall(profileName, controller) {
    const entry = { profileName, controller }
    inflight.add(entry)
    return () => inflight.delete(entry)
}

export function abortGatewayProfile(profileName) {
    for (const entry of inflight) {
        if (!profileName || entry.profileName === profileName) entry.controller.abort()
    }
}

function bindRequest(req, res, profileName) {
    const controller = new AbortController()
    const release = trackGatewayCall(profileName, controller)
    // `req` `close` also fires after a normal body read. Abort only when the client leaves early.
    const abort = () => {
        if (!res.writableEnded) controller.abort()
    }
    res.on('close', abort)
    req.on('aborted', abort)
    return {
        signal: controller.signal,
        release() {
            release()
            res.off('close', abort)
            req.off('aborted', abort)
        }
    }
}

export function stopGateway() {
    const closing = servers.splice(0).map((item) => item.handle.close())
    return Promise.all(closing)
}

function ensureListening(port) {
    loadTokensOnce()
    const found = servers.find((item) => item.port === port)
    if (found) return found
    const server = http.createServer(onRequest)
    watchServer(server, port)
    server.listen(port, '127.0.0.1')
    server.unref()
    return trackServer(server, port)
}

function watchServer(server, port) {
    server.on('error', (error) => {
        const index = servers.findIndex((item) => item.server === server)
        if (index !== -1) servers.splice(index, 1)
        console.warn(`[harness] gateway on 127.0.0.1:${port} failed: ${error.message}`)
    })
}

function trackServer(server, port) {
    const item = { port, server, handle: null }
    const handle = {
        server,
        port,
        close() {
            return new Promise((resolve) => {
                const finish = () => {
                    const index = servers.indexOf(item)
                    if (index !== -1) servers.splice(index, 1)
                    resolve()
                }
                if (!server.listening) {
                    finish()
                    return
                }
                server.close(() => finish())
                server.closeIdleConnections?.()
                server.closeAllConnections?.()
            })
        }
    }
    item.handle = handle
    servers.push(item)
    return item
}

function loadTokensOnce() {
    if (tokensLoaded) return
    tokensLoaded = true
    const root = path.join(hermesHome(), 'profiles')
    if (!fs.existsSync(root)) return
    for (const entry of fs.readdirSync(root)) {
        const env = readEnvFile(path.join(root, entry, '.env'))
        const token = env.OPENAI_API_KEY || ''
        const base = String(env.OPENAI_BASE_URL || '')
            .trim()
            .replace(/\/$/, '')
        if (!TOKEN_RE.test(token) || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base)) continue
        const harnessName = env.CUTTLELY_GATEWAY_HARNESS || readParent(path.join(root, entry))
        const specialistName = env.CUTTLELY_GATEWAY_SPECIALIST || ''
        if (!harnessName || !specialistName) continue
        tokens.set(token, {
            harnessName,
            specialistName,
            modelKey: env.CUTTLELY_MODEL_KEY || '',
            profileName: entry
        })
    }
}

function readParent(dir) {
    const file = path.join(dir, 'harness-parent')
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8').trim()
}

function readEnvFile(file) {
    if (!fs.existsSync(file)) return {}
    const env = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
}

function lookupToken(presented) {
    const text = String(presented || '')
    const given = Buffer.from(text)
    let found = null
    for (const [token, meta] of tokens) {
        const buf = Buffer.from(token)
        if (buf.length === given.length && buf.length > 0 && crypto.timingSafeEqual(buf, given)) found = meta
    }
    return found
}

function bearer(req) {
    const header = String(req.headers.authorization || '')
    const match = header.match(/^Bearer\s+(\S+)\s*$/i)
    return match ? match[1] : ''
}

function isLoopback(address) {
    return LOOPBACK.has(address)
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
}

function publicMessage(message, token) {
    let text = String(message || 'The model request failed.')
    if (token && text.includes(token)) text = text.split(token).join('[key]')
    return text
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > 1_000_000) {
                reject(Object.assign(new Error('Request body is too large.'), { statusCode: 400 }))
                req.destroy()
            } else chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function pathnameOf(req) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathName = url.pathname.replace(/\/+$/, '')
    return pathName || '/'
}

async function onRequest(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: { message: 'The harness gateway accepts loopback clients only.', type: 'forbidden' } })
        return
    }
    const pathName = pathnameOf(req)
    // The start script waits for this before it launches Hermes. No token: the process just has to be up.
    if (req.method === 'GET' && pathName === '/health') {
        sendJson(res, 200, { ok: true })
        return
    }
    const token = bearer(req)
    const meta = lookupToken(token)
    if (!meta) {
        sendJson(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } })
        return
    }
    try {
        if (req.method === 'GET' && pathName === '/v1/models') {
            sendJson(res, 200, {
                object: 'list',
                data: [{ id: meta.profileName, object: 'model', created: unixNow(), owned_by: 'cuttlely' }]
            })
            return
        }
        if (req.method === 'POST' && pathName === '/v1/chat/completions') {
            await completeChat(req, res, meta)
            return
        }
        if (req.method === 'POST' && pathName === '/harness/tools/list') {
            const record = requireHarness(meta.harnessName)
            const ctx = await ownerContext(record)
            sendJson(res, 200, { tools: await toolSpecs(record, meta.specialistName, ctx) })
            return
        }
        if (req.method === 'POST' && pathName === '/harness/tools/call') {
            await callTool(req, res, meta)
            return
        }
        sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } })
    } catch (error) {
        if (res.writableEnded || res.destroyed) return
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            if (!res.headersSent) sendJson(res, 499, { error: { message: 'Client disconnected', type: 'aborted' } })
            return
        }
        const status = error?.statusCode || 502
        sendJson(res, status, { error: { message: publicMessage(error?.message, token), type: error?.code || 'server_error' } })
    }
}

function unixNow() {
    return Math.floor(Date.now() / 1000)
}

const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function requireHarness(name) {
    if (!PROFILE_NAME.test(name || '')) throw new HarnessError('not_found', `Harness "${name}" was not found.`)
    const saved = getHarness(name)
    if (saved) return saved
    // A draft try registers its token under the try profile directory. That name is not a saved harness.
    const roster = readProfileRoster(name)
    if (roster) return roster
    throw new HarnessError('not_found', `Harness "${name}" was not found.`)
}

function readProfileRoster(name) {
    const file = path.join(hermesHome(), 'profiles', name, 'harness-roster.json')
    if (!fs.existsSync(file)) return null
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.specialists)) return null
        return parsed
    } catch {
        return null
    }
}

function specialistOf(record, name) {
    return (record.specialists || []).find((item) => item.name === name) || null
}

function fallbackBinding(record, specialistName) {
    const specialist = specialistOf(record, specialistName)
    if (specialist?.fallbackModel?.nodeName) return specialist.fallbackModel
    if (record.chief?.fallbackModel?.nodeName) return record.chief.fallbackModel
    return null
}

function modelBinding(record, specialistName) {
    const specialist = specialistOf(record, specialistName)
    if (!specialist) throw new HarnessError('not_found', `Specialist "${specialistName}" is not on harness "${record.name}".`)
    if (specialist.model?.nodeName) return specialist.model
    if (record.chief?.model?.nodeName) return record.chief.model
    throw new HarnessError('stale_record', `Harness "${record.name}" was saved by an older Cuttlely. Open its canvas and save it again.`)
}

async function ownerContext(record) {
    if (typeof contextFor !== 'function') {
        throw new HarnessError('no_flow_context', 'Harness tools need the Cuttlely server context; run them through a chat flow.')
    }
    const runtime = await contextFor(record)
    const flowOptions = { ...(runtime?.flowOptions || {}) }
    if (record.workspaceId && flowOptions.workspaceId !== record.workspaceId) {
        throw new HarnessError('wrong_workspace', `Harness "${record.name}" belongs to another workspace.`)
    }
    if (flowOptions.callerChatflowId == null && flowOptions.chatflowid != null) flowOptions.callerChatflowId = flowOptions.chatflowid
    if (record.chatflowId) flowOptions.chatflowid = record.chatflowId
    return {
        componentNodes: runtime?.componentNodes,
        loadNode: runtime?.loadNode,
        flowOptions,
        nodeCache: new Map(),
        modelCache: new Map()
    }
}

// OpenAI semantics: no tool_choice means auto. Hermes omits it, and forcing required made a
// finished agent loop call tools forever instead of answering.
function toolChoiceOf(value) {
    if (value == null) return 'auto'
    if (value === 'auto' || value === 'required' || value === 'none') return value
    return undefined
}

function openAiToolCalls(toolCalls) {
    return (toolCalls || []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function?.name || '', arguments: call.function?.arguments ?? '{}' }
    }))
}

function finishReason(toolCalls) {
    return toolCalls.length ? 'tool_calls' : 'stop'
}

async function completeChat(req, res, meta) {
    const body = await parseJson(req)
    if (!Array.isArray(body.messages)) {
        sendJson(res, 400, { error: { message: 'messages must be an array.', type: 'invalid_request_error' } })
        return
    }
    if (body.tools != null && !Array.isArray(body.tools)) {
        sendJson(res, 400, { error: { message: 'tools must be an array.', type: 'invalid_request_error' } })
        return
    }
    const record = requireHarness(meta.harnessName)
    const ctx = await ownerContext(record)
    const primary = modelBinding(record, meta.specialistName)
    const fallback = fallbackBinding(record, meta.specialistName)
    const bound = bindRequest(req, res, meta.profileName)
    let result
    try {
        result = await withModelFallback({
            primary,
            fallback,
            onUse: () => console.info(`[harness] ${record.name} gateway fallback ${fallback.label || fallback.nodeName}`),
            run: async (binding, windowMs, controlSignal) => {
                const parts = [bound.signal]
                if (controlSignal) parts.push(controlSignal)
                const deadline = windowMs > 0 ? AbortSignal.timeout(windowMs) : undefined
                if (deadline) parts.push(deadline)
                const signal = parts.length > 1 ? AbortSignal.any(parts) : parts[0]
                const resolved = await resolveModel(binding, ctx)
                try {
                    return await invokeChat(resolved, {
                        messages: body.messages,
                        tools: body.tools,
                        toolChoice: toolChoiceOf(body.tool_choice),
                        temperature: body.temperature,
                        maxTokens: body.max_tokens,
                        stop: body.stop,
                        signal
                    })
                } catch (error) {
                    if (deadline?.aborted && !bound.signal.aborted && !controlSignal?.aborted) {
                        throw new HarnessError('model_slow', `${resolved.label || 'chat model'} did not answer within ${windowMs}ms.`)
                    }
                    throw error
                }
            }
        })
    } finally {
        bound.release()
    }
    if (bound.signal.aborted || res.writableEnded) return
    const toolCalls = openAiToolCalls(result.toolCalls)
    const created = unixNow()
    const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`
    const reason = finishReason(toolCalls)
    const usage = openAiUsage(result.usage)
    if (body.stream === true) {
        writeStream(res, { id, created, model: meta.profileName, content: result.content, toolCalls, reason, usage })
        return
    }
    const message = { role: 'assistant', content: result.content ?? '' }
    if (toolCalls.length) message.tool_calls = toolCalls
    const payload = {
        id,
        object: 'chat.completion',
        created,
        model: meta.profileName,
        choices: [{ index: 0, message, finish_reason: reason }]
    }
    if (usage) payload.usage = usage
    sendJson(res, 200, payload)
}

// Hermes counts a specialist's tokens from the usage on each model reply. Chat models report it in different
// shapes; the reply carries the OpenAI one, with the cached prompt tokens when the model reported them.
export function openAiUsage(usage) {
    if (!usage || typeof usage !== 'object') return null
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens
    const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens
    if (prompt == null && completion == null) return null
    const prompt_tokens = Number(prompt) || 0
    const completion_tokens = Number(completion) || 0
    const cached = cachedPromptTokens(usage)
    return {
        prompt_tokens,
        completion_tokens,
        total_tokens: Number(usage.total_tokens ?? usage.totalTokens) || prompt_tokens + completion_tokens,
        ...(cached != null ? { prompt_tokens_details: { cached_tokens: cached } } : {})
    }
}

function writeStream(res, { id, created, model, content, toolCalls, reason, usage }) {
    const delta = { role: 'assistant' }
    if (content) delta.content = content
    if (toolCalls.length) delta.tool_calls = toolCalls
    const head = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }]
    }
    const tail = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: reason }]
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify(head)}\n\n`)
    res.write(`data: ${JSON.stringify(tail)}\n\n`)
    // The usage chunk OpenAI sends last when a client asks for include_usage.
    if (usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
}

async function toolSpecs(record, specialistName, ctx) {
    const specialist = specialistOf(record, specialistName)
    if (!specialist) return []
    const tools = []
    const refused = new Set()
    for (const binding of specialist.modules || []) tools.push(toolSpec(binding, 'Connected node'))
    for (const binding of specialist.mcpServers || []) {
        if (!isFlowiseMcpBinding(binding)) continue
        const prepared = await prepareModule(binding, '', {
            componentNodes: ctx.componentNodes,
            loadNode: ctx.loadNode,
            flowOptions: ctx.flowOptions,
            nodeCache: ctx.nodeCache
        })
        const ready = readyToolSpecs(prepared)
        const specs = refuseSqlTools(record, specialistName, binding, ready, refused)
        if (specs.length) tools.push(...specs)
        else if (ready.length) continue
        else tools.push(toolSpec(binding, 'Connected MCP server'))
    }
    refusedSqlTools.set(refusedKey(record.name, specialistName), refused)
    if (!tools.length && !refused.size) tools.push(toolSpec({}, 'Bound Flowise module'))
    return tools
}

// SQL tools from an MCP server that cannot limit its tables are not offered, and a call to one is refused.
const refusedSqlTools = new Map()

function refusedKey(harnessName, specialistName) {
    return `${harnessName}\0${specialistName}`
}

function refuseSqlTools(record, specialistName, binding, specs, refused) {
    if (enforcesTables(binding)) return specs
    const before = refusedSqlTools.get(refusedKey(record.name, specialistName))
    const kept = []
    for (const spec of specs) {
        if (!runsSql(spec)) {
            kept.push(spec)
            continue
        }
        if (!before?.has(spec.name)) {
            console.warn(`[harness] ${record.name}/${specialistName}: refused SQL tool ${spec.name}. ${SQL_TOOL_REFUSED}`)
        }
        refused.add(spec.name)
    }
    // A call by the server's own name runs its first tool, so that name is refused with it.
    if (specs.length && runsSql(specs[0])) {
        for (const name of [binding.nodeName, binding.serverName, binding.label]) if (name) refused.add(name)
    }
    return kept
}

export function isRefusedSqlTool(harnessName, specialistName, toolName) {
    return Boolean(refusedSqlTools.get(refusedKey(harnessName, specialistName))?.has(toolName))
}

function toolSpec(binding, kind) {
    const name = binding.nodeName || binding.serverName || binding.label || 'module'
    const label = binding.label || binding.nodeName || binding.serverName || 'node'
    const detail = binding.description ? ` ${binding.description}` : ''
    return {
        name,
        description: `${kind} ${label}.${detail} Pass the request as input.`,
        inputSchema: { type: 'object', properties: { input: { type: 'string' }, query: { type: 'string' } } }
    }
}

async function callTool(req, res, meta) {
    const body = await parseJson(req)
    if (!body.name || typeof body.name !== 'string') {
        sendJson(res, 400, { error: { message: 'Tool name is required.', type: 'invalid_request_error' } })
        return
    }
    const record = requireHarness(meta.harnessName)
    const ctx = await ownerContext(record)
    const scope = callScope(body.scope, meta.harnessName)
    const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? { ...body.arguments } : {}
    const callId = hermesToolCallId(body, args)
    delete args._cuttlelyCallId
    // A call can come before any tool list in this process, after a restart for example.
    if (!refusedSqlTools.has(refusedKey(meta.harnessName, meta.specialistName))) {
        await toolSpecs(record, meta.specialistName, ctx)
    }
    if (isRefusedSqlTool(meta.harnessName, meta.specialistName, body.name)) {
        sendJson(res, 200, { result: JSON.stringify({ error: SQL_TOOL_REFUSED, cuttlelyOutcome: 'expected' }) })
        return
    }
    const result = await withAnalystScope(
        scope,
        () =>
            executeSpecialistTool(meta.harnessName, meta.specialistName, body.name, args, {
                harness: record,
                componentNodes: ctx.componentNodes,
                loadNode: ctx.loadNode,
                flowOptions: ctx.flowOptions,
                nodeCache: ctx.nodeCache
            }),
        { workspace: record.workspaceId }
    )
    rememberAnalystResult(meta, result, scope, body.name, args, callId)
    sendJson(res, 200, { result })
}

// Hermes sends its session id as the scope. A per-turn id ends in a turn mark; the cursor belongs to the chat.
export function callScope(raw, harnessName) {
    const text = typeof raw === 'string' ? sessionChat(raw.trim()) : ''
    if (!text) return ''
    const colon = text.indexOf(':')
    const chat = colon === -1 ? text : text.slice(colon + 1)
    return analystScopeKey(harnessName, chat)
}

function hermesToolCallId(body, args) {
    for (const key of ['tool_call_id', 'toolCallId', 'callId']) {
        const value = body?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
    }
    const embedded = args?._cuttlelyCallId
    if (typeof embedded === 'string' && embedded.trim()) return embedded.trim().slice(0, 200)
    return ''
}

function analystStatement(args) {
    if (!args || typeof args !== 'object') return { sql: '', cursor: '' }
    let sql = ''
    for (const key of ['sql', 'statement', 'query']) {
        if (typeof args[key] === 'string' && args[key].trim()) {
            sql = args[key]
            break
        }
    }
    const cursor = typeof args.cursor === 'string' ? args.cursor : ''
    return { sql, cursor }
}

function rememberAnalystResult(meta, result, scope, toolName, args, callId) {
    const prefix = `${meta.harnessName}:`
    const chatId = typeof scope === 'string' && scope.startsWith(prefix) ? scope.slice(prefix.length) : ''
    const statement = analystStatement(args)
    // Count every analyst call, including CREATE and INSERT, so a later SELECT keeps its own sequence.
    const id = isAnalystQueryTool(toolName)
        ? noteAnalystGatewayCall({
              harness: meta.harnessName,
              specialist: meta.specialistName,
              chatId,
              callId,
              sql: statement.sql,
              cursor: statement.cursor
          })
        : ''
    const text = typeof result === 'string' ? result : ''
    if (!text) return
    let parsed
    try {
        parsed = JSON.parse(text)
    } catch {
        return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    if (!Array.isArray(parsed.rows) && typeof parsed.summary !== 'string' && !parsed.cuttlelyOutcome && !parsed.cursor) return
    recordAnalystResult({ harness: meta.harnessName, specialist: meta.specialistName, chatId, callId: id, result: parsed })
}

async function parseJson(req) {
    const text = await readBody(req)
    if (!text) return {}
    try {
        const body = JSON.parse(text)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const error = new Error('Request body must be a JSON object.')
            error.statusCode = 400
            throw error
        }
        return body
    } catch (error) {
        if (error?.statusCode) throw error
        const bad = new Error('Request body is not JSON.')
        bad.statusCode = 400
        throw bad
    }
}
