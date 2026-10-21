// End-to-end check of the queue-mode abort path. Needs a Redis: REDIS_URL (for example redis://127.0.0.1:6379).
//
// Boots the built server (MODE=queue) and a worker on a temp data dir and a temp HOME, with the slow fake chat model in
// scripts/queue-abort-fake-model.cjs. Then:
//   1. starts a streaming prediction and reads a few tokens,
//   2. disconnects the client mid-stream,
//   3. checks that the worker stops the run (the model sees the abort signal well before its last token) and that
//      nothing is saved for that turn.
// A short prediction afterwards must complete and save its two messages, so the "nothing saved" check is not vacuous.
//
// Not part of `pnpm verify` (it needs Redis). Run it with `pnpm test:queue-abort`; the daily CI run on main starts a
// Redis service for it.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setupCodeFromLogs } from './smoke-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'packages', 'server')
const PRELOAD = path.join(ROOT, 'scripts', 'queue-abort-fake-model.cjs')
const SSO_GUARD = path.join(ROOT, 'scripts', 'refuse-sso-load.cjs')
const EMAIL = 'queue-abort@example.com'
const PASSWORD = 'QueueAbort1!'
const BOOT_MS = 12 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
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

function childEnv({ dataDir, home, port, marker, queueName }) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE_URL|WORKOS|STRIPE/i.test(key)) delete env[key]
    }
    return {
        ...env,
        HOME: home,
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_PATH: dataDir,
        SECRETKEY_PATH: dataDir,
        CUTTLELY_DATA_DIR: path.join(dataDir, 'cuttlely'),
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_WARM_HERMES: 'false',
        CUTTLELY_HARNESS_QUEUE: 'off',
        MODEL_LIST_CONFIG_JSON: 'bundled',
        NODE_ENV: 'development',
        MODE: 'queue',
        QUEUE_NAME: queueName,
        REDIS_URL: process.env.REDIS_URL,
        QUEUE_ABORT_MARKER: marker
    }
}

function start(command, env) {
    const logs = []
    const child = spawn(process.execPath, ['-r', SSO_GUARD, '-r', PRELOAD, path.join(SERVER, 'bin', 'run'), command], {
        cwd: SERVER,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const keep = (chunk) => {
        logs.push(String(chunk))
        if (logs.length > 200) logs.shift()
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const stop = () => {
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            try {
                child.kill('SIGTERM')
            } catch {
                // already gone
            }
        }
    }
    return { child, logs, stop }
}

async function waitFor(label, check, { child, logs }, ms = BOOT_MS) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (child && child.exitCode !== null) throw new Error(`${label}: process exited ${child.exitCode}\n${logs.join('').slice(-4000)}`)
        if (await check().catch(() => false)) return
        await sleep(500)
    }
    throw new Error(`${label}: timed out after ${ms / 1000}s\n${logs ? logs.join('').slice(-4000) : ''}`)
}

function cookieHeader(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return list.map((cookie) => cookie.split(';')[0]).join('; ')
}

