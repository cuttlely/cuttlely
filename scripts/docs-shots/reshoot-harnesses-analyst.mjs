// Reshoot the harness and Analyst guide pictures from a local server.
// One command from the repo root. No outside account. Keys are read from the environment only.
//
//   node scripts/docs-shots/reshoot-harnesses-analyst.mjs
//
// When OPENAI_API_KEY is unset, a local stand-in answers on 127.0.0.1 and the server is pointed at it
// with OPENAI_BASE_URL. Nothing in that mode calls a model provider.
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_H = path.join(ROOT, 'docs/images/harnesses')
const OUT_A = path.join(ROOT, 'docs/images/analyst')
const TMP = '/tmp/docs-shots'
const DATA = path.join(TMP, 'data')
const NOTES = path.join(TMP, 'notes')
const BASE = process.env.DOCS_SHOTS_BASE || 'http://127.0.0.1:43117'
const MODEL_PORT = process.env.DOCS_SHOTS_MODEL_PORT || '8791'
const HOLD = path.join(TMP, 'hold')
const FROM = process.env.DOCS_SHOTS_FROM || ''

fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(NOTES, { recursive: true })

const children = []
const log = (line) => console.log(`[docs-shots] ${line}`)

function track(child) {
    children.push(child)
    return child
}

function stopChildren() {
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

process.on('exit', stopChildren)
process.on('SIGINT', () => {
    stopChildren()
    process.exit(130)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(url, attempts = 90) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            const res = await fetch(url)
            if (res.ok || res.status === 401 || res.status === 404) return
        } catch {
            // not up yet
        }
        await sleep(1000)
    }
    throw new Error(`timed out waiting for ${url}`)
}

function standInKey() {
    if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, local: false }
    const key = `sk-local-${crypto.randomBytes(24).toString('hex')}`
    return { key, local: true }
}

function startStandIn() {
    const child = track(
        spawn(process.execPath, [path.join(ROOT, 'scripts/docs-shots/model-stand-in.mjs')], {
            cwd: ROOT,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, DOCS_SHOTS_MODEL_PORT: MODEL_PORT, DOCS_SHOTS_HOLD_FILE: HOLD }
        })
    )
    child.unref()
}

function startServer(extra = {}) {
    const { key, local } = standInKey()
    const env = {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.nvm/versions/node/v24.21.0/bin:${process.env.PATH}`,
        PORT: '43117',
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_ANALYST: 'auto',
        CUTTLELY_DATA_DIR: DATA,
        DATABASE_PATH: DATA,
        SECRETKEY_PATH: DATA,
        BLOB_STORAGE_PATH: path.join(DATA, 'blobs'),
        CUTTLELY_HERMES_HOME: path.join(DATA, 'hermes'),
        CUSTOM_MCP_PROTOCOL: 'stdio',
        OPENAI_API_KEY: key,
        ...(local ? { OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1` } : {})
    }
    for (const name of Object.keys(extra)) env[name] = extra[name]
    const child = track(
        spawn('bash', [path.join(ROOT, 'scripts/start-cuttlely.sh')], {
            cwd: ROOT,
            detached: true,
            env,
            stdio: ['ignore', fs.openSync(path.join(TMP, 'server.log'), 'a'), fs.openSync(path.join(TMP, 'server.log'), 'a')]
        })
    )
    child.unref()
    return key
}

const adminPath = path.join(TMP, 'admin.json')

function ensureAdmin() {
    if (fs.existsSync(adminPath)) return JSON.parse(fs.readFileSync(adminPath, 'utf8'))
    const password = `Aa1!${crypto.randomBytes(12).toString('hex')}`
    const admin = { email: 'rosa.diaz@example.com', password }
    fs.writeFileSync(adminPath, JSON.stringify(admin), { mode: 0o600 })
    return admin
}

async function createUser(admin) {
    const child = spawn('pnpm', ['user', '--email', admin.email], {
        cwd: ROOT,
        env: {
            ...process.env,
            PATH: `${process.env.HOME}/.nvm/versions/node/v24.21.0/bin:${process.env.PATH}`,
            CUTTLELY_LOCAL_ADMIN: 'true',
            CUTTLELY_DATA_DIR: DATA,
            DATABASE_PATH: DATA,
            SECRETKEY_PATH: DATA,
            BLOB_STORAGE_PATH: path.join(DATA, 'blobs')
        },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.end(`${admin.password}\n`)
    const out = await new Promise((resolve) => {
        let text = ''
        child.stdout.on('data', (chunk) => {
            text += chunk
        })
        child.stderr.on('data', (chunk) => {
            text += chunk
        })
        child.on('close', () => resolve(text))
    })
    if (!/created|already|Email count|Super User/i.test(out) && /error|refusing/i.test(out)) {
        throw new Error(`user command failed: ${out.slice(0, 400)}`)
    }
    log('local owner account ready')
}

function nameRosa() {
    const db = path.join(DATA, 'database.sqlite')
    const child = spawn('sqlite3', [db, `UPDATE user SET name = 'Rosa Diaz' WHERE email = 'rosa.diaz@example.com';`], { stdio: 'ignore' })
    return new Promise((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('could not set the display name'))))
    })
}

let cookie = ''

async function login(admin) {
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal' },
        body: JSON.stringify(admin)
    })
    if (!res.ok) throw new Error(`login failed: ${res.status}`)
    cookie = res.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; ')
}

async function api(method, apiPath, body) {
    const res = await fetch(`${BASE}/api/v1${apiPath}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal', cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let data
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status}: ${String(text).slice(0, 500)}`)
    return data
}

const MONEY = /\$\s?\d|\b\d+\.\d{2}\b|\b(dollars?|usd|eur)\b/i

function assertNoMoney(text, file) {
    const hit = String(text || '').match(MONEY)
    if (hit) throw new Error(`${file} contains a money figure (${hit[0]})`)
}

async function note(page, file) {
    const text = await page.locator('body').innerText()
    fs.writeFileSync(path.join(NOTES, `${path.basename(file)}.txt`), text)
    assertNoMoney(text, file)
}

async function shot(page, file, width, height) {
    await page.setViewportSize({ width, height })
    await sleep(300)
    await page.screenshot({ path: file })
    await note(page, file)
    log(path.basename(file))
}

async function shotClip(page, file, box) {
    await page.screenshot({ path: file, clip: box })
    log(path.basename(file))
}

async function openApp(page, url, look = 'classic') {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate((value) => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', value)
    }, look)
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.evaluate((value) => localStorage.setItem('cuttlely.canvasLook', value), look)
}

const state = {}

async function stepEmpty(page) {
    await openApp(page, `${BASE}/harnesses`, 'classic')
    await page.getByText('No agent teams yet').waitFor()
    await shot(page, path.join(OUT_H, 'agent-team-empty.png'), 1440, 1240)
}

async function stepTemplates(page) {
    await openApp(page, `${BASE}/marketplaces`, 'classic')
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await page.getByText('Chief of Staff Harness').waitFor()
    await shot(page, path.join(OUT_H, 'templates-harness-filter.png'), 1440, 960)
    await page.getByText('Chief of Staff Harness').click()
    await page.getByRole('button', { name: 'Use Template' }).waitFor()
    await shot(page, path.join(OUT_H, 'template-chief-of-staff.png'), 1440, 960)
    await page.getByRole('button', { name: 'Use Template' }).click()
    await page.waitForURL(/harnesscanvas/)
    await page.locator('.react-flow__node').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(500)
    await shot(page, path.join(OUT_H, 'canvas-from-template.png'), 1440, 960)
    state.unsaved = page.url()
}

async function stepSaveRejected(page) {
    await page.locator('.react-flow__node').first().waitFor()
    await page.getByTitle('Save Harness').click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('textbox').fill('chief-of-staff')
    await shot(page, path.join(OUT_H, 'save-dialog-name.png'), 1440, 960)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText(/needs a credential/i).waitFor()
    await shot(page, path.join(OUT_H, 'save-rejected-grok-credential.png'), 1440, 960)
}

