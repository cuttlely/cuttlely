// Reshoot the ETL and Usage guide pictures from a local server.
// Made-up bakery and outdoor-catalog data only. No provider key and no outside sign-in.
//
//   pnpm build
//   node scripts/docs-shots/capture-etl-usage.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { freePort, request, waitForPing } from '../smoke-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const SERVER = path.join(ROOT, 'packages', 'server')
const FAKE = path.join(ROOT, 'scripts', 'docs-shots', 'fake-chat.cjs')
const SSO_GUARD = path.join(ROOT, 'scripts', 'refuse-sso-load.cjs')
const SAMPLE = path.join(ROOT, 'samples', 'etl', 'outdoor-catalog.pipeline.json')
const CATALOG = path.join(ROOT, 'samples', 'etl', 'data', 'outdoor-catalog.csv')
const OUT_ETL = path.join(ROOT, 'docs', 'images', 'etl')
const OUT_USAGE = path.join(ROOT, 'docs', 'images', 'usage')
const NOTES = '/tmp/docs-shot-notes.json'
const EMAIL = 'rosa.diaz@example.com'
const PASSWORD = 'DocsShots1!'
const NAME = 'Rosa Diaz'
const PRICE_METADATA = '"metadataColumns": "sku, category, price"'
const PRICE_METADATA_OFF = '"metadataColumns": "sku, category"'

const notes = {}
const ONLY = new Set(process.argv.slice(2).map((name) => name.replace(/\.png$/, '')))

function wanted(file) {
    if (ONLY.size === 0) return true
    return ONLY.has(path.basename(file, '.png'))
}

function wantsAny(names) {
    if (ONLY.size === 0) return true
    return names.some((name) => ONLY.has(name))
}

function sampleOriginal() {
    return fs.readFileSync(SAMPLE, 'utf8')
}

const ORIGINAL_SAMPLE = sampleOriginal()

function restoreSample() {
    if (fs.readFileSync(SAMPLE, 'utf8') !== ORIGINAL_SAMPLE) fs.writeFileSync(SAMPLE, ORIGINAL_SAMPLE)
}

function childEnv(dataDir, port) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE_URL|API_KEY/i.test(key) && key !== 'SECRETKEY_PATH') delete env[key]
    }
    delete env.CUTTLELY_LOCAL_ADMIN
    delete env.WORKOS_API_KEY
    delete env.WORKOS_CLIENT_ID
    env.HOST = '127.0.0.1'
    env.PORT = String(port)
    env.DATABASE_PATH = dataDir
    env.SECRETKEY_PATH = dataDir
    env.CUTTLELY_DATA_DIR = path.join(dataDir, 'cuttlely')
    env.MODEL_LIST_CONFIG_JSON = 'bundled'
    env.CUTTLELY_WARM_HERMES = 'false'
    env.CUTTLELY_HARNESS_QUEUE = 'off'
    env.CUTTLELY_LOCAL_ADMIN = 'true'
    env.DOCS_SHOT_CATALOG = CATALOG
    env.NODE_ENV = 'development'
    delete env.MODE
    return env
}

function startServer(dataDir, port) {
    const logs = []
    const child = spawn(process.execPath, ['-r', SSO_GUARD, '-r', FAKE, path.join(SERVER, 'bin', 'run'), 'start'], {
        cwd: SERVER,
        env: childEnv(dataDir, port),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const keep = (chunk) => {
        logs.push(String(chunk))
        if (logs.length > 80) logs.shift()
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
    return { child, logs, stop }
}

function launchBrowser() {
    const { chromium } = require('playwright')
    const args = ['--no-sandbox', '--disable-dev-shm-usage']
    const attempts = [() => chromium.launch({ channel: 'chrome', args }), () => chromium.launch({ args })]
    return (async () => {
        let last
        for (const attempt of attempts) {
            try {
                return await attempt()
            } catch (error) {
                last = error
            }
        }
        const cli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js')
        const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { cwd: ROOT, stdio: 'inherit' })
        if (install.status !== 0) throw last
        return chromium.launch({ args })
    })()
}

function padPng(file, width, height) {
    const script = `
from PIL import Image
import sys
file, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(file).convert('RGB')
if im.width > w or im.height > h:
    im = im.crop((0, 0, min(im.width, w), min(im.height, h)))
canvas = Image.new('RGB', (w, h), im.getpixel((min(2, im.width - 1), min(2, im.height - 1))))
canvas.paste(im, (0, 0))
canvas.save(file)
`
    const result = spawnSync('python3', ['-c', script, file, String(width), String(height)], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'pad failed')
}

function insideViewport(box, viewport, pad = 1) {
    return (
        box &&
        box.width > 2 &&
        box.height > 2 &&
        box.x >= -pad &&
        box.y >= -pad &&
        box.x + box.width <= viewport.width + pad &&
        box.y + box.height <= viewport.height + pad
    )
}

// The pipeline drawer is position:fixed against a canvas wider than 1440px,
// so a 1440px frame cuts its right edge. Scroll that overflow into view,
// and only then grow the viewport if the element is still outside it.
async function reveal(page, locator) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        await locator.scrollIntoViewIfNeeded().catch(() => {})
        const box = await locator.boundingBox()
        if (!box) throw new Error('nothing to reveal')
        const viewport = page.viewportSize()
        if (insideViewport(box, viewport)) return box
        if (box.x < 0 || box.x + box.width > viewport.width) {
            const delta = box.x < 0 ? Math.floor(box.x) - 8 : Math.ceil(box.x + box.width - viewport.width + 16)
            await page.evaluate((dx) => window.scrollBy(dx, 0), delta)
        }
        const shifted = await locator.boundingBox()
        const view = page.viewportSize()
        if (!insideViewport(shifted, view)) {
            await page.setViewportSize({
                width: Math.max(view.width, Math.ceil((shifted?.x || 0) + (shifted?.width || 0) + 24)),
                height: Math.max(view.height, Math.ceil((shifted?.y || 0) + (shifted?.height || 0) + 24))
            })
        }
        await page.waitForTimeout(200)
    }
    const box = await locator.boundingBox()
    const viewport = page.viewportSize()
    if (!insideViewport(box, viewport)) throw new Error(`clipped at ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`)
    return box
}

