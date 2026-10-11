// Headless browser check of page routing: the sign-in redirect and where sign-in lands, every main page
// by direct load and by sidebar click, back and forward, a reload on a deep link, the unknown-page route, and the
// unsaved-changes prompt on the chat flow canvas (cancel stays, OK leaves, a saved canvas leaves without asking, and
// saving a new canvas moves it to its own address without asking). Fails on a page error or an error screen.
// Run it against two builds to compare them. Demo data only; prints short pass/fail lines, never the login.
//
// Needs a running Cuttlely (E2E_BASE_URL), a local admin login file (E2E_ADMIN_FILE) and a Playwright with a browser.
// Set E2E_PLAYWRIGHT to a Playwright module path when the repo's copy has no browser installed.
import fs from 'node:fs'
import { BASE, buildNode, upsertFlow } from './lib.mjs'
import { e2e } from './paths.mjs'

const { chromium } = await import(process.env.E2E_PLAYWRIGHT || 'playwright')
const ADMIN_FILE = process.env.E2E_ADMIN_FILE || e2e('admin.json')
const PROMPT = /unsaved changes/i
const ERROR_SCREEN = /Something went wrong|Unexpected Application Error|Error: Minified React error/i
const PAGES = [
    '/chatflows',
    '/agentflows',
    '/harnesses',
    '/etl',
    '/executions',
    '/marketplaces',
    '/tools',
    '/assistants',
    '/credentials',
    '/variables',
    '/apikey',
    '/document-stores'
]

let failures = 0
function check(name, ok, detail = '') {
    if (!ok) failures++
    console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const path = (page) => new URL(page.url()).pathname

async function settle(page) {
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined)
    await page.waitForTimeout(400)
}

async function errorScreen(page) {
    const text = await page
        .locator('body')
        .innerText()
        .catch(() => '')
    return ERROR_SCREEN.test(text)
}

async function signInForm(page, login) {
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(login.email)
    await form.locator('input[type=password]').fill(login.password)
    await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
}

// Watches for window.confirm while `action` runs; answers it with `accept` and returns its message, or '' if none.
async function withConfirm(page, accept, action) {
    let message = ''
    const onDialog = async (dialog) => {
        message = dialog.message()
        if (accept) await dialog.accept()
        else await dialog.dismiss()
    }
    page.on('dialog', onDialog)
    try {
        await action()
        await page.waitForTimeout(800)
    } finally {
        page.off('dialog', onDialog)
    }
    return message
}

async function dragFirstCard(page) {
    const card = page.locator('.react-flow__node').first()
    await card.waitFor({ timeout: 20000 })
    const box = await card.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 80, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
}

async function openSavedFromList(page) {
    await page.goto(`${BASE}/chatflows`)
    await settle(page)
    await page.getByText('router-e2e saved flow', { exact: true }).first().click()
    await page.waitForURL((url) => url.pathname === `/canvas/${saved.id}`, { timeout: 20000 })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await settle(page)
}

const login = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'))
const prompt = await buildNode('promptTemplate', 'promptTemplate_0', { label: 'Router check prompt', position: { x: 100, y: 100 } })
const saved = await upsertFlow({ name: 'router-e2e saved flow', type: 'CHATFLOW', nodes: [prompt], edges: [] })
const flowData = JSON.stringify({ nodes: [prompt], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })

const browser = await chromium.launch({ headless: true })
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error).slice(0, 200)))

    // Signed out: a protected page sends you to sign in, and signing in brings you back to it.
    await page.goto(`${BASE}/credentials`)
    await settle(page)
    check('signed out /credentials goes to sign in', ['/login', '/signin'].includes(path(page)), path(page))
    await signInForm(page, login)
    await page.waitForURL((url) => !['/login', '/signin'].includes(url.pathname), { timeout: 20000 }).catch(() => undefined)
    await settle(page)
    // React Router 6 builds land on / here too (/login hands over to /signin without the page asked for), so this only
    // reports where sign-in lands, for comparing two builds.
    check('sign in leaves the sign-in page', !['/login', '/signin'].includes(path(page)), `landed on ${path(page)}`)

    // Every main page by direct load.
    for (const route of PAGES) {
        const before = pageErrors.length
        await page.goto(`${BASE}${route}`)
        await settle(page)
        const bad = await errorScreen(page)
        check(`load ${route}`, path(page) === route && !bad && pageErrors.length === before, bad ? 'error screen' : path(page))
    }

    // Sidebar clicks are client-side navigation, then back and forward.
    await page.goto(`${BASE}/chatflows`)
    await settle(page)
    const visited = []
    for (const route of ['/marketplaces', '/tools', '/credentials']) {
        const link = page.locator(`a[href$="${route}"]`).first()
        if (!(await link.count())) {
            check(`sidebar link ${route}`, false, 'no link')
            continue
        }
        await link.click()
        await settle(page)
        check(`sidebar click ${route}`, path(page) === route && !(await errorScreen(page)), path(page))
        visited.push(route)
    }
    await page.goBack()
    await settle(page)
    check('back', path(page) === (visited.length > 1 ? visited[visited.length - 2] : '/chatflows'), path(page))
    await page.goForward()
    await settle(page)
    check('forward', path(page) === visited[visited.length - 1], path(page))

    // Unknown page: the catch-all route renders, not an error screen.
    await page.goto(`${BASE}/no-such-page-router-e2e`)
    await settle(page)
    check('unknown page', !(await errorScreen(page)), path(page))

    // A saved canvas: deep link and reload.
    await page.goto(`${BASE}/chatflows`)
    await settle(page)
    await page.goto(`${BASE}/canvas/${saved.id}`)
    await settle(page)
    await page.reload()
    await settle(page)
    check('reload /canvas/:id', path(page) === `/canvas/${saved.id}` && (await page.locator('.react-flow__node').count()) > 0)

    // Clean canvas, opened from the list (client-side navigation): Back returns to the list without asking.
    await openSavedFromList(page)
    let asked = await withConfirm(page, true, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('clean canvas Back returns to the list without a prompt', !asked && path(page) === '/chatflows', asked || path(page))

    // Dirty canvas: Back and browser back ask; cancel stays, OK leaves.
    await openSavedFromList(page)
    await dragFirstCard(page)
    asked = await withConfirm(page, false, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('dirty canvas Back asks', PROMPT.test(asked), asked || 'no prompt')
    check('cancel stays on the canvas', path(page) === `/canvas/${saved.id}`, path(page))
    asked = await withConfirm(page, false, () => page.goBack({ timeout: 3000 }).catch(() => undefined))
    await settle(page)
    check('browser back on a dirty canvas asks', PROMPT.test(asked) && path(page) === `/canvas/${saved.id}`, asked || path(page))
    asked = await withConfirm(page, true, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('OK leaves the canvas', PROMPT.test(asked) && path(page) === '/chatflows', path(page))

    // Dirty then saved: leaves without asking.
    await openSavedFromList(page)
    await dragFirstCard(page)
    await page.locator('[title^="Save "]').first().click()
    await settle(page)
    asked = await withConfirm(page, true, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('saved canvas leaves without a prompt', !asked && path(page) === '/chatflows', asked || path(page))

    // A new canvas with content (Add New from the list) asks before leaving; saving it moves it to /canvas/:id without
    // asking, and opens again at that address.
    await page.goto(`${BASE}/chatflows`)
    await settle(page)
    await page.evaluate((data) => localStorage.setItem('duplicatedFlowData', data), flowData)
    await page
        .getByRole('button', { name: /Add New/ })
        .first()
        .click()
    await settle(page)
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    asked = await withConfirm(page, false, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('new canvas with content asks', PROMPT.test(asked) && path(page) === '/canvas', asked || path(page))
    asked = await withConfirm(page, true, async () => {
        await page.locator('[title^="Save "]').first().click()
        const name = page.locator('#chatflow-name')
        await name.waitFor({ timeout: 10000 })
        await name.fill(`router-e2e new flow ${Date.now()}`)
        await page
            .getByRole('dialog')
            .getByRole('button', { name: /^Save$/ })
            .click()
    })
    await settle(page)
    const newPath = path(page)
    check(
        'saving a new canvas moves to /canvas/:id without a prompt',
        !asked && /^\/canvas\/[0-9a-f-]{36}$/.test(newPath),
        asked || newPath
    )
    asked = await withConfirm(page, true, () => page.locator('[title="Back"]').first().click())
    await settle(page)
    check('the new saved canvas leaves without a prompt', !asked && path(page) !== newPath, asked || path(page))
    await page.goto(`${BASE}${newPath}`)
    await settle(page)
    check(
        'the new canvas opens at its address',
        path(page) === newPath && (await page.locator('.react-flow__node').count()) > 0,
        path(page)
    )

    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
    await browser.close()
}

console.log(failures ? `router e2e: ${failures} failed` : 'router e2e: all passed')
process.exit(failures ? 1 : 0)