async function stepCredential(page) {
    const credPage = await page.context().newPage()
    await credPage.goto(`${BASE}/credentials`, { waitUntil: 'networkidle' })
    page = credPage
    await page.getByRole('button', { name: 'Add Credential' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').first().fill('OpenAI')
    await dialog.getByText('OpenAI API', { exact: true }).click()
    const name = dialog.getByLabel(/credential name/i)
    if (await name.count()) await name.fill('OpenAI main')
    else await dialog.getByRole('textbox').first().fill('OpenAI main')
    await shot(page, path.join(OUT_H, 'credential-openai-form.png'), 1440, 960)
    const key = process.env.OPENAI_API_KEY
    await dialog.locator('input[type="password"]').fill(key)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByText(/New Credential added/i).waitFor({ timeout: 15000 })
    await shot(page, path.join(OUT_H, 'credentials-list.png'), 1440, 960)
    await credPage.close()
}

async function closeSnackbar(page) {
    const close = page.locator('#notistack-snackbar').locator('xpath=..').getByRole('button').last()
    if (await close.count()) await close.click().catch(() => {})
    await page.keyboard.press('Escape')
}

async function deleteGrok(page) {
    await closeSnackbar(page)
    const node = page.locator('.react-flow__node').filter({ hasText: 'xAI Grok' }).first()
    await node.click({ position: { x: 30, y: 24 } })
    await node.getByTestId('card-delete').click()
    await node.waitFor({ state: 'detached' })
}

async function stepOpenAI(page) {
    await page.locator('.react-flow__node').first().waitFor()
    await page.keyboard.press('Escape')
    await deleteGrok(page)
    await page.getByRole('button', { name: 'add', exact: true }).click()
    await page.getByPlaceholder('Search nodes').fill('ChatOpenAI')
    await page.getByRole('button', { name: /OpenAI Custom Model/ }).waitFor()
    await page.getByRole('button', { name: /Azure OpenAI/ }).waitFor()
    await shot(page, path.join(OUT_H, 'add-node-openai.png'), 1440, 960)
    await page
        .locator('.MuiListItemButton-root')
        .filter({ has: page.getByText('OpenAI', { exact: true }) })
        .first()
        .click()
    const openAI = page.locator('.react-flow__node').filter({ hasText: 'OpenAI' }).first()
    await openAI.waitFor()
    if (await page.getByText('Add Nodes', { exact: true }).count()) {
        await page.getByRole('button', { name: 'add', exact: true }).click()
    }
    await sleep(400)
    const prime = page.locator('.react-flow__node').filter({ hasText: 'Harness Prime' }).first()
    const source = openAI.locator('.react-flow__handle-right').first()
    const target = prime.locator('.react-flow__handle-left').first()
    const from = await source.boundingBox()
    const to = await target.boundingBox()
    if (!from || !to) throw new Error('could not find the chat model handles')
    const edges = await page.locator('.react-flow__edge').count()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 30 })
    await page.mouse.up()
    await sleep(300)
    if ((await page.locator('.react-flow__edge').count()) <= edges) throw new Error('the OpenAI node did not connect to Harness Prime')
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(400)
    await shot(page, path.join(OUT_H, 'openai-connected.png'), 1440, 960)
    await openAI.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'OpenAI main' }).waitFor()
    await shot(page, path.join(OUT_H, 'openai-credential-pick.png'), 1440, 960)
    await page.getByRole('option', { name: 'OpenAI main' }).click()
}

async function framePostgresCard(page, node, file) {
    const tail = node.getByText(/Pass the statement as sql/i)
    await tail.waitFor({ timeout: 30000 })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(700)
    const pan = async (dx, dy) => {
        await page.mouse.move(720, 420)
        await page.mouse.down()
        await page.mouse.move(720 + dx, 420 + dy, { steps: 16 })
        await page.mouse.up()
        await sleep(300)
    }
    for (let i = 0; i < 8; i += 1) {
        const box = await node.boundingBox()
        const view = page.viewportSize()
        if (!box || !view) throw new Error('PostgreSQL MCP is not on screen')
        const dx = view.width / 2 - (box.x + box.width / 2)
        const dy = view.height / 2 - (box.y + box.height / 2)
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) break
        await pan(Math.max(-420, Math.min(420, dx)), Math.max(-360, Math.min(360, dy)))
    }
    for (let i = 0; i < 3; i += 1) {
        const box = await node.boundingBox()
        const view = page.viewportSize()
        if (!box || !view || box.height > view.height * 0.55) break
        await page.locator('.react-flow__controls-zoomin').click()
        await sleep(250)
    }
    for (let i = 0; i < 8; i += 1) {
        const box = await node.boundingBox()
        const end = await tail.boundingBox()
        const view = page.viewportSize()
        if (!box || !end || !view) throw new Error('PostgreSQL MCP card is not measurable')
        const fits =
            box.x >= 8 &&
            box.y >= 48 &&
            box.x + box.width <= view.width - 8 &&
            box.y + box.height <= view.height - 8 &&
            end.y >= 48 &&
            end.y + end.height <= view.height - 12 &&
            end.x >= box.x &&
            end.x + end.width <= box.x + box.width + 4
        if (fits) {
            await sleep(500)
            await page.screenshot({ path: file })
            await note(page, file)
            log(path.basename(file))
            return
        }
        if (box.height > view.height - 64 || end.y + end.height > view.height - 8) {
            await page.locator('.react-flow__controls-zoomout').click()
            await sleep(250)
        }
        const dx = view.width / 2 - (box.x + box.width / 2)
        const dy = view.height / 2 - (box.y + box.height / 2)
        await pan(Math.max(-420, Math.min(420, dx)), Math.max(-360, Math.min(360, dy)))
    }
    throw new Error('PostgreSQL MCP card is still cut off')
}

async function stepQueryAndSave(page) {
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    await mcp.waitFor()
    const box = await mcp.boundingBox()
    if (!box) throw new Error('PostgreSQL MCP is not on screen')
    await page.mouse.click(box.x + box.width / 2, box.y + 80)
    const select = mcp.locator('#mcpActions')
    let picked = false
    for (let i = 0; i < 20 && !picked; i += 1) {
        await select.click()
        const option = page.getByRole('option', { name: /query/i }).first()
        if (await option.count()) {
            await option.click()
            picked = true
        } else {
            await page.keyboard.press('Escape')
            await sleep(3000)
        }
    }
    if (!picked) throw new Error('QUERY was not in Available Actions')
    await framePostgresCard(page, mcp, path.join(OUT_H, 'postgres-mcp-query.png'))
    await page.getByTitle('Save Harness').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').fill('chief-of-staff')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText(/Last edited by Rosa Diaz/i).waitFor({ timeout: 20000 })
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(400)
    await shot(page, path.join(OUT_H, 'canvas-saved.png'), 1440, 960)
    state.canvas = page.url()
    state.canvasId = page.url().split('/').pop()
}

async function stepSync(page) {
    const flow = await api('GET', `/chatflows/${state.canvasId}`)
    const data = JSON.parse(flow.flowData)
    const node = data.nodes.find((item) => item.data?.name === 'plainText') || data.nodes[0]
    node.data.version = 0.1
    await api('PUT', `/chatflows/${state.canvasId}`, { ...flow, flowData: JSON.stringify(data) })
    await page.goto(state.canvas, { waitUntil: 'networkidle' })
    await page.getByTitle('Sync Nodes').waitFor()
    await page.getByTitle('Sync Nodes').click()
    await sleep(600)
    await shot(page, path.join(OUT_H, 'sync-nodes.png'), 1440, 960)
    await page.getByTitle('Save Harness').click()
    await sleep(1500)
}

async function askCanvas(page, question, until = 'Finished') {
    if (!page.url().includes('/harnesscanvas/')) await page.goto(state.canvas, { waitUntil: 'networkidle' })
    const input = page.locator('.cloud-wrapper').locator('visible=true').locator('#userInput')
    if (!(await input.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'chat', exact: true }).click()
        await input.waitFor({ timeout: 15000 })
    }
    await input.fill(question)
    await input.press('Enter')
    await page.getByText(until).last().waitFor({ timeout: 180000 })
    await sleep(400)
}

async function stepChats(page) {
    await askCanvas(page, 'What does the sample note say the researcher reads, and how were its vectors built?')
    await shot(page, path.join(OUT_H, 'canvas-chat-researcher.png'), 1440, 960)
    await page.getByTitle('Clear Chat History').click()
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await sleep(600)
    await askCanvas(
        page,
        'Use the analyst database. Create a tasks table with id, title, and status. Insert three tasks: draft agenda (open), book room (done), send invites (open). Show the open tasks.'
    )
    await shot(page, path.join(OUT_H, 'canvas-chat-analyst.png'), 1440, 960)
}

