// The new card look (compact cards, settings in a side panel) on the chat flow, harness and ETL pipeline canvases,
// and the side panel on the workflow canvas (workflow cards stay as they are; the panel replaces the dialog).
// Turns the switch on with the canvas toolbar button and checks every card is narrower but keeps exactly the same plug
// points and connections. Clicks a card, types 20 characters into its field in the panel and checks the cursor never
// leaves the field. Then checks Delete in the panel does not delete the card, Escape closes the panel, and the switch
// turns the classic look back on with the typed text on the card.
// Demo data only; prints short pass/fail lines, never the login.
//
// Needs a running Cuttlely (E2E_BASE_URL), a local admin login file (E2E_ADMIN_FILE) and a Playwright with a browser.
// Set E2E_PLAYWRIGHT to a Playwright module path when the repo's copy has no browser installed.
// Set E2E_SHOTS to a directory outside the repo to save screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { BASE, buildNode, connect, upsertFlow, log } from './lib.mjs'
import { e2e } from './paths.mjs'
import { pickCases } from './pick.mjs'

const { chromium } = await import(process.env.E2E_PLAYWRIGHT || 'playwright')
const ADMIN_FILE = process.env.E2E_ADMIN_FILE || e2e('admin.json')
const SHOTS = process.env.E2E_SHOTS || ''
const TYPED = 'Fresh rye loaf 2026!'
if (TYPED.length !== 20) throw new Error('the typed text must be 20 characters')

const cases = [
    {
        canvas: 'chat flow',
        type: 'CHATFLOW',
        route: 'canvas',
        field: 'template',
        nodeId: 'promptTemplate_0',
        build: async () => {
            const prompt = await buildNode('promptTemplate', 'promptTemplate_0', {
                label: 'Daily bread prompt',
                position: { x: 100, y: 100 }
            })
            const model = await buildNode('chatOllama', 'chatOllama_0', { position: { x: 100, y: 600 } })
            const chain = await buildNode('llmChain', 'llmChain_0', { label: 'Bread chain', position: { x: 600, y: 200 } })
            return { nodes: [prompt, model, chain], edges: [connect(prompt, chain, 'prompt'), connect(model, chain, 'model')] }
        }
    },
    {
        canvas: 'harness',
        type: 'HARNESS',
        route: 'harnesscanvas',
        field: 'instructions',
        nodeId: 'harnessSpecialist_0',
        // A harness saves only with one Harness Prime that has a chat model. Ollama needs no key; nothing here runs it.
        build: async () => {
            const model = await buildNode('chatOllama', 'chatOllama_0', { position: { x: 100, y: 500 } })
            const prime = await buildNode('harnessChief', 'harnessChief_0', { label: 'Bakery lead', position: { x: 500, y: 100 } })
            const specialist = await buildNode('harnessSpecialist', 'harnessSpecialist_0', {
                label: 'Pastry specialist',
                inputs: { specialistName: 'pastry' },
                position: { x: 100, y: 100 }
            })
            return {
                nodes: [model, prime, specialist],
                edges: [connect(model, prime, 'chatModel'), connect(specialist, prime, 'specialists')]
            }
        }
    },
    {
        canvas: 'ETL pipeline',
        type: 'ETL',
        route: 'etlcanvas',
        field: 'keyTemplate',
        nodeId: 'etlTransform_0',
        build: async () => ({ nodes: [await buildNode('etlTransform', 'etlTransform_0', { label: 'Clean recipes' })], edges: [] })
    },
    {
        canvas: 'workflow',
        type: 'AGENTFLOW',
        route: 'v2/agentcanvas',
        nodeId: 'directReplyAgentflow_0',
        workflow: true,
        build: async () => {
            const asWorkflowNode = (node) => ({ ...node, type: 'agentFlow' })
            const start = asWorkflowNode(
                await buildNode('startAgentflow', 'startAgentflow_0', { label: 'Start', position: { x: 100, y: 200 } })
            )
            const reply = asWorkflowNode(
                await buildNode('directReplyAgentflow', 'directReplyAgentflow_0', { label: 'Reply', position: { x: 400, y: 200 } })
            )
            return { nodes: [start, reply], edges: [] }
        }
    }
]

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

async function typeAndWatchFocus(page) {
    await page.evaluate(() => document.activeElement?.setAttribute('data-focus-probe', '1'))
    let lost = 0
    for (const ch of TYPED) {
        await page.keyboard.type(ch)
        await page.waitForTimeout(80)
        const kept = await page.evaluate(() => {
            const el = document.activeElement
            return !!el && el.isConnected && !!el.closest('[data-focus-probe]')
        })
        if (!kept) lost++
    }
    return lost
}

const shot = async (page, name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, name) })
}

