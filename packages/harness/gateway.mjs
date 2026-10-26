import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { noteAnalystGatewayCall, recordAnalystResult } from './analyst-capture.mjs'
import { isAnalystQueryTool } from './context.mjs'
import { SQL_TOOL_REFUSED, enforcesTables, runsSql } from './sql-tools.mjs'
import { analystScopeKey, finishAnalystCallTimings, withAnalystScope } from './runtime/analyst-store.mjs'
import { executeSpecialistTool, isFlowiseMcpBinding, prepareModule, readyToolSpecs, specialistToolBindings } from './bridge.mjs'
import { HarnessError } from './errors.mjs'
import { withModelFallback } from './fallback.mjs'
import { cachedPromptTokens, invokeChat, resolveModel } from './model.mjs'
import { listDirNoFollow, readFileNoFollow } from './contained-walk.mjs'
import { removeContainedTree } from './profile.mjs'
import { dataRoot, harnessStoreDir, hermesHome } from './paths.mjs'
import { tryLockIsLive } from './try-live.mjs'
import { sessionChat } from './specialist-run.mjs'
import { getHarness } from './store.mjs'

const DEFAULT_PORT = 43118
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const tokens = new Map()
const servers = []
const inflight = new Set()
const callerWorkspaces = new Map()
let tokensLoaded = false
let contextFor = null

export function setGatewayContext(next) {
    const previous = contextFor
    contextFor = typeof next === 'function' ? next : null
    return previous
}

// The run that is in this process. The gateway otherwise only sees the harness file.
export function noteCallerWorkspace(name, workspaceId) {
    if (!name || !workspaceId) return
    const stack = callerWorkspaces.get(name) || []
    stack.push(workspaceId)
    callerWorkspaces.set(name, stack)
}

export function clearCallerWorkspace(name) {
    const stack = callerWorkspaces.get(name)
    if (!stack) return
    stack.pop()
    if (!stack.length) callerWorkspaces.delete(name)
}

function notedCallerWorkspace(name) {
    const stack = callerWorkspaces.get(name)
    if (!stack?.length) return undefined
    return stack[stack.length - 1]
}

let healthHolds = 0
// Set by start-cuttlely.sh for the server it launches: /health answers 503 from the first request until the boot
// recompile ends (finishGatewayBoot), even when a save binds the listener before the boot pass takes its hold.
let bootFinished = false
const bootPending = () => !bootFinished && process.env.CUTTLELY_GATEWAY_HOLD_UNTIL_BOOT === '1'

export function finishGatewayBoot() {
    bootFinished = true
}

