// The table picker and describe pictures in docs/images/analyst/, from a local server and a local Postgres.
// No outside account. Keys are read from the environment only.
//
//   pnpm build && bash scripts/setup-hermes.sh
//   PGPASSWORD=... node scripts/docs-shots/capture-analyst-picker.mjs
//
// The script creates a made-up bakery database (samples/demo/bakery/bakery-postgres.sql) with a read-only login,
// saves it as a Postgres URL credential, and builds a one-analyst harness whose PostgreSQL MCP node ticks six
// relations. When OPENAI_API_KEY is unset, model-stand-in.mjs answers on 127.0.0.1: it describes the view, then
// queries it. CUTTLELY_TEST_PG_HOST, CUTTLELY_TEST_PG_PORT and CUTTLELY_TEST_PG_USER name the Postgres admin.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { themeFor } from './theme.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'docs/images/analyst')
const TMP = '/tmp/docs-shots-picker'
const DATA = path.join(TMP, 'data')
const BASE = 'http://127.0.0.1:43117'
const MODEL_PORT = process.env.DOCS_SHOTS_MODEL_PORT || '8791'
const HARNESS = 'bakery-accounts'
const DATABASE = 'bakery_docs'
const READER = 'bakery_reader'
const SELECTION = [
    'public.monthly_sales',
    'public.top_products',
    'public.account_balances',
    'public.weekly_store_revenue',
    'public.wholesale_accounts',
    'public.stores'
]
const ANALYST_INSTRUCTIONS = [
    'Answer bakery questions from the selected tables and views.',
    'Pick the view that matches the question: account_balances for what an account owes, monthly_sales for sales by month, weekly_store_revenue for a shop by week.',
    'A question that names an account code such as WA-1004 is about that account. Look up its account_id in wholesale_accounts first when the view needs the id.',
    'Describe a view before the first query against it.'
].join(' ')
const PROMPT = 'How many unpaid invoices does account WA-1004 have?'

const children = []
const log = (line) => console.log(`[docs-shots] ${line}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stopChildren() {
    for (const child of children) {
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            // already gone
        }
    }
}
process.on('exit', stopChildren)

function spawnDetached(command, args, env, logFile) {
    const out = logFile ? fs.openSync(logFile, 'a') : 'ignore'
    const child = spawn(command, args, { cwd: ROOT, detached: true, env, stdio: ['ignore', out, out] })
    children.push(child)
    child.unref()
    return child
}

async function waitFor(url, attempts = 120) {
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

function adminConfig(database = 'postgres') {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database
    }
}

async function seedBakery() {
    const password = crypto.randomBytes(18).toString('hex')
    const admin = new pg.Client(adminConfig())
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${DATABASE}`)
    await admin.query(`DROP ROLE IF EXISTS ${READER}`)
    await admin.query(`CREATE ROLE ${READER} LOGIN PASSWORD '${password}'`)
    await admin.end()
    const owner = new pg.Client(adminConfig(DATABASE))
    await owner.connect()
    await owner.query(fs.readFileSync(path.join(ROOT, 'samples/demo/bakery/bakery-postgres.sql'), 'utf8'))
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${READER}`)
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER}`)
    await owner.end()
    const { host, port } = adminConfig()
    return ['postgresql://', READER, ':', password, '@', host, ':', port, '/', DATABASE].join('')
}

let cookie = ''

async function api(method, apiPath, body) {
    const res = await fetch(`${BASE}/api/v1${apiPath}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-request-from': 'internal', cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status}: ${text.slice(0, 400)}`)
    return text ? JSON.parse(text) : null
}

