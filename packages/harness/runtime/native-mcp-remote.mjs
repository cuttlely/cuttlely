// Only the packaged, reviewed status contract is eligible. A tool name or server-provided
// readOnlyHint alone grants no network access, arguments, credentials or arbitrary remote tools.
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { HarnessError } from '../errors.mjs'
const components = createRequire(new URL('../../components/package.json', import.meta.url))
const reviewed = 'ops_status'
const operation = { name: reviewed, description: 'Read the allowlisted ops status note.', inputSchema: { type: 'object', properties: {} } }
const maxBytes = 512 * 1024
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const deny = () => new HarnessError('forbidden', 'This workspace MCP endpoint or action is no longer authorized.')
function parse(value) {
    return typeof value === 'string' ? JSON.parse(value) : value
}
function safeUrl(raw) {
    const u = new URL(raw)
    const https = u.protocol === 'https:'
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if ((!https && !local) || u.username || u.password || u.search || u.hash || u.href !== raw) throw deny()
    return u
}
function approved(workspaceId, serverId) {
    try {
        const input = process.env.CUTTLELY_NATIVE_MCP_ENDPOINTS
        if (!input || input.length > 32768) return
        const grants = JSON.parse(input)
        if (!Array.isArray(grants) || grants.length > 128) return
        const matching = grants.filter((item) => item?.serverId === serverId && item.workspaceId === workspaceId)
        if (matching.length !== 1) return
        const grant = matching[0]
        if (Object.keys(grant).some((k) => !['serverId', 'workspaceId', 'url', 'ssePostUrl', 'actions'].includes(k))) return
        if (!Array.isArray(grant.actions) || grant.actions.length !== 1 || grant.actions[0] !== reviewed) return
        const url = safeUrl(grant.url)
        if (grant.ssePostUrl && safeUrl(grant.ssePostUrl).origin !== url.origin) return
        return grant
    } catch {
        return
    }
}
export function remoteBinding(binding, workspaceId) {
    if (binding?.nodeName !== 'customMcpServerTool' || !workspaceId || binding.credential || Object.keys(binding.upstream || {}).length)
        return
    try {
        const inputs = binding.inputs || {}
        const serverId = inputs.mcpServerId
        if (!uuid.test(serverId) || Object.keys(inputs).some((k) => !['mcpServerId', 'mcpActions'].includes(k))) return
        const actions = parse(inputs.mcpActions || [])
        if (!Array.isArray(actions) || actions.length !== 1 || actions[0] !== reviewed) return
        const grant = approved(workspaceId, serverId)
        if (grant) return { entry: 'workspace:' + serverId, workspaceId, serverId, actions, grant }
    } catch {
        return
    }
}
function sameGrant(server) {
    const next = approved(server.workspaceId, server.serverId)
    if (!next || next.url !== server.grant.url || next.ssePostUrl !== server.grant.ssePostUrl) throw deny()
}
function conforming(tool) {
    const schema = tool?.inputSchema
    return (
        tool?.name === reviewed &&
        schema?.type === 'object' &&
        Object.keys(schema.properties || {}).length === 0 &&
        (!schema.required || (Array.isArray(schema.required) && !schema.required.length)) &&
        (schema.additionalProperties === undefined || schema.additionalProperties === false) &&
        Object.keys(schema).every((k) => ['type', 'properties', 'required', 'additionalProperties'].includes(k)) &&
        tool.annotations?.readOnlyHint !== false &&
        tool.annotations?.destructiveHint !== true &&
        tool.annotations?.openWorldHint !== true
    )
}
export function remoteTool(tools) {
    const matching = tools.filter((t) => t?.name === reviewed)
    if (matching.length !== 1 || !conforming(matching[0])) throw deny()
    return operation
}
async function row(server, flow) {
    sameGrant(server)
    if (flow?.workspaceId !== server.workspaceId || !flow.databaseEntities?.CustomMcpServer || !flow.appDataSource) throw deny()
    const stored = await flow.appDataSource.getRepository(flow.databaseEntities.CustomMcpServer).findOne({
        where: { id: server.serverId, workspaceId: server.workspaceId },
        select: { id: true, workspaceId: true, serverUrl: true, status: true, authType: true, authConfig: true, tools: true }
    })
    if (
        stored?.id !== server.serverId ||
        stored.workspaceId !== server.workspaceId ||
        stored.status !== 'AUTHORIZED' ||
        stored.serverUrl !== server.grant.url ||
        stored.authType !== 'CUSTOM_HEADERS' ||
        typeof stored.authConfig !== 'string' ||
        !stored.authConfig ||
        Buffer.byteLength(stored.authConfig) > 65536 ||
        !stored.tools ||
        typeof stored.tools !== 'string' ||
        Buffer.byteLength(stored.tools) > maxBytes
    )
        throw deny()
    try {
        remoteTool(JSON.parse(stored.tools).tools)
    } catch {
        throw deny()
    }
    return stored
}