// Compiling a profile binds the listener (gatewayUrl), so /health is held until the boot recompile ends.
// The returned function releases this hold once.
export function holdGatewayHealth() {
    healthHolds += 1
    let released = false
    return () => {
        if (released) return
        released = true
        healthHolds -= 1
    }
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

const closingHarnesses = new Set()

// Between closeHarnessTokens and reopenHarnessTokens no published token of that exact harness name is registered.
export function closeHarnessTokens(harnessName) {
    // Tokens on disk are loaded first, so the revocation that follows reaches them and a later lazy load cannot.
    loadTokensOnce()
    if (harnessName) closingHarnesses.add(String(harnessName))
}

export function reopenHarnessTokens(harnessName) {
    closingHarnesses.delete(String(harnessName || ''))
}

export function registerProfileToken({ token, harnessName, specialistName, modelKey, profileName, tryProfile = false }) {
    loadTokensOnce()
    // One token per profile directory. Recompiling bakery--shell replaces only that token.
    // A try profile (try{id}--shell) never evicts the published one, or another try.
    const directory = profileName || ''
    if (directory) {
        for (const [existing, meta] of [...tokens]) {
            if (meta.profileName === directory && existing !== token) tokens.delete(existing)
        }
    }
    // A harness being deleted gets no new published token: a run that compiles meanwhile cannot undo the revocation.
    if (!tryProfile && closingHarnesses.has(String(harnessName || ''))) return
    const next = {
        harnessName,
        specialistName,
        modelKey: modelKey || '',
        profileName: directory,
        tryProfile: Boolean(tryProfile)
    }
    // An unchanged token keeps its entry, so a request already running under it is not taken for revoked.
    const current = tokens.get(token)
    if (current && Object.keys(next).every((key) => current[key] === next[key])) return
    tokens.set(token, next)
}

// Whether a token is registered (used by the checks).
export function profileTokenKnown(token) {
    return Boolean(token) && tokens.has(token)
}

export function forgetProfileToken(token) {
    if (token) tokens.delete(token)
}

// Every published (not try) token of this exact harness name, and every token of the listed profile directories.
export function revokeHarnessTokens(harnessName, profileNames = [], { harnessWide = true } = {}) {
    loadTokensOnce()
    const name = harnessWide ? String(harnessName || '') : ''
    const directories = new Set(profileNames)
    for (const [token, meta] of [...tokens]) {
        if ((name && meta.harnessName === name && !meta.tryProfile) || directories.has(meta.profileName)) tokens.delete(token)
    }
}

export function startGateway(options = {}) {
    const host = options.host ?? '127.0.0.1'
    if (host !== '127.0.0.1') return Promise.reject(new Error('The harness gateway listens on 127.0.0.1 only.'))
    const port = options.port == null ? gatewayListenPort() : Number(options.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error('The harness gateway port is invalid.'))
    if (port !== 0) {
        // Resolves once the port is bound, so a port another process holds fails the start instead of passing.
        const item = ensureListening(port)
        if (item.server.listening) return Promise.resolve(item.handle)
        return new Promise((resolve, reject) => {
            const done = () => {
                item.server.off('listening', done)
                item.server.off('error', fail)
            }
            const fail = (error) => {
                done()
                reject(error)
            }
            item.server.once('listening', () => {
                done()
                resolve(item.handle)
            })
            item.server.once('error', fail)
        })
    }
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

const TRY_HOME = /^try[a-f0-9]{8,32}$/
const TRYX_HOME = /^tryx[a-f0-9]{16}$/

function tryHomeOf(entry) {
    if (TRY_HOME.test(entry)) return entry
    const split = entry.indexOf('--')
    if (split === -1) return ''
    const parent = entry.slice(0, split)
    return TRY_HOME.test(parent) ? parent : ''
}

function tryMarkerMatches(home) {
    const marker = path.join(hermesHome(), 'profiles', home, 'harness-try')
    if (!fs.existsSync(marker)) return false
    return fs.readFileSync(marker, 'utf8').trim() === home
}

// 'saved' stays. 'unknown' (the store threw) stays. Only a confirmed miss can be removed.
function savedHarnessState(name) {
    try {
        return getHarness(name) ? 'saved' : 'absent'
    } catch {
        return 'unknown'
    }
}

// A canvas try home is removable only when it carries the try marker, is not a saved harness,
// and has no live lock.
function abandonedTryHome(home) {
    if (!TRY_HOME.test(home || '')) return false
    if (savedHarnessState(home) !== 'absent') return false
    if (!tryMarkerMatches(home)) return false
    if (tryLockIsLive(home)) return false
    return true
}

// A specialist or fitted profile follows its try home. It is also a leftover when that home's
// directory or try marker is already gone, as long as the home is not a saved harness and not locked.
function abandonedChild(home) {
    if (!TRY_HOME.test(home || '')) return false
    if (tryLockIsLive(home)) return false
    if (savedHarnessState(home) !== 'absent') return false
    if (tryMarkerMatches(home)) return true
    const dir = path.join(hermesHome(), 'profiles', home)
    return !fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'harness-try'))
}

function abandonedTryEntry(entry, parentMarker) {
    const home = tryHomeOf(entry)
    if (home && entry === home) return abandonedTryHome(home)
    if (home) return abandonedChild(home)
    if (!TRYX_HOME.test(entry)) return false
    return abandonedChild(parentMarker)
}