// Workflows keep their own cards. The new look only moves the settings from the dialog into the side panel.
async function runWorkflowCase(page, item) {
    const { nodes, edges } = await item.build()
    const flow = await upsertFlow({ name: 'e2e-panel-workflow', type: item.type, nodes, edges })
    const result = { canvas: item.canvas }
    const card = page.locator(`.react-flow__node[data-id="${item.nodeId}"]`)
    const panel = page.getByTestId('node-side-panel')
    const toggle = page.getByRole('button', { name: 'toggle side panel' })
    await page.goto(`${BASE}/${item.route}/${flow.id}`, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.localStorage.removeItem('cuttlely.canvasLook'))
    await page.reload({ waitUntil: 'networkidle' })
    await card.waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    result.newLookByDefault = (await toggle.getAttribute('aria-pressed')) === 'true'

    await card.click()
    await panel.waitFor({ timeout: 10000 })
    result.noDialog = (await page.getByRole('dialog').count()) === 0
    const field = panel.locator('.ProseMirror').first()
    await field.waitFor({ timeout: 10000 })
    await field.click()
    result.focusLost = await typeAndWatchFocus(page)
    result.valueMatches = (await field.innerText()).trim() === TYPED
    await shot(page, 'panel-workflow.png')

    await panel.focus()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(300)
    result.deleteKeptCard = (await card.count()) === 1
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    result.escapeCloses = (await panel.count()) === 0

    // Classic: the click opens nothing, a double click opens the dialog with the typed text.
    await toggle.click()
    await card.click()
    await page.waitForTimeout(300)
    result.switchOff = (await toggle.getAttribute('aria-pressed')) === 'false' && (await panel.count()) === 0
    await card.dblclick()
    const dialog = page.getByRole('dialog').last()
    await dialog.waitFor({ timeout: 10000 })
    result.dialogShowsTyped = (await dialog.locator('.ProseMirror').first().innerText()).trim() === TYPED
    await page.keyboard.press('Escape')
    return result
}

async function runCase(page, item) {
    const { nodes, edges } = await item.build()
    const flow = await upsertFlow({ name: `e2e-panel-${item.route.replace(/\W/g, '-')}`, type: item.type, nodes, edges })
    const result = { canvas: item.canvas }
    const card = page.locator(`.react-flow__node[data-id="${item.nodeId}"]`)
    const panel = page.getByTestId('node-side-panel')
    const toggle = page.getByRole('button', { name: 'toggle side panel' })
    // With no choice in this browser, the new look is on.
    await page.goto(`${BASE}/${item.route}/${flow.id}`, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.localStorage.removeItem('cuttlely.canvasLook'))
    await page.reload({ waitUntil: 'networkidle' })
    await card.waitFor({ timeout: 20000 })
    result.newLookByDefault = (await toggle.getAttribute('aria-pressed')) === 'true'
    // The rest starts from classic cards.
    await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'classic'))
    await page.reload({ waitUntil: 'networkidle' })
    await card.waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    const cardField = card.locator(`input[name="${item.field}"], textarea[name="${item.field}"]`).first()
    const plugPoints = () =>
        page.$$eval('.react-flow__handle', (els) =>
            els.map((el) => `${el.closest('.react-flow__node')?.getAttribute('data-id')}|${el.getAttribute('data-handleid')}`).sort()
        )
    const classicPlugs = await plugPoints()
    const classicWidth = (await card.boundingBox())?.width || 0

    // Classic: clicking the card opens nothing and the field stays on the card.
    await card.locator('p').first().click()
    await page.waitForTimeout(300)
    result.classicKeepsFields = (await panel.count()) === 0 && (await cardField.count()) === 1

    await toggle.click()
    result.switchOn = (await toggle.getAttribute('aria-pressed')) === 'true'
    await page.waitForTimeout(500)
    result.compactCard =
        (await cardField.count()) === 0 &&
        (await card.getByTestId('compact-card-summary').count()) === 1 &&
        ((await card.boundingBox())?.width || 0) < classicWidth
    result.plugPointsKept = JSON.stringify(await plugPoints()) === JSON.stringify(classicPlugs) && classicPlugs.length > 0
    result.connectionsKept = (await page.locator('.react-flow__edge').count()) === edges.length
    await shot(page, `compact-${item.route.replace(/\W/g, '-')}.png`)
    await card.locator('p').first().click()
    await panel.waitFor({ timeout: 10000 })

    const field = panel.locator(`input[name="${item.field}"], textarea[name="${item.field}"]`).first()
    await field.waitFor({ timeout: 10000 })
    await field.click()
    result.focusLost = await typeAndWatchFocus(page)
    result.valueMatches = (await field.inputValue()).trim() === TYPED
    await shot(page, `panel-${item.route.replace(/\W/g, '-')}.png`)

    // Delete with the panel itself focused must not delete the card.
    await panel.focus()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(300)
    result.deleteKeptCard = (await card.count()) === 1

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    result.escapeCloses = (await panel.count()) === 0

    await toggle.click()
    await card.locator('p').first().click()
    await page.waitForTimeout(500)
    result.switchOff = (await toggle.getAttribute('aria-pressed')) === 'false' && (await panel.count()) === 0
    result.cardShowsTyped = (await cardField.count()) === 1 && (await cardField.inputValue()).trim() === TYPED
    result.classicPlugsBack = JSON.stringify(await plugPoints()) === JSON.stringify(classicPlugs)
    return result
}

let selected
try {
    selected = pickCases(cases, process.env.E2E_ONLY)
} catch (err) {
    console.error(err.message)
    process.exit(2)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let failed = 0
try {
    await signIn(page)
    for (const item of selected) {
        let result
        try {
            result = await (item.workflow ? runWorkflowCase(page, item) : runCase(page, item))
        } catch (err) {
            result = { canvas: item.canvas, error: String(err?.message || err).split('\n')[0] }
        }
        const ok =
            !result.error &&
            result.focusLost === 0 &&
            Object.entries(result).every(([key, value]) => key === 'canvas' || key === 'focusLost' || value === true)
        if (!ok) failed++
        log(ok ? 'PASS' : 'FAIL', JSON.stringify(result))
    }
} finally {
    await browser.close()
}
process.exit(failed ? 1 : 0)
