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

function connectNodes(source, target, inputName, edgeType) {
    const anchor =
        (target.data.inputAnchors || []).find((item) => item.name === inputName) ||
        (target.data.inputParams || []).find((item) => item.name === inputName)
    const targetHandle = edgeType === 'agentFlow' ? target.id : anchor?.id || `${target.id}-input-${inputName}`
    const sourceAnchor = source.data.outputAnchors?.[0]
    const sourceHandle = sourceAnchor?.options?.[0]?.id || sourceAnchor?.id
    const param = (target.data.inputParams || []).find((item) => item.name === inputName)
    if (param?.acceptVariable && target.data.inputs) {
        target.data.inputs[inputName] = `{{${source.id}.data.instance}}`
    }
    return {
        id: `${source.id}-${target.id}-${inputName}`,
        source: source.id,
        target: target.id,
        sourceHandle,
        targetHandle,
        type: edgeType
    }
}

async function createFlow(base, cookie, { name, type, nodes, edges = [] }) {
    const created = await request(`${base}/api/v1/chatflows`, {
        method: 'POST',
        cookie,
        body: {
            name,
            type,
            deployed: false,
            flowData: JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 0.9 } })
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

async function exercise(
    page,
    base,
    { route, nodeId, connectedId, buttonId, multiIds, removedIds, keptMentions, flowName, flowId, cookie, saveTitle, selectEdge, twoEdge }
) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await card.waitFor({ timeout: 20000 })
    await page.waitForTimeout(500)
    if (twoEdge) await checkTwoEdges(page, base, cookie, flowId, saveTitle, twoEdge)
    if (connectedId) await checkConnectedBackspace(page, connectedId, flowName)
    if (selectEdge) await deleteWorkflowEdge(page, buttonId)
    if (buttonId) await deleteFromToolbar(page, buttonId)
    if (multiIds?.length) await deleteSelectedCards(page, multiIds)
    // Before any duplicate reuses a freed id, the saved flow must not contain that id at all.
    if (removedIds?.length)
        await assertSavedFlow(page, base, cookie, flowId, saveTitle, removedIds, keptMentions, { reload: false, strict: true })
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
    if (removedIds?.length) await assertSavedFlow(page, base, cookie, flowId, saveTitle, removedIds, [], { reload: true })
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

async function canvasUnsaved(page, flowName) {
    return page.evaluate((name) => {
        const titles = [...document.querySelectorAll('.MuiTypography-root')].filter((el) => {
            const text = el.textContent.replace(/\s+/g, ' ').trim()
            return text === name || text === `* ${name}`
        })
        return titles.some((el) => el.textContent.includes('*'))
    }, flowName)
}

async function checkConnectedBackspace(page, nodeId, flowName) {
    if (await canvasUnsaved(page, flowName)) throw new Error(`${nodeId} canvas was already unsaved`)
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await card.waitFor({ timeout: 10000 })
    const box = await card.boundingBox()
    if (!box) throw new Error(`${nodeId} connected card has no box`)
    await card.click({ position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) } })
    const panel = page.getByTestId('node-side-panel')
    await panel.waitFor({ timeout: 10000 })
    await panel.getByTestId('close-settings').click()
    await page.waitForTimeout(200)
    if ((await panel.count()) !== 0) throw new Error(`${nodeId} panel stayed open before Backspace`)
    const before = await page.locator('.react-flow__node').count()
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    const after = await page.locator('.react-flow__node').count()
    if (after !== before - 1) throw new Error(`${nodeId} Backspace left ${after} cards, expected ${before - 1}`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 0) {
        throw new Error(`${nodeId} Backspace left the connected card`)
    }
    if (!(await canvasUnsaved(page, flowName))) throw new Error(`${nodeId} Backspace did not mark the canvas unsaved`)
}

async function deleteWorkflowEdge(page, sourceId) {
    const edge = sourceId ? page.locator(`[data-testid^="rf__edge-${sourceId}-"]`).first() : page.locator('.agent-flow-edge').first()
    await edge.waitFor({ timeout: 10000 })
    await edge.click()
    if ((await page.locator('.react-flow__edge.selected').count()) < 1) {
        throw new Error('workflow edge click did not select the line')
    }
    const before = await page.locator('.agent-flow-edge').count()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(400)
    if ((await page.locator('.agent-flow-edge').count()) !== before - 1) {
        throw new Error('Delete left the selected workflow line')
    }
}