async function buildTeam(page, description, look) {
    await openApp(page, `${BASE}/harnesscanvas`, look)
    await page.getByRole('button', { name: 'Build with AI' }).click()
    const dialog = page.getByRole('dialog', { name: 'Build with AI' })
    await dialog.waitFor()
    await dialog.getByRole('textbox').fill(description)
    return dialog
}

async function shotHarnessList(page) {
    await openApp(page, `${BASE}/harnesses`, 'classic')
    await page.getByText('chief-of-staff').waitFor()
    await shot(page, path.join(OUT_H, 'harness-list.png'), 1440, 960)
}

async function stepBuild(page) {
    await shotHarnessList(page)
    const study =
        'A study team: a science explainer who teaches a topic in plain words, and a quiz writer who makes three practice questions.'
    let dialog = await buildTeam(page, study, 'panel')
    await shot(page, path.join(OUT_H, 'build-with-ai-dialog.png'), 1440, 960)
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/harnesscanvas\/[0-9a-f-]{36}/, { timeout: 180000 })
    await page.locator('.react-flow__node').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click()
    const trip = 'A trip planning team with an itinerary planner and a budget specialist who uses a calculator'
    dialog = await buildTeam(page, trip, 'panel')
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/harnesscanvas\/[0-9a-f-]{36}/, { timeout: 180000 })
    await page.locator('.react-flow__node').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(500)
    await shot(page, path.join(OUT_H, 'build-with-ai-built.png'), 1440, 960)
    state.trip = page.url()
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.getByText(/seven days in Italy/i).click()
    await page.getByText('Finished').waitFor({ timeout: 180000 })
    await shot(page, path.join(OUT_H, 'build-with-ai-chat.png'), 1440, 960)
    const news = "A news team: a researcher who searches the web with Tavily for today's headlines, and a writer who sums them up."
    dialog = await buildTeam(page, news, 'panel')
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/harnesscanvas\/[0-9a-f-]{36}/, { timeout: 180000 })
    await page.getByText(/Tavily API needs/i).waitFor()
    await page.locator('.react-flow__controls-fitview').click({ force: true })
    await shot(page, path.join(OUT_H, 'build-with-ai-missing-credential.png'), 1440, 960)
    dialog = await buildTeam(page, study, 'classic')
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/harnesscanvas\/[0-9a-f-]{36}/, { timeout: 180000 })
    await page.locator('.react-flow__node').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(400)
    await shot(page, path.join(OUT_H, 'build-with-ai-classic.png'), 1440, 960)
}

async function stepHarnessPage(page) {
    await openApp(page, `${BASE}/harnesses`, 'classic')
    await page.getByText('chief-of-staff').waitFor()
    await page.getByText('chief-of-staff').click()
    await page.getByRole('heading', { name: 'Try it' }).waitFor()
    fs.writeFileSync(HOLD, '1')
    const box = page.getByPlaceholder('Ask this harness')
    await box.fill('Use the analyst database. How many tasks are open, and what are their titles?')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: 'Running' }).waitFor()
    await page.getByText(/sent work to analyst/i).waitFor({ timeout: 20000 })
    await page.getByText('Waiting for the first token.').waitFor()
    await shot(page, path.join(OUT_H, 'harness-try-it-running.png'), 1440, 960)
    fs.rmSync(HOLD, { force: true })
    await page.getByText(/There are 2 open tasks/i).waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
    await shot(page, path.join(OUT_H, 'harness-try-it-done.png'), 1440, 960)
    await page
        .getByText(/Create a tasks table/)
        .first()
        .click()
    const analystRow = page.getByText(/^analyst$/).last()
    await analystRow.scrollIntoViewIfNeeded()
    await analystRow.click()
    await page
        .getByText(/mcp__analyst__query/)
        .first()
        .scrollIntoViewIfNeeded()
    await sleep(300)
    await shot(page, path.join(OUT_H, 'harness-run-trace.png'), 1440, 960)
}

async function stepChatflow(page) {
    await openApp(page, `${BASE}/canvas`, 'classic')
    await page.getByRole('button', { name: 'add', exact: true }).click()
    await page.getByPlaceholder('Search nodes').fill('Harness')
    await page.getByText('Attach a named harness').waitFor()
    await shot(page, path.join(OUT_H, 'chatflow-add-harness-node.png'), 1440, 960)
    await page.getByText('Attach a named harness').click()
    const listed = await api('POST', '/node-load-method/harness', { name: 'harnessName', loadMethod: 'listHarnesses', inputs: {} })
    log(`harness options ${JSON.stringify(listed).slice(0, 240)}`)
    const harnessInput = page.locator('#harnessName')
    await harnessInput.click({ force: true })
    await harnessInput.press('ArrowDown')
    const harnessOption = page.getByRole('option', { name: /chief-of-staff/ })
    await harnessOption.waitFor({ timeout: 15000 })
    await harnessOption.click()
    await page.getByTitle('Save Chatflow').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').fill('Chief of staff chat')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText(/Last edited by/i).waitFor({ timeout: 20000 })
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    const input = page.locator('#userInput')
    await input.fill('What does the sample note say the researcher reads, and how were its vectors built?')
    await input.press('Enter')
    await page.getByText('Finished').waitFor({ timeout: 180000 })
    await shot(page, path.join(OUT_H, 'chatflow-harness-chat.png'), 1440, 960)
}

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function terminalShot(browser, file, lines, width, height) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' })
    const flat = lines.flatMap((line) => String(line).split('\n'))
    const body = flat.map((line) => `<div>${escapeHtml(line) || ' '}</div>`).join('')
    await page.setContent(
        `<!doctype html><body style="margin:0;background:#fff;color:#222;font:13px/1.35 'DejaVu Sans Mono',monospace;padding:10px 12px">${body}<div>$ <span style="display:inline-block;width:8px;height:13px;background:#222"></span></div></body>`
    )
    await page.screenshot({ path: file })
    await page.close()
    log(path.basename(file))
}

