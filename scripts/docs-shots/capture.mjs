// Reshoot the canvas, share, API and Try the demo pictures from a fresh local server.
// No outside account. A model key is read from OPENAI_API_KEY when DOCS_SHOT_USE_EXTERNAL=1.
// Otherwise a loopback stand-in answers, and a local placeholder is the only credential value.
// Nothing here prints a key, a token or a password.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function settle(page, ms = 240000) {
    const end = Date.now() + ms
    let last = '',
        stable = 0
    await page.waitForTimeout(3000)
    while (Date.now() < end) {
        const t = await page.evaluate(
            () =>
                document.body.innerText.length +
                ':' +
                document.body.innerText.slice(-200) +
                (/(Running|Answering|Waiting for the first token)/.test(document.body.innerText) ? ' Running' : '')
        )
        const busy = /Running|Answering|Waiting for the first token/.test(t)
        if (t === last && !busy) {
            stable += 1
            if (stable >= 5) return
        } else {
            stable = 0
            last = t
        }
        await page.waitForTimeout(1000)
    }
}
import { themeFor } from './theme.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ONLY = new Set(
    (process.env.DOCS_SHOTS || 'all')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
)
const want = (name) => ONLY.has('all') || ONLY.has(name)
const STUB_PORT = Number(process.env.DOCS_SHOT_STUB_PORT || 8791)
const APP_PORT = Number(process.env.DOCS_SHOT_PORT || 43117)
const PAGE_PORT = Number(process.env.DOCS_SHOT_PAGE_PORT || 8792)
const BASE = `http://127.0.0.1:${APP_PORT}`
const EXTERNAL = process.env.DOCS_SHOT_USE_EXTERNAL === '1' && Boolean(process.env.OPENAI_API_KEY)
const DATA = fs.mkdtempSync(path.join('/tmp', 'cuttlely-docs-shots-'))
const NOTES = []
const children = []

const EMAIL = 'owner@crumb.example'
const OWNER = 'Rosa Diaz'
const PASSWORD = `Aa1!${crypto.randomBytes(12).toString('hex')}`
const LOCAL_KEY = EXTERNAL ? process.env.OPENAI_API_KEY : `local-${crypto.randomBytes(12).toString('hex')}`

function log(line) {
    console.log(`[docs-shots] ${line}`)
}

function track(child) {
    children.push(child)
    return child
}

function stopAll() {
    for (const child of children) {
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
}

process.on('exit', stopAll)
process.on('SIGINT', () => {
    stopAll()
    process.exit(1)
})

async function waitFor(url, seconds, label) {
    const started = Date.now()
    let last = ''
    while (Date.now() - started < seconds * 1000) {
        try {
            const res = await fetch(url)
            if (res.ok || res.status === 401) return
            last = String(res.status)
        } catch (error) {
            last = error.code || error.message
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`${label} did not answer (${last})`)
}

function startStub() {
    if (EXTERNAL) return
    const child = track(
        spawn(process.execPath, [path.join(ROOT, 'scripts/docs-shots/stub-model.mjs')], {
            cwd: ROOT,
            env: { ...process.env, DOCS_SHOT_STUB_PORT: String(STUB_PORT) },
            stdio: ['ignore', 'inherit', 'inherit'],
            detached: true
        })
    )
    child.unref()
}

function startServer() {
    fs.mkdirSync(path.join(DATA, 'db'), { recursive: true })
    fs.mkdirSync(path.join(DATA, 'secrets'), { recursive: true })
    fs.mkdirSync(path.join(DATA, 'hermes'), { recursive: true })
    const env = {
        ...process.env,
        PATH: `${process.env.HOME}/.nvm/versions/node/v24.15.0/bin:${process.env.HOME}/.local/bin:${process.env.PATH}`,
        PORT: String(APP_PORT),
        HOST: '127.0.0.1',
        CUTTLELY_DATA_DIR: DATA,
        CUTTLELY_HERMES_HOME: path.join(DATA, 'hermes'),
        DATABASE_PATH: path.join(DATA, 'db'),
        SECRETKEY_PATH: path.join(DATA, 'secrets'),
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_WARM_HERMES: 'false',
        MODEL_LIST_CONFIG_JSON: 'bundled',
        OPENAI_API_KEY: LOCAL_KEY
    }
    if (!EXTERNAL) env.OPENAI_BASE_URL = `http://127.0.0.1:${STUB_PORT}/v1`
    const child = track(
        spawn('bash', [path.join(ROOT, 'scripts/start-cuttlely.sh')], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'inherit', 'inherit'],
            detached: true
        })
    )
    child.unref()
}