function removeProfileTree(entry) {
    const dir = path.join(hermesHome(), 'profiles', entry)
    try {
        const env = readEnvFile(path.join(dir, '.env'))
        if (env.OPENAI_API_KEY) forgetProfileToken(env.OPENAI_API_KEY)
    } catch {
        // This entry can still be deleted. The others are a separate call.
    }
    try {
        removeContainedTree(dir)
    } catch {
        // EBUSY on this directory does not stop the rest of the sweep.
    }
    try {
        removeContainedTree(path.join(dataRoot(), 'workspaces', entry))
    } catch {
        // The profile removal above already finished or failed on its own.
    }
}

// Leftover canvas tries (and fitted profiles that belonged to one) are not a live run after a crash.
// A saved harness whose name looks like a try, and a try with a live lock file, stay.
// Returns every entry this sweep decided is abandoned, including one whose removal failed.
export function sweepAbandonedTryProfiles() {
    const abandoned = new Set()
    const root = path.join(hermesHome(), 'profiles')
    const entries = listDirNoFollow(root)
    if (!entries) return abandoned
    const drop = []
    for (const entry of entries) {
        const marker = readParent(path.join(root, entry))
        if (!abandonedTryEntry(entry, marker)) continue
        drop.push(entry)
        abandoned.add(entry)
    }
    for (const entry of drop) {
        try {
            removeProfileTree(entry)
        } catch {
            // One entry must not abort the sweep. Its token stays out of the map.
        }
    }
    return abandoned
}

function ingestProfileTokens(abandoned = new Set()) {
    const root = path.join(hermesHome(), 'profiles')
    const entries = listDirNoFollow(root)
    if (!entries) return
    for (const entry of entries) {
        if (abandoned.has(entry)) continue
        // A link is not a profile the runtime loads, including one that could not be renamed aside.
        if (entry.endsWith('.quarantine') || /\.quarantine-\d+$/.test(entry)) continue
        const dir = path.join(root, entry)
        try {
            if (fs.lstatSync(dir).isSymbolicLink()) continue
        } catch {
            continue
        }
        const env = readEnvFile(path.join(dir, '.env'))
        const token = env.OPENAI_API_KEY || ''
        const base = String(env.OPENAI_BASE_URL || '')
            .trim()
            .replace(/\/$/, '')
        if (!TOKEN_RE.test(token) || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base)) continue
        const harnessName = env.CUTTLELY_GATEWAY_HARNESS || readParent(dir)
        const specialistName = env.CUTTLELY_GATEWAY_SPECIALIST || ''
        if (!harnessName || !specialistName) continue
        if (abandonedTryEntry(entry, harnessName) || abandonedTryEntry(entry, readParent(dir))) continue
        // A published token of a deleted harness stays revoked across restarts, even if its profile is still on disk.
        if (env.CUTTLELY_GATEWAY_TRY !== '1' && !harnessSaved(harnessName)) continue
        // A harness being deleted gets no published token back from disk either.
        if (env.CUTTLELY_GATEWAY_TRY !== '1' && closingHarnesses.has(harnessName)) continue
        // A published token was issued for one saved record. A harness saved again under the name since (another
        // createdAt, or none recorded) gets fresh tokens when it next compiles, never this one.
        if (env.CUTTLELY_GATEWAY_TRY !== '1' && !issuedForSavedRecord(harnessName, env.CUTTLELY_GATEWAY_CREATED)) continue
        tokens.set(token, {
            harnessName,
            specialistName,
            modelKey: env.CUTTLELY_MODEL_KEY || '',
            profileName: entry,
            tryProfile: env.CUTTLELY_GATEWAY_TRY === '1'
        })
    }
}

// The harness has a store file (or a staged canvas delete that can still be put back).
function harnessSaved(name) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return false
    const dir = harnessStoreDir()
    return fs.existsSync(path.join(dir, `${name}.json`)) || fs.existsSync(path.join(dir, `${name}.json.deleting`))
}