async function createUser(admin, env) {
    const child = spawn('pnpm', ['user', '--email', admin.email], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(`${admin.password}\n`)
    await new Promise((resolve) => child.on('close', resolve))
}

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

function harnessFlow(openAiCredential, postgresCredential) {
    const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/harnesses/chief-of-staff.canvas.json'), 'utf8'))
    const flow = typeof sample.flowData === 'string' ? JSON.parse(sample.flowData) : sample.flowData
    const keep = new Set(['chief_0', 'chatXAI_0', 'analyst_0', 'postgreSQLMCP_0'])
    flow.nodes = flow.nodes.filter((node) => keep.has(node.id))
    flow.edges = flow.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target))
    for (const node of flow.nodes) {
        if (node.id === 'chatXAI_0') {
            Object.assign(node.data, {
                name: 'chatOpenAI',
                label: 'ChatOpenAI',
                type: 'ChatOpenAI',
                version: 8.3,
                credential: openAiCredential
            })
            node.data.inputs = { modelName: 'gpt-4o-mini', temperature: '0.2' }
        }
        if (node.id === 'chief_0') node.data.inputs.instructions = 'Account, sales and shop questions go to the analyst.'
        if (node.id === 'analyst_0') node.data.inputs.instructions = ANALYST_INSTRUCTIONS
        if (node.id === 'postgreSQLMCP_0') {
            node.data.credential = postgresCredential
            node.data.inputs = { mcpActions: '["query"]', analystRelations: JSON.stringify(SELECTION) }
        }
    }
    for (const edge of flow.edges) {
        if (edge.source === 'chatXAI_0')
            edge.sourceHandle = 'chatXAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable'
    }
    return flow
}

async function openApp(page, url) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', 'classic')
    })
    await page.goto(url, { waitUntil: 'networkidle' })
}

async function shotPicker(page, flowId) {
    const file = path.join(OUT, 'postgres-mcp-table-picker.png')
    await openApp(page, `${BASE}/harnesscanvas/${flowId}`)
    const mcp = page.getByTestId('rf__node-postgreSQLMCP_0')
    await mcp.waitFor()
    await mcp.getByText('public.account_balances', { exact: true }).waitFor({ timeout: 30000 })
    const picker = mcp.getByRole('group', { name: 'Tables and views' })
    const label = mcp.getByText('Tables and views', { exact: true })
    await page.locator('.react-flow__controls-fitview').click({ force: true })
    await sleep(500)
    const center = async () => {
        const box = await picker.boundingBox()
        const view = page.viewportSize()
        const dx = view.width / 2 - (box.x + box.width / 2)
        const dy = view.height / 2 - (box.y + box.height / 2)
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return true
        await page.mouse.move(60, 300)
        await page.mouse.down()
        await page.mouse.move(60 + Math.max(-500, Math.min(500, dx)), 300 + Math.max(-400, Math.min(400, dy)), { steps: 16 })
        await page.mouse.up()
        await sleep(300)
        return false
    }
    for (let i = 0; i < 12; i += 1) {
        await center()
        const box = await picker.boundingBox()
        if (box.width >= 360) break
        await page.locator('.react-flow__controls-zoomin').click()
        await sleep(300)
    }
    for (let i = 0; i < 6 && !(await center()); i += 1) {
        // keep panning until the list is in the middle
    }
    await themeFor(page, true)
    await sleep(500)
    const card = await mcp.boundingBox()
    const top = await label.last().boundingBox()
    const list = await picker.boundingBox()
    const x = Math.max(0, card.x - 24)
    const y = Math.max(0, Math.min(top?.y ?? list.y, list.y - 110) - 24)
    const width = Math.min(page.viewportSize().width - x, card.width + 48)
    const height = Math.min(page.viewportSize().height - y, list.y + list.height - y + 96)
    await page.screenshot({ path: file, clip: { x, y, width, height } })
    log(path.basename(file))
}

