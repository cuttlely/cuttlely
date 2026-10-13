// Duplicate, delete, and close the settings panel on the chatflow and workflow canvases.
// Boots the built server unless E2E_BASE_URL is already set. Demo data only. Prints no password.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort, request, startServer, waitForPing } from './smoke-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const PASSWORD = 'CanvasActions1!'
const EMAIL = 'canvas-actions@example.com'
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
        const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
            cwd: ROOT,
            stdio: 'inherit'
        })
        if (install.status !== 0) throw last
        return chromium.launch({ args })
    })()
}

async function buildNode(base, cookie, name, id, { label, position }) {
    const def = await request(`${base}/api/v1/nodes/${name}`, { cookie })
    if (def.status !== 200) throw new Error(`node ${name} ${def.status}: ${def.text.slice(0, 200)}`)
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

async function createFlow(base, cookie, { name, type, nodes }) {
    const created = await request(`${base}/api/v1/chatflows`, {
        method: 'POST',
        cookie,
        body: {
            name,
            type,
            deployed: false,
            flowData: JSON.stringify({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 0.9 } })
        }
    })
    if (created.status !== 200) throw new Error(`create ${type} ${created.status}: ${created.text.slice(0, 300)}`)
    return JSON.parse(created.text)
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
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'panel'))
}