async function stepAnalyst(page) {
    const flows = await api('GET', '/chatflows')
    const list = Array.isArray(flows) ? flows : flows?.data || []
    const chief = list.find((flow) => flow.name === 'chief-of-staff')
    if (!chief) throw new Error('chief-of-staff was not saved')
    state.canvas = `${BASE}/harnesscanvas/${chief.id}`
    state.canvasId = chief.id
    const cmdline = (entry) => {
        try {
            return fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8')
        } catch {
            return ''
        }
    }
    const childrenOf = (entry) => {
        try {
            return fs.readFileSync(`/proc/${entry}/task/${entry}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
        } catch {
            return []
        }
    }
    let pid = ''
    for (const entry of fs.readdirSync('/proc')) {
        if (!cmdline(entry).includes('start-cuttlely.sh')) continue
        for (const child of childrenOf(entry)) {
            const cmd = cmdline(child)
            if (cmd.includes('node') || cmd.includes('./run')) pid = child
        }
    }
    if (!pid) throw new Error('server pid not found')
    const environ = execFileSync('bash', ['-lc', `tr '\\0' '\\n' < /proc/${pid}/environ`], { encoding: 'utf8' })
    const analystLine = environ.split('\n').find((line) => line.startsWith('CUTTLELY_ANALYST=')) || ''
    const databaseLine = environ.split('\n').some((line) => line.startsWith('DATABASE_TYPE='))
        ? environ.split('\n').find((line) => line.startsWith('DATABASE_TYPE='))
        : 'DATABASE_TYPE is unset'
    await terminalShot(
        page.context().browser(),
        path.join(OUT_A, 'process-env-auto.png'),
        [
            `$ pid=${pid}`,
            `$ tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(CUTTLELY_ANALYST|DATABASE_TYPE)=' || true`,
            analystLine,
            `$ tr '\\0' '\\n' < /proc/$pid/environ | grep -q '^DATABASE_TYPE=' || echo 'DATABASE_TYPE is unset'`,
            databaseLine
        ],
        1420,
        220
    )
    await openApp(page, state.canvas, 'classic')
    await page.locator('.react-flow__node').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click({ force: true })
    await sleep(400)
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    const box = await mcp.boundingBox()
    const vp = page.viewportSize()
    const dx = vp.width / 2 - (box.x + box.width / 2)
    const dy = vp.height / 2 - (box.y + box.height / 2)
    await page.mouse.move(120, 220)
    await page.mouse.down()
    await page.mouse.move(120 + dx, 220 + dy, { steps: 15 })
    await page.mouse.up()
    for (let i = 0; i < 2; i += 1) await page.locator('.react-flow__controls-zoomin').click()
    await shot(page, path.join(OUT_A, 'postgres-mcp-query.png'), 1440, 960)
    await askCanvas(page, 'Seed sqlite shot.')
    const analystDb = fs.readdirSync(DATA).find((name) => name.startsWith('analyst') && name.endsWith('.db'))
    if (!analystDb) throw new Error('analyst database was not created')
    const q = (file, sql) => execFileSync('sqlite3', [path.join(DATA, file), sql], { encoding: 'utf8' }).trimEnd()
    const lines = [
        '$ ls -1 database.sqlite ' + analystDb,
        ...execFileSync('ls', ['-1', path.join(DATA, 'database.sqlite'), path.join(DATA, analystDb)], { encoding: 'utf8' })
            .trimEnd()
            .split('\n')
            .map((name) => path.basename(name)),
        "$ echo 'database.sqlite tables named sales or tickets:'",
        'database.sqlite tables named sales or tickets:',
        `$ sqlite3 database.sqlite "SELECT count(*) FROM sqlite_master WHERE name IN ('sales','tickets');"`,
        q('database.sqlite', "SELECT count(*) FROM sqlite_master WHERE name IN ('sales','tickets');"),
        `$ echo '${analystDb} tables:'`,
        `${analystDb} tables:`,
        `$ sqlite3 ${analystDb} .tables`,
        q(analystDb, '.tables'),
        "$ echo 'sales rows:'",
        'sales rows:',
        `$ sqlite3 ${analystDb} 'SELECT id, region, units FROM sales ORDER BY id;'`,
        q(analystDb, 'SELECT id, region, units FROM sales ORDER BY id;'),
        "$ echo 'tickets rows:'",
        'tickets rows:',
        `$ sqlite3 ${analystDb} 'SELECT id, title FROM tickets ORDER BY id;'`,
        q(analystDb, 'SELECT id, title FROM tickets ORDER BY id;')
    ]
    await terminalShot(page.context().browser(), path.join(OUT_A, 'sqlite-analyst-db.png'), lines, 1324, 648)
    await askCanvas(
        page,
        'Use the analyst database. Create a sales table with id, region, and units. Insert west 10, east 20, and west 5. Show the total units by region. Then add 10 to every west row and show all rows.'
    )
    await shot(page, path.join(OUT_A, 'canvas-chat-sales.png'), 1440, 960)
    await askCanvas(
        page,
        "Analyst: run these statements one at a time: DROP TABLE IF EXISTS tickets; CREATE TABLE tickets (id integer primary key, title text); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO tickets SELECT i, 'Ticket ' || i FROM n; then SELECT * FROM tickets ORDER BY id and show all rows."
    )
    await page.setViewportSize({ width: 1440, height: 918 })
    const chat = page.locator('.cloud-wrapper')
    const chatBox = await chat.boundingBox()
    await page.screenshot({
        path: path.join(OUT_A, 'paging-page-1-start.png'),
        clip: { x: chatBox.x, y: chatBox.y, width: 400, height: 738 }
    })
    log('paging-page-1-start.png')
}

async function runTry(page, harness, prompt, until, { fresh = true } = {}) {
    if (fresh || !page.url().includes(`/harnesses/${harness}`)) {
        await openApp(page, `${BASE}/harnesses/${harness}`, 'classic')
    }
    await page.getByRole('heading', { name: 'Try it' }).waitFor()
    const box = page.getByPlaceholder('Ask this harness')
    await box.fill(prompt)
    const before = await page.getByText('Finished').count()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.waitForFunction((n) => document.body.innerText.split('Finished').length - 1 > n, before, { timeout: 180000 })
    if (until) await page.getByText(until).last().waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 30000 })
    await sleep(300)
}

async function expandAnalyst(page) {
    const heading = page.getByText('Harness Prime sent work to analyst').last()
    await heading.scrollIntoViewIfNeeded()
    const analyst = heading.locator('xpath=following::*[normalize-space()="analyst"][1]')
    await analyst.click()
    await page
        .getByText(/mcp__analyst__query/)
        .last()
        .waitFor({ timeout: 10000 })
    await sleep(200)
}

async function clipFromTryIt(page, file, width, height) {
    await page.setViewportSize({ width: 1440, height: Math.max(1200, height + 160) })
    const heading = page.getByRole('heading', { name: 'Try it' })
    await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await sleep(200)
    const box = await heading.boundingBox()
    await clipAt(page, file, box.x, box.y, width, height)
}

async function clipAt(page, file, x, y, width, height) {
    const vp = page.viewportSize()
    const left = Math.max(0, Math.min(x, vp.width - width))
    const top = Math.max(0, Math.min(y, vp.height - height))
    await page.screenshot({ path: file, clip: { x: left, y: top, width, height } })
    log(path.basename(file))
}

async function stepAnalystMore(page) {
    await runTry(
        page,
        'chief-of-staff',
        "Use the analyst database. Run VACUUM INTO '/tmp/docs-shots/not-a-file.db'.",
        /refused ATTACH or VACUUM/
    )
    await shot(page, path.join(OUT_A, 'try-it-vacuum-refused.png'), 1440, 960)
    await runTry(page, 'chief-of-staff', 'Use the analyst database. Run a recursive count with no end.', /statement timeout/)
    await page.setViewportSize({ width: 1440, height: 1400 })
    const timeout = page.getByText('canceling statement due to statement timeout').last()
    await timeout.scrollIntoViewIfNeeded()
    const timeoutBox = await timeout.boundingBox()
    await clipAt(page, path.join(OUT_A, 'statement-timeout-sqlite.png'), timeoutBox.x - 48, timeoutBox.y - 400, 948, 530)
    await runTry(page, 'chief-of-staff', 'Seed bakery orders.', /Finished/)
    await runTry(
        page,
        'chief-of-staff',
        'Use the analyst database. Create a temp table tmp_targets, insert apple tart 900, lemon cake 400, and rye loaf 300, and join it to demo_orders.',
        /ordered, target/,
        { fresh: false }
    )
    await expandAnalyst(page)
    await page
        .getByText(/3 rows/)
        .last()
        .waitFor()
    await page.setViewportSize({ width: 1440, height: 1400 })
    const runButton = page.getByRole('button', { name: 'Run', exact: true })
    await runButton.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await sleep(200)
    const runBox = await runButton.boundingBox()
    await clipAt(page, path.join(OUT_A, 'temp-table-join.png'), runBox.x - 8, runBox.y - 280, 1108, 810)
    await runTry(page, 'chief-of-staff', 'Use the analyst database. Run SELECT * FROM tmp_targets.', /no such table/, { fresh: false })
    await expandAnalyst(page)
    const next = page.getByText(/no such table: tmp_targets/).last()
    await next.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await sleep(200)
    const nextBox = await next.boundingBox()
    const contentX = (await page.getByRole('heading', { name: 'Try it' }).boundingBox())?.x || nextBox.x
    await clipAt(page, path.join(OUT_A, 'temp-table-next-turn.png'), contentX, nextBox.y - 500, 1108, 619)
}

async function placePng(page, src, file, width, height) {
    const b64 = fs.readFileSync(src).toString('base64')
    const host = await page.context().newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' })
    await host.setContent(
        `<!doctype html><body style="margin:0;background:#f7f7f4"><img alt="" src="data:image/png;base64,${b64}" style="display:block;margin:16px 20px"></body>`
    )
    await host.screenshot({ path: file })
    await host.close()
    log(path.basename(file))
}

async function compositeChat(page, file, width, height) {
    const tmp = path.join(TMP, 'chat-element.png')
    await page.locator('.cloud-wrapper').screenshot({ path: tmp })
    const b64 = fs.readFileSync(tmp).toString('base64')
    const host = await page.context().newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' })
    await host.setContent(
        `<!doctype html><body style="margin:0;background:#f7f7f4"><img alt="" src="data:image/png;base64,${b64}" style="display:block;margin:16px 20px"></body>`
    )
    await host.screenshot({ path: file })
    await host.close()
    log(path.basename(file))
}

async function widenChat(page, width, height) {
    await page.evaluate(
        ({ width: w, height: h }) => {
            const chat = document.querySelector('.cloud-wrapper')
            if (!chat) return
            for (const [key, value] of Object.entries({
                position: 'fixed',
                left: '0',
                top: '0',
                width: `${w}px`,
                height: `${h}px`,
                'max-width': 'none',
                'z-index': '10000',
                background: '#f7f7f4',
                overflow: 'auto'
            })) {
                chat.style.setProperty(key, value, 'important')
            }
        },
        { width, height }
    )
}