async function shotDescribeTrace(page) {
    const file = path.join(OUT, 'try-it-describe-trace.png')
    await openApp(page, `${BASE}/harnesses/${HARNESS}`)
    await page.getByRole('heading', { name: 'Try it' }).waitFor()
    await page.getByPlaceholder('Ask this harness').fill(PROMPT)
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page
        .getByText(/WA-1004 \(.*\) has \d+ unpaid invoices/)
        .last()
        .waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 30000 })
    const heading = page.getByText('Harness Prime sent work to analyst').first()
    await heading.scrollIntoViewIfNeeded()
    await heading.locator('xpath=following::*[normalize-space()="analyst"][1]').click()
    await page
        .getByText(/mcp__analyst__describe/)
        .first()
        .waitFor({ timeout: 10000 })
    await page.setViewportSize({ width: 1440, height: 1100 })
    const tryIt = page.getByRole('heading', { name: 'Try it' })
    await tryIt.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await sleep(300)
    const box = await tryIt.boundingBox()
    const answer = await page
        .getByText(/WA-1004 \(.*\) has \d+ unpaid invoices/)
        .first()
        .boundingBox()
    await themeFor(page, false)
    const x = Math.max(0, box.x - 24)
    const y = Math.max(0, box.y - 16)
    await page.screenshot({ path: file, clip: { x, y, width: 1100, height: answer.y + answer.height + 32 - y } })
    log(path.basename(file))
}

async function main() {
    fs.rmSync(TMP, { recursive: true, force: true })
    fs.mkdirSync(DATA, { recursive: true })
    const postgresUrl = await seedBakery()
    log('bakery database ready')
    const local = !process.env.OPENAI_API_KEY
    const modelKey = local ? `sk-local-${crypto.randomBytes(24).toString('hex')}` : process.env.OPENAI_API_KEY
    if (local) {
        spawnDetached(process.execPath, [path.join(ROOT, 'scripts/docs-shots/model-stand-in.mjs')], {
            ...process.env,
            DOCS_SHOTS_MODEL_PORT: MODEL_PORT,
            DOCS_SHOTS_HOLD_FILE: path.join(TMP, 'hold')
        })
        await waitFor(`http://127.0.0.1:${MODEL_PORT}/health`)
    }
    const env = {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
        PORT: '43117',
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_DATA_DIR: DATA,
        DATABASE_PATH: DATA,
        SECRETKEY_PATH: DATA,
        BLOB_STORAGE_PATH: path.join(DATA, 'blobs'),
        CUTTLELY_HERMES_HOME: path.join(DATA, 'hermes'),
        OPENAI_API_KEY: modelKey,
        ...(local ? { OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1` } : {})
    }
    delete env.CUTTLELY_ANALYST
    delete env.CUTTLELY_POSTGRES_URL
    spawnDetached('bash', [path.join(ROOT, 'scripts/start-cuttlely.sh')], env, path.join(TMP, 'server.log'))
    await waitFor(`${BASE}/api/v1/ping`)
    for (let i = 0; i < 120 && !fs.existsSync(path.join(DATA, 'encryption.key')); i += 1) await sleep(500)
    const admin = { email: 'rosa.diaz@example.com', password: `Aa1!${crypto.randomBytes(12).toString('hex')}` }
    await createUser(admin, env)
    await login(admin)
    const openAi = await api('POST', '/credentials', {
        name: 'OpenAI main',
        credentialName: 'openAIApi',
        plainDataObj: { openAIApiKey: modelKey }
    })
    const bakery = await api('POST', '/credentials', {
        name: 'Bakery database',
        credentialName: 'PostgresUrl',
        plainDataObj: { postgresUrl }
    })
    const flow = await api('POST', '/chatflows', {
        name: HARNESS,
        flowData: JSON.stringify(harnessFlow(openAi.id, bakery.id)),
        type: 'HARNESS',
        deployed: false,
        isPublic: false
    })
    log(`harness ${HARNESS} saved`)

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
    try {
        await shotPicker(page, flow.id)
        await shotDescribeTrace(page)
    } catch (error) {
        await page.screenshot({ path: path.join(TMP, 'fail.png') }).catch(() => {})
        throw error
    }
    await browser.close()
    const admin2 = new pg.Client(adminConfig())
    await admin2.connect()
    await admin2.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
    await admin2.query(`DROP ROLE IF EXISTS ${READER}`)
    await admin2.end()
    log('picker pictures written')
}

main().catch((error) => {
    console.error(error)
    stopChildren()
    process.exit(1)
})