let cookie = ''

async function api(method, urlPath, body) {
    const res = await fetch(`${BASE}/api/v1${urlPath}`, {
        method,
        headers: {
            'content-type': 'application/json',
            'x-request-from': 'internal',
            ...(cookie ? { cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let data
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok) {
        const brief = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`${method} ${urlPath} -> ${res.status}: ${brief.slice(0, 400)}`)
    }
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (set.length) cookie = set.map((item) => item.split(';')[0]).join('; ')
    return data
}

const defs = new Map()
async function nodeDef(name) {
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

async function buildNode(name, id, { inputs = {}, credential, output, label, position = { x: 0, y: 0 }, type = 'customNode' } = {}) {
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
        const options = def.outputs.map((item) => ({
            id: `${id}-output-${item.name}-${(item.baseClasses || []).join('|')}`,
            name: item.name,
            label: item.label,
            type: (item.baseClasses || []).join(' | ')
        }))
        outputAnchors = [{ name: 'output', label: 'Output', type: 'options', options, default: output || def.outputs[0].name }]
        outputs = { output: output || def.outputs[0].name }
    } else {
        outputAnchors = [
            {
                id: `${id}-output-${def.name}-${(def.baseClasses || [def.type]).join('|')}`,
                name: def.name,
                label: def.type,
                type: (def.baseClasses || [def.type]).join(' | ')
            }
        ]
    }
    const data = {
        id,
        label: label || def.label,
        version: def.version,
        name: def.name,
        type: def.type,
        color: def.color,
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
    return { id, position, type, width: 300, height: 400, data }
}

function sourceHandle(node) {
    const anchor = node.data.outputAnchors[0]
    if (anchor.type === 'options') return anchor.options.find((item) => item.name === node.data.outputs.output).id
    return anchor.id
}

function connect(source, target, inputName) {
    const anchor = target.data.inputAnchors.find((item) => item.name === inputName)
    if (!anchor) throw new Error(`${target.id} has no input ${inputName}`)
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

async function saveFlow({ name, type, nodes, edges, chatbotConfig, isPublic = false, apikeyid = '' }) {
    const body = {
        name,
        type,
        deployed: false,
        isPublic,
        apikeyid,
        flowData: JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 0.8 } })
    }
    if (chatbotConfig) body.chatbotConfig = JSON.stringify(chatbotConfig)
    return api('POST', '/chatflows', body)
}

async function disableStreaming(name) {
    const listed = await api('GET', '/chatflows?type=HARNESS')
    const rows = Array.isArray(listed) ? listed : listed?.data || []
    const flow = rows.find((item) => item.name === name)
    if (!flow) return
    const full = await api('GET', `/chatflows/${flow.id}`)
    const data = JSON.parse(full.flowData)
    let changed = false
    for (const node of data.nodes || []) {
        if (node?.data?.name === 'chatOpenAI') {
            node.data.inputs = { ...(node.data.inputs || {}), streaming: false }
            changed = true
        }
    }
    if (changed) await api('PUT', `/chatflows/${flow.id}`, { flowData: JSON.stringify(data) })
}

async function publish(id) {
    try {
        await api('POST', `/flow-drafts/${id}/publish`, {})
    } catch (error) {
        if (!/no draft|already|unchanged|404|no unpublished/i.test(String(error.message))) throw error
    }
}

function moneyHit(text) {
    return text.match(/\$\s?\d/) || text.match(/(?<![A-Za-z0-9.-])\d+\.\d{2}\b/)
}

async function assertNoMoney(page, file) {
    const text = await page.locator('body').innerText()
    const hit = moneyHit(text)
    NOTES.push({ file, hit: hit ? hit[0] : '', sample: text.replace(/\s+/g, ' ').slice(0, 500) })
    if (hit) throw new Error(`${file} shows a money figure (${hit[0]})`)
}

async function hideMoney(page, keepAmounts = false) {
    await page.evaluate((keepAmounts) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        const nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        for (const node of nodes) {
            if (/\$\s?\d/.test(node.nodeValue || '')) {
                node.nodeValue = node.nodeValue
                    .replace(/\.?\s*Estimated cost:[^.]*/gi, '')
                    .replace(/,?\s*estimated(?:\s+cost)?:?\s*\$?[\d.,]*/gi, '')
                    .replace(keepAmounts ? /(?!)/g : /\$[\d.,]+/g, '')
                    .replace(/(\d(?:\.\d)?\s*s)\.\d{3,}/g, '$1')
            }
        }
    }, keepAmounts)
}

// Frames whose main subject is the canvas editor. A large dialog or the expanded chat over a canvas stays light.
const DARK = new Set([
    'canvas/canvas-new-look.png',
    'canvas/canvas-side-panel.png',
    'canvas/grok-model-dropdown.png',
    'canvas/canvas-classic.png',
    'canvas/canvas-workflow-panel.png',
    'canvas/build-with-ai-built.png',
    'canvas/build-with-ai-chat.png'
])

async function shoot(page, file, { width = 1440, height = 960, scheme = 'light', clip } = {}) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme })
    await themeFor(page, DARK.has(file))
    const keepAmounts = file.startsWith('try-the-demo/customer-care-')
    await hideMoney(page, keepAmounts)
    await page.waitForTimeout(200)
    if (!keepAmounts) await assertNoMoney(page, file)
    const dest = path.join(ROOT, 'docs/images', file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    await page.screenshot({ path: dest, ...(clip ? { clip } : {}) })
    log(`wrote ${file}`)
}

