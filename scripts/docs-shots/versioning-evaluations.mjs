// Reshoot docs/images/versioning and docs/images/evaluations from a local server.
// No outside account. Chat answers come from fake-model.cjs. GitHub is the local stand-in.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort, waitForPing } from '../smoke-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const SERVER = path.join(ROOT, 'packages', 'server')
const PRELOAD = path.join(ROOT, 'scripts', 'docs-shots', 'fake-model.cjs')
const SSO_GUARD = path.join(ROOT, 'scripts', 'refuse-sso-load.cjs')
const EMAIL = 'rosa@rosas-bakery.example'
const PASSWORD = 'BakeryCounter1!'
const OWNER = 'Rosa Diaz'
const MODEL = 'gpt-4.1-mini-2025-04-14'
const ONLY = new Set(
    String(process.env.DOCS_SHOTS_ONLY || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
)
const VIEW = { width: 1440, height: 960 }
const TALL = { width: 1440, height: 1100 }
const COMPACT = { width: 1280, height: 860 }
const WEBHOOK_VIEW = { width: 1280, height: 893 }

const LIVE_SYSTEM =
    "You are the counter at Rosa's Bakery. Saturday hours are 8 AM to 2 PM. Gluten-free bread is baked only on Tuesdays. Rye loaves are baked every morning. Birthday cakes need an order by Wednesday."
const DRAFT_SATURDAY = LIVE_SYSTEM.replace('8 AM', '7 AM')
const PROMOTE_SYSTEM = LIVE_SYSTEM.replace('8 AM', '7 AM').replace('only on Tuesdays', 'every day')
const AGENT_DRAFT =
    "You are the counter at Rosa's Bakery. Saturday hours are 7 AM to 2 PM. Gluten-free bread is baked every day. Please place birthday cake orders by Wednesday. Rye loaves are baked every morning."

const QUESTIONS = [
    'Do you have rye loaves today?',
    'Can I order a birthday cake for Friday?',
    'Do you have gluten-free bread today?',
    'What time do you open on Saturday?'
]

const stops = []

function want(name) {
    if (!ONLY.size) return true
    return ONLY.has(name) || ONLY.has(path.basename(name, '.png'))
}

function brief(text) {
    return String(text || '')
        .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
        .replace(/sk-[A-Za-z0-9_-]+/g, '[hidden]')
        .slice(0, 400)
}

async function api(url, { method = 'GET', cookie = '', bearer = '', body, timeoutMs = 60000 } = {}) {
    const headers = {}
    if (!bearer) headers['x-request-from'] = 'internal'
    if (cookie) headers.cookie = cookie
    if (bearer) headers.authorization = `Bearer ${bearer}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const cookieOut = setCookie.map((item) => item.split(';')[0]).join('; ') || cookie
    return { status: response.status, text, cookie: cookieOut }
}

function json(result, what) {
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`${what} ${result.status}: ${brief(result.text)}`)
    }
    if (!result.text) return null
    return JSON.parse(result.text)
}

function freePortPromise() {
    return freePort()
}

function startApp(dataDir, port, extra) {
    const logs = []
    const env = { ...process.env, ...extra }
    for (const key of Object.keys(env)) {
        if (/^(OPENAI|ANTHROPIC|AZURE|GOOGLE|GEMINI|XAI|GROK).*KEY/i.test(key)) delete env[key]
    }
    env.HOST = '127.0.0.1'
    env.PORT = String(port)
    env.DATABASE_PATH = dataDir
    env.SECRETKEY_PATH = dataDir
    env.CUTTLELY_DATA_DIR = path.join(dataDir, 'cuttlely')
    env.CUTTLELY_WARM_HERMES = 'false'
    env.CUTTLELY_HARNESS_QUEUE = 'off'
    env.MODEL_LIST_CONFIG_JSON = 'bundled'
    env.CUTTLELY_LOCAL_ADMIN = 'true'
    env.NODE_ENV = 'development'
    env.TZ = 'UTC'
    delete env.MODE
    const child = spawn(process.execPath, ['-r', SSO_GUARD, '-r', PRELOAD, path.join(SERVER, 'bin', 'run'), 'start'], {
        cwd: SERVER,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const keep = (chunk) => {
        logs.push(String(chunk))
        if (logs.length > 60) logs.shift()
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
    stops.push(stop)
    return { child, logs, stop, dataDir, port, base: `http://127.0.0.1:${port}` }
}

async function boot(extra = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-docs-shots-'))
    const port = await freePortPromise()
    const app = startApp(dataDir, port, extra)
    await waitForPing(app.base, app.child, app.logs)
    return app
}

async function signUp(base) {
    json(
        await api(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: OWNER, email: EMAIL, credential: PASSWORD } }
        }),
        'register'
    )
    const loggedIn = await api(`${base}/api/v1/auth/login`, {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD }
    })
    if (loggedIn.status !== 200 || !loggedIn.cookie) throw new Error(`login ${loggedIn.status}: ${brief(loggedIn.text)}`)
    return loggedIn.cookie
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

async function buildNode(base, cookie, name, id, { label, position }) {
    const def = json(await api(`${base}/api/v1/nodes/${name}`, { cookie }), `node ${name}`)
    const inputParams = []
    const inputAnchors = []
    const defaults = {}
    for (const input of def.inputs || []) {
        const entry = { ...input, id: `${id}-input-${input.name}-${input.type}` }
        if (PARAM_TYPES.has(input.type)) inputParams.push(entry)
        else inputAnchors.push(entry)
        defaults[input.name] = input.default ?? ''
    }
    let outputAnchors
    let outputs = {}
    if (def.outputs?.length) {
        const options = def.outputs.map((output) => ({
            id: `${id}-output-${output.name}-${(output.baseClasses || []).join('|')}`,
            name: output.name,
            label: output.label,
            type: (output.baseClasses || []).join(' | ')
        }))
        outputAnchors = [{ name: 'output', label: 'Output', type: 'options', options, default: def.outputs[0].name }]
        outputs = { output: def.outputs[0].name }
    } else {
        outputAnchors = [
            {
                id: `${id}-output-${def.name}-${(def.baseClasses || []).join('|')}`,
                name: def.name,
                label: def.type,
                type: (def.baseClasses || []).join(' | ')
            }
        ]
    }
    return {
        id,
        position,
        type: 'customNode',
        data: {
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
            inputs: defaults,
            outputAnchors,
            outputs,
            selected: false
        }
    }
}

function connectNodes(source, target, inputName) {
    const anchor =
        (target.data.inputAnchors || []).find((item) => item.name === inputName) ||
        (target.data.inputParams || []).find((item) => item.name === inputName)
    const targetHandle = anchor?.id || `${target.id}-input-${inputName}`
    const sourceAnchor = source.data.outputAnchors?.[0]
    const sourceHandle = sourceAnchor?.options?.[0]?.id || sourceAnchor?.id
    return {
        id: `${source.id}-${target.id}-${inputName}`,
        source: source.id,
        target: target.id,
        sourceHandle,
        targetHandle,
        type: 'buttonedge'
    }
}

function agentEdge(source, target) {
    return {
        id: `${source.id}-${target.id}`,
        source: source.id,
        target: target.id,
        sourceHandle: `${source.id}-output-0`,
        targetHandle: target.id,
        type: 'agentFlow',
        data: { sourceColor: '#64B5F6', targetColor: '#4DDBBB' }
    }
}

function canvas(nodes, edges) {
    return JSON.stringify({ nodes, edges, viewport: { x: 80, y: 40, zoom: 0.85 } })
}

async function createFlow(base, cookie, body) {
    return json(await api(`${base}/api/v1/chatflows`, { method: 'POST', cookie, body }), `create ${body.name}`)
}

async function getFlow(base, cookie, id) {
    return json(await api(`${base}/api/v1/chatflows/${id}`, { cookie }), 'get flow')
}