async function resetFrame(page) {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})
}

async function revealDrawer(page) {
    const drawer = page.locator('.MuiDrawer-paper').last()
    const close = drawer.getByRole('button', { name: 'Close', exact: true })
    await reveal(page, close)
    const box = await drawer.boundingBox()
    const viewport = page.viewportSize()
    if (!box || box.x < -1 || box.x + box.width > viewport.width + 1) {
        await reveal(page, drawer)
    }
    const fitted = await drawer.boundingBox()
    const view = page.viewportSize()
    if (!fitted || fitted.x < -1 || fitted.x + fitted.width > view.width + 1) {
        throw new Error(`drawer clipped at ${JSON.stringify(fitted)} in ${JSON.stringify(view)}`)
    }
    return drawer
}

async function shot(page, file, { clip, pad, note, fit } = {}) {
    if (!wanted(file)) {
        console.log('skip', path.basename(file))
        return
    }
    if (fit) await reveal(page, fit)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (clip) await page.screenshot({ path: file, clip })
    else await page.screenshot({ path: file })
    if (pad) padPng(file, pad[0], pad[1])
    const text = note == null ? '' : note
    notes[path.relative(ROOT, file)] = text
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2))
    if (/\$\d/.test(text) || /price:\s*\d/.test(text)) {
        throw new Error(`${path.basename(file)} includes a money figure`)
    }
    if (file.endsWith('usage-prices.png') && /\d/.test(text)) {
        throw new Error(`${path.basename(file)} includes a price figure`)
    }
    console.log('shot', path.relative(ROOT, file))
}

async function bodyNote(page, locator) {
    const target = locator || page.locator('body')
    return (await target.innerText()).replace(/\s+\n/g, '\n').slice(0, 4000)
}

async function setLook(page, look) {
    await page.evaluate((value) => {
        localStorage.setItem('isDarkMode', 'false')
        localStorage.setItem('cuttlely.canvasLook', value)
    }, look)
}

async function openCanvas(page, base, route, look) {
    await setLook(page, look)
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    const fit = page.locator('.react-flow__controls-fitview')
    if (await fit.count()) await fit.click()
    await page.waitForTimeout(400)
}

async function openPanel(page, buttonName) {
    await page.getByRole('button', { name: buttonName, exact: true }).click()
    await page.getByRole('heading', { name: 'Pipeline' }).waitFor()
}

async function setAccordion(page, title, open) {
    const summary = page
        .locator('.MuiAccordionSummary-root')
        .filter({ has: page.getByText(title, { exact: true }) })
        .first()
    await summary.waitFor()
    const expanded = await summary.evaluate((el) => {
        const node = el.getAttribute('aria-expanded') != null ? el : el.querySelector('[aria-expanded]')
        return node?.getAttribute('aria-expanded') === 'true'
    })
    if (expanded !== open) await summary.click()
}

async function scrollPanelTo(page, text) {
    const target = page.getByText(text, { exact: false }).last()
    await target.evaluate((el) => {
        let node = el.parentElement
        while (node && node !== document.body) {
            const style = getComputedStyle(node)
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 8) {
                const top = el.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
                node.scrollTop = Math.max(0, top - 8)
                return
            }
            node = node.parentElement
        }
    })
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
    const def = await request(`${base}/api/v1/nodes/${name}`, { cookie })
    if (def.status !== 200) throw new Error(`node ${name} ${def.status}`)
    const spec = JSON.parse(def.text)
    const inputParams = []
    const inputAnchors = []
    const defaults = {}
    for (const input of spec.inputs || []) {
        const entry = { ...input, id: `${id}-input-${input.name}-${input.type}` }
        if (PARAM_TYPES.has(input.type)) inputParams.push(entry)
        else inputAnchors.push(entry)
        defaults[input.name] = input.default ?? ''
    }
    let outputAnchors
    let outputs = {}
    if (spec.outputs?.length) {
        const options = spec.outputs.map((output) => ({
            id: `${id}-output-${output.name}-${(output.baseClasses || []).join('|')}`,
            name: output.name,
            label: output.label,
            type: (output.baseClasses || []).join(' | ')
        }))
        outputAnchors = [{ name: 'output', label: 'Output', type: 'options', options, default: spec.outputs[0].name }]
        outputs = { output: spec.outputs[0].name }
    } else {
        outputAnchors = [
            {
                id: `${id}-output-${spec.name}-${(spec.baseClasses || []).join('|')}`,
                name: spec.name,
                label: spec.type,
                type: (spec.baseClasses || []).join(' | ')
            }
        ]
    }
    return {
        id,
        position,
        type: 'customNode',
        data: {
            id,
            label: label || spec.label,
            version: spec.version,
            name: spec.name,
            type: spec.type,
            baseClasses: spec.baseClasses,
            category: spec.category,
            description: spec.description,
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
        source: source.id,
        sourceHandle,
        target: target.id,
        targetHandle,
        type: 'buttonedge',
        id: `${source.id}-${target.id}-${inputName}`
    }
}