function issuedForSavedRecord(name, created) {
    if (!created) return false
    const dir = harnessStoreDir()
    for (const file of [`${name}.json`, `${name}.json.deleting`]) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            if (record?.createdAt) return record.createdAt === created
        } catch {
            // Missing or unreadable: try the other file.
        }
    }
    return false
}

// A process start loads tokens only after abandoned tries are gone.
export function bootHarnessGateway() {
    tokensLoaded = false
    const abandoned = sweepAbandonedTryProfiles()
    tokensLoaded = true
    ingestProfileTokens(abandoned)
}

function loadTokensOnce() {
    if (tokensLoaded) return
    bootHarnessGateway()
}

function readParent(dir) {
    const text = readFileNoFollow(path.join(dir, 'harness-parent'))
    return text == null ? '' : text.trim()
}

function readEnvFile(file) {
    const text = readFileNoFollow(file)
    if (text == null) return {}
    const env = {}
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
}

// A request checks its token again after every await: a delete that revoked the token while the request waited for
// its body or its owner (and maybe a new harness saved under the name) must not reach that new harness.
class RevokedDuringRequest extends Error {}

// Checks wait here (after a tool's node is prepared, or a model is resolved) to revoke a token at that point.
export const gatewayRequestHooks = { beforeRun: null }

async function readyToRun(meta) {
    if (gatewayRequestHooks.beforeRun) await gatewayRequestHooks.beforeRun(meta)
    assertStillValid(meta)
}