async function scrollTextToTop(page, text) {
    const loc = page.getByText(text).first()
    await loc.evaluate((el) => {
        let node = el.parentElement
        while (node) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8) {
                const top = el.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
                node.scrollTop = Math.max(0, top - 8)
                return
            }
            node = node.parentElement
        }
    })
    await sleep(150)
}

async function stepPaging(page) {
    await ensureCanvas()
    // The canvas chat keeps one chat id for every turn. An empty history keeps earlier turns out of the frame.
    await page.route('**/internal-chatmessage/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.goto(state.canvas, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.locator('#userInput').waitFor()
    const prompt =
        "Analyst: run these statements one at a time: DROP TABLE IF EXISTS tickets; CREATE TABLE tickets (id integer primary key, title text); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO tickets SELECT i, 'Ticket ' || i FROM n; then SELECT * FROM tickets ORDER BY id and show all rows."
    await askCanvas(page, prompt, /Ticket 1/)
    await page.getByText(PAGE_LINE).last().waitFor()
    await page.setViewportSize({ width: 1440, height: 960 })
    await scrollTextToTop(page, 'Analyst: run these statements')
    const chat = page.locator('.cloud-wrapper')
    const chatBox = await chat.boundingBox()
    await page.screenshot({
        path: path.join(OUT_A, 'paging-page-1-start.png'),
        clip: { x: chatBox.x, y: chatBox.y, width: 400, height: 738 }
    })
    log('paging-page-1-start.png')
    await scrollTextToTop(page, 'Ticket 90')
    const page1 = path.join(TMP, 'paging-page-1-element.png')
    const box1 = await page.locator('.cloud-wrapper').boundingBox()
    await page.screenshot({ path: page1, clip: box1 })
    await placePng(page, page1, path.join(OUT_A, 'paging-page-1-line.png'), 1200, 1086)
    await runTry(page, 'chief-of-staff', prompt, /rows 1-100 of 150/)
    await runTry(page, 'chief-of-staff', 'show more', /last page/, { fresh: false })
    await page.setViewportSize({ width: 1440, height: 1600 })
    const last = page.getByText(/last page/).last()
    await last.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await sleep(200)
    const lastBox = await last.boundingBox()
    await clipAt(page, path.join(OUT_A, 'paging-page-2-last.png'), Math.max(0, lastBox.x - 24), Math.max(0, lastBox.y - 1000), 1000, 1145)
    await runTry(page, 'chief-of-staff', 'How many rows are in the tickets table?', /contains \d+ rows/)
    await runTry(page, 'chief-of-staff', 'show more', /nothing to page yet/, { fresh: false })
    await page.setViewportSize({ width: 1440, height: 1400 })
    const count = page.getByText(/How many rows are in the tickets table\?/).last()
    await count.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await sleep(200)
    const countBox = await count.boundingBox()
    await clipAt(page, path.join(OUT_A, 'paging-nothing-yet.png'), countBox.x - 48, countBox.y - 16, 400, 809)
}

const PAGE_LINE = 'rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)'

async function ensureCanvas() {
    if (state.canvas) return
    const list = await flowList()
    const chief = list.find((flow) => flow.name === 'chief-of-staff')
    if (!chief) throw new Error('chief-of-staff was not saved')
    state.canvas = `${BASE}/harnesscanvas/${chief.id}`
    state.canvasId = chief.id
}

async function stepTrace(page) {
    await ensureCanvas()
    await page.goto(state.canvas, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.locator('.cloud-wrapper').locator('visible=true').locator('#userInput').waitFor()
    await shotNothingYet(page)
    await runTry(page, 'chief-of-staff', 'Use the analyst database. Select every row from tickets.', /Finished/)
    await expandAnalyst(page)
    const chip = page.getByText(/mcp__analyst__query · done · 100 rows/).last()
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    await page.getByText(/Showing 5 of 100 rows/).waitFor({ timeout: 15000 })
    await page.getByText('Ticket 5').waitFor()
    await page.setViewportSize({ width: 1680, height: 1200 })
    const card = page.locator('text=Harness Prime sent work to analyst').last()
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await sleep(200)
    const box = await card.boundingBox()
    await clipAt(page, path.join(OUT_A, 'trace-query-preview.png'), Math.max(0, box.x - 16), Math.max(0, box.y - 56), 1584, 1016)
}

async function flowList() {
    const flows = await api('GET', '/chatflows')
    return Array.isArray(flows) ? flows : flows?.data || []
}

async function copyHarness(name, mutate) {
    const list = await flowList()
    const found = list.find((flow) => flow.name === name)
    if (found) return found
    const chief = list.find((flow) => flow.name === 'chief-of-staff') || { id: '' }
    if (!chief) throw new Error('chief-of-staff was not saved')
    const full = await api('GET', `/chatflows/${chief.id}`)
    const flowData = typeof full.flowData === 'string' ? JSON.parse(full.flowData) : full.flowData
    if (mutate) mutate(flowData)
    try {
        return await api('POST', '/chatflows', {
            name,
            flowData: JSON.stringify(flowData),
            type: full.type || 'HARNESS',
            deployed: false,
            isPublic: false
        })
    } catch (error) {
        if (/already used/i.test(String(error.message))) return { name }
        throw error
    }
}

function addBakeryMcp(flowData) {
    const nodes = flowData.nodes || []
    const edges = flowData.edges || []
    const analyst = nodes.find((node) => node.id === 'analyst_0' || node.data?.label === 'analyst')
    if (!analyst) throw new Error('analyst specialist node was not found')
    const config = JSON.stringify({
        command: process.execPath,
        args: [path.join(ROOT, 'scripts/docs-shots/bakery-mcp.mjs')]
    })
    nodes.push({
        id: 'customMCP_0',
        type: 'customNode',
        position: { x: (analyst.position?.x || 400) - 280, y: (analyst.position?.y || 200) + 280 },
        data: {
            id: 'customMCP_0',
            label: 'Custom MCP',
            name: 'customMCP',
            version: 1.1,
            type: 'Custom MCP Tool',
            category: 'Tools (MCP)',
            inputs: { mcpServerConfig: config, mcpActions: '["bakery_hours"]' }
        }
    })
    const attached = edges.find((edge) => edge.target === analyst.id && /attached/.test(edge.targetHandle || ''))
    const targetHandle =
        attached?.targetHandle ||
        `${analyst.id}-input-attached-BaseRetriever | Tool | VectorStore | Document | Embeddings | TextSplitter | BaseDocumentTransformer`
    edges.push({
        id: `customMCP_0-${analyst.id}-attached`,
        source: 'customMCP_0',
        target: analyst.id,
        sourceHandle: 'customMCP_0-output-customMCP-Tool',
        targetHandle,
        type: 'buttonedge'
    })
    flowData.nodes = nodes
    flowData.edges = edges
}

async function stepSqlRefused(page) {
    await copyHarness('bakery-other-sql', addBakeryMcp)
    await runTry(
        page,
        'bakery-other-sql',
        'How many sourdough orders did the bakery have? Use the execute_sql tool.',
        /execute_sql tool is not available/
    )
    await clipFromTryIt(page, path.join(OUT_A, 'sql-refused.png'), 948, 549)
}

async function workspaceIdByName(name) {
    const db = path.join(DATA, 'database.sqlite')
    const rows = execFileSync('sqlite3', ['-separator', '|', db, 'SELECT id, name FROM workspace;'], { encoding: 'utf8' })
    for (const line of rows.trim().split('\n')) {
        const [id, label] = line.split('|')
        if (label === name) return id
    }
    return ''
}

function cloneCredential(workspaceId) {
    const db = path.join(DATA, 'database.sqlite')
    const row = execFileSync('sqlite3', ['-separator', '\t', db, `SELECT name, credentialName, encryptedData FROM credential LIMIT 1;`], {
        encoding: 'utf8'
    }).trim()
    const [name, credentialName, encryptedData] = row.split('\t')
    const id = crypto.randomUUID()
    execFileSync('sqlite3', [
        db,
        `INSERT INTO credential (id, name, credentialName, encryptedData, workspaceId) VALUES ('${id}', '${name.replace(
            /'/g,
            "''"
        )}', '${credentialName.replace(/'/g, "''")}', '${encryptedData.replace(/'/g, "''")}', '${workspaceId}');`
    ])
    return id
}

async function shotNothingYet(page) {
    await ensureCanvas()
    await page.goto(state.canvas, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.locator('.cloud-wrapper').locator('visible=true').locator('#userInput').waitFor()
    const full = page.getByText("There's nothing to page yet. Ask your question again and I'll show the first page.").first()
    if (!(await full.count())) {
        await askCanvas(page, 'How many rows are in the tickets table?', /contains \d+ rows/)
        await askCanvas(page, 'show more', /nothing to page yet/)
    }
    await full.waitFor()
    await widenChat(page, 400, 1100)
    await full.evaluate((el) => {
        let node = el.parentElement
        while (node) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8) {
                const top = el.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
                node.scrollTop = Math.max(0, top - 280)
                return
            }
            node = node.parentElement
        }
        el.scrollIntoView({ block: 'center' })
    })
    await sleep(300)
    await page.setViewportSize({ width: 1440, height: 1800 })
    const chat = page.locator('.cloud-wrapper')
    const chatBox = await chat.boundingBox()
    const textBox = await full.boundingBox()
    if (!chatBox || !textBox) throw new Error('the nothing-to-page reply is not on screen')
    let clipY = textBox.y + textBox.height + 20 - 809
    if (clipY < chatBox.y) clipY = chatBox.y
    if (textBox.y < clipY || textBox.y + textBox.height > clipY + 800) {
        throw new Error('the nothing-to-page reply is still cut off')
    }
    await page.screenshot({
        path: path.join(OUT_A, 'paging-nothing-yet.png'),
        clip: { x: chatBox.x, y: clipY, width: 400, height: 809 }
    })
    log('paging-nothing-yet.png')
}

async function stepWorkspaces(page) {
    if (process.env.DOCS_SHOTS_SKIP_NOTHING !== '1') await shotNothingYet(page)
    const defaultTeam = await workspaceIdByName('Default Workspace')
    if (defaultTeam) await api('POST', `/workspace/switch?id=${encodeURIComponent(defaultTeam)}`)
    const list = await flowList()
    const chiefId =
        list.find((flow) => flow.name === 'chief-of-staff')?.id ||
        execFileSync('sqlite3', [path.join(DATA, 'database.sqlite'), "SELECT id FROM chat_flow WHERE name = 'chief-of-staff' LIMIT 1;"], {
            encoding: 'utf8'
        }).trim()
    const full = await api('GET', `/chatflows/${chiefId}`)
    const savedFlow = typeof full.flowData === 'string' ? full.flowData : JSON.stringify(full.flowData)
    const savedType = full.type || 'HARNESS'
    await copyHarness('bakery-auto-timeout')
    if (process.env.DOCS_SHOTS_SKIP_HOME !== '1') {
        await runTry(
            page,
            'bakery-auto-timeout',
            'Run exactly this one statement and nothing else, then report what the tool returned: SELECT count(*) AS n FROM demo_orders;',
            /count of 150 rows/
        )
        await expandAnalyst(page)
        await page.getByText(/1 row/).last().waitFor()
        await clipFromTryIt(page, path.join(OUT_A, 'workspace-home-team.png'), 1108, 619)
    }
    const org = execFileSync('sqlite3', [path.join(DATA, 'database.sqlite'), 'SELECT id FROM organization LIMIT 1;'], {
        encoding: 'utf8'
    }).trim()
    let teamB = await workspaceIdByName('Demo team B')
    if (!teamB) {
        const created = await api('POST', '/workspace', { name: 'Demo team B', organizationId: org, description: 'Second bakery team' })
        teamB = created.id
    }
    await api('POST', `/workspace/switch?id=${encodeURIComponent(teamB)}`)
    const teamList = await flowList()
    const stale = teamList.find((flow) => flow.name === 'bakery-team-b-auto')
    if (stale) await api('DELETE', `/chatflows/${stale.id}`)
    const homeCredential = execFileSync(
        'sqlite3',
        [path.join(DATA, 'database.sqlite'), `SELECT id FROM credential WHERE workspaceId != '${teamB}' LIMIT 1;`],
        { encoding: 'utf8' }
    ).trim()
    const credentialId = cloneCredential(teamB)
    const rebound = savedFlow.replaceAll(homeCredential, credentialId)
    await api('POST', '/chatflows', {
        name: 'bakery-team-b-auto',
        flowData: rebound,
        type: savedType,
        deployed: false,
        isPublic: false
    })
    await runTry(
        page,
        'bakery-team-b-auto',
        'Run exactly this one statement and nothing else, then report what the tool returned: SELECT count(*) AS n FROM demo_orders;',
        /no table named demo_orders/
    )
    await expandAnalyst(page)
    await page
        .getByText(/failed/)
        .last()
        .waitFor()
    await clipFromTryIt(page, path.join(OUT_A, 'workspace-second-team.png'), 1108, 619)
    const homeId = await workspaceIdByName('Default Workspace')
    const fallback = execFileSync(
        'sqlite3',
        [
            path.join(DATA, 'database.sqlite'),
            "SELECT id FROM workspace WHERE name != 'Demo team B' AND name != 'Personal Workspace' LIMIT 1;"
        ],
        { encoding: 'utf8' }
    ).trim()
    await api('POST', `/workspace/switch?id=${encodeURIComponent(homeId || fallback)}`)
}

async function stepRetakeChats(page) {
    await ensureCanvas()
    await page.goto(state.canvas, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'chat', exact: true }).click()
    await page.getByTitle('Clear Chat History').click()
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await sleep(400)
    await askCanvas(
        page,
        'Use the analyst database. Create a tasks table with id, title, and status. Insert three tasks: draft agenda (open), book room (done), send invites (open). Show the open tasks.',
        /draft agenda/
    )
    await shot(page, path.join(OUT_H, 'canvas-chat-analyst.png'), 1440, 960)
    await page.getByTitle('Clear Chat History').click()
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await sleep(400)
    await askCanvas(
        page,
        'Use the analyst database. Create a sales table with id, region, and units. Insert west 10, east 20, and west 5. Show the total units by region. Then add 10 to every west row and show all rows.',
        /west 15, east 20/
    )
    await shot(page, path.join(OUT_A, 'canvas-chat-sales.png'), 1440, 960)
}