async function deleteFromToolbar(page, nodeId) {
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
    const box = await card.boundingBox()
    if (!box) throw new Error(`${nodeId} has no box for the Delete button`)
    await card.click({ position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) } })
    await page.getByTestId('node-side-panel').waitFor({ timeout: 10000 })
    const before = await page.locator('.react-flow__node').count()
    await card.locator('[data-testid="card-delete"]').click()
    await page.waitForTimeout(400)
    if ((await page.locator('.react-flow__node').count()) !== before - 1) throw new Error(`${nodeId} toolbar Delete did not drop the count`)
    if ((await page.locator(`.react-flow__node[data-id="${nodeId}"]`).count()) !== 0)
        throw new Error(`${nodeId} toolbar Delete left the card`)
}

async function deleteSelectedCards(page, ids) {
    const first = page.locator(`.react-flow__node[data-id="${ids[0]}"]`)
    const firstBox = await first.boundingBox()
    await first.click({ position: { x: Math.min(30, firstBox.width / 2), y: Math.min(16, firstBox.height / 2) } })
    const panel = page.getByTestId('node-side-panel')
    await panel.waitFor({ timeout: 10000 })
    await panel.getByTestId('close-settings').click()
    await page.waitForTimeout(200)
    for (const id of ids.slice(1)) {
        const card = page.locator(`.react-flow__node[data-id="${id}"]`)
        const box = await card.boundingBox()
        await card.click({
            modifiers: ['Control'],
            position: { x: Math.min(30, box.width / 2), y: Math.min(16, box.height / 2) }
        })
        if ((await panel.count()) !== 0) await panel.getByTestId('close-settings').click()
    }
    const selected = await page.locator('.react-flow__node.selected').count()
    if (selected < ids.length) throw new Error(`selected ${selected} cards, expected ${ids.length}`)
    const before = await page.locator('.react-flow__node').count()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(400)
    if ((await page.locator('.react-flow__node').count()) !== before - ids.length) {
        throw new Error(
            `multi-select Delete left ${await page.locator('.react-flow__node').count()} cards, expected ${before - ids.length}`
        )
    }
    for (const id of ids) {
        if ((await page.locator(`.react-flow__node[data-id="${id}"]`).count()) !== 0) throw new Error(`multi-select Delete left ${id}`)
    }
}

async function readSavedFlow(page, base, cookie, flowId, saveTitle) {
    const responsePromise = page.waitForResponse(
        (response) => {
            const url = response.url()
            return (
                response.request().method() === 'PUT' &&
                (url.includes(`/api/v1/flow-drafts/${flowId}`) || url.includes(`/api/v1/chatflows/${flowId}`))
            )
        },
        { timeout: 15000 }
    )
    await page.locator(`[title="${saveTitle}"]`).click()
    const response = await responsePromise
    const body = await response.json()
    let flowData = body?.draft?.flowData || body?.flowData
    if (!flowData) {
        const draft = await request(`${base}/api/v1/flow-drafts/${flowId}`, { cookie })
        flowData = JSON.parse(draft.text || '{}')?.draft?.flowData
    }
    if (!flowData) {
        const live = await request(`${base}/api/v1/chatflows/${flowId}`, { cookie })
        flowData = JSON.parse(live.text || '{}')?.flowData
    }
    if (!flowData) throw new Error('save did not return the flow')
    return typeof flowData === 'string' ? JSON.parse(flowData) : flowData
}

// One source with two lines. Deleting the template line clears that field and leaves the other line's token.
async function checkTwoEdges(page, base, cookie, flowId, saveTitle, spec) {
    const edge = page.locator(`[data-testid="rf__edge-${spec.edgeId}"]`)
    await edge.waitFor({ timeout: 10000 })
    const clicked = await edge.evaluate((el) => {
        const button = el.querySelector('button.edgebutton')
        if (!button) return { ok: false, html: el.innerHTML.slice(0, 300) }
        button.click()
        return { ok: true }
    })
    if (!clicked.ok) throw new Error(`${spec.edgeId} has no delete button: ${clicked.html}`)
    await page.waitForTimeout(400)
    if ((await page.locator(`[data-testid="rf__edge-${spec.edgeId}"]`).count()) !== 0) {
        const left = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length)
        throw new Error(`${spec.edgeId} stayed on the canvas (${left} edges)`)
    }
    if ((await page.locator(`[data-testid="rf__edge-${spec.keepEdgeId}"]`).count()) !== 1) {
        throw new Error(`${spec.keepEdgeId} was removed with ${spec.edgeId}`)
    }
    const parsed = await readSavedFlow(page, base, cookie, flowId, saveTitle)
    const target = (parsed.nodes || []).find((node) => node.id === spec.targetId)
    const cleared = target?.data?.inputs?.[spec.clearedField]
    const clearedText = typeof cleared === 'string' ? cleared : JSON.stringify(cleared ?? '')
    if (clearedText.includes(spec.sourceId)) {
        throw new Error(`${spec.clearedField} still mentions ${spec.sourceId} after deleting ${spec.edgeId}`)
    }
    const kept = target?.data?.inputs?.[spec.keptField]
    const keptText = typeof kept === 'string' ? kept : JSON.stringify(kept ?? '')
    if (!keptText.includes(spec.keepToken)) {
        throw new Error(`${spec.keptField} lost ${spec.keepToken} when ${spec.edgeId} was deleted`)
    }
    if ((parsed.edges || []).some((item) => item.id === spec.edgeId)) throw new Error(`saved flow still has ${spec.edgeId}`)
    if (!(parsed.edges || []).some((item) => item.id === spec.keepEdgeId)) throw new Error(`saved flow lost ${spec.keepEdgeId}`)
}

