// Shared helpers for the live end-to-end test. Talks to a running Cuttlely over HTTP and to the
// Pinecone data plane of the test index only. Never prints a key.
import fs from 'node:fs'
import { e2e } from './paths.mjs'

export const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3100'
const ADMIN_FILE = process.env.E2E_ADMIN_FILE || e2e('admin.json')
const PINECONE_HOST = process.env.E2E_PINECONE_HOST || ''
const ALLOWED_INDEX_HOST = /^https:\/\/[a-z]+-test-[a-z0-9]+\.svc\./

export function log(...args) {
    console.log(new Date().toISOString(), ...args)
}

export function redact(text) {
    let out = String(text ?? '')
    for (const name of ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'CUTTLELY_GITHUB_PAT']) {
        const value = process.env[name]
        if (value && value.length > 6) out = out.split(value).join(`[${name}]`)
    }
    return out.replace(/\b(sk|xai|pcsk)[-_][A-Za-z0-9_-]{8,}/g, '$1-[redacted]')
}

let cookie = ''
let loggingIn = null

function login() {
    if (!loggingIn) loggingIn = doLogin().finally(() => (loggingIn = null))
    return loggingIn
}

async function doLogin() {
    const body = fs.readFileSync(ADMIN_FILE, 'utf8')
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal' },
        body
    })
    if (!res.ok) throw new Error(`login failed: ${res.status}`)
    cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
}

export async function api(method, path, body, { retry = true } = {}) {
    if (!cookie) await login()
    const res = await fetch(`${BASE}/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal', cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (res.status === 401 && retry) {
        cookie = ''
        return api(method, path, body, { retry: false })
    }
    const text = await res.text()
    let data
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok)
        throw new Error(
            `${method} ${path} -> ${res.status}: ${redact(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 800)}`
        )
    return data
}

const defs = new Map()
export async function nodeDef(name) {
    if (!defs.has(name)) defs.set(name, await api('GET', `/nodes/${name}`))
    return defs.get(name)
}

const PARAM_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs'
])

// Same shape the canvas writes (packages/ui/src/utils/genericHelper.js initNode), trimmed to what the server reads.
export async function buildNode(name, id, { inputs = {}, credential, output, label, position = { x: 0, y: 0 } } = {}) {
    const def = await nodeDef(name)
    const inputParams = []
    const inputAnchors = []
    const defaults = {}
    for (const input of def.inputs || []) {
        const entry = { ...input, id: `${id}-input-${input.name}-${input.type}` }
        if (PARAM_TYPES.has(input.type)) inputParams.push(entry)
        else inputAnchors.push(entry)
        defaults[input.name] = input.default ?? ''
    }
    if (def.credential) inputParams.unshift({ ...def.credential, id: `${id}-input-credential-credential` })
    let outputAnchors
    let outputs = {}
    if (def.outputs?.length) {
        const options = def.outputs.map((o) => ({
            id: `${id}-output-${o.name}-${(o.baseClasses || []).join('|')}`,
            name: o.name,
            label: o.label,
            type: (o.baseClasses || []).join(' | ')
        }))
        outputAnchors = [{ name: 'output', label: 'Output', type: 'options', options, default: output || def.outputs[0].name }]
        outputs = { output: output || def.outputs[0].name }
    } else {
        outputAnchors = [
            {
                id: `${id}-output-${def.name}-${def.baseClasses.join('|')}`,
                name: def.name,
                label: def.type,
                type: def.baseClasses.join(' | ')
            }
        ]
    }
    const data = {
        id,
        label: label || def.label,
        version: def.version,
        name: def.name,
        type: def.type,
        baseClasses: def.baseClasses,
        category: def.category,
        description: def.description,
        inputParams,
        inputAnchors,
        inputs: { ...defaults, ...inputs },
        outputAnchors,
        outputs,
        selected: false
    }
    if (credential) {
        data.credential = credential
        data.inputs.FLOWISE_CREDENTIAL_ID = credential
    }
    return { id, position, type: 'customNode', width: 300, height: 500, data }
}

export function sourceHandle(node) {
    const anchor = node.data.outputAnchors[0]
    if (anchor.type === 'options') return anchor.options.find((o) => o.name === node.data.outputs.output).id
    return anchor.id
}

// Wires source into target.inputs[inputName], as the canvas does: an edge plus a {{id.data.instance}} reference.
export function connect(source, target, inputName) {
    const anchor = target.data.inputAnchors.find((a) => a.name === inputName)
    if (!anchor) throw new Error(`${target.id} has no input anchor ${inputName}`)
    const ref = `{{${source.id}.data.instance}}`
    const current = target.data.inputs[inputName]
    if (anchor.list || Array.isArray(current)) target.data.inputs[inputName] = [...(Array.isArray(current) ? current : []), ref]
    else target.data.inputs[inputName] = ref
    return {
        source: source.id,
        sourceHandle: sourceHandle(source),
        target: target.id,
        targetHandle: anchor.id,
        type: 'buttonedge',
        id: `${source.id}-${sourceHandle(source)}-${target.id}-${anchor.id}`
    }
}

export async function upsertFlow({ name, type, nodes, edges }) {
    const flowData = JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } })
    const typeParam = type === 'CHATFLOW' ? 'CHATFLOW' : type
    const existing = (await api('GET', `/chatflows?type=${typeParam}`)) || []
    const list = Array.isArray(existing) ? existing : existing.data || []
    const found = list.find((flow) => flow.name === name)
    if (found) return api('PUT', `/chatflows/${found.id}`, { name, flowData, type })
    return api('POST', '/chatflows', { name, flowData, type, deployed: false })
}

export async function credentialId(name) {
    const list = await api('GET', '/credentials')
    const found = list.find((c) => c.name === name)
    if (!found) throw new Error(`credential ${name} is missing; run setup first`)
    return found.id
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitRun(runId, { timeoutMs = 600000, until = ['completed', 'failed', 'cancelled', 'paused'] } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const run = await api('GET', `/etl/runs/${runId}`)
        if (until.includes(run.status)) return run
        if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs} ms`)
        await sleep(1000)
    }
}