async function createFlow(base, cookie, body) {
    const created = await request(`${base}/api/v1/chatflows`, { method: 'POST', cookie, body })
    if (created.status !== 200 && created.status !== 201) throw new Error(`create flow ${created.status}: ${created.text.slice(0, 300)}`)
    return JSON.parse(created.text)
}

async function importOutdoor(base, cookie) {
    const stripped = ORIGINAL_SAMPLE.replace(PRICE_METADATA, PRICE_METADATA_OFF)
    if (stripped === ORIGINAL_SAMPLE) throw new Error('sample metadata marker missing')
    fs.writeFileSync(SAMPLE, stripped)
    try {
        const imported = await request(`${base}/api/v1/etl/samples/outdoor-catalog/import`, { method: 'POST', cookie, body: {} })
        if (imported.status !== 200 && imported.status !== 201) {
            throw new Error(`import ${imported.status}: ${imported.text.slice(0, 300)}`)
        }
        return JSON.parse(imported.text)
    } finally {
        restoreSample()
    }
}

async function startRun(base, cookie, id, mode = 'incremental') {
    const started = await request(`${base}/api/v1/etl/pipelines/${id}/runs`, {
        method: 'POST',
        cookie,
        body: { mode },
        timeoutMs: 20000
    })
    if (started.status !== 200 && started.status !== 201) throw new Error(`run ${started.status}: ${started.text.slice(0, 300)}`)
    const run = JSON.parse(started.text)
    const runId = run.id
    const deadline = Date.now() + 90000
    let last = run
    while (Date.now() < deadline) {
        const current = await request(`${base}/api/v1/etl/runs/${runId}`, { cookie })
        if (current.status !== 200) throw new Error(`run status ${current.status}`)
        last = JSON.parse(current.text)
        if (!['queued', 'running', 'pausing'].includes(last.status)) return last
        await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`run ${runId} stayed ${last.status}`)
}

function seedUsage(dataDir) {
    const db = new DatabaseSync(path.join(dataDir, 'database.sqlite'))
    try {
        const workspace = db.prepare('SELECT id FROM workspace LIMIT 1').get()
        if (!workspace?.id) throw new Error('no workspace')
        const day = (offset) => {
            const date = new Date()
            date.setUTCDate(date.getUTCDate() + offset)
            return date.toISOString().slice(0, 10)
        }
        const insert = db.prepare(
            'INSERT INTO token_usage_day (id, workspaceId, flowId, model, day, inputTokens, outputTokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        const rows = [
            ['flow-bakery', day(-2), 105, 35],
            ['flow-bakery', day(-1), 105, 35],
            ['flow-orders', day(-1), 11, 4]
        ]
        for (const [flowId, when, inputTokens, outputTokens] of rows) {
            insert.run(crypto.randomUUID(), workspace.id, flowId, 'bakery-counter', when, inputTokens, outputTokens)
        }
    } finally {
        db.close()
    }
}