function flowTextHasId(text, id) {
    return new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text)
}

function mentionSpan(text, id, path) {
    const idPart = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tail = path ? '\\.' : '(?:\\\\"|")'
    return new RegExp(`data-id=(?:\\\\")?${idPart}${tail}`).test(text)
}

function inputsMention(parsed, id) {
    for (const node of parsed.nodes || []) {
        const inputs = JSON.stringify(node?.data?.inputs ?? '')
        if (flowTextHasId(inputs, id)) return node.id
    }
    return null
}

async function assertSavedFlow(page, base, cookie, flowId, saveTitle, ids, keptMentions = [], { reload = true, strict = false } = {}) {
    let parsed = await readSavedFlow(page, base, cookie, flowId, saveTitle)
    if (reload) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
        const again = await request(`${base}/api/v1/flow-drafts/${flowId}`, { cookie })
        let reloaded = JSON.parse(again.text || '{}')?.draft?.flowData
        if (!reloaded) {
            const live = await request(`${base}/api/v1/chatflows/${flowId}`, { cookie })
            reloaded = JSON.parse(live.text || '{}')?.flowData
        }
        if (!reloaded) throw new Error('reload did not return the flow')
        parsed = typeof reloaded === 'string' ? JSON.parse(reloaded) : reloaded
    }
    const text = JSON.stringify(parsed)
    for (const id of ids) {
        if (mentionSpan(text, id, false) || mentionSpan(text, id, true)) {
            throw new Error(`saved flow still has a mention span for ${id}`)
        }
        const mentionedOn = inputsMention(parsed, id)
        if (mentionedOn) throw new Error(`saved flow still mentions ${id} on ${mentionedOn}`)
        const nodeLeft = (parsed.nodes || []).some((node) => node.id === id)
        const edgeLeft = (parsed.edges || []).some((edge) => edge.source === id || edge.target === id)
        if (strict) {
            if (flowTextHasId(text, id)) throw new Error(`saved flow still contains ${id}`)
            if (nodeLeft) throw new Error(`saved flow still has card ${id}`)
        }
        if (edgeLeft && !nodeLeft) throw new Error(`saved flow still has a line for ${id}`)
        if (strict && edgeLeft) throw new Error(`saved flow still has a line for ${id}`)
    }
    for (const id of keptMentions) {
        if (!mentionSpan(text, id, false) || !mentionSpan(text, `${id}.output.content`, false)) {
            throw new Error(`saved flow lost the mention span for ${id}`)
        }
    }
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
    const chatSources = []
    for (const [index, label, x] of [
        [1, 'Connected prompt', 480],
        [2, 'Button prompt', 760],
        [3, 'Multi prompt A', 160],
        [4, 'Multi prompt B', 480]
    ]) {
        chatSources.push(
            await buildNode(base, cookie, 'promptTemplate', `promptTemplate_${index}`, {
                label,
                position: { x, y: index < 3 ? 360 : 560 }
            })
        )
    }
    const chatEdges = chatSources.map((node) => connectNodes(node, prompt, 'promptValues', 'buttonedge'))
    prompt.data.inputs.promptValues = chatSources.map((node) => `{{${node.id}.data.instance}}`).join(' ')
    const toolAgent = await buildNode(base, cookie, 'toolAgent', 'toolAgent_0', {
        label: 'Two inputs',
        position: { x: 820, y: 80 }
    })
    chatEdges.push(connectNodes(chatSources[0], toolAgent, 'memory', 'buttonedge'))
    chatEdges.push(connectNodes(chatSources[0], toolAgent, 'tools', 'buttonedge'))
    toolAgent.data.inputs.memory = '{{promptTemplate_1.data.instance}}'
    toolAgent.data.inputs.tools = ['{{promptTemplate_1.data.instance}}', 'keep']
    const chat = await createFlow(base, cookie, {
        name: 'canvas actions chat',
        type: 'CHATFLOW',
        nodes: [prompt, toolAgent, ...chatSources],
        edges: chatEdges
    })
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
    const replyInput = (reply.data.inputParams || []).find((item) => item.acceptVariable) || reply.data.inputParams?.[0]
    const flowSources = []
    for (const [index, label, x, y] of [
        [1, 'Connected reply', 760, 160],
        [2, 'Button reply', 80, 420],
        [3, 'Multi reply A', 420, 420],
        [4, 'Multi reply B', 760, 420]
    ]) {
        const node = await buildNode(base, cookie, 'directReplyAgentflow', `directReplyAgentflow_${index}`, {
            label,
            position: { x, y }
        })
        node.type = 'agentFlow'
        flowSources.push(node)
    }
    const keptReply = await buildNode(base, cookie, 'directReplyAgentflow', 'directReplyAgentflow_10', {
        label: 'Kept reply',
        position: { x: 1080, y: 160 }
    })
    keptReply.type = 'agentFlow'
    flowSources.push(keptReply)
    const flowEdges = flowSources.map((node) => connectNodes(node, reply, replyInput?.name || 'directReplyMessage', 'agentFlow'))
    const mentionSpan = (id) =>
        `<p><span class="variable" data-type="mention" data-id="${id}" data-label="${id}">{{ ${id} }}</span></p><span class="variable" data-type="mention" data-id="${id}.output.content" data-label="${id}.output.content">{{ ${id}.output.content }}</span>`
    reply.data.inputs[replyInput?.name || 'directReplyMessage'] = flowSources.map((node) => mentionSpan(node.id)).join('')
    const flow = await createFlow(base, cookie, {
        name: 'canvas actions workflow',
        type: 'AGENTFLOW',
        nodes: [start, reply, ...flowSources],
        edges: flowEdges
    })
    const chief = await buildNode(base, cookie, 'harnessChief', 'harnessChief_0', {
        label: 'Harness Prime',
        position: { x: 480, y: 40 }
    })
    const specialist = await buildNode(base, cookie, 'harnessSpecialist', 'harnessSpecialist_0', {
        label: 'Helper',
        position: { x: 800, y: 40 }
    })
    specialist.data.inputs.specialistName = 'helper'
    const model = await buildNode(base, cookie, 'chatOllama', 'chatOllama_0', {
        label: 'Local model',
        position: { x: 160, y: 40 }
    })
    model.data.inputs.modelName = 'llama3'
    const harnessPrompt = await buildNode(base, cookie, 'promptTemplate', 'promptTemplate_0', {
        label: 'Harness prompt',
        position: { x: 160, y: 280 }
    })
    const harnessSources = []
    for (let index = 1; index <= 4; index += 1) {
        harnessSources.push(
            await buildNode(base, cookie, 'promptTemplate', `promptTemplate_${index}`, {
                label: `Harness ${index}`,
                position: { x: 160 + (index % 2) * 320, y: 140 + Math.floor(index / 2) * 220 }
            })
        )
    }
    const harnessEdges = [
        connectNodes(model, chief, 'chatModel', 'buttonedge'),
        ...harnessSources.map((node) => connectNodes(node, harnessPrompt, 'promptValues', 'buttonedge'))
    ]
    harnessPrompt.data.inputs.promptValues = harnessSources.map((node) => `{{${node.id}.data.instance}}`).join(' ')
    const harness = await createFlow(base, cookie, {
        name: `canvas-actions-harness-${Date.now()}`,
        type: 'HARNESS',
        nodes: [model, chief, specialist, harnessPrompt, ...harnessSources],
        edges: harnessEdges
    })
    const pipelinePrompt = await buildNode(base, cookie, 'promptTemplate', 'promptTemplate_0', {
        label: 'Pipeline prompt',
        position: { x: 160, y: 140 }
    })
    const pipelineSources = []
    for (let index = 1; index <= 4; index += 1) {
        pipelineSources.push(
            await buildNode(base, cookie, 'promptTemplate', `promptTemplate_${index}`, {
                label: `Pipeline ${index}`,
                position: { x: 160 + (index % 2) * 320, y: 140 + Math.floor(index / 2) * 220 }
            })
        )
    }
    const pipelineEdges = pipelineSources.map((node) => connectNodes(node, pipelinePrompt, 'promptValues', 'buttonedge'))
    pipelinePrompt.data.inputs.promptValues = pipelineSources.map((node) => `{{${node.id}.data.instance}}`).join(' ')
    const pipeline = await createFlow(base, cookie, {
        name: `canvas-actions-pipeline-${Date.now()}`,
        type: 'ETL',
        nodes: [pipelinePrompt, ...pipelineSources],
        edges: pipelineEdges
    })
    return { chat, flow, harness, pipeline }
}