async function signIn(page) {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(EMAIL)
    await form.locator('input[type=password]').fill(PASSWORD)
    await form.getByRole('button', { name: /^Sign in/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
}

async function dismissDialogs(page) {
    for (let i = 0; i < 3; i += 1) {
        const dialog = page.locator('.MuiDialog-root [role="dialog"]')
        if (!(await dialog.count())) return
        const text = (await dialog.first().innerText()).replace(/\s+/g, ' ').slice(0, 160)
        if (/How can I help|Type your question|Clear Chat/.test(text)) return
        log(`closing a dialog: ${text}`)
        const close = dialog.getByRole('button', { name: /^(close|cancel|got it|ok|done)$/i })
        if (await close.count()) await close.first().click()
        else await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
    }
}

async function askExpanded(page, question) {
    const input = page.getByPlaceholder('Type your question...')
    await input.fill(question)
    await input.press('Enter')
}

async function scrollChat(page, text) {
    await page.evaluate((needle) => {
        const root = document.querySelector('.MuiDialog-root') || document.body
        const target = [...root.querySelectorAll('p, span, strong, div, button, li')]
            .filter((el) => el.textContent.includes(needle))
            .sort((a, b) => a.textContent.length - b.textContent.length)[0]
        if (target) target.scrollIntoView({ block: 'start' })
    }, text)
    await page.waitForTimeout(300)
}

async function fitCanvas(page) {
    await dismissDialogs(page)
    const fit = page.locator('.react-flow__controls-fitview')
    if (await fit.count()) await fit.click({ timeout: 4000 }).catch(() => {})
}

async function openCanvas(page, route, id) {
    await page.goto(`${BASE}/${route}/${id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(600)
    await fitCanvas(page)
    await page.waitForTimeout(400)
}

async function bakeryFlow(credentialId) {
    const prompt = await buildNode('promptTemplate', 'promptTemplate_0', {
        label: 'Recipe prompt',
        position: { x: 80, y: 180 },
        inputs: { template: 'Suggest a bread recipe for {season}.' }
    })
    const model = await buildNode('chatOllama', 'chatOllama_0', {
        label: 'Local model',
        position: { x: 80, y: 520 },
        inputs: { baseUrl: 'http://localhost:11434', modelName: 'bakery-local', temperature: 0.2 }
    })
    const chain = await buildNode('llmChain', 'llmChain_0', { label: 'Recipe chain', position: { x: 620, y: 220 } })
    const edges = [connect(prompt, chain, 'prompt'), connect(model, chain, 'model')]
    return saveFlow({ name: 'Bakery recipes', type: 'CHATFLOW', nodes: [prompt, model, chain], edges })
}

async function grokFlow() {
    const grok = await buildNode('chatXAI', 'chatXAI_0', { label: 'xAI Grok', position: { x: 280, y: 180 } })
    return saveFlow({ name: 'Grok model', type: 'CHATFLOW', nodes: [grok], edges: [] })
}

async function workflowFlow() {
    const start = await buildNode('startAgentflow', 'startAgentflow_0', {
        label: 'Start',
        position: { x: 80, y: 240 },
        type: 'agentFlow'
    })
    const reply = await buildNode('directReplyAgentflow', 'directReplyAgentflow_0', {
        label: 'Reply',
        position: { x: 420, y: 240 },
        type: 'agentFlow',
        inputs: { directReplyMessage: "Welcome to the bakery! Ask me about today's bread." }
    })
    const source = start.data.outputAnchors?.[0]?.id || `${start.id}-output-${start.data.name}`
    const edge = {
        id: `${start.id}-${source}-${reply.id}-${reply.id}`,
        type: 'agentFlow',
        source: start.id,
        sourceHandle: source,
        target: reply.id,
        targetHandle: reply.id,
        data: { sourceColor: start.data.color, targetColor: reply.data.color }
    }
    return saveFlow({ name: 'Bakery greeting', type: 'AGENTFLOW', nodes: [start, reply], edges: [edge] })
}

const SHARE_CONFIG = {
    title: 'Crumb & Co.',
    welcomeMessage: "Hi! I can help with today's breads and opening hours.",
    textInput: { placeholder: 'Ask about breads or hours' },
    starterPrompts: {
        0: { prompt: 'What breads do you bake?' },
        1: { prompt: 'Are you open on Sunday?' },
        2: { prompt: 'Do you have anything gluten-free?' }
    },
    chatFeedback: { status: true },
    generateNewSession: true
}

async function shareFlow(credentialId) {
    const model = await buildNode('chatOpenAI', 'chatOpenAI_0', {
        label: 'OpenAI',
        position: { x: 80, y: 80 },
        credential: credentialId,
        inputs: { modelName: 'gpt-4.1-mini' }
    })
    const memory = await buildNode('bufferMemory', 'bufferMemory_0', { label: 'Buffer Memory', position: { x: 80, y: 420 } })
    const chain = await buildNode('conversationChain', 'conversationChain_0', {
        label: 'Counter answers',
        position: { x: 560, y: 160 },
        inputs: {
            systemMessagePrompt:
                'You are the counter at Crumb & Co., a made-up bakery. Answer about breads and hours. Never state a price or a currency amount.'
        }
    })
    const edges = [connect(model, chain, 'model'), connect(memory, chain, 'memory')]
    const saved = await saveFlow({
        name: 'Crumb & Co.',
        type: 'CHATFLOW',
        nodes: [model, memory, chain],
        edges,
        chatbotConfig: SHARE_CONFIG,
        isPublic: true
    })
    await publish(saved.id)
    return saved
}

async function chartHarness(credentialId) {
    return api('POST', '/demo', { credentialId, demo: 'bakery' })
}

async function chartChat() {
    const node = await buildNode('harness', 'harness_0', {
        label: 'Crumb sales',
        position: { x: 240, y: 180 },
        inputs: { harnessName: 'bakery-demo' }
    })
    const saved = await saveFlow({
        name: 'Crumb sales chat',
        type: 'CHATFLOW',
        nodes: [node],
        edges: [],
        isPublic: true,
        chatbotConfig: {
            title: 'Crumb & Co.',
            welcomeMessage: 'Ask for a loaf chart.',
            textInput: { placeholder: 'Ask about loaves' },
            allowedOrigins: [BASE, `http://127.0.0.1:${PAGE_PORT}`]
        }
    })
    await publish(saved.id)
    return saved
}

