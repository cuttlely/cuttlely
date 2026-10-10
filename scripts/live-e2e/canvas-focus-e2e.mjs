// Types 20 characters into a card field on each of the four canvases (chat flow, harness, ETL pipeline, workflow) and
// into a document store loader field, and checks the cursor never leaves the field. Then changes the field from outside
// (the Expand dialog) and checks the field shows the new text. Demo data only; prints short pass/fail lines, never the
// login.
//
// Needs a running Cuttlely (E2E_BASE_URL), a local admin login file (E2E_ADMIN_FILE) and a Playwright with a browser.
// Set E2E_PLAYWRIGHT to a Playwright module path when the repo's copy has no browser installed.
// Set E2E_SHOTS to a directory outside the repo to save one screenshot per canvas.
import fs from 'node:fs'
import path from 'node:path'
import { BASE, api, buildNode, connect, upsertFlow, log } from './lib.mjs'
import { e2e } from './paths.mjs'
import { pickCases } from './pick.mjs'

const { chromium } = await import(process.env.E2E_PLAYWRIGHT || 'playwright')
const ADMIN_FILE = process.env.E2E_ADMIN_FILE || e2e('admin.json')
const SHOTS = process.env.E2E_SHOTS || ''
const TYPED = 'Fresh rye loaf 2026!'
if (TYPED.length !== 20) throw new Error('the typed text must be 20 characters')

const asWorkflowNode = (node) => ({ ...node, type: 'agentFlow' })

const cases = [
    {
        canvas: 'chat flow',
        type: 'CHATFLOW',
        route: 'canvas',
        field: 'template',
        nodeId: 'promptTemplate_0',
        nodes: async () => [await buildNode('promptTemplate', 'promptTemplate_0', { label: 'Daily bread prompt' })]
    },
    {
        canvas: 'harness',
        type: 'HARNESS',
        route: 'harnesscanvas',
        field: 'instructions',
        nodeId: 'harnessSpecialist_0',
        // A harness saves only with one Harness Prime that has a chat model. Ollama needs no key; nothing here runs it.
        nodes: async () => {
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
        nodes: async () => [await buildNode('etlTransform', 'etlTransform_0', { label: 'Clean recipes' })]
    },
    {
        canvas: 'workflow',
        type: 'AGENTFLOW',
        route: 'v2/agentcanvas',
        field: 'directReplyMessage',
        nodeId: 'directReplyAgentflow_0',
        rich: true,
        nodes: async () => [
            asWorkflowNode(await buildNode('startAgentflow', 'startAgentflow_0', { label: 'Start', position: { x: 100, y: 200 } })),
            asWorkflowNode(
                await buildNode('directReplyAgentflow', 'directReplyAgentflow_0', { label: 'Reply', position: { x: 400, y: 200 } })
            )
        ]
    },
    {
        canvas: 'document store',
        route: 'document-stores',
        field: 'text',
        // The Plain Text loader settings page of a new document store, not a canvas.
        open: async () => {
            const store = await api('POST', '/document-store/store', {
                name: `e2e-focus-store-${Date.now()}`,
                description: 'Bakery recipes'
            })
            return `${BASE}/document-stores/${store.id}/plainText`
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

// Marks the focused element, then types one character at a time and checks the marked element still has focus.
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

async function runCase(page, item) {
    if (item.open) {
        await page.goto(await item.open(), { waitUntil: 'networkidle' })
    } else {
        const built = await item.nodes()
        const { nodes, edges } = Array.isArray(built) ? { nodes: built, edges: [] } : built
        const flow = await upsertFlow({ name: `e2e-focus-${item.route.replace(/\W/g, '-')}`, type: item.type, nodes, edges })
        await page.goto(`${BASE}/${item.route}/${flow.id}`, { waitUntil: 'networkidle' })
        await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    }
    await page.waitForTimeout(1000)

    let field
    let readValue
    let scope = page
    if (item.rich) {
        await page.locator(`.react-flow__node[data-id="${item.nodeId}"]`).dblclick()
        scope = page.getByRole('dialog').last()
        field = scope.locator('.ProseMirror').first()
        readValue = () => field.innerText()
    } else if (item.open) {
        field = page.locator(`textarea[name="${item.field}"]:not([aria-hidden]), input[name="${item.field}"]`).first()
        readValue = () => field.inputValue()
    } else {
        const card = page.locator(`.react-flow__node[data-id="${item.nodeId}"]`)
        scope = card
        field = card.locator(`input[name="${item.field}"], textarea[name="${item.field}"]`).first()
        readValue = () => field.inputValue()
    }
    await field.waitFor({ timeout: 15000 })
    await field.click()
    const lost = await typeAndWatchFocus(page)
    const value = (await readValue()).trim()
    const result = { canvas: item.canvas, typed: TYPED.length, focusLost: lost, valueMatches: value === TYPED }

    // Outside change: the Expand dialog writes the field from outside the field itself.
    const expand = scope.locator('button[title="Expand"]').first()
    if (await expand.count()) {
        await expand.click()
        const dialog = page.getByRole('dialog').last()
        const editor = dialog.locator('textarea:not([aria-hidden]), .ProseMirror, [contenteditable=true]').first()
        await editor.waitFor({ timeout: 10000 })
        await editor.click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('Sourdough')
        await dialog.getByRole('button', { name: 'Save' }).click()
        await page.waitForTimeout(500)
        result.expandSync = (await readValue()).trim() === 'Sourdough'
    }
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(SHOTS, `focus-${item.route.replace(/\W/g, '-')}.png`) })
    }
    return result
}

// E2E_ONLY picks cases by name, comma separated (for example "document store"). An unknown name stops the run.
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
    // These cases type into fields on the card, so they use classic cards (the new look keeps fields in the side panel,
    // which canvas-side-panel-e2e.mjs checks).
    await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'classic'))
    for (const item of selected) {
        let result
        try {
            result = await runCase(page, item)
        } catch (err) {
            result = { canvas: item.canvas, error: String(err?.message || err).split('\n')[0] }
        }
        const ok = !result.error && result.focusLost === 0 && result.valueMatches && result.expandSync !== false
        if (!ok) failed++
        log(ok ? 'PASS' : 'FAIL', JSON.stringify(result))
    }
} finally {
    await browser.close()
}
process.exit(failed ? 1 : 0)