function messageUrl(grant, target, method) {
    if (target.href === grant.url && ['GET', 'POST', 'DELETE'].includes(method)) return true
    if (!grant.ssePostUrl || method !== 'POST' || target.username || target.password || target.hash) return false
    const base = new URL(grant.ssePostUrl)
    if (target.origin !== base.origin || target.pathname !== base.pathname) return false
    const params = [...target.searchParams]
    return params.length === 1 && params[0][0] === 'sessionId' && uuid.test(params[0][1])
}

async function credentials(stored) {
    const { decryptCredentialData } = components('@cuttlely/components/utils')
    let headers
    try {
        headers = (await decryptCredentialData(stored.authConfig, ['custom-mcp', stored.id]))?.headers
    } catch {
        throw deny()
    }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw deny()
    const entries = Object.entries(headers)
    if (entries.length !== 1 || !['authorization', 'x-api-key'].includes(entries[0][0].toLowerCase())) throw deny()
    const [key, value] = entries[0]
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[^\x20-\x7e]/.test(value)) throw deny()
    return [key, value]
}

// The SDK expects a WHATWG response. Run each DNS resolution and each connection through
// the released pinned HTTP client, refuse redirects, and bound both streamed and JSON bodies.
async function checkedFetch(url, init, auth, signal) {
    const { secureFetch } = components('@cuttlely/components/httpSecurity')
    const headers = new Headers(init.headers)
    headers.set(...auth)
    const res = await secureFetch(url.href, { method: init.method, headers: Object.fromEntries(headers), body: init.body, signal }, 0)
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        res.body?.destroy()
        throw deny()
    }
    async function* chunks() {
        let bytes = 0
        try {
            for await (const chunk of res.body) {
                bytes += Buffer.byteLength(chunk)
                if (bytes > maxBytes) throw new Error('MCP response exceeds its limit.')
                yield chunk
            }
        } finally {
            res.body?.destroy()
        }
    }
    const body = [204, 205, 304].includes(res.status) ? null : Readable.toWeb(Readable.from(chunks()))
    return new Response(body, { status: res.status, headers: Object.fromEntries(res.headers.entries()) })
}

export async function withRemoteClient(server, flow, assertCurrent, options, operationFn) {
    const { Client } = components('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = components('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { SSEClientTransport } = components('@modelcontextprotocol/sdk/client/sse.js')
    const initial = await row(server, flow)
    const auth = await credentials(initial)
    let requests = 0
    let allowFallback = false
    const check = async () => {
        options.signal.throwIfAborted()
        assertCurrent()
        const current = await row(server, flow)
        if (current.authConfig !== initial.authConfig) throw deny()
        options.signal.throwIfAborted()
        assertCurrent()
    }
    async function attempt(sse) {
        const session = new AbortController()
        const signal = AbortSignal.any([session.signal, options.signal])
        let initiated = false
        const fetch = async (input, init = {}) => {
            const url = new URL(typeof input === 'string' ? input : input.href || input.url)
            const method = (init.method || 'GET').toUpperCase()
            if (++requests > 12 || !messageUrl(server.grant, url, method)) throw deny()
            await check()
            const waits = [signal]
            if (init.signal) waits.push(init.signal)
            if (method === 'DELETE') waits.push(AbortSignal.timeout(1500))
            const res = await checkedFetch(url, init, auth, AbortSignal.any(waits))
            if (!sse && !initiated && method === 'POST') allowFallback = [404, 405, 406, 415].includes(res.status)
            return res
        }
        const url = new URL(server.grant.url)
        const transport = sse
            ? new SSEClientTransport(url, { fetch, eventSourceInit: { fetch } })
            : new StreamableHTTPClientTransport(url, {
                  fetch,
                  reconnectionOptions: {
                      maxRetries: 0,
                      maxReconnectionDelay: 0,
                      initialReconnectionDelay: 0,
                      reconnectionDelayGrowFactor: 1
                  }
              })
        const client = new Client({ name: 'cuttlely', version: '1.0.0' })
        let cancel
        const abort = new Promise((_, reject) => {
            cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
        })
        try {
            await Promise.race([client.connect(transport, { ...options, signal }), abort])
            initiated = true
            await check()
            const result = await Promise.race([operationFn(client, { ...options, signal }), abort])
            await check()
            return result
        } finally {
            signal.removeEventListener('abort', cancel)
            if (!sse && transport.sessionId && !signal.aborted) {
                try {
                    await transport.terminateSession()
                } catch {
                    /* Credentials can be revoked before protocol cleanup. */
                }
            }
            session.abort()
            await client.close()
            await transport.close()
        }
    }
    try {
        return await attempt(false)
    } catch (error) {
        if (!allowFallback || !server.grant.ssePostUrl || error?.code === 'forbidden') throw error
        await check()
        return attempt(true)
    }
}