function servePages(shareId, chartId) {
    const pages = {
        '/bubble': `<!doctype html><html><head><meta charset="utf-8"><title>Crumb & Co. Bakery</title>
<style>body{font:18px/1.5 Georgia,serif;margin:48px;color:#26251e;background:#f7f7f4}h1{font-weight:500}</style></head>
<body><h1>Crumb & Co. Bakery</h1><p>Today's breads and opening hours. The chat in the corner can help.</p>
<script src="${BASE}/embed/chat.js" data-flow-id="${shareId}" data-theme="light" data-open="true" defer></script></body></html>`,
        '/chart': `<!doctype html><html><head><meta charset="utf-8"><title>Crumb & Co. Bakery</title>
<style>body{font:18px/1.5 Georgia,serif;margin:48px;color:#26251e;background:#f7f7f4}h1{font-weight:500}</style></head>
<body><h1>Crumb & Co. Bakery</h1><p>This page is on another site. The chat can show a chart of loaves.</p>
<script src="${BASE}/embed/chat.js" data-flow-id="${chartId}" data-theme="light" data-open="true" defer></script></body></html>`
    }
    const server = http.createServer((req, res) => {
        const html = pages[req.url] || pages['/bubble']
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(html)
    })
    return new Promise((resolve) => server.listen(PAGE_PORT, '127.0.0.1', () => resolve(server)))
}

