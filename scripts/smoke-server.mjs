// Boot the built server on a free port and a temp data dir.
// Checks ping, the marketplace template list, one prediction, a provider that keeps answering 429, that deleting a
// flow removes its leads, and that SIGTERM lets running predictions finish.
// The chat model is the preload in smoke-fake-model.cjs. No network and no real key.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'packages', 'server')
const PRELOAD = path.join(ROOT, 'scripts', 'smoke-fake-model.cjs')
const SSO_GUARD = path.join(ROOT, 'scripts', 'refuse-sso-load.cjs')
const PASSWORD = 'SmokeTest1!'
const EMAIL = 'smoke-local@example.com'
const BOOT_MS = 12 * 60 * 1000
const PREDICT_MS = 3 * 60 * 1000

export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(() => resolve(port))
        })
    })
}

const BOOT_LOG_FORBIDDEN = /Auth0SSO|AzureSSO|GithubSSO|GoogleSSO|initializeSSO|Stripe is not initialized|Identity Manager initialized/

function childEnv(dataDir, port, extra = {}) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE_URL|API_KEY/i.test(key) && key !== 'SECRETKEY_PATH') delete env[key]
    }
    delete env.CUTTLELY_LOCAL_ADMIN
    delete env.WORKOS_API_KEY
    delete env.WORKOS_CLIENT_ID
    delete env.WORKOS_REDIRECT_URI
    delete env.WORKOS_COOKIE_PASSWORD
    delete env.STRIPE_SECRET_KEY
    env.HOST = '127.0.0.1'
    env.PORT = String(port)
    env.DATABASE_PATH = dataDir
    // The smoke run stays on this machine: no daily model list fetch from GitHub.
    env.MODEL_LIST_CONFIG_JSON = 'bundled'
    env.SECRETKEY_PATH = dataDir
    env.CUTTLELY_DATA_DIR = path.join(dataDir, 'cuttlely')
    env.CUTTLELY_WARM_HERMES = 'false'
    env.CUTTLELY_HARNESS_QUEUE = 'off'
    env.NODE_ENV = 'development'
    delete env.MODE
    return { ...env, ...extra }
}

function assertBootLogs(logs, label) {
    const text = logs.join('')
    const match = text.match(BOOT_LOG_FORBIDDEN)
    if (match) throw new Error(`${label} boot log matched ${match[0]}`)
}

function cookieHeader(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return list.map((cookie) => cookie.split(';')[0]).join('; ')
}