function pgEnv(name, database, user, password) {
    return {
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: '127.0.0.1',
        DATABASE_PORT: '5432',
        DATABASE_NAME: database,
        DATABASE_USER: user,
        DATABASE_PASSWORD: password,
        PORT: '43127',
        CUTTLELY_HARNESS_GATEWAY_PORT: '43128',
        HERMES_API_PORT: '8644',
        CUTTLELY_DATA_DIR: path.join(TMP, name),
        DATABASE_PATH: path.join(TMP, name),
        SECRETKEY_PATH: path.join(TMP, name),
        BLOB_STORAGE_PATH: path.join(TMP, name, 'blobs'),
        CUTTLELY_HERMES_HOME: path.join(TMP, name, 'hermes')
    }
}

function ensurePgRole(user, database, createrole) {
    const flag = createrole ? 'CREATEROLE' : 'NOCREATEROLE'
    const password = `docs-${crypto.randomBytes(12).toString('hex')}`
    const sql = `
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN
                CREATE ROLE ${user} LOGIN PASSWORD '${password}' ${flag};
            ELSE
                ALTER ROLE ${user} WITH LOGIN PASSWORD '${password}' ${flag};
            END IF;
        END $$;
        SELECT 'ok';
    `
    execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' })
    execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS ${database};`], {
        stdio: 'pipe'
    })
    execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database} OWNER ${user};`], {
        stdio: 'pipe'
    })
    return password
}

async function stopServer() {
    stopChildren()
    children.length = 0
    await sleep(1500)
}