async function request(url, { method = 'GET', cookie = '', body, timeoutMs = 30000 } = {}) {
    const headers = { 'x-request-from': 'internal' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    return { status: response.status, text: await response.text(), cookie: cookieHeader(response) || cookie }
}

function flow(credentialId) {
    const modelType = 'ChatOpenAI | BaseChatModel | BaseLanguageModel | Runnable'
    const promptType = 'PromptTemplate | BaseStringPromptTemplate | BasePromptTemplate'
    const node = (id, x, data) => ({
        id,
        type: 'customNode',
        position: { x, y: 0 },
        data: { id, inputParams: [], inputAnchors: [], outputs: {}, ...data }
    })
    return {
        nodes: [
            node('promptTemplate_0', 0, {
                label: 'Prompt Template',
                name: 'promptTemplate',
                type: 'PromptTemplate',
                category: 'Prompts',
                // As saved by the editor: promptValues accepts variables, so {{question}} becomes the user's question.
                inputParams: [
                    { name: 'template', type: 'string', acceptVariable: false },
                    { name: 'promptValues', type: 'json', acceptVariable: true }
                ],
                inputs: { template: '{question}', promptValues: '{"question":"{{question}}"}' },
                outputAnchors: [
                    {
                        id: `promptTemplate_0-output-promptTemplate-${promptType}`,
                        name: 'promptTemplate',
                        label: 'PromptTemplate',
                        type: promptType
                    }
                ]
            }),
            node('chatOpenAI_0', 200, {
                label: 'OpenAI',
                name: 'chatOpenAI',
                type: 'ChatOpenAI',
                category: 'Chat Models',
                credential: credentialId,
                inputs: { modelName: 'gpt-4o-mini', temperature: '0', streaming: true },
                outputAnchors: [
                    { id: `chatOpenAI_0-output-chatOpenAI-${modelType}`, name: 'chatOpenAI', label: 'ChatOpenAI', type: modelType }
                ]
            }),
            node('llmChain_0', 400, {
                label: 'LLM Chain',
                name: 'llmChain',
                type: 'LLMChain',
                category: 'Chains',
                inputAnchors: [
                    { id: 'llmChain_0-input-model-BaseLanguageModel', name: 'model', type: 'BaseLanguageModel' },
                    { id: 'llmChain_0-input-prompt-BasePromptTemplate', name: 'prompt', type: 'BasePromptTemplate' }
                ],
                inputs: { model: '{{chatOpenAI_0.data.instance}}', prompt: '{{promptTemplate_0.data.instance}}' },
                outputAnchors: [
                    {
                        id: 'llmChain_0-output-llmChain-LLMChain|BaseChain|Runnable',
                        name: 'llmChain',
                        label: 'LLMChain',
                        type: 'LLMChain | BaseChain | Runnable'
                    }
                ],
                outputs: { output: 'llmChain' }
            })
        ],
        edges: [
            {
                id: 'e-prompt',
                type: 'buttonedge',
                source: 'promptTemplate_0',
                sourceHandle: `promptTemplate_0-output-promptTemplate-${promptType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-prompt-BasePromptTemplate'
            },
            {
                id: 'e-model',
                type: 'buttonedge',
                source: 'chatOpenAI_0',
                sourceHandle: `chatOpenAI_0-output-chatOpenAI-${modelType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-model-BaseLanguageModel'
            }
        ]
    }
}

const readMarker = (marker) =>
    fs.existsSync(marker)
        ? fs
              .readFileSync(marker, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : []

/** Streams a prediction and disconnects after `tokensBeforeDisconnect` token events. Returns the tokens seen. */
async function streamThenDisconnect(base, cookie, chatflowId, tokensBeforeDisconnect) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    const response = await fetch(`${base}/api/v1/prediction/${chatflowId}`, {
        method: 'POST',
        headers: { 'x-request-from': 'internal', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ question: 'Write a long story', streaming: true }),
        signal: controller.signal
    })
    if (response.status !== 200) throw new Error(`streaming prediction ${response.status}: ${(await response.text()).slice(0, 400)}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let tokens = 0
    try {
        while (tokens < tokensBeforeDisconnect) {
            const { value, done } = await reader.read()
            if (done) throw new Error(`stream ended after ${tokens} tokens, before the disconnect`)
            buffer += decoder.decode(value, { stream: true })
            let index
            while ((index = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                const line = block.split('\n').find((l) => l.startsWith('data:'))
                if (!line) continue
                try {
                    const payload = JSON.parse(line.slice(5))
                    if (payload.event === 'token') tokens++
                    if (payload.event === 'error') throw new Error(`stream error event: ${JSON.stringify(payload.data).slice(0, 300)}`)
                } catch (error) {
                    if (error instanceof SyntaxError) continue
                    throw error
                }
            }
        }
    } finally {
        clearTimeout(timer)
        controller.abort() // the client goes away mid-stream
    }
    return tokens
}

async function main() {
    if (!process.env.REDIS_URL) {
        console.error('queue-abort-e2e: set REDIS_URL, for example REDIS_URL=redis://127.0.0.1:6379 pnpm test:queue-abort')
        process.exit(2)
    }
    if (!fs.existsSync(path.join(SERVER, 'dist', 'commands'))) throw new Error('packages/server/dist is missing. Run pnpm build first.')

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-queue-abort-'))
    const dataDir = path.join(scratch, 'data')
    const home = path.join(scratch, 'home')
    fs.mkdirSync(dataDir)
    fs.mkdirSync(home)
    const marker = path.join(scratch, 'model-events.jsonl')
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const opts = { dataDir, home, port, marker, queueName: `cuttlely-queue-abort-${crypto.randomBytes(4).toString('hex')}` }

    const main = start('start', childEnv(opts))
    let worker
    const stopAll = () => {
        main.stop()
        if (worker) worker.stop()
    }
    process.on('exit', stopAll)
    try {
        console.log(`queue-abort-e2e: server ${base}, queue ${opts.queueName}`)
        await waitFor('server ping', async () => (await request(`${base}/api/v1/ping`, { timeoutMs: 2000 })).text.includes('pong'), main)
        // The worker starts once the server has created the database, so the two never race on the first migration.
        worker = start('worker', childEnv({ ...opts, port: await freePort() }))
        await waitFor('worker ready', async () => worker.logs.join('').includes('Prediction Worker'), worker)
        console.log('queue-abort-e2e: server and worker up')

        const setupCode = setupCodeFromLogs(main.logs)
        if (!setupCode) throw new Error('the server log had no setup code')
        const registered = await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: 'Queue Abort', email: EMAIL, credential: PASSWORD }, setupCode }
        })
        if (registered.status !== 200) throw new Error(`register ${registered.status}: ${registered.text.slice(0, 300)}`)
        const login = await request(`${base}/api/v1/auth/login`, { method: 'POST', body: { email: EMAIL, password: PASSWORD } })
        if (login.status !== 200 || !login.cookie) throw new Error(`login ${login.status}: ${login.text.slice(0, 300)}`)
        const cookie = login.cookie
        const credential = await request(`${base}/api/v1/credentials`, {
            method: 'POST',
            cookie,
            body: { name: 'queue-abort', credentialName: 'openAIApi', plainDataObj: { openAIApiKey: 'queue-abort-placeholder' } }
        })
        if (credential.status !== 200) throw new Error(`credential ${credential.status}: ${credential.text.slice(0, 300)}`)
        const chatflow = await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: {
                name: 'queue-abort',
                type: 'CHATFLOW',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(flow(JSON.parse(credential.text).id))
            }
        })
        if (chatflow.status !== 200 && chatflow.status !== 201)
            throw new Error(`chatflow ${chatflow.status}: ${chatflow.text.slice(0, 300)}`)
        const chatflowId = JSON.parse(chatflow.text).id

        // 1 and 2: stream, then disconnect mid-stream.
        const seen = await streamThenDisconnect(base, cookie, chatflowId, 3)
        console.log(`queue-abort-e2e: read ${seen} tokens through Redis, then disconnected`)

        // 3: the worker gets the abort event and the run stops long before the model's 400th token.
        await waitFor('model abort in the worker', async () => readMarker(marker).some((e) => e.event === 'aborted'), worker, 30000).catch(
            (error) => {
                throw new Error(`${error.message}\nmodel events: ${JSON.stringify(readMarker(marker))}`)
            }
        )
        await sleep(3000)
        const events = readMarker(marker)
        const aborted = events.find((e) => e.event === 'aborted')
        if (aborted.pid !== worker.child.pid)
            throw new Error(`the model ran in pid ${aborted.pid}, not in the worker (${worker.child.pid})`)
        if (events.some((e) => e.event === 'completed'))
            throw new Error(`the run finished despite the disconnect: ${JSON.stringify(events)}`)
        if (aborted.tokens >= 400) throw new Error(`the run was not stopped early: ${JSON.stringify(aborted)}`)
        console.log(`queue-abort-e2e: worker stopped the run after ${aborted.tokens} of 400 tokens`)

        // The server picks the chat id (a client-sent chatId is not trusted), and this chatflow is new, so every
        // message it holds belongs to this test: none for the aborted turn.
        const messagesOf = async () => {
            const saved = await request(`${base}/api/v1/chatmessage/${chatflowId}`, { cookie })
            if (saved.status !== 200) throw new Error(`chat messages ${saved.status}: ${saved.text.slice(0, 300)}`)
            return JSON.parse(saved.text)
        }
        const abortedMessages = await messagesOf()
        if (abortedMessages.length !== 0) throw new Error(`the aborted turn saved ${abortedMessages.length} messages`)
        console.log('queue-abort-e2e: nothing saved for the aborted turn')

        // Control: a short prediction through the same queue completes and saves the question and the answer, so the
        // empty list above means nothing was saved, not that saved messages are invisible to this check.
        const ok = await request(`${base}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            cookie,
            timeoutMs: 120000,
            body: { question: 'Say hi' }
        })
        if (ok.status !== 200 || !ok.text.includes('t0')) throw new Error(`control prediction ${ok.status}: ${ok.text.slice(0, 300)}`)
        const savedOk = await messagesOf()
        const roles = savedOk.map((m) => m.role).join(',')
        if (savedOk.length !== 2 || roles !== 'userMessage,apiMessage' || savedOk[0].content !== 'Say hi')
            throw new Error(`the control turn saved ${savedOk.length} messages (${roles}), expected the question and the answer`)
        console.log('queue-abort-e2e: control prediction completed and saved 2 messages')
        console.log('queue-abort-e2e: pass')
    } finally {
        stopAll()
        await sleep(500)
        if (process.env.QUEUE_ABORT_KEEP) console.log(`queue-abort-e2e: kept ${scratch}`)
        else fs.rmSync(scratch, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    })
}