async function putFlow(base, cookie, id, flowData, extra = {}, bearer = '') {
    const current = await getFlow(base, cookie, id)
    const body = {
        name: current.name,
        type: current.type,
        flowData,
        chatbotConfig: current.chatbotConfig,
        category: current.category,
        deployed: current.deployed,
        ...extra
    }
    const opts = { method: 'PUT', body }
    if (bearer) opts.bearer = bearer
    else opts.cookie = cookie
    return json(await api(`${base}/api/v1/chatflows/${id}`, opts), 'update flow')
}

async function saveDraft(base, cookie, id, flowData) {
    return json(await api(`${base}/api/v1/flow-drafts/${id}`, { method: 'PUT', cookie, body: { flowData } }), 'save draft')
}

async function versionsOf(base, cookie, id) {
    const list = json(await api(`${base}/api/v1/flow-versions/${id}`, { cookie }), 'versions')
    return list.versions || []
}

async function credential(base, cookie, name, keyName = 'openAIApi') {
    const made = json(
        await api(`${base}/api/v1/credentials`, {
            method: 'POST',
            cookie,
            body: { name, credentialName: keyName, plainDataObj: { openAIApiKey: 'docs-shot-placeholder' } }
        }),
        `credential ${name}`
    )
    return made.id
}

async function mintKey(base, cookie) {
    const listed = json(
        await api(`${base}/api/v1/apikey`, {
            method: 'POST',
            cookie,
            body: {
                keyName: 'docs-shots',
                permissions: [
                    'chatflows:create',
                    'chatflows:view',
                    'chatflows:update',
                    'agentflows:create',
                    'agentflows:view',
                    'agentflows:update'
                ]
            }
        }),
        'api key'
    )
    const rows = Array.isArray(listed) ? listed : listed.data || []
    const row = rows.find((item) => typeof item.apiKey === 'string' && item.apiKey.length > 8)
    if (!row) throw new Error('api key response had no usable key')
    return row.apiKey
}

function withSystem(flowData, text) {
    const data = JSON.parse(flowData)
    const node = data.nodes.find((item) => item.data.name === 'conversationChain')
    node.data.inputs.systemMessagePrompt = text
    return JSON.stringify(data)
}

function withPositions(flowData, positions) {
    const data = JSON.parse(flowData)
    for (const node of data.nodes) {
        if (positions[node.id]) node.position = positions[node.id]
    }
    return JSON.stringify(data)
}

function withModel(flowData, { credentialId, temperature, modelName }) {
    const data = JSON.parse(flowData)
    const node = data.nodes.find((item) => item.data.name === 'chatOpenAI')
    node.data.credential = credentialId
    node.data.inputs.modelName = modelName
    node.data.inputs.temperature = temperature
    return JSON.stringify(data)
}

async function predict(base, cookie, id, question, chatId) {
    const result = await api(`${base}/api/v1/prediction/${id}`, {
        method: 'POST',
        cookie,
        timeoutMs: 120000,
        body: { question, chatId, streaming: false }
    })
    if (result.status !== 200) throw new Error(`predict ${result.status}: ${brief(result.text)}`)
    return result.text
}

async function messagesOf(base, cookie, id) {
    const result = json(await api(`${base}/api/v1/chatmessage/${id}?order=ASC&feedback=true`, { cookie }), 'messages')
    if (Array.isArray(result)) return result
    return result.data || result.messages || []
}

function githubStandIn(root) {
    const repos = [
        { full_name: 'rosas-bakery/cuttlely-flows', private: true, size: 0, permissions: { push: true }, archived: false },
        { full_name: 'rosas-bakery/website', private: true, size: 12, permissions: { push: true }, archived: false },
        { full_name: 'rosas-bakery/order-forms', private: true, size: 4, permissions: { push: true }, archived: false },
        { full_name: 'rosas-bakery/menu-photos', private: true, size: 8, permissions: { push: true }, archived: false }
    ]
    fs.mkdirSync(path.join(root, 'rosas-bakery'), { recursive: true })
    const bare = path.join(root, 'rosas-bakery', 'cuttlely-flows.git')
    fs.rmSync(bare, { recursive: true, force: true })
    spawnSyncGit(['init', '--bare', bare])
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
        }
        if (req.method === 'GET' && url.pathname === '/user') return send(200, { login: 'rosas-bakery' })
        if (req.method === 'GET' && url.pathname === '/user/repos') {
            const page = Number(url.searchParams.get('page') || '1')
            return send(200, page === 1 ? repos : [])
        }
        if (req.method === 'POST' && url.pathname === '/user/repos') {
            let raw = ''
            req.on('data', (chunk) => {
                raw += chunk
            })
            req.on('end', () => {
                const name = JSON.parse(raw || '{}').name || 'cuttlely-flows'
                const full = `rosas-bakery/${name}`
                if (!repos.some((item) => item.full_name === full)) {
                    repos.unshift({ full_name: full, private: true, size: 0, permissions: { push: true }, archived: false })
                    const dir = path.join(root, 'rosas-bakery', `${name}.git`)
                    if (!fs.existsSync(dir)) spawnSyncGit(['init', '--bare', dir])
                }
                send(201, { full_name: full, private: true })
            })
            return
        }
        send(404, { message: 'not found' })
    })
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                bare,
                close: () => server.close()
            })
        })
    })
}