// --- Pinecone data plane, test index only -------------------------------------------------------

function pineconeKey() {
    const key = process.env.PINECONE_API_KEY
    if (!key) throw new Error('PINECONE_API_KEY is not set. Export it in the shell. Do not commit it.')
    if (!PINECONE_HOST) throw new Error('E2E_PINECONE_HOST is not set. Point it at the cuttlely-test index.')
    if (!ALLOWED_INDEX_HOST.test(PINECONE_HOST))
        throw new Error(`refusing Pinecone host ${PINECONE_HOST}: only the cuttlely-test index is allowed`)
    return key
}

export const pineconeUsage = { reads: 0, writes: 0 }

async function pc(method, path, body) {
    const res = await fetch(`${PINECONE_HOST}${path}`, {
        method,
        headers: { 'Api-Key': pineconeKey(), 'content-type': 'application/json', 'X-Pinecone-API-Version': '2025-04' },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Pinecone ${method} ${path} -> ${res.status}: ${redact(text).slice(0, 400)}`)
    return text ? JSON.parse(text) : {}
}

export async function queryByFilter(namespace, filter, topK = 100) {
    const vector = Array.from({ length: 1536 }, (_, i) => (i % 7 === 0 ? 1 : 0.01))
    const result = await pc('POST', '/query', { namespace, vector, topK, filter, includeMetadata: true })
    pineconeUsage.reads += 1
    return result.matches || []
}

export async function namespaceCount(namespace) {
    const stats = await pc('POST', '/describe_index_stats', {})
    return stats.namespaces?.[namespace]?.vectorCount ?? 0
}

export async function namespaceStats() {
    const stats = await pc('POST', '/describe_index_stats', {})
    return stats.namespaces || {}
}

export async function listIds(namespace, prefix) {
    const ids = []
    let token
    do {
        const qs = new URLSearchParams({ namespace, limit: '100' })
        if (prefix) qs.set('prefix', prefix)
        if (token) qs.set('paginationToken', token)
        const page = await pc('GET', `/vectors/list?${qs}`)
        pineconeUsage.reads += 1
        for (const v of page.vectors || []) ids.push(v.id)
        token = page.pagination?.next
    } while (token)
    return ids.sort()
}

export async function fetchVectors(namespace, ids) {
    const out = {}
    for (let i = 0; i < ids.length; i += 100) {
        const qs = new URLSearchParams({ namespace })
        for (const id of ids.slice(i, i + 100)) qs.append('ids', id)
        const page = await pc('GET', `/vectors/fetch?${qs}`)
        pineconeUsage.reads += 1
        Object.assign(out, page.vectors || {})
    }
    return out
}

export async function deleteNamespace(namespace) {
    if (!namespace || !/^(e2e|pt)-/.test(namespace))
        throw new Error(`refusing to delete namespace "${namespace}": only e2e-* and pt-* test namespaces`)
    return pc('DELETE', `/namespaces/${encodeURIComponent(namespace)}`)
}

// Serverless counts are eventually consistent; poll until the namespace settles on the expected count.
export async function settleCount(namespace, expected, { timeoutMs = 90000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let ids = []
    for (;;) {
        ids = await listIds(namespace)
        if (ids.length === expected || Date.now() > deadline) return ids
        await sleep(3000)
    }
}
