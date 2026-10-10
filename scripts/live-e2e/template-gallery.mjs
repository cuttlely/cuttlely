// Screenshot gallery of every bundled canvas: each Templates page file and each sample opens in the template preview, one
// screenshot apiece, plus an index page. Also reports what the browser drew: cards and connections on screen against the
// file, and cards that cover each other. The structural half runs in verify (packages/server templateCheck.test.ts); this
// command needs a browser and a running Cuttlely, so it never runs there.
//
// Needs a running Cuttlely (E2E_BASE_URL), a local admin login file (E2E_ADMIN_FILE) and a Playwright with a browser
// (E2E_PLAYWRIGHT when the repo's copy has none). GALLERY_DIR names the output directory; it must be outside the repo.
// GALLERY_ONLY takes a comma list of words to match file names. GALLERY_LOOK picks the card look the preview uses:
// classic or panel (the new look, compact cards); unset keeps whatever the browser has. Prints short lines, never the login.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, api, log } from './lib.mjs'
import { e2e } from './paths.mjs'
import { canvasSettled, previewProblems } from './gallery-wait.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ADMIN_FILE = process.env.E2E_ADMIN_FILE || e2e('admin.json')
const OUT = path.resolve(process.env.GALLERY_DIR || e2e('template-gallery'))
const LOOK = process.env.GALLERY_LOOK || ''
if (LOOK && !['classic', 'panel'].includes(LOOK)) {
    console.error('GALLERY_LOOK must be classic or panel.')
    process.exit(2)
}
const ONLY = (process.env.GALLERY_ONLY || '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)

const inside = (child, parent) => {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
// Resolve links on the nearest part of the path that exists, so a link into the repo is caught too.
const real = (target) => {
    let dir = target
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
    return path.join(fs.realpathSync.native(dir), path.relative(dir, target))
}
if (inside(OUT, REPO) || inside(real(OUT), real(REPO))) {
    console.error(`GALLERY_DIR must be outside the repo (${REPO}).`)
    process.exit(2)
}

// The same files the template open check reads, in the same order.
const SOURCES = [
    { kind: 'chatflow', dir: 'packages/server/marketplaces/chatflows', suffix: '.json' },
    { kind: 'agentflow', dir: 'packages/server/marketplaces/agentflows', suffix: '.json' },
    { kind: 'workflow', dir: 'packages/server/marketplaces/agentflowsv2', suffix: '.json' },
    { kind: 'chatflow', dir: 'samples/chatflows', suffix: '.chatflow.json' },
    { kind: 'harness', dir: 'samples/harnesses', suffix: '.canvas.json' },
    { kind: 'pipeline', dir: 'samples/etl', suffix: '.pipeline.json' }
]
const TYPE_OF = { chatflow: 'Chatflow', agentflow: 'Agentflow', workflow: 'AgentflowV2', harness: 'Harness', pipeline: 'ETL' }

function bundled() {
    const list = []
    for (const source of SOURCES) {
        const dir = path.join(REPO, source.dir)
        if (!fs.existsSync(dir)) continue
        for (const file of fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(source.suffix))
            .sort()) {
            const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            const raw = record.flowData === undefined ? record : record.flowData
            const flowData = typeof raw === 'string' ? raw : JSON.stringify(raw)
            const isSample = source.dir.startsWith('samples/')
            list.push({
                kind: source.kind,
                file: `${source.dir}/${file}`,
                // The Templates page names a marketplace file by its file name and a sample by its name field.
                name: isSample ? String(record.name || file) : file.slice(0, -'.json'.length),
                flowData
            })
        }
    }
    return list
}

async function signIn(page) {
    const login = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'))
    await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(login.email)
    await form.locator('input[type=password]').fill(login.password)
    await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
}

// Opens the preview the way a Templates page click does: an in-app navigation that carries the template.
// Back to the Templates page, and wait until the previous preview is gone, so its cards can't be read as the next one's.
async function leavePreview(page) {
    if (!(await page.locator('.react-flow__node').count())) return
    await page.evaluate(() => {
        const entry = { usr: null, key: `gallery-back-${Date.now()}`, idx: (window.history.state?.idx || 0) + 1 }
        window.history.pushState(entry, '', '/marketplaces')
        window.dispatchEvent(new PopStateEvent('popstate', { state: entry }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 0, null, { timeout: 15000 })
}

// Wait until the screen shows exactly this canvas's cards and holds still. Gives up after the timeout and lets the
// counts report what is missing.
async function waitForCanvas(page, flow, timeout = 20000) {
    const expectedIds = (flow.nodes || []).map((node) => String(node.id))
    const looks = []
    const until = Date.now() + timeout
    while (Date.now() < until) {
        looks.push(
            await page.evaluate(() => {
                const nodes = [...document.querySelectorAll('.react-flow__node')]
                const size = nodes.reduce((sum, el) => {
                    const r = el.getBoundingClientRect()
                    return sum + Math.round(r.width) + Math.round(r.height)
                }, 0)
                return {
                    ids: nodes.map((el) => el.getAttribute('data-id')),
                    connections: document.querySelectorAll('.react-flow__edge').length,
                    size
                }
            })
        )
        if (canvasSettled(looks, expectedIds)) return true
        await page.waitForTimeout(250)
    }
    return false
}

async function openPreview(page, item, index) {
    const route = item.kind === 'workflow' ? `/v2/marketplace/gallery-${index}` : `/marketplace/gallery-${index}`
    const state = { id: `gallery-${index}`, name: item.name, templateName: item.name, type: TYPE_OF[item.kind], flowData: item.flowData }
    await page.evaluate(
        ({ route, state, index }) => {
            const entry = { usr: state, key: `gallery${index}`, idx: (window.history.state?.idx || 0) + 1 }
            window.history.pushState(entry, '', route)
            window.dispatchEvent(new PopStateEvent('popstate', { state: entry }))
        },
        { route, state, index }
    )
}

// What the browser drew: cards, connections and any two cards that cover each other (a card inside its block is fine).
async function drawn(page, flow) {
    const parents = Object.fromEntries((flow.nodes || []).map((node) => [String(node.id), node.parentNode || '']))
    return page.evaluate((parents) => {
        const boxes = [...document.querySelectorAll('.react-flow__node')].map((el) => {
            const r = el.getBoundingClientRect()
            return { id: el.getAttribute('data-id'), x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const covered = []
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i]
                const b = boxes[j]
                if ((parents[a.id] || '') !== (parents[b.id] || '')) continue
                if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1)
                    covered.push(`${a.id} / ${b.id}`)
            }
        }
        return {
            cards: boxes.length,
            connections: document.querySelectorAll('.react-flow__edge').length,
            empty: boxes.filter((box) => box.w < 2 || box.h < 2).map((box) => box.id),
            covered,
            // Card sizes in canvas units (not scaled by zoom), for scripts/templates-respace.mjs.
            sizes: Object.fromEntries(
                [...document.querySelectorAll('.react-flow__node')].map((el) => [
                    el.getAttribute('data-id'),
                    { w: el.offsetWidth, h: el.offsetHeight }
                ])
            )
        }
    }, parents)
}

const slug = (text) =>
    text
        .replace(/(\.(chatflow|canvas|pipeline))?\.json$/, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
const htmlText = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))

const { chromium } = await import(process.env.E2E_PLAYWRIGHT || 'playwright')
let items = bundled()
if (ONLY.length) {
    // A word that matches no file stops the run, so a typo never passes with nothing checked.
    const missing = ONLY.filter((word) => !items.some((item) => item.file.toLowerCase().includes(word)))
    if (missing.length) {
        console.error(`GALLERY_ONLY: no bundled canvas file matches ${missing.map((word) => `"${word}"`).join(', ')}.`)
        process.exit(2)
    }
    items = items.filter((item) => ONLY.some((word) => item.file.toLowerCase().includes(word)))
}

// Prefer the copy the Templates page serves: it is the one a click opens, with anchors filled in for samples.
const served = new Map()
for (const template of (await api('GET', '/marketplaces/templates')) || []) {
    if (typeof template?.flowData === 'string') served.set(`${template.type}\0${template.templateName || template.name}`, template.flowData)
}
for (const item of items) {
    const flowData = served.get(`${TYPE_OF[item.kind]}\0${item.name}`)
    item.served = Boolean(flowData)
    if (flowData) item.flowData = flowData
}

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const results = []
try {
    await signIn(page)
    if (LOOK) await page.evaluate((look) => window.localStorage.setItem('cuttlely.canvasLook', look), LOOK)
    await page.goto(`${BASE}/marketplaces`, { waitUntil: 'networkidle' })
    for (const [index, item] of items.entries()) {
        const flow = JSON.parse(item.flowData)
        const expected = { cards: (flow.nodes || []).length, connections: (flow.edges || []).length }
        const shot = `${String(index + 1).padStart(2, '0')}-${item.kind}-${slug(path.basename(item.file))}.png`
        let result
        try {
            await leavePreview(page)
            await openPreview(page, item, index)
            await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
            const drew = await waitForCanvas(page, flow)
            // Fit the whole canvas in view for the screenshot, the same as the fit-view button.
            const fit = page.locator('.react-flow__controls-fitview').first()
            if (await fit.count()) await fit.click()
            const settled = drew && (await waitForCanvas(page, flow, 5000))
            const seen = await drawn(page, flow)
            await page.screenshot({ path: path.join(OUT, shot) })
            const problems = previewProblems({ expected, seen, settled })
            result = { ...item, flowData: undefined, shot, expected, seen, problems }
        } catch (err) {
            result = { ...item, flowData: undefined, shot: '', expected, problems: [String(err?.message || err).split('\n')[0]] }
        }
        results.push(result)
        log(result.problems.length ? 'FAIL' : 'PASS', item.file, result.problems.join('; '))
    }
} finally {
    await browser.close()
}

const rows = results
    .map(
        (r) =>
            `<figure><figcaption><b>${htmlText(r.name)}</b> <code>${htmlText(r.file)}</code> ${
                r.problems.length ? `<span class="bad">${htmlText(r.problems.join('; '))}</span>` : '<span class="ok">ok</span>'
            }</figcaption>${r.shot ? `<img loading="lazy" src="${htmlText(r.shot)}">` : ''}</figure>`
    )
    .join('\n')
fs.writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Bundled canvases</title><style>body{font:14px sans-serif;margin:24px}figure{margin:0 0 32px}img{max-width:100%;border:1px solid #ccc}.bad{color:#b00}.ok{color:#070}</style><h1>Bundled canvases (${results.length})</h1>\n${rows}\n`
)
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => r.problems.length).length
log(`${results.length - failed} of ${results.length} canvases drew cleanly. Gallery: ${path.join(OUT, 'index.html')}`)
process.exit(failed ? 1 : 0)