async function bootPostgres(page, label, database, user, createrole) {
    await stopServer()
    const password = ensurePgRole(user, database, createrole)
    const dir = path.join(TMP, label)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const extra = pgEnv(label, database, user, password)
    const prev = BASE
    startStandIn()
    await waitFor(`http://127.0.0.1:${MODEL_PORT}/health`)
    startServer(extra)
    const origin = `http://127.0.0.1:${extra.PORT}`
    await waitFor(`${origin}/api/v1/ping`, 120)
    const admin = ensureAdmin()
    const child = spawn('pnpm', ['user', '--email', admin.email], {
        cwd: ROOT,
        env: {
            ...process.env,
            PATH: `${process.env.HOME}/.nvm/versions/node/v24.21.0/bin:${process.env.PATH}`,
            CUTTLELY_LOCAL_ADMIN: 'true',
            ...extra
        },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.end(`${admin.password}\n`)
    await new Promise((resolve) => child.on('close', resolve))
    const res = await fetch(`${origin}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal' },
        body: JSON.stringify(admin)
    })
    if (!res.ok) throw new Error(`postgres login failed: ${res.status}`)
    cookie = res.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; ')
    const baseWas = process.env.DOCS_SHOTS_BASE
    process.env.DOCS_SHOTS_BASE = origin
    return { origin, prev, baseWas, password }
}

async function stepPostgres(page) {
    const booted = await bootPostgres(page, 'pg-role', 'cuttlely', 'cuttlely', true)
    const origin = booted.origin
    const savedBase = BASE
    // BASE is a const. Use origin directly below.
    await page.goto(`${origin}/signin`, { waitUntil: 'networkidle' })
    const admin = ensureAdmin()
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(admin.email)
    await form.locator('input[type=password]').fill(admin.password)
    await form.getByRole('button', { name: /Sign in/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    await page.goto(`${origin}/marketplaces`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', 'classic')
    })
    await page.goto(`${origin}/marketplaces`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await page.getByText('Chief of Staff Harness').click()
    await page.getByRole('button', { name: 'Use Template' }).click()
    await page.waitForURL(/harnesscanvas/)
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    await page
        .getByText(/No Available Actions|QUERY|isolated analyst store|create roles/)
        .first()
        .waitFor({ timeout: 60000 })
    // Roles are cluster-wide. Drop readers left by an earlier database so this shot shows this workspace only.
    execFileSync(
        'sudo',
        [
            '-n',
            '-u',
            'postgres',
            'psql',
            '-d',
            'cuttlely',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            `DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT pr.rolname FROM pg_roles pr
    WHERE pr.rolname LIKE 'analyst_reader%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname = replace(pr.rolname, 'analyst_reader', 'analyst')
      )
  LOOP
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END $$;`
        ],
        { stdio: 'pipe' }
    )
    const psql = execFileSync(
        'sudo',
        [
            '-n',
            '-u',
            'postgres',
            'psql',
            '-d',
            'cuttlely',
            '-c',
            '\\dn analyst*',
            '-c',
            "SELECT rolname, rolsuper, rolcreaterole, rolconfig FROM pg_roles WHERE rolname LIKE 'analyst_reader%' ORDER BY rolname;"
        ],
        { encoding: 'utf8' }
    )
    fs.writeFileSync(path.join(NOTES, 'postgres-analyst-role.raw.txt'), psql)
    const banner = execFileSync('psql', ['--version'], { encoding: 'utf8' }).trim()
    const lines = [
        `$ sudo -u postgres psql -d cuttlely`,
        `psql (${banner.replace(/^psql \(PostgreSQL\) /, '')} (Ubuntu 16.15-0ubuntu0.24.04.1))`,
        'Type "help" for help.',
        '',
        `cuttlely=# \\dn analyst*`
    ]
    for (const line of psql.trimEnd().split('\n')) lines.push(line)
    lines.push('cuttlely=#')
    await terminalShot(page.context().browser(), path.join(OUT_A, 'postgres-analyst-role.png'), lines, 1284, 444)
    await bootPostgres(page, 'pg-closed', 'cuttlely_closed', 'cuttlely_limited', false)
    const closed = 'http://127.0.0.1:43127'
    await page.goto(`${closed}/signin`, { waitUntil: 'networkidle' })
    const form2 = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form2.locator('input').first().fill(admin.email)
    await form2.locator('input[type=password]').fill(admin.password)
    await form2.getByRole('button', { name: /Sign in/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    await page.goto(`${closed}/marketplaces`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', 'classic')
    })
    await page.goto(`${closed}/marketplaces`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await page.getByText('Chief of Staff Harness').click()
    await page.getByRole('button', { name: 'Use Template' }).click()
    await page.waitForURL(/harnesscanvas/)
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    await mcp.waitFor()
    const refusal = page.getByText(/Analyst mode needs the application database user to create roles/)
    for (let i = 0; i < 12; i += 1) {
        const box = await mcp.boundingBox()
        const vp = page.viewportSize()
        if (box && box.y > 80 && box.y < 420 && box.x > 40) break
        const fromX = 80
        const fromY = 80
        const dx = box ? vp.width * 0.62 - (box.x + box.width / 2) : 0
        const dy = box ? 160 - box.y : 200
        await page.mouse.move(fromX, fromY)
        await page.mouse.down()
        await page.mouse.move(fromX + dx, fromY + dy, { steps: 10 })
        await page.mouse.up()
        await sleep(200)
    }
    await refusal.waitFor({ timeout: 60000 })
    let refusalBox = await refusal.boundingBox()
    if (refusalBox && refusalBox.height < 28) {
        await page.locator('.react-flow__controls-zoomin').click()
        await sleep(300)
        const box = await mcp.boundingBox()
        const vp = page.viewportSize()
        if (box) {
            await page.mouse.move(40, 40)
            await page.mouse.down()
            await page.mouse.move(40 + (vp.width * 0.55 - box.x), 40 + (140 - box.y), { steps: 8 })
            await page.mouse.up()
            await sleep(200)
        }
        refusalBox = await refusal.boundingBox()
    }
    if (!refusalBox || refusalBox.height < 12) throw new Error('the create-roles refusal is not legible')
    const card = await mcp.boundingBox()
    if (card && refusalBox.y + refusalBox.height > card.y + card.height + 4) {
        throw new Error('the create-roles refusal is cut off by the node')
    }
    await sleep(400)
    await shot(page, path.join(OUT_A, 'available-actions-create-roles.png'), 1440, 960)
    void savedBase
}

async function shootSqliteFigure(browser) {
    const analystDb = fs.readdirSync(DATA).find((name) => name === 'analyst-ff33404ebc.db')
    if (!analystDb) throw new Error('analyst-ff33404ebc.db is not in the data directory')
    const db = path.join(DATA, analystDb)
    execFileSync('sqlite3', [
        db,
        'UPDATE sales SET units = 10 WHERE id = 1; UPDATE sales SET units = 20 WHERE id = 2; UPDATE sales SET units = 5 WHERE id = 3; DELETE FROM tickets WHERE id > 3;'
    ])
    const q = (file, sql) => execFileSync('sqlite3', [path.join(DATA, file), sql], { encoding: 'utf8' }).trimEnd()
    const lines = [
        '$ ls -1 database.sqlite ' + analystDb,
        ...execFileSync('ls', ['-1', path.join(DATA, 'database.sqlite'), path.join(DATA, analystDb)], { encoding: 'utf8' })
            .trimEnd()
            .split('\n')
            .map((name) => path.basename(name)),
        "$ echo 'database.sqlite tables named sales or tickets:'",
        'database.sqlite tables named sales or tickets:',
        `$ sqlite3 database.sqlite "SELECT count(*) FROM sqlite_master WHERE name IN ('sales','tickets');"`,
        q('database.sqlite', "SELECT count(*) FROM sqlite_master WHERE name IN ('sales','tickets');"),
        `$ echo '${analystDb} tables:'`,
        `${analystDb} tables:`,
        `$ sqlite3 ${analystDb} .tables`,
        q(analystDb, '.tables'),
        "$ echo 'sales rows:'",
        'sales rows:',
        `$ sqlite3 ${analystDb} 'SELECT id, region, units FROM sales ORDER BY id;'`,
        q(analystDb, 'SELECT id, region, units FROM sales ORDER BY id;'),
        "$ echo 'tickets rows:'",
        'tickets rows:',
        `$ sqlite3 ${analystDb} 'SELECT id, title FROM tickets ORDER BY id;'`,
        q(analystDb, 'SELECT id, title FROM tickets ORDER BY id;')
    ]
    await terminalShot(browser, path.join(OUT_A, 'sqlite-analyst-db.png'), lines, 1324, 648)
}

async function stepReviewFixes(page) {
    if (process.env.DOCS_SHOTS_REVIEW !== '1') return
    if (process.env.DOCS_SHOTS_REVIEW_PART === 'tail') {
        const home = await workspaceIdByName('Default Workspace')
        await page.goto(`${BASE}/harnesses`, { waitUntil: 'domcontentloaded' })
        const switched = await page.evaluate(async (id) => {
            const res = await fetch(`/api/v1/workspace/switch?id=${encodeURIComponent(id)}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', 'x-request-from': 'internal' }
            })
            return res.status
        }, home)
        if (switched >= 300) throw new Error(`could not open the home workspace (${switched})`)
        state.canvasId = execFileSync(
            'sqlite3',
            [path.join(DATA, 'database.sqlite'), "SELECT id FROM chat_flow WHERE name = 'chief-of-staff' LIMIT 1;"],
            {
                encoding: 'utf8'
            }
        ).trim()
        state.canvas = `${BASE}/harnesscanvas/${state.canvasId}`
        if (process.env.DOCS_SHOTS_SKIP_NOTHING !== '1') await shotNothingYet(page)
        await frameCreateRoles(page)
        return
    }
    const defaultTeam = await workspaceIdByName('Default Workspace')
    if (defaultTeam) await api('POST', `/workspace/switch?id=${encodeURIComponent(defaultTeam)}`)
    const flows = await flowList()
    for (const name of ['News-Team-Harness', 'Study-Team-Harness', 'Study-Team-Harness-2', 'Trip-Planning-Harness']) {
        const flow = flows.find((item) => item.name === name)
        if (!flow) continue
        try {
            await api('DELETE', `/chatflows/${flow.id}`)
        } catch (error) {
            log(`left ${name} in place: ${error.message}`)
        }
    }
    await shotHarnessList(page)
    if (await page.getByText('News-Team-Harness').count()) throw new Error('the harness list still shows a built team')
    await shootSqliteFigure(page.context().browser())
    await shotNothingYet(page)
    await frameCreateRoles(page)
}

async function frameCreateRoles(page) {
    await bootPostgres(page, 'pg-closed', 'cuttlely_closed', 'cuttlely_limited', false)
    const closed = 'http://127.0.0.1:43127'
    await page.goto(`${closed}/signin`, { waitUntil: 'networkidle' })
    const admin = ensureAdmin()
    const form2 = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form2.locator('input').first().fill(admin.email)
    await form2.locator('input[type=password]').fill(admin.password)
    await form2.getByRole('button', { name: /Sign in/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    await page.goto(`${closed}/marketplaces`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', 'classic')
    })
    await page.goto(`${closed}/marketplaces`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await page.getByText('Chief of Staff Harness').click()
    await page.getByRole('button', { name: 'Use Template' }).click()
    await page.waitForURL(/harnesscanvas/)
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    await mcp.waitFor()
    await page.setViewportSize({ width: 1440, height: 960 })
    for (let i = 0; i < 8; i += 1) {
        const box = await mcp.boundingBox()
        if (box && box.y > 40 && box.y + box.height < 900) break
        await page.mouse.move(720, 520)
        await page.mouse.down()
        await page.mouse.move(720, 220, { steps: 12 })
        await page.mouse.up()
        await sleep(200)
    }
    await mcp.locator('#mcpActions').click()
    await page.getByRole('option', { name: /No Available Actions/ }).click()
    const refusal = page.getByText(/This database refused that/)
    await refusal.waitFor({ timeout: 20000 })
    const nodeBox = await mcp.boundingBox()
    if (nodeBox) {
        await page.mouse.move(nodeBox.x + nodeBox.width / 2, Math.min(nodeBox.y + 40, 700))
        for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -200)
        await sleep(300)
    }
    for (let i = 0; i < 6; i += 1) {
        const box = await refusal.boundingBox()
        if (box && box.y > 80 && box.y + box.height < 900 && box.height > 16) break
        await page.mouse.move(720, 520)
        await page.mouse.down()
        await page.mouse.move(720, 260, { steps: 10 })
        await page.mouse.up()
        await sleep(200)
    }
    const settled = await refusal.boundingBox()
    if (!settled || settled.height < 36 || settled.y < 40 || settled.y + settled.height > 920) {
        throw new Error(`the create-roles refusal is still cut off (${settled ? Math.round(settled.height) : 0}px)`)
    }
    await sleep(400)
    await page.screenshot({ path: path.join(OUT_A, 'available-actions-create-roles.png') })
    log('available-actions-create-roles.png')
}

const STEPS = [
    ['empty', stepEmpty],
    ['templates', stepTemplates],
    ['save-rejected', stepSaveRejected],
    ['credential', stepCredential],
    ['openai', stepOpenAI],
    ['query-save', stepQueryAndSave],
    ['sync', stepSync],
    ['chats', stepChats],
    ['build', stepBuild],
    ['harness-page', stepHarnessPage],
    ['chatflow', stepChatflow],
    ['analyst', stepAnalyst],
    ['analyst-more', stepAnalystMore],
    ['paging', stepPaging],
    ['trace', stepTrace],
    ['sql-refused', stepSqlRefused],
    ['workspaces', stepWorkspaces],
    ['retake-chats', stepRetakeChats],
    ['postgres', stepPostgres],
    ['review-fixes', stepReviewFixes],
    ['harness-mcp', stepHarnessMcp]
]

async function stepHarnessMcp(page) {
    if (process.env.DOCS_SHOTS_FROM !== 'harness-mcp') return
    const id = execFileSync(
        'sqlite3',
        [path.join(DATA, 'database.sqlite'), "SELECT id FROM chat_flow WHERE name = 'chief-of-staff' LIMIT 1;"],
        {
            encoding: 'utf8'
        }
    ).trim()
    const home = await workspaceIdByName('Default Workspace')
    await openApp(page, `${BASE}/harnesses`, 'classic')
    if (home) {
        await page.evaluate(async (workspaceId) => {
            await fetch(`/api/v1/workspace/switch?id=${encodeURIComponent(workspaceId)}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', 'x-request-from': 'internal' }
            })
        }, home)
    }
    fs.rmSync(path.join(DATA, 'analyst-mcp.json'), { force: true })
    await waitFor('http://127.0.0.1:43118/', 120)
    await openApp(page, `${BASE}/harnesscanvas/${id}`, 'classic')
    await page.keyboard.press('Escape')
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    await mcp.waitFor({ timeout: 30000 })
    await mcp.getByText(/Run one SQL statement in the isolated analyst store/).waitFor({ timeout: 90000 })
    await framePostgresCard(page, mcp, path.join(OUT_H, 'postgres-mcp-query.png'))
}

function resetData() {
    fs.mkdirSync(TMP, { recursive: true })
    if (FROM) {
        fs.writeFileSync(path.join(TMP, 'server.log'), '')
        return
    }
    fs.rmSync(DATA, { recursive: true, force: true })
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(path.join(TMP, 'server.log'), '')
}

async function main() {
    resetData()
    const local = !process.env.OPENAI_API_KEY
    if (local) {
        startStandIn()
        await waitFor(`http://127.0.0.1:${MODEL_PORT}/health`)
        log('local model stand-in is up')
    } else log('using OPENAI_API_KEY from the environment')
    const key = startServer()
    process.env.OPENAI_API_KEY = key
    await waitFor(`${BASE}/api/v1/ping`)
    const readyDeadline = Date.now() + 60000
    while (Date.now() < readyDeadline) {
        if (fs.existsSync(path.join(DATA, 'encryption.key'))) break
        await sleep(500)
    }
    if (!fs.existsSync(path.join(DATA, 'encryption.key'))) throw new Error('server did not write its encryption key')
    const logText = fs.readFileSync(path.join(TMP, 'server.log'), 'utf8')
    if (/not ready/.test(logText)) throw new Error('server reported it is not ready; see /tmp/docs-shots/server.log')
    log('server is up')
    const admin = ensureAdmin()
    await createUser(admin)
    await nameRosa()
    await login(admin)
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, colorScheme: 'light' })
    const page = await context.newPage()
    await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(admin.email)
    await form.locator('input[type=password]').fill(admin.password)
    await form.getByRole('button', { name: /Sign in/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    let run = !FROM
    for (const [name, fn] of STEPS) {
        if (!run && name === FROM) run = true
        if (!run) continue
        log(`step ${name}`)
        try {
            await fn(page)
        } catch (error) {
            await page.screenshot({ path: path.join(TMP, 'fail.png'), fullPage: false }).catch(() => {})
            throw error
        }
    }
    await browser.close()
    log('harness pictures written')
}

main().catch((error) => {
    console.error(error)
    stopChildren()
    process.exit(1)
})