function assertStillValid(meta) {
    for (const value of tokens.values()) if (value === meta) return
    throw new RevokedDuringRequest('Unauthorized')
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
    // While the server compiles profiles from an older compiler, /health answers 503, so Hermes waits for them.
    if (req.method === 'GET' && pathName === '/health') {
        if (healthHolds > 0 || bootPending()) sendJson(res, 503, { ok: false, starting: true })
        else sendJson(res, 200, { ok: true })
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
            const record = requireHarness(meta)
            const ctx = await ownerContext(record)
            assertStillValid(meta)
            const specs = await toolSpecs(record, meta.specialistName, ctx, meta.profileName)
            assertStillValid(meta)
            sendJson(res, 200, { tools: specs })
            return
        }
        if (req.method === 'POST' && pathName === '/harness/tools/call') {
            await callTool(req, res, meta)
            return
        }
        sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } })
    } catch (error) {
        if (res.writableEnded || res.destroyed) return
        if (error instanceof RevokedDuringRequest) {
            // The tool may already have run. The bridge must not treat this 401 as a stale token and call again.
            sendJson(res, 401, {
                error: { message: 'Unauthorized', type: 'authentication_error', code: 'revoked_during_request' }
            })
            return
        }
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

function requireHarness(meta) {
    const name = meta?.harnessName || ''
    if (!PROFILE_NAME.test(name)) throw new HarnessError('not_found', `Harness "${name}" was not found.`)
    // A try token carries the flag. The profile directory must also have the try marker.
    // A saved harness of the same name is never used for that token, and a try directory is never used for a published token.
    if (meta.tryProfile) {
        const roster = readTryRoster(name)
        if (!roster) throw new HarnessError('not_found', `Harness "${name}" was not found.`)
        return roster
    }
    const saved = getHarness(name)
    if (!saved) throw new HarnessError('not_found', `Harness "${name}" was not found.`)
    return saved
}

function readTryRoster(name) {
    const dir = path.join(hermesHome(), 'profiles', name)
    const marker = path.join(dir, 'harness-try')
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== name) return null
    const file = path.join(dir, 'harness-roster.json')
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
    const noted = notedCallerWorkspace(record.name)
    let caller = noted
    if (caller === undefined) {
        const { callerWorkspaceForJob } = await import('./queue.mjs')
        caller = callerWorkspaceForJob(record.name)
    }
    // contextFor copies the harness file's team. A known caller replaces that before the comparison.
    if (caller !== undefined) flowOptions.workspaceId = caller || undefined
    // A harness with no team is not in the caller's team. Both empty is an offline run with no team on either side.
    if ((flowOptions.workspaceId || '') !== (record.workspaceId || '')) {
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
    assertStillValid(meta)
    if (!Array.isArray(body.messages)) {
        sendJson(res, 400, { error: { message: 'messages must be an array.', type: 'invalid_request_error' } })
        return
    }
    if (body.tools != null && !Array.isArray(body.tools)) {
        sendJson(res, 400, { error: { message: 'tools must be an array.', type: 'invalid_request_error' } })
        return
    }
    const record = requireHarness(meta)
    const ctx = await ownerContext(record)
    assertStillValid(meta)
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
                await readyToRun(meta)
                try {
                    // Nothing is awaited between this check and the model call starting.
                    assertStillValid(meta)
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
    assertStillValid(meta)
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

async function toolSpecs(record, specialistName, ctx, profileName) {
    const specialist = specialistOf(record, specialistName)
    if (!specialist) return []
    const refused = new Set()
    const routes = new Map()
    const all = [...(specialist.modules || []), ...(specialist.mcpServers || [])]
    const routeOf = (binding) => {
        const index = all.indexOf(binding)
        return binding?.nodeId ? { nodeId: binding.nodeId, index } : { index }
    }
    // MCP servers advertise their own tool names, so those are read first and no node name may take one.
    const served = new Map()
    for (const binding of specialist.mcpServers || []) {
        if (!isFlowiseMcpBinding(binding)) continue
        const prepared = await prepareModule(binding, '', {
            componentNodes: ctx.componentNodes,
            loadNode: ctx.loadNode,
            flowOptions: ctx.flowOptions,
            nodeCache: ctx.nodeCache
        })
        served.set(binding, readyToolSpecs(prepared))
    }
    const reserved = new Set()
    for (const ready of served.values()) for (const spec of ready) reserved.add(spec.name)
    const names = new Map(specialistToolBindings(specialist, reserved).map((entry) => [entry.binding, entry.name]))
    const tools = []
    const nodeNamed = new Set()
    for (const binding of specialist.modules || []) {
        nodeNamed.add(names.get(binding))
        tools.push(toolSpec(binding, 'Connected node', names.get(binding)))
        routes.set(names.get(binding), routeOf(binding))
    }
    for (const binding of specialist.mcpServers || []) {
        if (!served.has(binding)) continue
        const ready = served.get(binding)
        const specs = refuseSqlTools(profileName, specialistName, binding, ready, refused, names.get(binding))
        for (const spec of ready) if (!routes.has(spec.name)) routes.set(spec.name, routeOf(binding))
        if (specs.length) tools.push(...specs)
        else if (ready.length) continue
        else {
            nodeNamed.add(names.get(binding))
            tools.push(toolSpec(binding, 'Connected MCP server', names.get(binding)))
            routes.set(names.get(binding), routeOf(binding))
        }
    }
    // A refused server's old aliases must not refuse a node that is listed under the same name.
    for (const name of nodeNamed) refused.delete(name)
    // The sets belong to this specialist profile. A try must not replace the published profile's sets.
    if (profileName) {
        refusedSqlTools.set(refusalKey(profileName), refused)
        toolRoutes.set(refusalKey(profileName), routes)
    }
    if (!tools.length && !refused.size) tools.push(toolSpec({}, 'Bound Flowise module'))
    return tools
}

// The node behind each advertised tool name, per profile, so a call runs the node it was listed for.
const toolRoutes = new Map()

// SQL tools from an MCP server that cannot limit its tables are not offered, and a call to one is refused.
const refusedSqlTools = new Map()

function refusalKey(profileName) {
    return String(profileName || '')
}

function refuseSqlTools(profileName, specialistName, binding, specs, refused, ownName) {
    if (enforcesTables(binding)) return specs
    const before = refusedSqlTools.get(refusalKey(profileName))
    const kept = []
    for (const spec of specs) {
        if (!runsSql(spec)) {
            kept.push(spec)
            continue
        }
        if (!before?.has(spec.name)) {
            console.warn(`[harness] ${profileName}/${specialistName}: refused SQL tool ${spec.name}. ${SQL_TOOL_REFUSED}`)
        }
        refused.add(spec.name)
    }
    // A call by the server's own name runs its first tool, so that name is refused with it.
    if (specs.length && runsSql(specs[0])) {
        for (const name of [binding.nodeName, binding.serverName, binding.label, ownName]) if (name) refused.add(name)
    }
    return kept
}

function routeFor(profileName, toolName) {
    const route = profileName ? toolRoutes.get(refusalKey(profileName))?.get(toolName) : null
    if (!route) return {}
    return route.nodeId ? { nodeId: route.nodeId } : { bindingIndex: route.index }
}

export function isRefusedSqlTool(profileName, toolName) {
    return Boolean(refusedSqlTools.get(refusalKey(profileName))?.has(toolName))
}

function toolSpec(binding, kind, ownName) {
    const name = ownName || binding.nodeName || binding.serverName || binding.label || 'module'
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
    assertStillValid(meta)
    if (!body.name || typeof body.name !== 'string') {
        sendJson(res, 400, { error: { message: 'Tool name is required.', type: 'invalid_request_error' } })
        return
    }
    const record = requireHarness(meta)
    const ctx = await ownerContext(record)
    assertStillValid(meta)
    // The page cursor and the analyst session use the saved harness name. meta.harnessName is the try profile.
    const scope = callScope(body.scope, record.name)
    const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? { ...body.arguments } : {}
    const callId = hermesToolCallId(body, args)
    delete args._cuttlelyCallId
    // A call can come before any tool list in this process, after a restart for example.
    if (meta.profileName && (!refusedSqlTools.has(refusalKey(meta.profileName)) || !toolRoutes.has(refusalKey(meta.profileName)))) {
        await toolSpecs(record, meta.specialistName, ctx, meta.profileName)
    }
    if (isRefusedSqlTool(meta.profileName, body.name)) {
        sendJson(res, 200, { result: JSON.stringify({ error: SQL_TOOL_REFUSED, cuttlelyOutcome: 'expected' }) })
        return
    }
    // Tool discovery awaits: a delete may have revoked the token meanwhile, and then no tool runs.
    assertStillValid(meta)
    // Step timings for the run trace. The tool result itself is unchanged.
    const timings = []
    const callStarted = performance.now()
    const result = await withAnalystScope(
        scope,
        () =>
            executeSpecialistTool(record.name, meta.specialistName, body.name, args, {
                ...routeFor(meta.profileName, body.name),
                harness: record,
                componentNodes: ctx.componentNodes,
                loadNode: ctx.loadNode,
                flowOptions: ctx.flowOptions,
                nodeCache: ctx.nodeCache,
                // Checked once the tool's node is prepared, right before the tool itself runs.
                beforeCall: () => readyToRun(meta),
                assertCall: () => assertStillValid(meta)
            }),
        { workspace: record.workspaceId, timings }
    )
    finishAnalystCallTimings(timings, performance.now() - callStarted)
    assertStillValid(meta)
    rememberAnalystResult(record.name, meta.specialistName, result, scope, body.name, args, callId, timings.at(-1))
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

function rememberAnalystResult(savedName, specialistName, result, scope, toolName, args, callId, timings) {
    const prefix = `${savedName}:`
    const chatId = typeof scope === 'string' && scope.startsWith(prefix) ? scope.slice(prefix.length) : ''
    const statement = analystStatement(args)
    // Count every analyst call, including CREATE and INSERT, so a later SELECT keeps its own sequence.
    const id = isAnalystQueryTool(toolName)
        ? noteAnalystGatewayCall({
              harness: savedName,
              specialist: specialistName,
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
    recordAnalystResult({ harness: savedName, specialist: specialistName, chatId, callId: id, result: parsed, timings })
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