async function persistDeletes(page, base, cookie, spec) {
    await page.goto(`${base}${spec.route}`, { waitUntil: 'domcontentloaded' })
    await page.locator(`.react-flow__node[data-id="${spec.nodeId}"]`).waitFor({ timeout: 20000 })
    await page.waitForTimeout(400)
    await checkConnectedBackspace(page, spec.connectedId, spec.flowName)
    await deleteFromToolbar(page, spec.buttonId)
    await deleteSelectedCards(page, spec.multiIds)
    await assertSavedFlow(page, base, cookie, spec.flowId, spec.saveTitle, spec.removedIds)
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
        await exercise(page, base, {
            route: `/canvas/${flows.chat.id}`,
            nodeId: 'promptTemplate_0',
            connectedId: 'promptTemplate_1',
            buttonId: 'promptTemplate_2',
            multiIds: ['promptTemplate_3', 'promptTemplate_4'],
            removedIds: ['promptTemplate_1', 'promptTemplate_2', 'promptTemplate_3', 'promptTemplate_4'],
            flowName: 'canvas actions chat',
            flowId: flows.chat.id,
            cookie: loggedIn.cookie,
            saveTitle: 'Save Chatflow',
            twoEdge: {
                edgeId: 'promptTemplate_1-toolAgent_0-memory',
                keepEdgeId: 'promptTemplate_1-toolAgent_0-tools',
                targetId: 'toolAgent_0',
                sourceId: 'promptTemplate_1',
                clearedField: 'memory',
                keptField: 'tools',
                keepToken: '{{promptTemplate_1.data.instance}}'
            }
        })
        console.log('chatflow canvas actions ok')
        await exercise(page, base, {
            route: `/v2/agentcanvas/${flows.flow.id}`,
            nodeId: 'directReplyAgentflow_0',
            connectedId: 'directReplyAgentflow_1',
            buttonId: 'directReplyAgentflow_2',
            multiIds: ['directReplyAgentflow_3', 'directReplyAgentflow_4'],
            removedIds: ['directReplyAgentflow_1', 'directReplyAgentflow_2', 'directReplyAgentflow_3', 'directReplyAgentflow_4'],
            flowName: 'canvas actions workflow',
            flowId: flows.flow.id,
            cookie: loggedIn.cookie,
            saveTitle: 'Save Agents',
            selectEdge: true,
            keptMentions: ['directReplyAgentflow_10']
        })
        console.log('workflow canvas actions ok')
        await persistDeletes(page, base, loggedIn.cookie, {
            route: `/harnesscanvas/${flows.harness.id}`,
            nodeId: 'promptTemplate_0',
            connectedId: 'promptTemplate_1',
            buttonId: 'promptTemplate_2',
            multiIds: ['promptTemplate_3', 'promptTemplate_4'],
            removedIds: ['promptTemplate_1', 'promptTemplate_2', 'promptTemplate_3', 'promptTemplate_4'],
            flowName: flows.harness.name,
            flowId: flows.harness.id,
            saveTitle: 'Save Harness'
        })
        console.log('harness canvas actions ok')
        await persistDeletes(page, base, loggedIn.cookie, {
            route: `/etlcanvas/${flows.pipeline.id}`,
            nodeId: 'promptTemplate_0',
            connectedId: 'promptTemplate_1',
            buttonId: 'promptTemplate_2',
            multiIds: ['promptTemplate_3', 'promptTemplate_4'],
            removedIds: ['promptTemplate_1', 'promptTemplate_2', 'promptTemplate_3', 'promptTemplate_4'],
            flowName: flows.pipeline.name,
            flowId: flows.pipeline.id,
            saveTitle: 'Save Pipeline'
        })
        console.log('pipeline canvas actions ok')
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