async function askWidget(page, question) {
    const input = page.locator('textarea, input[type=text]').last()
    await input.waitFor({ timeout: 20000 })
    await input.fill(question)
    await page.locator('button[title="Send"], button[aria-label="Send"]').last().click()
    await page.locator('.dc-bot-bubble, .dc-msg.bot').last().waitFor({ timeout: 180000 })
    await page.waitForFunction(() => !document.querySelector('.dc-typing') && !document.querySelector('button[title="Stop"]'), null, {
        timeout: 180000
    })
    await page.waitForTimeout(800)
}

async function main() {
    log(`data directory ready (not printed)`)
    startStub()
    if (!EXTERNAL) await waitFor(`http://127.0.0.1:${STUB_PORT}/health`, 20, 'stand-in')
    startServer()
    await waitFor(`${BASE}/api/v1/ping`, 180, 'server')
    log('server is up')

    await api('POST', '/account/register', { user: { name: OWNER, email: EMAIL, credential: PASSWORD } })
    await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD })
    const credential = await api('POST', '/credentials', {
        name: 'OpenAI demo',
        credentialName: 'openAIApi',
        plainDataObj: { openAIApiKey: LOCAL_KEY }
    })

    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, colorScheme: 'light' })
    await context.addInitScript(() => localStorage.setItem('isDarkMode', 'false'))
    const page = await context.newPage()
    await signIn(page)

    if (want('card')) {
        await page.goto(`${BASE}/chatflows`, { waitUntil: 'domcontentloaded' })
        await page.locator('#try-the-demo').waitFor({ timeout: 20000 })
        await shoot(page, 'try-the-demo/try-the-demo-card.png')
        const controls = page.locator('#try-the-demo').getByRole('button', { name: 'Try the demo' })
        await controls.waitFor()
        await assertNoMoney(page, 'try-the-demo/try-the-demo-key.png')
        await page.locator('#try-the-demo').screenshot({ path: path.join(ROOT, 'docs/images/try-the-demo/try-the-demo-key.png') })
        log('wrote try-the-demo/try-the-demo-key.png')
    }

    if (want('demo') || want('demo-chart')) {
        if (want('demo')) {
            await page.goto(`${BASE}/chatflows`, { waitUntil: 'domcontentloaded' })
            await page.locator('#try-the-demo').getByRole('button', { name: 'Try the demo' }).click()
            await page.waitForURL(/harnesscanvas/, { timeout: 180000 })
            await page.getByRole('button', { name: /Maya Okafor/ }).waitFor({ timeout: 60000 })
            await disableStreaming('customer-care-demo')
            await page.getByRole('button', { name: 'expand' }).click()
            await page.getByText('Hi there! How can I help?').waitFor()
            await page.evaluate(() => {
                const paper = document.querySelector('.MuiDialog-paper')
                if (paper) {
                    paper.style.maxWidth = '960px'
                    paper.style.width = '960px'
                }
                document.querySelectorAll('.MuiDialog-paper button').forEach((button) => {
                    button.style.whiteSpace = 'normal'
                    button.style.height = 'auto'
                    button.style.textAlign = 'left'
                })
            })
            await page.waitForTimeout(300)
            await shoot(page, 'try-the-demo/customer-care-open.png')
            await page.getByRole('button', { name: /Maya Okafor/ }).click()
            await page.getByText('Decision', { exact: false }).waitFor({ timeout: 240000 })
            await page.waitForTimeout(800)
            const remedy = page.getByText('name the remedy steps')
            for (let i = 0; i < 3 && !(await remedy.isVisible().catch(() => false)); i += 1) {
                await page.getByText('policy', { exact: true }).click()
                await page.waitForTimeout(400)
            }
            await shoot(page, 'try-the-demo/customer-care-policy.png')
            await scrollChat(page, 'Harness Prime sent work')
            await shoot(page, 'try-the-demo/customer-care-run.png')
            await scrollChat(page, 'Source: Service Recovery Policy')
            await shoot(page, 'try-the-demo/customer-care-answer.png')
            await askExpanded(
                page,
                'Daniel Reyes wrote in on 6 Oct about order LH-20398: "My duvet set was due Saturday and it still isn\'t here. Where is it?"'
            )
            await settle(page)
            await page.waitForTimeout(800)
            const trace = page.getByText('warehouse scans, carrier scans').last()
            for (let i = 0; i < 3 && !(await trace.isVisible().catch(() => false)); i += 1) {
                await page.getByText('operations', { exact: true }).last().click()
                await page.waitForTimeout(400)
            }
            await shoot(page, 'try-the-demo/customer-care-carrier.png')
            await askExpanded(page, 'Which orders are held in a warehouse right now, and which of those customers are Plus or Premier?')
            await settle(page)
            await page.waitForTimeout(800)
            await scrollChat(page, 'Which orders are held in a warehouse right now').catch(() => {})
            await shoot(page, 'try-the-demo/customer-care-held.png', { height: 800 })
        }

        await page.goto(`${BASE}/chatflows`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /bakery quickstart/i }).click()
        await page.waitForURL(/harnesscanvas/, { timeout: 240000 })
        await page
            .getByText(/croissant|revenue|opening hours/i)
            .first()
            .waitFor({ timeout: 60000 })
        if (await page.getByRole('button', { name: 'expand' }).count()) await page.getByRole('button', { name: 'expand' }).click()
        if (want('demo')) await shoot(page, 'try-the-demo/demo-open.png')
        await disableStreaming('bakery-demo')
        await page.getByRole('button', { name: /croissant/i }).click()
        await settle(page)
        await shoot(page, 'try-the-demo/demo-chart.png')
    }

    if (want('canvas')) {
        const bakery = await bakeryFlow(credential.id)
        const grok = await grokFlow()
        const greeting = await workflowFlow()
        await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'panel'))
        await openCanvas(page, 'canvas', bakery.id)
        await shoot(page, 'canvas/canvas-new-look.png')
        await page.locator('.react-flow__node', { hasText: 'Recipe prompt' }).click()
        await page.getByTestId('node-side-panel').waitFor()
        await shoot(page, 'canvas/canvas-side-panel.png')
        await openCanvas(page, 'canvas', grok.id)
        await page.locator('.react-flow__node').first().click()
        await page.getByTestId('node-side-panel').waitFor()
        const panel = page.getByTestId('node-side-panel')
        await panel.locator('input[role="combobox"]').nth(1).click()
        await page.locator('.MuiAutocomplete-listbox').getByText('grok-4.6').waitFor({ timeout: 20000 })
        await shoot(page, 'canvas/grok-model-dropdown.png')
        await page.keyboard.press('Escape')
        await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'classic'))
        await openCanvas(page, 'canvas', bakery.id)
        await shoot(page, 'canvas/canvas-classic.png')
        await page.goto(`${BASE}/chatflows`, { waitUntil: 'domcontentloaded' })
        await page.locator('.MuiAvatar-root').last().click()
        const classicSwitch = page.getByRole('switch', { name: /Classic cards/ })
        if ((await classicSwitch.getAttribute('aria-checked')) !== 'true') await classicSwitch.click()
        await page.waitForTimeout(300)
        await shoot(page, 'canvas/canvas-classic-cards-setting.png', { height: 1240 })
        await page.keyboard.press('Escape')
        await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'panel'))
        await openCanvas(page, 'v2/agentcanvas', greeting.id)
        await page.locator('.react-flow__node', { hasText: 'Reply' }).click()
        await page.getByTestId('node-side-panel').waitFor()
        await shoot(page, 'canvas/canvas-workflow-panel.png')

        await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'panel'))
        await page.goto(`${BASE}/canvas`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: 'Build with AI' }).click()
        await page.getByRole('button', { name: /math helper/i }).click()
        await page.getByRole('button', { name: 'Build', exact: true }).waitFor()
        await shoot(page, 'canvas/build-with-ai-dialog.png')
        await page.getByRole('button', { name: 'Build', exact: true }).click()
        await page.getByText('Math Helper with Calculator').first().waitFor({ timeout: 60000 })
        await page.locator('.react-flow__controls-fitview').click()
        await shoot(page, 'canvas/build-with-ai-built.png')
        await page.getByTitle('Save Chatflow').click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await page.getByText(/Draft/).waitFor({ timeout: 20000 })
        await page.locator('button[aria-label="chat"]').click()
        const chatInput = page.getByPlaceholder(/Ask|Type|Send a message|question/i).last()
        await chatInput.fill('What is 18 times 24?')
        await page.keyboard.press('Enter')
        await page.getByText('432').waitFor({ timeout: 120000 })
        await shoot(page, 'canvas/build-with-ai-chat.png')
        await page.getByRole('button', { name: 'Publish' }).click()
        await page.getByRole('button', { name: 'Run check' }).click()
        await page
            .getByText(/answered/)
            .last()
            .waitFor({ timeout: 180000 })
        await page.evaluate(() => document.querySelectorAll('[class*="SnackbarContainer"]').forEach((el) => el.remove()))
        await shoot(page, 'canvas/build-with-ai-check.png')
    }

    if (want('share') || want('api')) {
        const share = await shareFlow(credential.id)
        const harness = want('share') ? await chartHarness(credential.id) : null
        const chart = harness ? await chartChat() : null
        const site = chart ? await servePages(share.id, chart.id) : null

        if (want('share')) {
            await page.goto(`${BASE}/chatbot/${share.id}`, { waitUntil: 'domcontentloaded' })
            await page.getByText("Hi! I can help with today's breads and opening hours.").waitFor()
            await shoot(page, 'share-and-embed/share-welcome.png')
            await askWidget(page, 'Do you have anything gluten-free?')
            await shoot(page, 'share-and-embed/share-light.png')
            await page.emulateMedia({ colorScheme: 'dark' })
            await page.reload({ waitUntil: 'domcontentloaded' })
            await askWidget(page, 'Are you open on Sunday? Show the week as a table.')
            await shoot(page, 'share-and-embed/share-dark.png', { scheme: 'dark' })
            await page.emulateMedia({ colorScheme: 'light' })
            await page.setViewportSize({ width: 390, height: 844 })
            await page.reload({ waitUntil: 'domcontentloaded' })
            await askWidget(page, 'Are you open on Sunday? Show the week as a table.')
            await shoot(page, 'share-and-embed/share-mobile.png', { width: 390, height: 844 })

            await page.setViewportSize({ width: 1280, height: 1000 })
            await page.emulateMedia({ colorScheme: 'dark' })
            await page.goto(`${BASE}/chatbot/${chart.id}`, { waitUntil: 'domcontentloaded' })
            await askWidget(page, 'Compare sourdough and rye loaves: sourdough 120, rye 75')
            await page
                .locator('img')
                .first()
                .waitFor({ timeout: 15000 })
                .catch(() => log('harness chart had no image'))
            await shoot(page, 'share-and-embed/harness-chart.png', { width: 1280, height: 1000, scheme: 'dark' })

            await page.emulateMedia({ colorScheme: 'light' })
            await page.setViewportSize({ width: 1440, height: 960 })
            await page.goto(`http://127.0.0.1:${PAGE_PORT}/bubble`, { waitUntil: 'domcontentloaded' })
            await askWidget(page, 'Do you have anything gluten-free?')
            await shoot(page, 'share-and-embed/embed-bubble.png')
            await page.setViewportSize({ width: 1280, height: 1000 })
            await page.goto(`http://127.0.0.1:${PAGE_PORT}/chart`, { waitUntil: 'domcontentloaded' })
            await askWidget(page, 'Chart this week of croissant loaves')
            await page
                .locator('img')
                .first()
                .waitFor({ timeout: 15000 })
                .catch(() => log('embed chart had no image'))
            await shoot(page, 'share-and-embed/embed-chart.png', { width: 1280, height: 1000 })
        }

        if (want('api')) {
            const helper = await shareFlow(credential.id)
            // The example app uses an API key, not the model credential. Create the key and three flows that use it.
            const created = await api('POST', '/apikey', { keyName: 'Bakery website', permissions: ['chatflows:view'] })
            const revealed = (Array.isArray(created) ? created : created.data || []).find((row) => row.apiKey)
            const apiKey = revealed?.apiKey
            const keyId = revealed?.id
            if (!apiKey || !keyId) throw new Error('API key was not returned')
            await api('PUT', `/chatflows/${helper.id}`, { apikeyid: keyId, name: 'Bakery helper', isPublic: false })
            for (const name of ['Counter answers', 'Bread list']) {
                const extra = await shareFlow(credential.id)
                await api('PUT', `/chatflows/${extra.id}`, { apikeyid: keyId, name, isPublic: false })
            }
            await page.goto(`${BASE}/apikey`, { waitUntil: 'domcontentloaded' })
            await page.getByText('Bakery website').waitFor()
            await page.getByText('Hidden').waitFor()
            await shoot(page, 'api/api-keys-page.png')

            const app = track(
                spawn(process.execPath, [path.join(ROOT, 'examples/web-app/server.mjs')], {
                    cwd: path.join(ROOT, 'examples/web-app'),
                    env: {
                        ...process.env,
                        PORT: '8090',
                        CUTTLELY_URL: BASE,
                        CUTTLELY_FLOW_ID: helper.id,
                        CUTTLELY_API_KEY: apiKey
                    },
                    stdio: ['ignore', 'inherit', 'inherit'],
                    detached: true
                })
            )
            app.unref()
            await waitFor('http://127.0.0.1:8090/', 20, 'example app')
            await page.goto('http://127.0.0.1:8090/', { waitUntil: 'domcontentloaded' })
            const ask = async (question) => {
                await page.locator('#question').fill(question)
                await page.locator('#ask').click()
                await page.locator('#log .a').last().waitFor({ timeout: 60000 })
                await page.waitForFunction(() => !document.querySelector('#ask').disabled, null, { timeout: 60000 })
            }
            await ask('Hi, I am Sam. Is rye bread baked today? It is Saturday.')
            await ask('What is my name, and are you open on Sunday?')
            await shoot(page, 'api/api-example-app.png')
        }
        if (site) site.close()
    }

    fs.writeFileSync('/tmp/docs-shot-notes.json', JSON.stringify(NOTES, null, 2))
    await browser.close()
    log('capture finished')
}

main()
    .catch((error) => {
        console.error(`[docs-shots] ${error.message || error}`)
        fs.writeFileSync('/tmp/docs-shot-notes.json', JSON.stringify(NOTES, null, 2))
        process.exitCode = 1
    })
    .finally(() => {
        stopAll()
    })