async function exercise(page, base, { route, nodeId }) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await card.waitFor({ timeout: 20000 })
    await page.waitForTimeout(500)
    const before = await page.locator('.react-flow__node').count()
    const box = await card.boundingBox()
    if (!box) throw new Error(`${nodeId} has no box`)
    await page.mouse.move(box.x + Math.min(24, box.width / 2), box.y + Math.min(20, box.height / 2))
    await page.waitForTimeout(300)
    const hoverBar = card.locator('[data-testid="card-actions"]')
    if ((await hoverBar.count()) !== 1) throw new Error(`${nodeId} toolbar is missing on hover`)

    await card.click({ position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) } })
    const panel = page.getByTestId('node-side-panel')
    await panel.waitFor({ timeout: 10000 })
    if ((await card.locator('[data-testid="card-actions"]').count()) !== 1) {
        throw new Error(`${nodeId} toolbar is missing while the panel is open`)
    }
    await checkBackspaceInField(page, panel, nodeId)
    await panel.getByTestId('panel-duplicate').click()
    await page.waitForTimeout(400)
    const afterCopy = await page.locator('.react-flow__node').count()
    if (afterCopy !== before + 1) throw new Error(`${nodeId} duplicate left ${afterCopy} cards, expected ${before + 1}`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 1) {
        throw new Error(`${nodeId} duplicate removed the original card`)
    }
    // The panel moves onto the copy, so Delete removes the copy and leaves the original.
    if ((await panel.getByText(nodeId, { exact: true }).count()) !== 0) {
        throw new Error(`${nodeId} panel stayed on the original card after duplicate`)
    }

    await panel.getByTestId('panel-delete').click()
    await page.waitForTimeout(400)
    const afterDelete = await page.locator('.react-flow__node').count()
    if (afterDelete !== before) throw new Error(`${nodeId} delete left ${afterDelete} cards, expected ${before}`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 1) {
        throw new Error(`${nodeId} delete removed the original card`)
    }
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} panel stayed open after delete`)

    await card.click({ position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) } })
    await panel.waitFor({ timeout: 10000 })
    await panel.getByTestId('close-settings').click()
    await page.waitForTimeout(300)
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} close button left the panel open`)

    await card.click({ position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) } })
    await panel.waitFor({ timeout: 10000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} Escape left the panel open`)

    await checkCanvasBackspace(page, card, nodeId)
    await checkHoverClicks(page, nodeId, 'above')
    const survivor = await remainingCardId(page, nodeId)
    await checkTopEdge(page, page.locator(`.react-flow__node[data-id="${survivor}"]`), survivor)
    await checkHoverClicks(page, survivor, 'below')
}

async function remainingCardId(page, removedId) {
    const ids = await page.locator('.react-flow__node').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')))
    const survivor = ids.find((id) => id && id !== removedId && !id.startsWith('startAgentflow'))
    if (!survivor) throw new Error(`no card left after deleting ${removedId}`)
    return survivor
}

async function deselect(page) {
    const pane = page.locator('.react-flow__pane').first()
    const box = await pane.boundingBox()
    await pane.click({ position: { x: 24, y: Math.max(24, box.height - 120) } })
    await page.waitForTimeout(200)
}

async function moveFromCardToButton(page, card, testId) {
    if (await card.evaluate((el) => el.classList.contains('selected'))) await deselect(page)
    if (await card.evaluate((el) => el.classList.contains('selected'))) throw new Error(`${testId} card stayed selected`)
    const box = await card.boundingBox()
    if (!box) throw new Error(`${testId} card has no box`)
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(22, box.height / 2))
    await page.waitForTimeout(250)
    const button = card.locator(`[data-testid="${testId}"]`)
    await button.waitFor({ timeout: 3000 })
    const buttonBox = await button.boundingBox()
    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2, { steps: 12 })
    await page.waitForTimeout(200)
    if ((await button.count()) !== 1) throw new Error(`${testId} unmounted while the pointer moved onto it`)
    await button.click()
}

// Hover an unselected card, cross onto Duplicate and click it, then do the same for Delete.
async function dragCardTo(page, card, { top, left }) {
    const cardBox = await card.boundingBox()
    if (!cardBox) throw new Error('card has no box to drag')
    const offsetX = Math.min(28, cardBox.width / 2)
    const offsetY = Math.min(18, cardBox.height / 2)
    await page.mouse.move(cardBox.x + offsetX, cardBox.y + offsetY)
    await page.mouse.down()
    await page.mouse.move((left ?? cardBox.x) + offsetX, top + offsetY, { steps: 16 })
    await page.mouse.up()
    await page.waitForTimeout(300)
}

async function checkHoverClicks(page, nodeId, placement) {
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await card.waitFor({ timeout: 10000 })
    const paneBox = await page.locator('.react-flow').first().boundingBox()
    // A duplicate sits to the right of its original and can leave the view. Park the card in the pane first.
    const left = paneBox.x + Math.min(280, paneBox.width * 0.28)
    const top = placement === 'below' ? paneBox.y : paneBox.y + paneBox.height * 0.45
    await dragCardTo(page, card, { top, left })
    await deselect(page)
    const probe = await card.boundingBox()
    await page.mouse.move(probe.x + probe.width / 2, probe.y + Math.min(20, probe.height / 2))
    await page.waitForTimeout(250)
    const side = await card.locator('[data-testid="card-actions"]').getAttribute('data-placement')
    if (side !== placement) throw new Error(`${nodeId} bar was ${side}, expected ${placement}`)
    await page.mouse.move(8, 8)
    await page.waitForTimeout(200)
    const before = await page.locator('.react-flow__node').count()
    await moveFromCardToButton(page, card, 'card-duplicate')
    await page.waitForTimeout(400)
    const copied = await page.locator('.react-flow__node').count()
    if (copied !== before + 1) {
        throw new Error(`${nodeId} hover duplicate (${placement}) did not add a card`)
    }
    // Cross from the card onto toolbar Delete. Hiding that button fails here, including when the row sits below a card at the top.
    await moveFromCardToButton(page, card, 'card-delete')
    await page.waitForTimeout(400)
    const afterDelete = await page.locator('.react-flow__node').count()
    if (afterDelete !== copied - 1) {
        throw new Error(`${nodeId} hover delete (${placement}) left ${afterDelete} cards, expected ${copied - 1}`)
    }
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 0) {
        throw new Error(`${nodeId} hover delete (${placement}) left the card`)
    }
}

async function checkBackspaceInField(page, panel, nodeId) {
    const field = panel.locator('textarea, input[type="text"], [contenteditable="true"]').first()
    await field.waitFor({ timeout: 10000 })
    await field.click()
    await page.keyboard.press('End')
    const editable = await field.evaluate((el) => el.getAttribute('contenteditable') === 'true')
    const read = () => (editable ? field.innerText() : field.inputValue())
    const start = await read()
    const before = await page.locator('.react-flow__node').count()
    await page.keyboard.type('Q')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)
    const afterText = await read()
    if (afterText !== start) throw new Error(`${nodeId} Backspace in the panel field left "${afterText}"`)
    if ((await page.locator('.react-flow__node').count()) !== before) {
        throw new Error(`${nodeId} Backspace in a panel field removed a card`)
    }
    if ((await panel.count()) === 0) throw new Error(`${nodeId} Backspace in a panel field closed the panel`)
}

async function checkCanvasBackspace(page, card, nodeId) {
    const panel = page.getByTestId('node-side-panel')
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} panel was open for canvas Backspace`)
    if (!(await card.evaluate((el) => el.classList.contains('selected')))) {
        await card.click({ position: { x: Math.min(30, (await card.boundingBox()).width / 2), y: 16 } })
        await panel.waitFor({ timeout: 10000 })
        await panel.getByTestId('close-settings').click()
        await page.waitForTimeout(200)
    }
    const before = await page.locator('.react-flow__node').count()
    await card.locator('[data-testid="card-duplicate"]').click()
    await page.waitForTimeout(400)
    if ((await page.locator('.react-flow__node').count()) !== before + 1) {
        throw new Error(`${nodeId} Backspace setup did not add a card`)
    }
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} duplicate opened the panel before Backspace`)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    const after = await page.locator('.react-flow__node').count()
    if (after !== before) throw new Error(`${nodeId} Backspace left ${after} cards, expected ${before}`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 1) {
        throw new Error(`${nodeId} Backspace removed the original card`)
    }
}

// A card at the top of the view used to lose its buttons above the canvas, under the floating buttons.
async function checkTopEdge(page, card, nodeId) {
    const pane = page.locator('.react-flow').first()
    const paneBox = await pane.boundingBox()
    if (!paneBox || !(await card.boundingBox())) throw new Error(`${nodeId} could not be measured for the top-edge check`)
    await dragCardTo(page, card, { top: paneBox.y, left: paneBox.x + Math.min(280, paneBox.width * 0.28) })
    await page.waitForTimeout(100)
    const before = await page.locator('.react-flow__node').count()
    for (const testId of ['card-duplicate', 'card-delete']) {
        const button = card.locator(`[data-testid="${testId}"]`)
        await button.waitFor({ timeout: 5000 })
        const box = await button.boundingBox()
        if (!box) throw new Error(`${nodeId} ${testId} has no box at the top edge`)
        const fullyInside =
            box.y >= paneBox.y - 1 &&
            box.y + box.height <= paneBox.y + paneBox.height + 1 &&
            box.x >= paneBox.x - 1 &&
            box.x + box.width <= paneBox.x + paneBox.width + 1
        if (!fullyInside) {
            throw new Error(
                `${nodeId} ${testId} is not fully inside the canvas (button ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(
                    box.width
                )}x${Math.round(box.height)}; pane ${Math.round(paneBox.x)},${Math.round(paneBox.y)} ${Math.round(
                    paneBox.width
                )}x${Math.round(paneBox.height)})`
            )
        }
        const topmost = await page.evaluate(
            ({ x, y, testId }) => {
                const hit = document.elementFromPoint(x, y)
                const button = hit?.closest?.(`[data-testid="${testId}"]`)
                return Boolean(button)
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2, testId }
        )
        if (!topmost) throw new Error(`${nodeId} ${testId} is covered at its center`)
    }
    await card.locator('[data-testid="card-duplicate"]').click()
    await page.waitForTimeout(400)
    const copied = await page.locator('.react-flow__node').count()
    if (copied !== before + 1) throw new Error(`${nodeId} top-edge duplicate left ${copied} cards, expected ${before + 1}`)
    const copyBar = page.locator('.react-flow__node.selected [data-testid="card-delete"]')
    await copyBar.click()
    await page.waitForTimeout(400)
    const after = await page.locator('.react-flow__node').count()
    if (after !== before) throw new Error(`${nodeId} top-edge delete left ${after} cards, expected ${before}`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 1) {
        throw new Error(`${nodeId} top-edge delete removed the original card`)
    }
}

async function prepareFlows(base, cookie) {
    const prompt = await buildNode(base, cookie, 'promptTemplate', 'promptTemplate_0', {
        label: 'Daily bread prompt',
        position: { x: 160, y: 140 }
    })
    const chat = await createFlow(base, cookie, { name: 'canvas actions chat', type: 'CHATFLOW', nodes: [prompt] })
    const start = await buildNode(base, cookie, 'startAgentflow', 'startAgentflow_0', {
        label: 'Start',
        position: { x: 80, y: 160 }
    })
    start.type = 'agentFlow'
    const reply = await buildNode(base, cookie, 'directReplyAgentflow', 'directReplyAgentflow_0', {
        label: 'Reply',
        position: { x: 420, y: 160 }
    })
    reply.type = 'agentFlow'
    const flow = await createFlow(base, cookie, {
        name: 'canvas actions workflow',
        type: 'AGENTFLOW',
        nodes: [start, reply]
    })
    return { chat, flow }
}

export async function runCanvasActions(base) {
    const registered = await request(`${base}/api/v1/account/register`, {
        method: 'POST',
        body: { user: { name: 'Canvas Actions', email: EMAIL, credential: PASSWORD } }
    })
    if (registered.status !== 200 && registered.status !== 404) {
        throw new Error(`register ${registered.status}: ${registered.text.slice(0, 200)}`)
    }
    const loggedIn = await request(`${base}/api/v1/auth/login`, {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD }
    })
    if (loggedIn.status !== 200 || !loggedIn.cookie) throw new Error(`login ${loggedIn.status}`)
    const flows = await prepareFlows(base, loggedIn.cookie)

    const browser = await launchBrowser()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
        await signIn(page, base)
        await exercise(page, base, { route: `/canvas/${flows.chat.id}`, nodeId: 'promptTemplate_0' })
        console.log('chatflow canvas actions ok')
        await exercise(page, base, { route: `/v2/agentcanvas/${flows.flow.id}`, nodeId: 'directReplyAgentflow_0' })
        console.log('workflow canvas actions ok')
    } finally {
        await browser.close()
    }
}

async function main() {
    if (process.env.E2E_BASE_URL) {
        await runCanvasActions(process.env.E2E_BASE_URL.replace(/\/$/, ''))
        return
    }
    if (!fs.existsSync(path.join(ROOT, 'packages', 'server', 'dist', 'commands'))) {
        throw new Error('packages/server/dist is missing. The verify build step has to run before this test.')
    }
    if (!fs.existsSync(path.join(ROOT, 'packages', 'ui', 'build', 'index.html'))) {
        throw new Error('packages/ui/build is missing. The verify build step has to run before this test.')
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-canvas-actions-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const { child, logs, stop } = startServer(dataDir, port, { CUTTLELY_LOCAL_ADMIN: 'true' })
    try {
        await waitForPing(base, child, logs)
        await runCanvasActions(base)
    } finally {
        stop()
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error))
        process.exit(1)
    })
}