// The printed setup link carries the one-time code after #code=.
export function setupCodeFromLogs(logs) {
    const text = Array.isArray(logs) ? logs.join('') : String(logs || '')
    const match = text.match(/#code=([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
}

export async function request(url, { method = 'GET', cookie = '', body, timeoutMs = 30000 } = {}) {
    const headers = { 'x-request-from': 'internal' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    return { status: response.status, text, cookie: cookieHeader(response) || cookie, retryAfter: response.headers.get('retry-after') }
}

export function smokeFlow(credentialId) {
    const modelType = 'ChatOpenAI | BaseChatModel | BaseLanguageModel | Runnable'
    const promptType = 'PromptTemplate | BaseStringPromptTemplate | BasePromptTemplate'
    return {
        nodes: [
            {
                id: 'promptTemplate_0',
                type: 'customNode',
                position: { x: 0, y: 0 },
                data: {
                    id: 'promptTemplate_0',
                    label: 'Prompt Template',
                    name: 'promptTemplate',
                    type: 'PromptTemplate',
                    category: 'Prompts',
                    // promptValues accepts variables, as in the real node, so {{question}} becomes the question the
                    // model sees (the fake model acts on words in it: smoke-slow, smoke-429).
                    inputParams: [{ label: 'Format Prompt Values', name: 'promptValues', type: 'json', acceptVariable: true }],
                    inputAnchors: [],
                    inputs: {
                        template: '{question}',
                        promptValues: '{"question":"{{question}}"}'
                    },
                    outputAnchors: [
                        {
                            id: `promptTemplate_0-output-promptTemplate-${promptType}`,
                            name: 'promptTemplate',
                            label: 'PromptTemplate',
                            type: promptType
                        }
                    ],
                    outputs: {}
                }
            },
            {
                id: 'chatOpenAI_0',
                type: 'customNode',
                position: { x: 0, y: 200 },
                data: {
                    id: 'chatOpenAI_0',
                    label: 'OpenAI',
                    name: 'chatOpenAI',
                    type: 'ChatOpenAI',
                    category: 'Chat Models',
                    credential: credentialId,
                    inputParams: [],
                    inputAnchors: [],
                    inputs: {
                        modelName: 'gpt-4o-mini',
                        temperature: '0',
                        streaming: false
                    },
                    outputAnchors: [
                        {
                            id: `chatOpenAI_0-output-chatOpenAI-${modelType}`,
                            name: 'chatOpenAI',
                            label: 'ChatOpenAI',
                            type: modelType
                        }
                    ],
                    outputs: {}
                }
            },
            {
                id: 'llmChain_0',
                type: 'customNode',
                position: { x: 400, y: 80 },
                data: {
                    id: 'llmChain_0',
                    label: 'LLM Chain',
                    name: 'llmChain',
                    type: 'LLMChain',
                    category: 'Chains',
                    inputParams: [],
                    inputAnchors: [
                        { id: 'llmChain_0-input-model-BaseLanguageModel', name: 'model', type: 'BaseLanguageModel' },
                        { id: 'llmChain_0-input-prompt-BasePromptTemplate', name: 'prompt', type: 'BasePromptTemplate' }
                    ],
                    inputs: {
                        model: '{{chatOpenAI_0.data.instance}}',
                        prompt: '{{promptTemplate_0.data.instance}}'
                    },
                    outputAnchors: [
                        {
                            id: 'llmChain_0-output-llmChain-LLMChain|BaseChain|Runnable',
                            name: 'llmChain',
                            label: 'LLMChain',
                            type: 'LLMChain | BaseChain | Runnable'
                        }
                    ],
                    outputs: { output: 'llmChain' }
                }
            }
        ],
        edges: [
            {
                source: 'promptTemplate_0',
                sourceHandle: `promptTemplate_0-output-promptTemplate-${promptType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-prompt-BasePromptTemplate',
                type: 'buttonedge',
                id: 'e-prompt'
            },
            {
                source: 'chatOpenAI_0',
                sourceHandle: `chatOpenAI_0-output-chatOpenAI-${modelType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-model-BaseLanguageModel',
                type: 'buttonedge',
                id: 'e-model'
            }
        ]
    }
}

export async function waitForPing(base, child, logs) {
    const deadline = Date.now() + BOOT_MS
    let last = ''
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited ${child.exitCode} before ping\n${logs.join('')}`)
        }
        try {
            const response = await request(`${base}/api/v1/ping`, { timeoutMs: 2000 })
            if (response.status === 200 && response.text.includes('pong')) return
            last = `${response.status} ${response.text.slice(0, 200)}`
        } catch (error) {
            last = error instanceof Error ? error.name : 'waiting'
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`server did not answer /api/v1/ping within ${BOOT_MS / 1000}s (${last})\n${logs.join('').slice(-4000)}`)
}

export function startServer(dataDir, port, extra) {
    const logs = []
    let setupCode = ''
    let pending = ''
    const child = spawn(process.execPath, ['-r', SSO_GUARD, '-r', PRELOAD, path.join(SERVER, 'bin', 'run'), 'start'], {
        cwd: SERVER,
        env: childEnv(dataDir, port, extra),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const keep = (chunk) => {
        const text = String(chunk)
        logs.push(text)
        if (logs.length > 80) logs.shift()
        if (!setupCode) {
            pending = (pending + text).slice(-240)
            const match = pending.match(/#code=([A-Za-z0-9_-]+)/)
            if (match) setupCode = match[1]
        }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const stop = () => {
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            child.kill('SIGTERM')
        }
    }
    return {
        child,
        logs,
        stop,
        get setupCode() {
            return setupCode || setupCodeFromLogs(logs)
        }
    }
}

async function bootClosedRegister() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-smoke-closed-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const { child, logs, stop } = startServer(dataDir, port, {
        WORKOS_API_KEY: 'sk_test_cuttlely_boot',
        WORKOS_CLIENT_ID: 'client_cuttlely_boot',
        WORKOS_REDIRECT_URI: `${base}/api/v1/auth/callback`,
        WORKOS_COOKIE_PASSWORD: 'cuttlely-boot-cookie-password-32b'
    })
    try {
        console.log(`workos boot ${base}`)
        await waitForPing(base, child, logs)
        assertBootLogs(logs, 'workos')
        const registered = await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: 'Smoke', email: EMAIL, credential: PASSWORD } }
        })
        if (registered.status !== 404)
            throw new Error(`register with local admin off ${registered.status}: ${registered.text.slice(0, 200)}`)
        console.log('workos boot ok, register 404')
    } finally {
        stop()
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
}

function leadCount(dataDir, chatflowId) {
    const db = new DatabaseSync(path.join(dataDir, 'database.sqlite'), { readOnly: true })
    try {
        return Number(db.prepare('SELECT COUNT(*) AS count FROM lead WHERE chatflowid = ?').get(chatflowId).count)
    } finally {
        db.close()
    }
}

// A lead holds a visitor's name, email and phone. Deleting the flow through the API has to take its leads with it.
async function checkLeadsGoWithFlow(base, cookie, chatflowId, dataDir) {
    const lead = await request(`${base}/api/v1/leads`, {
        method: 'POST',
        body: { chatflowid: chatflowId, name: 'Rosa Crumb', email: 'rosa@crumb-and-co.example', phone: '555-0142' }
    })
    if (lead.status !== 200) throw new Error(`lead ${lead.status}: ${lead.text.slice(0, 300)}`)
    if (leadCount(dataDir, chatflowId) !== 1) throw new Error('the saved lead is not in the database')
    const deleted = await request(`${base}/api/v1/chatflows/${chatflowId}`, { method: 'DELETE', cookie })
    if (deleted.status !== 200) throw new Error(`delete chatflow ${deleted.status}: ${deleted.text.slice(0, 300)}`)
    const left = leadCount(dataDir, chatflowId)
    if (left !== 0) throw new Error(`deleting the flow left ${left} lead row(s) behind`)
}

// SIGTERM (what hosts send on every deploy) lets predictions that are running finish instead of cutting them off.
async function checkShutdownDrain(base, cookie, chatflowId, child) {
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    const running = Array.from({ length: 5 }, (_, index) =>
        request(`${base}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            cookie,
            timeoutMs: PREDICT_MS,
            body: { question: `smoke-slow ${index}`, streaming: false }
        })
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const signalled = Date.now()
    child.kill('SIGTERM')
    const answers = await Promise.all(running)
    const bad = answers.filter((answer) => answer.status !== 200 || !answer.text.includes('smoke-ok'))
    if (bad.length) throw new Error(`${bad.length} of 5 predictions failed during shutdown: ${bad[0].status} ${bad[0].text.slice(0, 200)}`)
    const { code, signal } = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout', signal: null }), 40000))
    ])
    if (code !== 0) throw new Error(`server exit after SIGTERM: code ${code} signal ${signal}`)
    console.log(`server drained and exited ${((Date.now() - signalled) / 1000).toFixed(1)}s after SIGTERM`)
}