async function signIn(page, base) {
    await page.goto(`${base}/signin`, { waitUntil: 'domcontentloaded' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(EMAIL)
    await form.locator('input[type=password]').fill(PASSWORD)
    await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin') && !url.pathname.startsWith('/organization'), { timeout: 30000 })
}

async function main() {
    if (!fs.existsSync(path.join(SERVER, 'dist', 'commands'))) throw new Error('packages/server/dist is missing. Run pnpm build first.')
    restoreSample()
    const dataDir = path.join(os.tmpdir(), 'cuttlely-docs-shots')
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir)
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const { child, logs, stop } = startServer(dataDir, port)
    const browser = await launchBrowser()
    const page = await (
        await browser.newContext({
            viewport: { width: 1440, height: 960 },
            deviceScaleFactor: 1,
            colorScheme: 'light',
            locale: 'en-US',
            timezoneId: 'UTC'
        })
    ).newPage()
    await page.addInitScript(() => {
        localStorage.setItem('isDarkMode', 'false')
    })
    let failed = null
    try {
        console.log(`docs server ${base}`)
        await waitForPing(base, child, logs)
        const registered = await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: NAME, email: EMAIL, credential: PASSWORD } }
        })
        if (registered.status !== 200) throw new Error(`register ${registered.status}`)
        const loggedIn = await request(`${base}/api/v1/auth/login`, {
            method: 'POST',
            body: { email: EMAIL, password: PASSWORD }
        })
        if (loggedIn.status !== 200 || !loggedIn.cookie) throw new Error(`login ${loggedIn.status}`)
        const cookie = loggedIn.cookie
        const credential = await request(`${base}/api/v1/credentials`, {
            method: 'POST',
            cookie,
            body: { name: 'OpenAI main', credentialName: 'openAIApi', plainDataObj: { openAIApiKey: 'docs-shots-placeholder' } }
        })
        if (credential.status !== 200) throw new Error(`credential ${credential.status}`)
        const credentialId = JSON.parse(credential.text).id

        await signIn(page, base)

        await page.goto(`${base}/etl`, { waitUntil: 'domcontentloaded' })
        await page.getByText('No pipelines yet').waitFor()
        await shot(page, path.join(OUT_ETL, 'etl-empty.png'), { note: await bodyNote(page) })
        await page.getByRole('button', { name: 'Import Sample' }).first().click()
        const sampleMenu = page.getByRole('menu')
        await sampleMenu.waitFor()
        const sampleNames = ['Bakery Handbook', 'Cuttlely Handbook', 'Outdoor Catalog']
        for (const name of sampleNames) {
            const heading = sampleMenu.getByRole('heading', { name, exact: true })
            await heading.waitFor()
            await reveal(page, heading)
            if (!insideViewport(await heading.boundingBox(), page.viewportSize())) {
                throw new Error(`${name} is outside the Import Sample frame`)
            }
        }
        await page.waitForTimeout(300)
        const menuNote = await bodyNote(page, sampleMenu)
        if (!/Bakery Handbook/.test(menuNote) || !/Cuttlely Handbook/.test(menuNote) || !/Outdoor Catalog/.test(menuNote)) {
            throw new Error('Import Sample menu is missing a sample')
        }
        await shot(page, path.join(OUT_ETL, 'etl-import-sample.png'), { note: menuNote })
        await page.keyboard.press('Escape')
        await resetFrame(page)

        const outdoor = await importOutdoor(base, cookie)
        await openCanvas(page, base, `/etlcanvas/${outdoor.id}`, 'classic')
        await shot(page, path.join(OUT_ETL, 'etl-canvas-sample.png'), { note: await bodyNote(page) })

        await openPanel(page, 'Preview')
        await page.getByText(/documents from/).waitFor({ timeout: 30000 })
        await page.setViewportSize({ width: 1680, height: 1200 })
        const previewDrawer = await revealDrawer(page)
        const rootChip = previewDrawer.getByText(/^root\b/).first()
        await reveal(page, rootChip)
        if (!insideViewport(await rootChip.boundingBox(), page.viewportSize())) {
            throw new Error('preview root chip is outside the frame')
        }
        await shot(page, path.join(OUT_ETL, 'etl-preview.png'), { note: await bodyNote(page, previewDrawer) })
        await resetFrame(page)
        await setAccordion(page, 'Load', false)
        await setAccordion(page, 'Clean & transform', false)
        await setAccordion(page, 'Split', true)
        await page.getByText('new', { exact: true }).first().waitFor()
        await scrollPanelTo(page, 'Clean & transform')
        await shot(page, path.join(OUT_ETL, 'etl-preview-steps.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })

        await openPanel(page, 'Run')
        await page.getByRole('button', { name: 'Start run' }).waitFor()
        await shot(page, path.join(OUT_ETL, 'etl-run-new.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })

        const first = await startRun(base, cookie, outdoor.id)
        if (first.status !== 'succeeded') throw new Error(`first run ${first.status} ${first.error || ''}`)
        await openCanvas(page, base, `/etlcanvas/${outdoor.id}`, 'classic')
        await openPanel(page, 'Run')
        await page.getByText('succeeded').first().waitFor()
        await setAccordion(page, 'New run', false)
        await page.setViewportSize({ width: 1680, height: 1100 })
        let drawer = await revealDrawer(page)
        const runTitle = page.getByRole('heading', { name: /^Run / })
        await scrollPanelTo(page, await runTitle.innerText())
        await reveal(page, runTitle)
        await reveal(page, page.getByText('100.0%', { exact: true }))
        await reveal(page, drawer.getByText('Deleted', { exact: true }))
        await shot(page, path.join(OUT_ETL, 'etl-run-done.png'), { note: await bodyNote(page, drawer) })
        await resetFrame(page)

        await page.setViewportSize({ width: 1680, height: 1400 })
        drawer = await revealDrawer(page)
        await scrollPanelTo(page, await runTitle.innerText())
        await reveal(page, runTitle)
        await reveal(page, page.getByText('Delete removed'))
        await shot(page, path.join(OUT_ETL, 'etl-run-steps.png'), { note: await bodyNote(page, drawer) })
        await resetFrame(page)

        const second = await startRun(base, cookie, outdoor.id)
        if (second.status !== 'succeeded') throw new Error(`second run ${second.status}`)
        await openCanvas(page, base, `/etlcanvas/${outdoor.id}`, 'classic')
        await openPanel(page, 'Run')
        await page.getByText(/sources skipped/).waitFor()
        await setAccordion(page, 'New run', false)
        await page.setViewportSize({ width: 1680, height: 1100 })
        drawer = await revealDrawer(page)
        const secondTitle = page.getByRole('heading', { name: /^Run / })
        await scrollPanelTo(page, await secondTitle.innerText())
        await reveal(page, secondTitle)
        await reveal(page, page.getByText(/sources skipped/))
        await reveal(page, drawer.getByText('Deleted', { exact: true }))
        await shot(page, path.join(OUT_ETL, 'etl-run-incremental.png'), { note: await bodyNote(page, drawer) })
        await resetFrame(page)
        const ask = page.getByPlaceholder('Ask something the data should answer')
        await ask.scrollIntoViewIfNeeded()
        await ask.fill('tent for alpine starts')
        await page.getByRole('button', { name: 'Search', exact: true }).click()
        await page
            .getByText(/^score /)
            .first()
            .waitFor()
        await scrollPanelTo(page, 'Try retrieval')
        await shot(page, path.join(OUT_ETL, 'etl-try-retrieval.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })

        await openPanel(page, 'Schedule')
        await page.getByLabel('Every').fill('6')
        await page.getByLabel('Unit').click()
        await page.getByRole('option', { name: 'hours', exact: true }).click()
        const backdrop = page.locator('.MuiBackdrop-root')
        if (await backdrop.count())
            await backdrop
                .last()
                .click({ force: true })
                .catch(() => {})
        await page.keyboard.press('Escape')
        const menu = page.locator('.MuiMenu-root, .MuiPopover-root')
        if (await menu.count()) {
            await menu
                .first()
                .waitFor({ state: 'hidden', timeout: 3000 })
                .catch(async () => {
                    await page.keyboard.press('Escape')
                })
        }
        await page.getByText('No schedule yet').waitFor()
        await shot(page, path.join(OUT_ETL, 'etl-schedule-form.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })
        await page.getByRole('button', { name: 'Add schedule' }).click()
        await page.getByText(/Every 6 hours/).waitFor()
        await shot(page, path.join(OUT_ETL, 'etl-schedule.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })

        await openPanel(page, 'Preview')
        const uploadCsv = path.join(dataDir, 'crumb-co-bakes.csv')
        fs.writeFileSync(uploadCsv, 'sku,name\nBUN-1,Morning bun\n')
        await page.locator('input[type=file]').setInputFiles(uploadCsv)
        await page.getByText('crumb-co-bakes.csv', { exact: true }).waitFor({ timeout: 20000 })
        await page.getByText('Upload a file to the server').scrollIntoViewIfNeeded()
        await shot(page, path.join(OUT_ETL, 'etl-upload.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })

        await page.goto(`${base}/etl`, { waitUntil: 'domcontentloaded' })
        await page.getByText('Upcoming runs').waitFor()
        await page.getByText('Outdoor Catalog').first().waitFor()
        await shot(page, path.join(OUT_ETL, 'etl-list.png'), { note: await bodyNote(page) })

        if (wantsAny(['usage-page', 'usage-prices'])) {
            seedUsage(dataDir)
            await page.setViewportSize({ width: 2400, height: 1800 })
            await page.goto(`${base}/usage`, { waitUntil: 'domcontentloaded' })
            const usageTitle = page.locator('h1').filter({ hasText: /^Usage$/ })
            await usageTitle.waitFor()
            await page.getByRole('table', { name: 'Usage by flow' }).waitFor()
            await page.getByText('No price for bakery-counter').waitFor()
            const usageHeading = await usageTitle.boundingBox()
            const usageTable = await page.getByRole('table', { name: 'Usage by flow' }).boundingBox()
            const usageNote = [
                await usageTitle.innerText(),
                await page.getByText(/UTC\./).first().innerText(),
                await page.getByText(/No price for/).innerText(),
                await page.getByRole('table', { name: 'Usage by flow' }).innerText()
            ].join('\n')
            await shot(page, path.join(OUT_USAGE, 'usage-page.png'), {
                clip: {
                    x: Math.max(0, Math.floor(usageHeading.x - 28)),
                    y: Math.max(0, Math.floor(usageHeading.y - 20)),
                    width: 2080,
                    height: Math.ceil(usageTable.y + usageTable.height - usageHeading.y + 48)
                },
                pad: [2080, 1506],
                note: usageNote
            })
            const find = page.getByLabel('Find a model')
            await find.scrollIntoViewIfNeeded()
            await find.fill('bakery-counter')
            await page.getByRole('cell', { name: 'bakery-counter', exact: true }).waitFor()
            const prices = await page.locator('#model-prices').boundingBox()
            await shot(page, path.join(OUT_USAGE, 'usage-prices.png'), {
                clip: {
                    x: Math.max(0, Math.floor(prices.x - 8)),
                    y: Math.max(0, Math.floor(prices.y - 8)),
                    width: 1904,
                    height: Math.ceil(prices.height + 16)
                },
                pad: [1904, 520],
                note: await bodyNote(page, page.locator('#model-prices'))
            })
            await page.setViewportSize({ width: 1440, height: 960 })
        }

        if (wantsAny(['etl-retriever-pick', 'harness-etl-canvas', 'harness-etl-chat'])) {
            await buildHarness(page, base, cookie, credentialId)
        }
        await versionStory(page, base, cookie, outdoor.id, { first, second })
        if (wantsAny(['build-with-ai-dialog', 'build-with-ai-built', 'build-with-ai-search'])) {
            await buildWithAi(page, base, cookie)
        }
        if (wantsAny(['publish-check-cost'])) {
            await publishCheck(page, base, cookie, credentialId)
        }
        contactSheet()
        console.log('capture done')
    } catch (error) {
        failed = error
        await page.screenshot({ path: '/tmp/docs-shot-fail.png' }).catch(() => {})
        console.error(error instanceof Error ? error.stack || error.message : error)
    } finally {
        restoreSample()
        await browser.close().catch(() => {})
        stop()
    }
    if (failed) process.exit(1)
}

async function buildHarness(page, base, cookie, credentialId) {
    const retriever = await buildNode(base, cookie, 'etlRetriever', 'etlRetriever_0', { position: { x: 40, y: 120 } })
    retriever.data.inputs.pipeline = 'Outdoor Catalog'
    retriever.data.inputs.topK = 4
    const specialist = await buildNode(base, cookie, 'harnessSpecialist', 'harnessSpecialist_0', { position: { x: 460, y: 40 } })
    specialist.data.inputs.specialistName = 'catalog'
    specialist.data.inputs.instructions =
        'Answer product questions from the Outdoor Catalog. Search it with the ETL Retriever tool, and quote names, weights, and prices as written.'
    const model = await buildNode(base, cookie, 'chatOpenAI', 'chatOpenAI_0', { position: { x: 900, y: 40 } })
    model.data.credential = credentialId
    model.data.inputs.modelName = 'gpt-4o-mini'
    model.data.inputs.temperature = 0.2
    model.data.inputs.FLOWISE_CREDENTIAL_ID = credentialId
    const prime = await buildNode(base, cookie, 'harnessChief', 'harnessChief_0', { position: { x: 1320, y: 80 } })
    prime.data.inputs.instructions = 'Product questions go to the catalog specialist. Do not invent products.'
    const harness = await createFlow(base, cookie, {
        name: 'gear-desk',
        type: 'HARNESS',
        deployed: false,
        isPublic: false,
        flowData: JSON.stringify({
            nodes: [retriever, specialist, model, prime],
            edges: [
                connectNodes(retriever, specialist, 'attached'),
                connectNodes(specialist, prime, 'specialists'),
                connectNodes(model, prime, 'chatModel')
            ],
            viewport: { x: 0, y: 0, zoom: 0.85 }
        })
    })
    await openCanvas(page, base, `/harnesscanvas/${harness.id}`, 'classic')
    const card = page.locator('.react-flow__node', { hasText: 'ETL Retriever' })
    await card.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /Outdoor Catalog/ }).waitFor()
    await shot(page, path.join(OUT_ETL, 'etl-retriever-pick.png'), { note: await bodyNote(page) })
    await page.keyboard.press('Escape')
    await page.locator('.react-flow__controls-fitview').click()
    await page.waitForTimeout(300)
    await shot(page, path.join(OUT_ETL, 'harness-etl-canvas.png'), { note: await bodyNote(page) })
    await page.locator('button[aria-label="chat"]').click()
    const input = page.locator('#userInput')
    await input.waitFor()
    await input.fill('Which shelter is built for alpine starts, and what does it weigh and cost?')
    await input.press('Enter')
    await page.getByText('Direct to catalog').first().waitFor({ timeout: 90000 })
    await page.waitForFunction(
        () => {
            const input = document.querySelector('#userInput')
            return input && input.getAttribute('placeholder') !== 'Waiting for response...'
        },
        null,
        { timeout: 90000 }
    )
    await page.locator('.cloud').evaluate((el) => {
        el.scrollTop = 0
    })
    await page.waitForTimeout(300)
    await shot(page, path.join(OUT_ETL, 'harness-etl-chat.png'), { note: await bodyNote(page) })
}

async function versionStory(page, base, cookie, id, earlier) {
    const current = await request(`${base}/api/v1/chatflows/${id}`, { cookie })
    if (current.status !== 200) throw new Error(`get flow ${current.status}`)
    const flow = JSON.parse(current.text)
    const missing = flow.flowData.replaceAll('outdoor-catalog.csv', 'products-2026.csv')
    const draft = await request(`${base}/api/v1/flow-drafts/${id}`, { method: 'PUT', cookie, body: { flowData: missing } })
    if (draft.status !== 200) throw new Error(`draft ${draft.status}: ${draft.text.slice(0, 300)}`)
    await openCanvas(page, base, `/etlcanvas/${id}`, 'classic')
    await openPanel(page, 'Preview')
    await page.getByText(/was not found on the server/).waitFor({ timeout: 30000 })
    await page.setViewportSize({ width: 1680, height: 1200 })
    const missingDrawer = await revealDrawer(page)
    const missingFile = page.getByRole('alert').filter({ hasText: 'products-2026.csv' })
    await reveal(page, missingFile)
    if (!insideViewport(await missingFile.boundingBox(), page.viewportSize())) {
        throw new Error('missing-file alert is outside the frame')
    }
    await shot(page, path.join(OUT_ETL, 'etl-preview-missing-file.png'), {
        note: await bodyNote(page, missingDrawer)
    })
    await resetFrame(page)
    const published = await request(`${base}/api/v1/flow-drafts/${id}/publish`, { method: 'POST', cookie, body: {} })
    if (published.status !== 200) throw new Error(`publish missing ${published.status}: ${published.text.slice(0, 300)}`)
    const failed = await startRun(base, cookie, id)
    if (failed.status !== 'failed') throw new Error(`expected failed run, got ${failed.status}`)
    await openCanvas(page, base, `/etlcanvas/${id}`, 'classic')
    await openPanel(page, 'Run')
    await page.getByText('failed').first().waitFor()
    await setAccordion(page, 'New run', false)
    await page.setViewportSize({ width: 1680, height: 1400 })
    const failedDrawer = await revealDrawer(page)
    const failedTitle = page.getByRole('heading', { name: /^Run / })
    await scrollPanelTo(page, await failedTitle.innerText())
    await reveal(page, failedTitle)
    await reveal(page, page.getByRole('alert').filter({ hasText: 'products-2026.csv' }))
    if (!insideViewport(await failedTitle.boundingBox(), page.viewportSize())) {
        throw new Error('failed run title is outside the frame')
    }
    await shot(page, path.join(OUT_ETL, 'etl-run-failed.png'), { note: await bodyNote(page, failedDrawer) })
    await resetFrame(page)
    await page.getByRole('tab', { name: 'Versions' }).click()
    await page.getByText('Version 2').waitFor()
    await shot(page, path.join(OUT_ETL, 'etl-versions.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })
    await page.getByRole('button', { name: 'Restore' }).click()
    await page.locator('strong', { hasText: '*' }).waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByText('outdoor-catalog.csv').first().waitFor()
    await page.locator('.react-flow__controls-fitview').click()
    await page.waitForTimeout(300)
    await shot(page, path.join(OUT_ETL, 'etl-version-restored.png'), { note: await bodyNote(page) })
    await page.locator('[title="Save Pipeline"]').click()
    await page.locator('strong', { hasText: '*' }).waitFor({ state: 'hidden', timeout: 20000 })
    const republished = await request(`${base}/api/v1/flow-drafts/${id}/publish`, { method: 'POST', cookie, body: {} })
    if (republished.status !== 200) throw new Error(`republish ${republished.status}: ${republished.text.slice(0, 300)}`)
    const third = await startRun(base, cookie, id)
    if (third.status !== 'succeeded') throw new Error(`restored run ${third.status} ${third.error || ''}`)
    await openCanvas(page, base, `/etlcanvas/${id}`, 'classic')
    await openPanel(page, 'Run')
    await page.getByRole('tab', { name: 'Versions' }).click()
    await page.getByText('Version 3').waitFor()
    await shot(page, path.join(OUT_ETL, 'etl-versions-after.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })
    await page.getByRole('tab', { name: 'History' }).click()
    await page.getByText('failed').waitFor()
    await page.setViewportSize({ width: 1680, height: 1200 })
    const historyDrawer = await revealDrawer(page)
    const sameSession = [third.id, failed.id, earlier.second.id, earlier.first.id].map((runId) => runId.slice(0, 8))
    let historyText = await historyDrawer.innerText()
    for (const runId of sameSession) {
        if (!historyText.includes(runId)) throw new Error(`history is missing run ${runId} from this session`)
    }
    await scrollPanelTo(page, sameSession[0])
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const hidden = []
        for (const runId of sameSession) {
            const row = historyDrawer.getByText(new RegExp(runId)).first()
            if (!insideViewport(await row.boundingBox(), page.viewportSize())) hidden.push(runId)
        }
        if (hidden.length === 0) break
        const viewport = page.viewportSize()
        await page.setViewportSize({ width: viewport.width, height: viewport.height + 280 })
        await scrollPanelTo(page, sameSession[0])
        await revealDrawer(page)
        if (attempt === 2) throw new Error(`history rows outside the frame: ${hidden.join(', ')}`)
    }
    historyText = await historyDrawer.innerText()
    fs.writeFileSync('/tmp/docs-shot-run-ids.json', JSON.stringify({ sameSession, failed: failed.id, third: third.id }, null, 2))
    console.log('history runs', sameSession.join(' '))
    await shot(page, path.join(OUT_ETL, 'etl-history.png'), { note: historyText })
    await resetFrame(page)
}

async function buildWithAi(page, base) {
    await setLook(page, 'panel')
    await page.goto(`${base}/etlcanvas`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Build with AI' }).waitFor()
    await page.getByRole('button', { name: 'Build with AI' }).click()
    await page.getByRole('dialog').waitFor()
    const description = `The outdoor product catalog CSV at ${CATALOG}. Each row is one product: sku is the id, name, category and description are the text, price is metadata. People search products by what they do.`
    await page.getByLabel('Describe your data').fill(description)
    const dialog = page.getByRole('dialog')
    await page.waitForFunction(
        () => {
            const root = document.querySelector('[role="dialog"]')
            if (!root) return false
            const values = [...root.querySelectorAll('input, textarea')].map((el) => el.value || '').join('\n')
            const text = `${root.innerText}\n${values}`
            return text.includes('OpenAI') && text.includes('gpt-4.1-mini')
        },
        null,
        { timeout: 90000 }
    )
    await shot(page, path.join(OUT_ETL, 'build-with-ai-dialog.png'), { note: await bodyNote(page, dialog) })
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/\/etlcanvas\//, { timeout: 60000 })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    await page.locator('.react-flow__controls-fitview').click()
    await page.waitForTimeout(400)
    await shot(page, path.join(OUT_ETL, 'build-with-ai-built.png'), { note: await bodyNote(page) })
    const id = page.url().split('/').pop()
    const cookie = await apiCookie(page)
    const run = await startRun(base, cookie, id)
    if (run.status !== 'succeeded') throw new Error(`built run ${run.status} ${run.error || ''}`)
    await openCanvas(page, base, `/etlcanvas/${id}`, 'panel')
    await openPanel(page, 'Run')
    await page.getByText('succeeded').first().waitFor()
    const starter = page.getByText('What are the best products for hiking?', { exact: true })
    await starter.scrollIntoViewIfNeeded()
    await starter.click()
    await page
        .getByText(/^score /)
        .first()
        .waitFor({ timeout: 20000 })
    await page
        .getByText(/^score /)
        .first()
        .evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await shot(page, path.join(OUT_ETL, 'build-with-ai-search.png'), { note: await bodyNote(page, page.locator('.MuiDrawer-paper')) })
}

async function apiCookie(page) {
    const cookies = await page.context().cookies()
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

async function publishCheck(page, base, cookie, credentialId) {
    const liveTemplate = 'Bakery hours: we open at 8 AM on Saturdays. Gluten-free bread is baked fresh on Tuesdays only.\n{question}'
    const draftTemplate = 'Bakery hours: we open at 7 AM on Saturdays. We bake gluten-free bread fresh every day.\n{question}'
    const prompt = await buildNode(base, cookie, 'promptTemplate', 'promptTemplate_0', { position: { x: 40, y: 80 } })
    prompt.data.inputs.template = liveTemplate
    prompt.data.inputs.promptValues = '{"question":"{{question}}"}'
    const model = await buildNode(base, cookie, 'chatOpenAI', 'chatOpenAI_0', { position: { x: 40, y: 360 } })
    model.data.credential = credentialId
    model.data.inputs.modelName = 'claude'
    model.data.inputs.temperature = 0
    model.data.inputs.streaming = false
    model.data.inputs.FLOWISE_CREDENTIAL_ID = credentialId
    const chain = await buildNode(base, cookie, 'llmChain', 'llmChain_0', { position: { x: 480, y: 160 } })
    chain.data.inputs.model = '{{chatOpenAI_0.data.instance}}'
    chain.data.inputs.prompt = '{{promptTemplate_0.data.instance}}'
    const flow = await createFlow(base, cookie, {
        name: 'Bakery helper',
        type: 'CHATFLOW',
        deployed: false,
        isPublic: false,
        flowData: JSON.stringify({
            nodes: [prompt, model, chain],
            edges: [connectNodes(prompt, chain, 'prompt'), connectNodes(model, chain, 'model')],
            viewport: { x: 0, y: 0, zoom: 1 }
        })
    })
    for (const question of ['What time do you open on Saturday?', 'Is the gluten-free bread baked fresh?']) {
        const answer = await request(`${base}/api/v1/prediction/${flow.id}`, {
            method: 'POST',
            cookie,
            timeoutMs: 60000,
            body: { question, streaming: false }
        })
        if (answer.status !== 200) throw new Error(`prediction ${answer.status}: ${answer.text.slice(0, 300)}`)
    }
    const saved = JSON.parse((await request(`${base}/api/v1/chatflows/${flow.id}`, { cookie })).text)
    const data = JSON.parse(saved.flowData)
    const promptNode = data.nodes.find((node) => node.id === 'promptTemplate_0')
    promptNode.data.inputs.template = draftTemplate
    const drafted = await request(`${base}/api/v1/flow-drafts/${flow.id}`, {
        method: 'PUT',
        cookie,
        body: { flowData: JSON.stringify(data) }
    })
    if (drafted.status !== 200) throw new Error(`bakery draft ${drafted.status}: ${drafted.text.slice(0, 300)}`)
    await page.setViewportSize({ width: 1760, height: 1100 })
    await openCanvas(page, base, `/canvas/${flow.id}`, 'classic')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByTestId('check-run').click()
    await page
        .getByTestId('check-results')
        .getByText(/answered/)
        .waitFor({ timeout: 120000 })
    await page.getByTestId('check-results').getByText('Changed').first().waitFor({ timeout: 120000 })
    const box = await page.getByTestId('check-results').boundingBox()
    const note = await bodyNote(page, page.getByTestId('check-results'))
    await shot(page, path.join(OUT_USAGE, 'publish-check-cost.png'), {
        clip: {
            x: Math.max(0, Math.floor(box.x - 12)),
            y: Math.max(0, Math.floor(box.y - 12)),
            width: Math.min(1760, Math.ceil(box.width + 24)),
            height: Math.min(806, Math.ceil(box.height + 24))
        },
        pad: [1760, 806],
        note
    })
}

function contactSheet() {
    const files = [
        ...fs
            .readdirSync(OUT_ETL)
            .filter((name) => name.endsWith('.png'))
            .map((name) => path.join(OUT_ETL, name)),
        ...fs
            .readdirSync(OUT_USAGE)
            .filter((name) => name.endsWith('.png'))
            .map((name) => path.join(OUT_USAGE, name))
    ].sort()
    const script = `
from PIL import Image, ImageDraw
import os, sys
files = sys.argv[1:]
thumbs = []
for file in files:
    im = Image.open(file).convert('RGB')
    im.thumbnail((280, 180))
    card = Image.new('RGB', (300, 210), (247, 247, 244))
    card.paste(im, ((300 - im.width) // 2, 8))
    draw = ImageDraw.Draw(card)
    draw.text((8, 190), os.path.basename(file), fill=(38, 37, 30))
    thumbs.append(card)
cols = 4
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 300, rows * 210), (247, 247, 244))
for i, card in enumerate(thumbs):
    sheet.paste(card, ((i % cols) * 300, (i // cols) * 210))
os.makedirs('/opt/cursor/artifacts', exist_ok=True)
sheet.save('/opt/cursor/artifacts/etl-usage-contact-sheet.png')
print(sheet.size)
`
    const result = spawnSync('python3', ['-c', script, ...files], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'contact sheet failed')
    console.log('contact', result.stdout.trim())
}

main()