function spawnSyncGit(args) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${brief(result.stderr)}`)
}

async function launchBrowser() {
    const { chromium } = require('playwright')
    return chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

async function openPage(browser, base) {
    const context = await browser.newContext({ viewport: VIEW, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1 })
    await context.addInitScript(() => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', 'panel')
    })
    const page = await context.newPage()
    await page.goto(`${base}/signin`, { waitUntil: 'domcontentloaded' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(EMAIL)
    await form.locator('input[type=password]').fill(PASSWORD)
    await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 30000 })
    return page
}

async function animationsDone(page, timeout = 12000) {
    await page.waitForFunction(
        () =>
            document.getAnimations().every((anim) => {
                if (anim.playState !== 'running') return true
                const targetNode = anim.effect && anim.effect.target
                if (targetNode && targetNode.nodeType === 1) {
                    const style = getComputedStyle(targetNode)
                    if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return true
                }
                const timing = anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : null
                if (timing && timing.iterations === Infinity) return true
                return false
            }),
        null,
        { timeout, polling: 50 }
    )
}

// The target has to be on screen, opaque, and finished with its own transition. A label that
// already exists (a button named the same as the card it opens) is not enough.
async function ready(page, locator, timeout = 20000) {
    const target = locator.first()
    await target.waitFor({ state: 'visible', timeout })
    const handle = await target.elementHandle()
    if (!handle) throw new Error('the target was not in the page')
    await page.waitForFunction(
        (el) => {
            if (!el || !el.isConnected) return false
            const chain = []
            let node = el
            while (node) {
                chain.push(node)
                node = node.parentElement
            }
            for (const item of chain) {
                const style = getComputedStyle(item)
                if (style.display === 'none' || style.visibility === 'hidden') return false
                const opacity = Number.parseFloat(style.opacity)
                if (Number.isFinite(opacity) && opacity < 0.99) return false
            }
            const running = typeof document.getAnimations === 'function' ? document.getAnimations() : []
            return running.every((anim) => {
                const targetNode = anim.effect && anim.effect.target
                if (!targetNode || !chain.includes(targetNode)) return true
                const style = targetNode.nodeType === 1 ? getComputedStyle(targetNode) : null
                if (style && (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0))
                    return true
                const timing = anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : null
                if (timing && timing.iterations === Infinity) return true
                return anim.playState === 'finished' || anim.playState === 'idle'
            })
        },
        handle,
        { timeout, polling: 50 }
    )
}

async function shot(page, rel, size = VIEW) {
    if (!want(rel)) return
    if (page.viewportSize().width !== size.width || page.viewportSize().height !== size.height) {
        await page.setViewportSize(size)
        await animationsDone(page)
    }
    await animationsDone(page)
    const target = path.join(ROOT, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    await page.screenshot({ path: target })
    console.log('shot', rel)
}

async function see(page, text, timeout = 20000) {
    const locator = page.getByText(text, { exact: false }).first()
    await ready(page, locator, timeout)
}

async function onScreen(page, locator, timeout = 20000) {
    const target = locator.first()
    await ready(page, target, timeout)
    const handle = await target.elementHandle()
    if (!handle) throw new Error('the target was not in the page')
    await page.waitForFunction(
        (el) => {
            const rect = el.getBoundingClientRect()
            return (
                rect.width > 8 &&
                rect.height > 8 &&
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= window.innerHeight + 1 &&
                rect.right <= window.innerWidth + 1
            )
        },
        handle,
        { timeout, polling: 50 }
    )
}

// Scroll the target up until its box sits fully above a fixed footer or bar.
async function sitAbove(page, locator, footer, timeout = 20000) {
    const target = locator.first()
    await target.waitFor({ state: 'visible', timeout })
    const bar = footer.first()
    const node = await target.elementHandle()
    const stop = (await bar.count()) ? await bar.elementHandle() : null
    if (!node) throw new Error('the target was not in the page')
    await page.waitForFunction(
        ({ el, barEl }) => {
            const scrollParent = (start) => {
                let parent = start.parentElement
                while (parent) {
                    const style = getComputedStyle(parent)
                    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) return parent
                    parent = parent.parentElement
                }
                return null
            }
            const fits = () => {
                const rect = el.getBoundingClientRect()
                const limit = barEl ? barEl.getBoundingClientRect().top : window.innerHeight
                return (
                    rect.width > 8 &&
                    rect.height > 8 &&
                    rect.top >= 8 &&
                    rect.left >= 0 &&
                    rect.bottom <= limit - 6 &&
                    rect.right <= window.innerWidth + 1
                )
            }
            if (fits()) return true
            const parent = scrollParent(el)
            const rect = el.getBoundingClientRect()
            const limit = barEl ? barEl.getBoundingClientRect().top : window.innerHeight
            const delta = Math.max(16, rect.bottom - limit + 12)
            if (parent) parent.scrollTop += delta
            else window.scrollBy(0, delta)
            return fits()
        },
        { el: node, barEl: stop },
        { timeout, polling: 50 }
    )
    await ready(page, target, timeout)
}

async function showFully(page, locator, timeout = 20000) {
    const target = locator.first()
    await target.waitFor({ state: 'attached', timeout })
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await onScreen(page, target, timeout)
}

async function fitCanvas(page) {
    const node = page.locator('.react-flow__node').first()
    await ready(page, node)
    const fit = page.locator('.react-flow__controls-fitview')
    if (await fit.count()) {
        await fit.click()
        await ready(page, node)
        await animationsDone(page)
    }
}

async function canvasOf(page, base, id, agent = false) {
    const route = agent ? `/v2/agentcanvas/${id}` : `/canvas/${id}`
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    await page.getByTitle('Version history').waitFor({ timeout: 30000 })
    await page.waitForTimeout(600)
}

async function versionPage(page, base, id, sha) {
    await page.goto(`${base}/versions/${id}/${sha}`, { waitUntil: 'domcontentloaded' })
    await see(page, 'Read-only version', 30000)
    await page.waitForTimeout(500)
}

async function openPublish(page) {
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await ready(page, page.getByRole('dialog').getByRole('heading', { name: 'Publish' }))
}

async function openGate(page, dataset) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByText('Configuration', { exact: true }).click()
    const dialog = page.getByRole('dialog')
    await ready(page, dialog.getByRole('heading', { name: 'Chatflow Configuration' }))
    await page.getByText('View Messages', { exact: true }).waitFor({ state: 'hidden' })
    await dialog.getByText('Passing test set', { exact: true }).click()
    const note = dialog.getByText('Publish is refused until this draft passes the dataset at the mark you set.')
    await ready(page, note)
    const datasetSelect = dialog.locator('[data-testid="publish-gate-dataset"]')
    await ready(page, datasetSelect)
    const selectHandle = await datasetSelect.elementHandle()
    await page.waitForFunction(
        ({ el, name }) => {
            const chosen = el.options && el.options[el.selectedIndex]
            return Boolean(chosen && chosen.text.trim() === name)
        },
        { el: selectHandle, name: dataset }
    )
    await ready(page, dialog.getByRole('heading', { name: 'Chatflow Configuration' }))
    await page.getByText('View Messages', { exact: true }).waitFor({ state: 'hidden' })
    await animationsDone(page)
}

function byTitle(versions, part) {
    const found = versions.find((item) => String(item.title || '').includes(part))
    if (!found) throw new Error(`no version matching ${part}: ${versions.map((item) => item.title).join(' | ')}`)
    return found
}

async function insertExecutions(dataDir, flowId, workspaceId) {
    const db = new DatabaseSync(path.join(dataDir, 'database.sqlite'))
    const stamp = (seconds) => `2026-10-13 08:51:${String(seconds).padStart(2, '0')}`
    const row = (id, header, seconds) => {
        const executionData = JSON.stringify([
            {
                nodeId: 'startAgentflow_0',
                nodeLabel: 'Start',
                data: {
                    name: 'startAgentflow',
                    output: { webhook: { body: { event: 'bake', loaf: 'rye' }, headers: { 'x-bakery': header }, query: {} } }
                },
                status: 'FINISHED'
            }
        ])
        db.prepare(
            `INSERT INTO execution (id, executionData, state, agentflowId, sessionId, isPublic, createdDate, updatedDate, stoppedDate, workspaceId)
             VALUES (?, ?, 'FINISHED', ?, ?, 0, ?, ?, ?, ?)`
        ).run(id, executionData, flowId, `session-${id}`, stamp(seconds), stamp(seconds), stamp(seconds), workspaceId)
    }
    row('11111111-1111-4111-8111-111111111111', 'oven-a', 10)
    row('22222222-2222-4222-8222-222222222222', 'oven-b', 40)
    db.close()
}

async function main() {
    if (!fs.existsSync(path.join(SERVER, 'dist', 'commands'))) throw new Error('Build the server first: pnpm build')
    const githubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-docs-github-'))
    const github = await githubStandIn(githubRoot)
    stops.push(github.close)
    const githubEnv = {
        CUTTLELY_GITHUB_ALLOW_FILE_REMOTES: 'on',
        CUTTLELY_GITHUB_TEST_ROOT: githubRoot,
        CUTTLELY_GITHUB_TEST_API: github.url
    }
    console.log('boot dev')
    const dev = await boot(githubEnv)
    const cookie = await signUp(dev.base)
    const browser = await launchBrowser()
    stops.push(() => browser.close())
    const page = await openPage(browser, dev.base)
    const trial = await credential(dev.base, cookie, 'OpenAI trial')
    const mainCred = await credential(dev.base, cookie, 'OpenAI main')
    const orders = await credential(dev.base, cookie, 'OpenAI orders')

    const memory = await buildNode(dev.base, cookie, 'bufferMemory', 'bufferMemory_0', {
        label: 'Buffer Memory',
        position: { x: 40, y: 40 }
    })
    const model = await buildNode(dev.base, cookie, 'chatOpenAI', 'chatOpenAI_0', {
        label: 'ChatOpenAI',
        position: { x: 40, y: 360 }
    })
    model.data.credential = trial
    model.data.inputs.modelName = MODEL
    model.data.inputs.temperature = '0.2'
    const chain = await buildNode(dev.base, cookie, 'conversationChain', 'conversationChain_0', {
        label: 'Conversation Chain',
        position: { x: 520, y: 160 }
    })
    chain.data.inputs.systemMessagePrompt = "You answer for Rosa's Bakery."
    chain.data.inputs.model = '{{chatOpenAI_0.data.instance}}'
    chain.data.inputs.memory = '{{bufferMemory_0.data.instance}}'
    const edges = [connectNodes(model, chain, 'model'), connectNodes(memory, chain, 'memory')]
    const created = await createFlow(dev.base, cookie, {
        name: 'Bakery helper',
        type: 'CHATFLOW',
        deployed: false,
        flowData: canvas([memory, model, chain], edges)
    })
    const flowId = created.id
    let flowData = created.flowData

    const key = await mintKey(dev.base, cookie)
    flowData = withModel(flowData, { credentialId: mainCred, temperature: '0', modelName: MODEL })
    await putFlow(dev.base, cookie, flowId, flowData, {}, key)

    flowData = withPositions(flowData, {
        bufferMemory_0: { x: 220, y: 40 },
        conversationChain_0: { x: 720, y: 300 }
    })
    await putFlow(dev.base, cookie, flowId, flowData)

    flowData = withSystem(flowData, LIVE_SYSTEM)
    await putFlow(dev.base, cookie, flowId, flowData)

    const versions = await versionsOf(dev.base, cookie, flowId)
    console.log('versions', versions.map((item) => item.title).join(' | '))
    const systemVersion = byTitle(versions, 'System Message')
    const movedVersion = byTitle(versions, 'Moved nodes')
    const credentialVersion = byTitle(versions, 'credential')
    const createdVersion = versions[versions.length - 1]

    await canvasOf(page, dev.base, flowId)
    await see(page, 'Bakery helper')
    await shot(page, 'docs/images/versioning/canvas-last-edited.png')
    await page.getByTitle('Version history').click()
    await see(page, 'Created Bakery helper')
    await shot(page, 'docs/images/versioning/history-drawer.png')
    await page.getByLabel('Edited by').click()
    await page.getByRole('option', { name: 'Cuttlely (API key or system)' }).click()
    await page.waitForTimeout(300)
    await shot(page, 'docs/images/versioning/history-filter-by-person.png')
    await page.keyboard.press('Escape')

    await versionPage(page, dev.base, flowId, systemVersion.sha)
    await see(page, 'system message prompt')
    await shot(page, 'docs/images/versioning/version-changes.png')
    await versionPage(page, dev.base, flowId, credentialVersion.sha)
    await page.getByRole('button', { name: 'Compare with now' }).click()
    await see(page, 'In a different place now')
    await shot(page, 'docs/images/versioning/version-compare-with-now.png')

    await versionPage(page, dev.base, flowId, movedVersion.sha)
    await page.getByRole('button', { name: 'Open as draft' }).click()
    const draftDialog = page.getByRole('dialog')
    await ready(page, draftDialog.getByRole('heading', { name: 'Open this version as your draft?' }))
    await onScreen(page, draftDialog.getByText('This opens on the canvas as your draft.'))
    await shot(page, 'docs/images/versioning/open-as-draft-confirm.png')
    await draftDialog.getByRole('button', { name: 'Open as draft' }).click()
    await ready(page, page.getByTestId('draft-label'))
    await fitCanvas(page)
    await onScreen(page, page.getByText('Opened this version as your draft. Live is unchanged until you publish.'))
    await onScreen(page, page.getByRole('button', { name: 'Publish', exact: true }))
    await shot(page, 'docs/images/versioning/after-open-as-draft.png')
    json(await api(`${dev.base}/api/v1/flow-drafts/${flowId}`, { method: 'DELETE', cookie }), 'discard draft')

    await predict(dev.base, cookie, flowId, 'Why was the sourdough late?', 'chat-sourdough')
    await predict(dev.base, cookie, flowId, 'Can I pick up on Monday?', 'chat-monday')
    for (const question of QUESTIONS) {
        await predict(dev.base, cookie, flowId, question, `chat-${question.slice(0, 12).replace(/\s/g, '-')}`)
    }
    const messages = await messagesOf(dev.base, cookie, flowId)
    const answerFor = (question) => {
        const user = messages.find((item) => item.role === 'userMessage' && item.content === question)
        if (!user) throw new Error(`missing question ${question}`)
        const answer = messages.find((item) => item.role === 'apiMessage' && item.chatId === user.chatId)
        if (!answer) throw new Error(`missing answer for ${question}`)
        return answer
    }
    const ryeAnswer = answerFor('Do you have rye loaves today?')
    const lateAnswer = answerFor('Why was the sourdough late?')
    const mondayAnswer = answerFor('Can I pick up on Monday?')
    for (const answer of [lateAnswer, mondayAnswer]) {
        json(
            await api(`${dev.base}/api/v1/feedback/${flowId}`, {
                method: 'POST',
                cookie,
                body: {
                    chatflowid: flowId,
                    messageId: answer.id,
                    chatId: answer.chatId,
                    rating: 'THUMBS_DOWN',
                    content: answer === lateAnswer ? 'That does not say when it will be ready.' : 'Monday was not the question.'
                }
            }),
            'feedback'
        )
    }

    const draftData = withSystem(flowData, DRAFT_SATURDAY)
    await saveDraft(dev.base, cookie, flowId, draftData)
    await canvasOf(page, dev.base, flowId)
    await openPublish(page)
    await see(page, 'What time do you open on Saturday?')
    await see(page, 'Questions from')
    await shot(page, 'docs/images/versioning/publish-check-questions.png')
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await see(page, 'answered', 120000)
    const gluten = page.getByTestId('check-case').filter({ hasText: 'gluten-free' })
    await sitAbove(page, gluten, page.getByRole('button', { name: 'Discard Draft' }))
    await onScreen(page, gluten.getByText('No, we bake gluten-free bread only on Tuesdays.').nth(0))
    await onScreen(page, gluten.getByText('No, we bake gluten-free bread only on Tuesdays.').nth(1))
    await shot(page, 'docs/images/versioning/publish-check-results.png')
    await page.keyboard.press('Escape')

    const counter = json(
        await api(`${dev.base}/api/v1/datasets/set`, {
            method: 'POST',
            cookie,
            body: { name: 'Counter answers', description: 'Answers from the bakery counter.' }
        }),
        'counter dataset'
    )
    const saturday = json(
        await api(`${dev.base}/api/v1/datasets/set`, {
            method: 'POST',
            cookie,
            body: { name: 'Saturday hours', description: 'Questions the bakery counter should answer.' }
        }),
        'saturday dataset'
    )
    for (const [input, output] of [
        ['Do you have rye loaves today?', 'Yes, rye is baked every morning.'],
        ['What time do you open on Saturday?', 'We open at 8 AM on Saturdays.']
    ]) {
        json(
            await api(`${dev.base}/api/v1/datasets/rows`, {
                method: 'POST',
                cookie,
                body: { datasetId: saturday.id, input, output }
            }),
            'saturday row'
        )
    }
    const ryeEval = json(
        await api(`${dev.base}/api/v1/evaluators`, {
            method: 'POST',
            cookie,
            body: { name: 'Mentions rye', type: 'text', operator: 'ContainsAny', value: 'rye' }
        }),
        'rye evaluator'
    )
    const shortEval = json(
        await api(`${dev.base}/api/v1/evaluators`, {
            method: 'POST',
            cookie,
            body: { name: 'Short answer', type: 'numeric', operator: 'lessThan', value: '400', measure: 'responseLength' }
        }),
        'short evaluator'
    )
    json(
        await api(`${dev.base}/api/v1/evaluators`, {
            method: 'POST',
            cookie,
            body: { name: 'Order is JSON', type: 'json', operator: 'IsValidJSON' }
        }),
        'json evaluator'
    )
    json(
        await api(`${dev.base}/api/v1/evaluators`, {
            method: 'POST',
            cookie,
            body: {
                name: 'Matches the counter card',
                type: 'llm',
                prompt: 'Does the reply match the expected output? Set pass to true only when it does.',
                outputSchema: [
                    {
                        id: 1,
                        property: 'pass',
                        type: 'boolean',
                        description: 'Whether the reply matches the expected output',
                        required: true
                    }
                ]
            }
        }),
        'model evaluator'
    )

    await page.goto(`${dev.base}/canvas/${flowId}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByText('View Messages', { exact: true }).click()
    await see(page, 'Why was the sourdough late?')
    const feedbackBox = page.locator('b', { hasText: 'Feedback' }).locator('xpath=..')
    await feedbackBox.click()
    await page.getByRole('option', { name: 'Negative' }).click()
    await page.getByText('Total Sessions').click()
    await page.waitForFunction(() => {
        const chip = [...document.querySelectorAll('.MuiChip-label')].find((el) => (el.textContent || '').trim() === 'Negative')
        if (!chip) return false
        let box = chip.parentElement
        while (box && !(box.textContent || '').trim().startsWith('Feedback')) box = box.parentElement
        if (box && chip.scrollWidth > chip.clientWidth + 1) {
            box.style.flex = '0 0 auto'
            box.style.minWidth = '320px'
        }
        return chip.scrollWidth <= chip.clientWidth + 1
    })
    const sourdough = page.locator('.MuiListItemButton-root', { hasText: 'Why was the sourdough late?' })
    await sourdough.click()
    await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('.MuiListItemButton-root')].find((el) =>
            (el.textContent || '').includes('Why was the sourdough late?')
        )
        return Boolean(row && row.classList.contains('Mui-selected'))
    })
    await ready(page, page.getByText('That does not say when it will be ready.'))
    await ready(page, page.getByRole('button', { name: 'Add rated answers to test set' }))
    await shot(page, 'docs/images/evaluations/messages-negative.png')
    await page.getByRole('button', { name: 'Add rated answers to test set' }).click()
    await see(page, 'See how many')
    await page.getByRole('dialog').getByLabel('Dataset').selectOption({ label: 'Counter answers' })
    await page.getByRole('button', { name: 'See how many' }).click()
    const ratedDialog = page.getByRole('dialog')
    await ready(page, ratedDialog.getByRole('heading', { name: 'Add rated answers to test set' }))
    await onScreen(page, ratedDialog.getByText('2 rated answers will be added'))
    await shot(page, 'docs/images/evaluations/rated-preview.png')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')

    await page.goto(`${dev.base}/canvas/${flowId}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByText('View Messages', { exact: true }).click()
    await see(page, 'Do you have rye loaves today?')
    await page.getByText('Do you have rye loaves today?').first().click()
    await page.getByRole('button', { name: 'Add to test set' }).click()
    await see(page, 'Yes, rye is baked every morning.')
    await page.getByRole('dialog').getByLabel('Dataset').selectOption({ label: 'Counter answers' })
    await page.waitForTimeout(300)
    await shot(page, 'docs/images/evaluations/add-one-answer.png')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')

    json(
        await api(`${dev.base}/api/v1/datasets/rows/from-message`, {
            method: 'POST',
            cookie,
            body: { datasetId: counter.id, messageId: ryeAnswer.id, output: 'Yes, rye is baked every morning.' }
        }),
        'from message'
    )

    const ratingPreview = json(
        await api(`${dev.base}/api/v1/datasets/rows/from-ratings`, {
            method: 'POST',
            cookie,
            body: { datasetId: counter.id, flowId, rating: 'THUMBS_DOWN', days: 7, dryRun: true }
        }),
        'rating preview'
    )
    json(
        await api(`${dev.base}/api/v1/datasets/rows/from-ratings`, {
            method: 'POST',
            cookie,
            body: {
                datasetId: counter.id,
                flowId,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: false,
                feedbackIds: ratingPreview.feedbackIds
            }
        }),
        'from ratings'
    )

    await page.goto(`${dev.base}/dataset_rows/${counter.id}`, { waitUntil: 'domcontentloaded' })
    await see(page, 'From a chat answer')
    await see(page, 'needs expected answer')
    await shot(page, 'docs/images/evaluations/needs-expected.png')
    await page.getByText('Why was the sourdough late?').click()
    const expectedDialog = page.getByRole('dialog')
    await ready(page, expectedDialog.getByRole('heading', { name: /Edit Item/ }))
    await ready(page, expectedDialog.getByText('Rejected answer'))
    const output = expectedDialog.locator('textarea:visible').nth(1)
    await output.fill('The morning bake ran long. The loaf is ready after 9.')
    await onScreen(page, expectedDialog.getByRole('button', { name: 'Save' }))
    await shot(page, 'docs/images/evaluations/fill-expected.png')
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await page.waitForTimeout(500)

    await page.goto(`${dev.base}/datasets`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Add New' }).click()
    const addDataset = page.getByRole('dialog')
    await ready(page, addDataset.getByRole('heading', { name: 'Add Dataset' }))
    await addDataset.locator('input').first().fill('Saturday hours')
    const desc = addDataset.locator('textarea, input').nth(1)
    await desc.fill('Questions the bakery counter should answer.')
    await onScreen(page, addDataset.getByRole('button', { name: 'Add', exact: true }))
    await shot(page, 'docs/images/evaluations/dataset-add.png')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

    await page.goto(`${dev.base}/dataset_rows/${saturday.id}`, { waitUntil: 'domcontentloaded' })
    await see(page, 'Do you have rye loaves today?')
    await shot(page, 'docs/images/evaluations/dataset-rows.png')
    await page.getByRole('button', { name: 'Upload CSV' }).click()
    const upload = page.getByRole('dialog')
    await ready(page, upload.getByRole('heading', { name: /Upload Items/ }))
    const csv = path.join(os.tmpdir(), 'saturday-hours.csv')
    fs.writeFileSync(csv, 'Input,Output\nDo you have rye loaves today?,Yes, rye is baked every morning.\n')
    await upload.locator('input[type=file]').setInputFiles(csv)
    await ready(page, upload.getByText('saturday-hours.csv'))
    const headers = upload.locator('.MuiSwitch-root')
    await headers.click()
    await page.waitForFunction(() => {
        const box = document.querySelector('[role="dialog"] .MuiSwitch-input')
        return Boolean(box && box.checked)
    })
    await ready(page, upload.getByRole('heading', { name: /Upload Items/ }))
    await shot(page, 'docs/images/evaluations/dataset-csv.png')
    await page.keyboard.press('Escape')

    await page.goto(`${dev.base}/evaluators`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Mentions rye', { exact: true }).click()
    await see(page, 'Contains Any')
    await shot(page, 'docs/images/evaluations/evaluator-text.png', TALL)
    await page.keyboard.press('Escape')
    await page.getByText('Order is JSON', { exact: true }).click()
    const jsonDialog = page.getByRole('dialog')
    await ready(page, jsonDialog.getByRole('heading', { name: 'Edit Evaluator' }))
    await page.waitForFunction(() => {
        const type = document.querySelector('#evaluatorType')
        const avail = document.querySelector('#availableEvaluators')
        return type?.value === 'Evaluate Result (JSON)' && avail?.value === 'Is Valid JSON'
    })
    await ready(page, jsonDialog.getByRole('heading', { name: 'Edit Evaluator' }))
    await shot(page, 'docs/images/evaluations/evaluator-json.png', TALL)
    await page.keyboard.press('Escape')
    await page.getByText('Short answer', { exact: true }).click()
    const numericDialog = page.getByRole('dialog')
    await ready(page, numericDialog.getByRole('heading', { name: 'Edit Evaluator' }))
    await page.waitForFunction(() => {
        const type = document.querySelector('#evaluatorType')
        const avail = document.querySelector('#availableEvaluators')
        const metric = document.querySelector('#metric')
        const value = document.querySelector('[role="dialog"] input[type="number"]')
        return (
            type?.value === 'Evaluate Metrics (Numeric)' &&
            avail?.value === 'Output Chars Length' &&
            metric?.value === 'Less Than' &&
            value?.value === '400'
        )
    })
    await ready(page, numericDialog.getByRole('heading', { name: 'Edit Evaluator' }))
    await shot(page, 'docs/images/evaluations/evaluator-numeric.png', TALL)
    await page.keyboard.press('Escape')
    await page.getByText('Matches the counter card', { exact: true }).click()
    const modelDialog = page.getByRole('dialog')
    await ready(page, modelDialog.getByRole('heading', { name: 'Edit Evaluator' }))
    await ready(page, modelDialog.getByText('Does the reply match the expected output? Set pass to true only when it does.'))
    await shot(page, 'docs/images/evaluations/evaluator-model.png', TALL)
    await page.keyboard.press('Escape')

    const answersFlow = await createFlow(dev.base, cookie, {
        name: 'Bakery helper',
        type: 'CHATFLOW',
        deployed: false,
        flowData
    })
    await saveDraft(dev.base, cookie, answersFlow.id, withSystem(flowData, DRAFT_SATURDAY))
    await canvasOf(page, dev.base, answersFlow.id)
    await openPublish(page)
    const publishAnswers = page.getByRole('dialog')
    await publishAnswers.getByLabel('Questions from').selectOption('dataset')
    await publishAnswers.getByLabel('Dataset').selectOption({ label: 'Counter answers' })
    await publishAnswers.getByText('Mentions rye', { exact: true }).click()
    await publishAnswers.getByText('Short answer', { exact: true }).click()
    await ready(page, publishAnswers.getByRole('button', { name: 'Run check', exact: true }))
    await onScreen(page, publishAnswers.getByText('6 runs for 3 questions'))
    await shot(page, 'docs/images/evaluations/publish-from-answers.png')
    await page.keyboard.press('Escape')
    json(await api(`${dev.base}/api/v1/chatflows/${answersFlow.id}`, { method: 'DELETE', cookie }), 'delete answers flow')

    const gateBody = (datasetId) => ({
        publishGate: { enabled: true, datasetId, evaluatorIds: [ryeEval.id, shortEval.id], threshold: 100 }
    })
    json(
        await api(`${dev.base}/api/v1/flow-drafts/${flowId}/settings`, { method: 'PUT', cookie, body: gateBody(counter.id) }),
        'counter gate'
    )
    await canvasOf(page, dev.base, flowId)
    await openGate(page, 'Counter answers')
    await shot(page, 'docs/images/evaluations/gate-from-answers.png')
    await page.keyboard.press('Escape')
    json(
        await api(`${dev.base}/api/v1/flow-drafts/${flowId}/settings`, { method: 'PUT', cookie, body: gateBody(saturday.id) }),
        'saturday gate'
    )
    await canvasOf(page, dev.base, flowId)
    await openGate(page, 'Saturday hours')
    await shot(page, 'docs/images/evaluations/publish-gate-settings.png')
    await page.keyboard.press('Escape')

    json(
        await api(`${dev.base}/api/v1/flow-drafts/${flowId}/settings`, {
            method: 'PUT',
            cookie,
            body: {
                publishGate: {
                    enabled: true,
                    datasetId: saturday.id,
                    evaluatorIds: [ryeEval.id, shortEval.id],
                    threshold: 100
                }
            }
        }),
        'gate'
    )
    const started = json(
        await api(`${dev.base}/api/v1/flow-drafts/${flowId}/check`, {
            method: 'POST',
            cookie,
            timeoutMs: 120000,
            body: { datasetId: saturday.id, evaluatorIds: [ryeEval.id, shortEval.id] }
        }),
        'start dataset check'
    )
    const checkId = started.id || started.check?.id
    const deadline = Date.now() + 120000
    let done = started
    while (Date.now() < deadline && done.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 500))
        done = json(await api(`${dev.base}/api/v1/flow-drafts/${flowId}/check/${checkId}`, { cookie }), 'poll check')
    }
    if (done.status === 'running') throw new Error('dataset check still running')
    await canvasOf(page, dev.base, flowId)
    await openPublish(page)
    await see(page, 'Run the test set')
    await shot(page, 'docs/images/evaluations/publish-dataset.png', TALL)

    const listed = json(
        await api(`${dev.base}/api/v1/evaluations`, {
            method: 'POST',
            cookie,
            timeoutMs: 120000,
            body: {
                name: 'Saturday hours check',
                evaluationType: 'benchmarking',
                datasetId: saturday.id,
                datasetName: 'Saturday hours',
                chatflowId: JSON.stringify([flowId]),
                chatflowName: JSON.stringify(['Bakery helper']),
                chatflowType: JSON.stringify(['CHATFLOW']),
                selectedSimpleEvaluators: JSON.stringify([ryeEval.id, shortEval.id]),
                selectedLLMEvaluators: '[]'
            }
        }),
        'evaluation'
    )
    const rows = Array.isArray(listed) ? listed : listed.data || []
    const evaluation = rows.find((item) => item.name === 'Saturday hours check')
    if (!evaluation?.id) throw new Error('evaluation was not created')
    const evaluationId = evaluation.id
    let evalRow = evaluation
    const evalDeadline = Date.now() + 120000
    while (Date.now() < evalDeadline && evalRow.status !== 'completed' && evalRow.status !== 'error') {
        await new Promise((resolve) => setTimeout(resolve, 800))
        evalRow = json(await api(`${dev.base}/api/v1/evaluations/${evaluationId}`, { cookie }), 'evaluation status')
    }
    console.log('evaluation', evalRow.status)
    await page.goto(`${dev.base}/evaluations`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New Evaluation' }).click()
    const wizard = page.getByRole('dialog')
    await ready(page, wizard.getByRole('heading', { name: 'Start New Evaluation' }))
    await wizard.locator('#evaluationName').fill('Saturday hours check')
    await wizard.locator('#dataset').click()
    const saturdayOption = page.getByRole('option', { name: 'Saturday hours', exact: true })
    await ready(page, saturdayOption)
    await saturdayOption.click()
    await page.waitForFunction(() => document.querySelector('#dataset')?.value === 'Saturday hours')
    await wizard.locator('#chatflow1').click()
    const bakeryOption = page.getByRole('option', { name: /^Bakery helper/ })
    await ready(page, bakeryOption.first())
    await bakeryOption.first().click()
    await ready(page, wizard.locator('.MuiChip-label', { hasText: 'Bakery helper' }))
    await animationsDone(page)
    await shot(page, 'docs/images/evaluations/evaluation-new.png', TALL)
    await page.keyboard.press('Escape')
    await page.goto(`${dev.base}/evaluation_results/${evaluationId}`, { waitUntil: 'domcontentloaded' })
    await see(page, 'Saturday hours check')
    await shot(page, 'docs/images/evaluations/evaluation-results.png', TALL)

    const risky = await createFlow(dev.base, cookie, {
        name: 'Bakery helper',
        type: 'CHATFLOW',
        deployed: false,
        chatbotConfig: JSON.stringify({ postProcessing: { enabled: true } }),
        flowData
    })
    await saveDraft(dev.base, cookie, risky.id, withSystem(flowData, DRAFT_SATURDAY))
    await canvasOf(page, dev.base, risky.id)
    await openPublish(page)
    await see(page, 'Post-processing code')
    await shot(page, 'docs/images/versioning/publish-check-risky-steps.png')
    await page.keyboard.press('Escape')
    json(await api(`${dev.base}/api/v1/chatflows/${risky.id}`, { method: 'DELETE', cookie }), 'delete risky')

    const start = await buildNode(dev.base, cookie, 'startAgentflow', 'startAgentflow_0', {
        label: 'Start',
        position: { x: 80, y: 180 }
    })
    start.type = 'agentFlow'
    start.data.inputs.startInputType = 'webhookTrigger'
    const reply = await buildNode(dev.base, cookie, 'directReplyAgentflow', 'directReplyAgentflow_0', {
        label: 'Reply',
        position: { x: 420, y: 180 }
    })
    reply.type = 'agentFlow'
    reply.data.inputs.directReplyMessage = 'The oven has the order.'
    const webhook = await createFlow(dev.base, cookie, {
        name: 'Order webhook',
        type: 'AGENTFLOW',
        deployed: false,
        flowData: canvas([start, reply], [agentEdge(start, reply)])
    })
    const webhookDraft = JSON.parse(webhook.flowData)
    webhookDraft.nodes.find((node) => node.id === 'directReplyAgentflow_0').data.inputs.directReplyMessage = 'The oven has the rye order.'
    await saveDraft(dev.base, cookie, webhook.id, JSON.stringify(webhookDraft))
    insertExecutions(dev.dataDir, webhook.id, webhook.workspaceId)
    await page.setViewportSize(WEBHOOK_VIEW)
    await canvasOf(page, dev.base, webhook.id, true)
    await openPublish(page)
    await see(page, 'x-bakery')
    await shot(page, 'docs/images/versioning/publish-check-webhook.png', WEBHOOK_VIEW)
    await page.keyboard.press('Escape')
    json(await api(`${dev.base}/api/v1/chatflows/${webhook.id}`, { method: 'DELETE', cookie }), 'delete webhook')
    await page.setViewportSize(VIEW)

    const agentStart = await buildNode(dev.base, cookie, 'startAgentflow', 'startAgentflow_0', {
        label: 'Start',
        position: { x: 80, y: 160 }
    })
    agentStart.type = 'agentFlow'
    agentStart.data.inputs.startInputType = 'chatInput'
    const llm = await buildNode(dev.base, cookie, 'llmAgentflow', 'llmAgentflow_0', {
        label: 'LLM',
        position: { x: 420, y: 160 }
    })
    llm.type = 'agentFlow'
    llm.data.inputs.llmModel = 'chatOpenAI'
    llm.data.inputs.llmModelConfig = { modelName: MODEL, temperature: 0, FLOWISE_CREDENTIAL_ID: mainCred }
    llm.data.inputs.llmMessages = [{ role: 'system', content: LIVE_SYSTEM }]
    llm.data.inputs.llmUserMessage = ''
    const agent = await createFlow(dev.base, cookie, {
        name: 'Bakery helper',
        type: 'AGENTFLOW',
        deployed: false,
        flowData: canvas([agentStart, llm], [agentEdge(agentStart, llm)])
    })
    for (const question of [
        'Do you have gluten-free bread today?',
        'What time do you open on Saturday?',
        'Can I order a birthday cake for Friday?'
    ]) {
        await predict(dev.base, cookie, agent.id, question, `agent-${question.slice(0, 8).replace(/\s/g, '-')}`)
    }
    const agentDraft = JSON.parse(agent.flowData)
    agentDraft.nodes.find((node) => node.id === 'llmAgentflow_0').data.inputs.llmMessages = [{ role: 'system', content: AGENT_DRAFT }]
    await saveDraft(dev.base, cookie, agent.id, JSON.stringify(agentDraft))
    await canvasOf(page, dev.base, agent.id, true)
    await openPublish(page)
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await see(page, 'answered differently', 180000)
    const birthday = page.getByTestId('check-case').filter({ hasText: 'birthday cake' })
    await showFully(page, birthday)
    await onScreen(page, birthday.getByText('Yes, you need to place your birthday cake order by Wednesday'))
    await onScreen(page, birthday.getByText('Yes, please place your order by Wednesday for a Friday birthday cake'))
    await shot(page, 'docs/images/versioning/publish-check-agentflow-results.png')
    await page.keyboard.press('Escape')
    json(await api(`${dev.base}/api/v1/chatflows/${agent.id}`, { method: 'DELETE', cookie }), 'delete agent')

    await page.setViewportSize(VIEW)
    await page.goto(`${dev.base}/version-history`, { waitUntil: 'domcontentloaded' })
    await see(page, 'Connect GitHub')
    await shot(page, 'docs/images/versioning/github-not-connected.png')
    await page.setViewportSize(COMPACT)
    await page.getByRole('button', { name: 'Connect GitHub' }).click()
    await see(page, 'Sign in to GitHub')
    await page.getByLabel('GitHub token').fill('docs-shot-token')
    await shot(page, 'docs/images/versioning/github-sign-in.png', COMPACT)
    await page.getByTestId('github-token-help-button').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await animationsDone(page)
    await page.getByTestId('github-token-help-button').click()
    const help = page.getByTestId('github-token-help')
    await ready(page, help)
    const helpBox = await help.boundingBox()
    const helpView = page.viewportSize()
    if (helpBox && helpBox.y + helpBox.height > helpView.height - 8) {
        await page.setViewportSize({ width: helpView.width, height: Math.ceil(helpBox.y + helpBox.height + 48) })
        await animationsDone(page)
    }
    await onScreen(page, help)
    await onScreen(page, help.getByText('Create a token on GitHub'))
    await onScreen(page, help.getByText('Read the guide'))
    await shot(page, 'docs/images/versioning/github-token-help.png', page.viewportSize())
    await page.keyboard.press('Escape')
    await page.setViewportSize(VIEW)
    await page.getByRole('button', { name: 'Continue' }).click()
    await see(page, 'rosas-bakery/cuttlely-flows')
    await page.getByText('rosas-bakery/cuttlely-flows').click()
    await shot(page, 'docs/images/versioning/github-pick-repo.png')
    await page.getByText('Make a new private repository').click()
    const repoName = page.getByRole('textbox', { name: 'New repository name' })
    await ready(page, repoName)
    const repoHandle = await repoName.elementHandle()
    await page.waitForFunction((el) => {
        const root = el.closest('.MuiFormControl-root')
        return el.value === 'cuttlely-flows' && Boolean(root && root.innerText.includes('rosas-bakery/'))
    }, repoHandle)
    await onScreen(page, repoName)
    await shot(page, 'docs/images/versioning/github-new-repo.png')
    await page.getByText('rosas-bakery/cuttlely-flows').click()
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await see(page, 'Up to date', 60000)
    await shot(page, 'docs/images/versioning/github-connected.png')
    json(
        await api(`${dev.base}/api/v1/flow-versions/environment`, { method: 'PUT', cookie, body: { environment: 'dev' } }),
        'dev environment'
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await see(page, 'Up to date')
    await shot(page, 'docs/images/versioning/github-dev.png')

    console.log('boot prod')
    const prod = await boot(githubEnv)
    const prodCookie = await signUp(prod.base)
    await credential(prod.base, prodCookie, 'OpenAI main')
    json(
        await api(`${prod.base}/api/v1/flow-versions/environment`, {
            method: 'PUT',
            cookie: prodCookie,
            body: { environment: 'prod' }
        }),
        'prod environment'
    )
    const prodKey = await mintKey(prod.base, prodCookie)
    json(
        await api(`${prod.base}/api/v1/flow-versions/github`, {
            method: 'PUT',
            cookie: prodCookie,
            body: { repo: 'rosas-bakery/cuttlely-flows', token: 'docs-shot-token', credentialName: 'GitHub: rosas-bakery/cuttlely-flows' }
        }),
        'prod connect'
    )
    json(await api(`${prod.base}/api/v1/flow-versions/github/push`, { method: 'POST', cookie: prodCookie }), 'prod look')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const prodPage = await openPage(browser, prod.base)
    const incoming = json(await api(`${prod.base}/api/v1/flow-versions/incoming`, { cookie: prodCookie }), 'incoming')
    console.log('incoming', JSON.stringify(incoming).slice(0, 500))
    const firstFlows = incoming.flows || []
    const bakeryIncoming = firstFlows.find((item) => item.flowId === flowId)
    if (!bakeryIncoming) throw new Error(`no chatflow to promote: ${firstFlows.map((item) => `${item.type}:${item.name}`).join(', ')}`)
    const promoted = json(
        await api(`${prod.base}/api/v1/flow-versions/incoming/${bakeryIncoming.flowId}/promote`, {
            method: 'POST',
            cookie: prodCookie,
            body: { sha: bakeryIncoming.version.sha }
        }),
        'first promote'
    )
    console.log('promoted', promoted?.chatflow?.id, promoted?.created, bakeryIncoming.flowId)
    const orderFlow = await simpleChat(dev.base, cookie, 'Order status', orders)
    const catering = await simpleChat(dev.base, cookie, 'Catering quotes', mainCred)
    await putFlow(dev.base, cookie, flowId, withModel(flowData, { credentialId: mainCred, temperature: '0.3', modelName: MODEL }))
    flowData = withModel(flowData, { credentialId: mainCred, temperature: '0.3', modelName: MODEL })
    flowData = withSystem(flowData, PROMOTE_SYSTEM)
    await putFlow(dev.base, cookie, flowId, flowData)
    json(await api(`${dev.base}/api/v1/flow-versions/github/push`, { method: 'POST', cookie }), 'dev sync')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    json(await api(`${prod.base}/api/v1/flow-versions/github/push`, { method: 'POST', cookie: prodCookie }), 'prod look again')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const prodFlows = json(await api(`${prod.base}/api/v1/chatflows`, { cookie: prodCookie }), 'prod flows')
    const prodList = Array.isArray(prodFlows) ? prodFlows : prodFlows.data || []
    const prodBakery = prodList.find((item) => item.name === 'Bakery helper')
    if (prodBakery) {
        await predict(prod.base, prodCookie, prodBakery.id, 'What time do you open on Saturday?', 'prod-saturday')
        await predict(prod.base, prodCookie, prodBakery.id, 'Do you have gluten-free bread today?', 'prod-gluten')
    }

    await prodPage.goto(`${prod.base}/chatflows`, { waitUntil: 'domcontentloaded' })
    await see(prodPage, 'New version')
    await shot(prodPage, 'docs/images/versioning/promote-banner.png')
    await prodPage.goto(`${prod.base}/promote`, { waitUntil: 'domcontentloaded' })
    await see(prodPage, 'Bakery helper')
    await shot(prodPage, 'docs/images/versioning/promote-list.png')
    await prodPage.goto(`${prod.base}/version-history`, { waitUntil: 'domcontentloaded' })
    await see(prodPage, 'Review')
    await shot(prodPage, 'docs/images/versioning/promote-card.png')

    const incomingAgain = json(await api(`${prod.base}/api/v1/flow-versions/incoming`, { cookie: prodCookie }), 'incoming again')
    const flows = incomingAgain.flows || incomingAgain
    const orderItem = flows.find((item) => item.name === 'Order status' && item.type === 'CHATFLOW')
    const bakeryItem = flows.find((item) => item.flowId === flowId)
    if (orderItem) {
        await prodPage.goto(`${prod.base}/promote/${orderItem.flowId}`, { waitUntil: 'domcontentloaded' })
        await see(prodPage, 'OpenAI orders')
        await shot(prodPage, 'docs/images/versioning/promote-missing.png')
    }
    if (bakeryItem) {
        await prodPage.goto(`${prod.base}/promote/${bakeryItem.flowId}`, { waitUntil: 'domcontentloaded' })
        try {
            await see(prodPage, 'What changed on Dev', 40000)
        } catch (error) {
            const text = await prodPage.locator('body').innerText()
            throw new Error(`promote review for ${bakeryItem.flowId} ${bakeryItem.status}: ${text.slice(0, 900)}`)
        }
        await shot(prodPage, 'docs/images/versioning/promote-review.png')
        const run = prodPage.getByRole('button', { name: 'Run check' })
        if (await run.count()) {
            await run.click()
            await see(prodPage, 'answered', 180000)
            const glutenRow = prodPage.getByTestId('check-case').filter({ hasText: 'gluten-free' })
            await sitAbove(prodPage, glutenRow, prodPage.getByRole('button', { name: 'Promote to Live' }))
            await onScreen(prodPage, glutenRow.getByText('No, we bake gluten-free bread only on Tuesdays.'))
            await onScreen(prodPage, glutenRow.getByText('Yes, we bake gluten-free bread every day.'))
            await shot(prodPage, 'docs/images/versioning/promote-check.png')
        }
        await prodPage.getByRole('button', { name: 'Promote to Live' }).click()
        await ready(prodPage, prodPage.getByRole('button', { name: 'Roll back' }), 30000)
        await ready(prodPage, prodPage.getByRole('link', { name: 'Open the flow' }))
        await ready(prodPage, prodPage.getByRole('link', { name: 'All new versions from Dev' }))
        await shot(prodPage, 'docs/images/versioning/promote-done.png')
        await prodPage
            .getByTitle('Version history')
            .click()
            .catch(async () => {
                await prodPage.goto(`${prod.base}/canvas/${bakeryItem.flowId}`, { waitUntil: 'domcontentloaded' })
                await prodPage.getByTitle('Version history').click()
            })
        await see(prodPage, 'Promoted from Dev')
        await shot(prodPage, 'docs/images/versioning/promote-history.png')
    }

    const discarded = await api(`${dev.base}/api/v1/flow-drafts/${flowId}`, { method: 'DELETE', cookie })
    if (discarded.status !== 200 && discarded.status !== 404)
        throw new Error(`discard before restore ${discarded.status}: ${brief(discarded.text)}`)
    json(
        await api(`${dev.base}/api/v1/flow-drafts/${flowId}/settings`, {
            method: 'PUT',
            cookie,
            body: { publishInstantly: true, publishGate: { enabled: false } }
        }),
        'publish instantly'
    )
    await versionPage(page, dev.base, flowId, credentialVersion.sha)
    await page.getByRole('button', { name: 'Compare with now' }).click()
    await page.getByRole('button', { name: 'Restore this version' }).click()
    const restoreDialog = page.getByRole('dialog')
    await ready(page, restoreDialog.getByRole('heading', { name: 'Restore this version?' }))
    await onScreen(page, restoreDialog.getByText('The flow goes back to this version and is live right away.'))
    await shot(page, 'docs/images/versioning/restore-confirm.png')
    await restoreDialog.getByRole('button', { name: 'Restore', exact: true }).click()
    await ready(page, page.locator('.react-flow__node').first())
    await fitCanvas(page)
    await onScreen(page, page.getByText('Restored. History has a new version, so you can undo this the same way.'))
    await shot(page, 'docs/images/versioning/after-restore.png')
    await page.getByTitle('Version history').click()
    await see(page, 'Restored:')
    await shot(page, 'docs/images/versioning/history-after-restore.png')

    await credential(dev.base, cookie, 'OpenAI main')
    await versionPage(page, dev.base, flowId, credentialVersion.sha)
    await see(page, 'OpenAI main')
    await shot(page, 'docs/images/versioning/version-duplicate-credential-name.png')
    const creds = json(await api(`${dev.base}/api/v1/credentials`, { cookie }), 'credentials')
    const credList = Array.isArray(creds) ? creds : creds.data || []
    const trialRow = credList.find((item) => item.name === 'OpenAI trial')
    if (trialRow) {
        json(await api(`${dev.base}/api/v1/credentials/${trialRow.id}`, { method: 'DELETE', cookie }), 'delete trial')
    }
    await versionPage(page, dev.base, flowId, createdVersion.sha)
    await see(page, 'OpenAI trial')
    await shot(page, 'docs/images/versioning/version-missing-credential.png')

    fs.renameSync(github.bare, `${github.bare}.aside`)
    fs.writeFileSync(github.bare, 'not a repository')
    json(await api(`${dev.base}/api/v1/flow-versions/github/push`, { method: 'POST', cookie }), 'retry push')
    await page.goto(`${dev.base}/version-history`, { waitUntil: 'domcontentloaded' })
    await see(page, 'Retrying', 30000)
    await shot(page, 'docs/images/versioning/github-retrying.png')

    console.log('extra flows', orderFlow.name, catering.name, 'prod key ready', Boolean(prodKey))
    console.log('done')
    process.exit(0)
}

async function simpleChat(base, cookie, name, credentialId) {
    const model = await buildNode(base, cookie, 'chatOpenAI', 'chatOpenAI_0', {
        label: 'ChatOpenAI',
        position: { x: 80, y: 80 }
    })
    model.data.credential = credentialId
    model.data.inputs.modelName = MODEL
    model.data.inputs.temperature = '0'
    const chain = await buildNode(base, cookie, 'conversationChain', 'conversationChain_0', {
        label: 'Conversation Chain',
        position: { x: 420, y: 80 }
    })
    chain.data.inputs.systemMessagePrompt = `${name} for Rosa's Bakery.`
    chain.data.inputs.model = '{{chatOpenAI_0.data.instance}}'
    chain.data.inputs.memory = '{{bufferMemory_0.data.instance}}'
    const memory = await buildNode(base, cookie, 'bufferMemory', 'bufferMemory_0', {
        label: 'Buffer Memory',
        position: { x: 80, y: 280 }
    })
    return createFlow(base, cookie, {
        name,
        type: 'CHATFLOW',
        deployed: false,
        flowData: canvas([memory, model, chain], [connectNodes(model, chain, 'model'), connectNodes(memory, chain, 'memory')])
    })
}

process.on('exit', () => {
    for (const stop of stops) {
        try {
            stop()
        } catch {
            /* already stopped */
        }
    }
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error))
        process.exit(1)
    })
}