// A model provider that keeps answering 429: a bounded number of tries, then 429 with the provider's Retry-After.
async function checkProviderRateLimit(base, cookie, chatflowId) {
    const started = Date.now()
    const limited = await request(`${base}/api/v1/prediction/${chatflowId}`, {
        method: 'POST',
        cookie,
        timeoutMs: PREDICT_MS,
        body: { question: 'smoke-429', streaming: false }
    })
    const seconds = (Date.now() - started) / 1000
    if (limited.status !== 429) throw new Error(`provider 429 came back as ${limited.status}: ${limited.text.slice(0, 300)}`)
    if (limited.retryAfter !== '12') throw new Error(`provider 429 Retry-After was ${limited.retryAfter}, expected 12`)
    if (seconds > 25) throw new Error(`provider 429 took ${seconds.toFixed(1)}s, expected the retry budget (about 20s at most)`)
    console.log(`provider 429 ok: 429 with Retry-After 12 in ${seconds.toFixed(1)}s`)
}

async function main() {
    if (!fs.existsSync(path.join(SERVER, 'dist', 'commands'))) {
        throw new Error('packages/server/dist is missing. The verify build step has to run before the smoke test.')
    }
    await bootClosedRegister()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-smoke-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const started = startServer(dataDir, port, { CUTTLELY_LOCAL_ADMIN: 'true' })
    const { child, logs, stop } = started
    process.on('exit', stop)
    try {
        console.log(`smoke server ${base} data ${dataDir}`)
        await waitForPing(base, child, logs)
        console.log('ping ok')

        assertBootLogs(logs, 'local admin')
        const forgot = await request(`${base}/api/v1/account/forgot-password`, {
            method: 'POST',
            body: { email: EMAIL }
        })
        if (forgot.status !== 404) throw new Error(`forgot-password ${forgot.status}: ${forgot.text.slice(0, 200)}`)

        const setupCode = started.setupCode
        if (!setupCode) throw new Error('the server log had no setup code')
        const registered = await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: 'Smoke', email: EMAIL, credential: PASSWORD }, setupCode }
        })
        if (registered.status !== 200) throw new Error(`register ${registered.status}: ${registered.text.slice(0, 400)}`)
        const loggedIn = await request(`${base}/api/v1/auth/login`, {
            method: 'POST',
            body: { email: EMAIL, password: PASSWORD }
        })
        if (loggedIn.status !== 200 || !loggedIn.cookie) {
            throw new Error(`login ${loggedIn.status}: ${loggedIn.text.slice(0, 400)}`)
        }
        const cookie = loggedIn.cookie
        const billing = await request(`${base}/api/v1/account/billing`, { method: 'POST', cookie, body: {} })
        if (billing.status !== 404) throw new Error(`billing ${billing.status}: ${billing.text.slice(0, 200)}`)

        const templates = await request(`${base}/api/v1/marketplaces/templates`, { cookie, timeoutMs: 60000 })
        if (templates.status !== 200) throw new Error(`templates ${templates.status}: ${templates.text.slice(0, 400)}`)
        const list = JSON.parse(templates.text)
        if (!Array.isArray(list) || list.length < 1) throw new Error('marketplace template list was empty')
        const withFlow = list.filter((item) => typeof item.flowData === 'string' && item.flowData.includes('nodes'))
        if (!withFlow.length) throw new Error('marketplace template list had no flowData')
        console.log(`templates ok (${list.length})`)

        const credential = await request(`${base}/api/v1/credentials`, {
            method: 'POST',
            cookie,
            body: {
                name: 'smoke-local',
                credentialName: 'openAIApi',
                plainDataObj: { openAIApiKey: 'smoke-local-placeholder' }
            }
        })
        if (credential.status !== 200) throw new Error(`credential ${credential.status}: ${credential.text.slice(0, 400)}`)
        const credentialId = JSON.parse(credential.text).id
        if (!credentialId) throw new Error('credential response had no id')

        const chatflow = await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: {
                name: 'smoke',
                type: 'CHATFLOW',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(smokeFlow(credentialId))
            }
        })
        if (chatflow.status !== 200 && chatflow.status !== 201) {
            throw new Error(`chatflow ${chatflow.status}: ${chatflow.text.slice(0, 500)}`)
        }
        const chatflowId = JSON.parse(chatflow.text).id
        const prediction = await request(`${base}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            cookie,
            timeoutMs: PREDICT_MS,
            body: { question: 'Say smoke-ok', streaming: false }
        })
        if (prediction.status !== 200 || !prediction.text.includes('smoke-ok')) {
            throw new Error(`prediction ${prediction.status}: ${prediction.text.slice(0, 500)}`)
        }
        console.log('prediction ok')

        await checkProviderRateLimit(base, cookie, chatflowId)

        // Leads are checked on a flow of their own, since the check deletes it; the drain check needs the first flow.
        const leadsFlow = await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: {
                name: 'smoke-leads',
                type: 'CHATFLOW',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(smokeFlow(credentialId))
            }
        })
        if (leadsFlow.status !== 200 && leadsFlow.status !== 201)
            throw new Error(`chatflow ${leadsFlow.status}: ${leadsFlow.text.slice(0, 300)}`)
        await checkLeadsGoWithFlow(base, cookie, JSON.parse(leadsFlow.text).id, dataDir)
        console.log('flow delete removed its leads')

        // Last: it stops the server.
        await checkShutdownDrain(base, cookie, chatflowId, child)
        console.log('shutdown drain ok: running predictions finished, then exit 0')
    } finally {
        stop()
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    })
}
