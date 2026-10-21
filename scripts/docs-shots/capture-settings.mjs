// Retake the docs pictures for server settings, sign-in, roles, a first run, and imports.
// Headless, fixed viewports, light theme, empty data directories, local owner only.
// Not part of the runtime image (.dockerignore) and not part of any npm package.
// It does not sign in to an outside service and it does not print secret values.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeFor } from './theme.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const IMAGES = path.join(ROOT, 'docs/images')
const SERVER = path.join(ROOT, 'packages/server')
const EXAMPLES = path.join(ROOT, 'examples/imports')
const PASSWORD = 'DocsShot1!'
const ROSA = { name: 'Rosa Diaz', email: 'rosa.diaz@example.com' }
const CASEY = { name: 'Casey Quinn', email: 'casey.quinn@example.com' }
const AVERY = { name: 'Avery Chen', email: 'avery.chen@example.com' }
// Obviously fake. Typed into a masked field. Never written to a log.
const FAKE_AUTHKIT_KEY = ['sk', 'test', 'demo', 'bakery', 'not', 'real'].join('_')
const FAKE_CLIENT_ID = 'client_demo_bakery'
const WIDE = { width: 1440, height: 960 }
const TALL = { width: 1440, height: 1240 }

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(() => resolve(port))
        })
    })
}

function childEnv(dataDir, port, extra) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE_URL|API_KEY/i.test(key) && key !== 'SECRETKEY_PATH') delete env[key]
    }
    delete env.CUTTLELY_LOCAL_ADMIN
    delete env.WORKOS_API_KEY
    delete env.WORKOS_CLIENT_ID
    delete env.WORKOS_REDIRECT_URI
    delete env.WORKOS_COOKIE_PASSWORD
    delete env.MODEL_LIST_CONFIG_JSON
    env.HOST = '127.0.0.1'
    env.PORT = String(port)
    env.DATABASE_PATH = dataDir
    env.SECRETKEY_PATH = dataDir
    env.CUTTLELY_DATA_DIR = path.join(dataDir, 'cuttlely')
    env.CUTTLELY_WARM_HERMES = 'false'
    env.CUTTLELY_HARNESS_QUEUE = 'off'
    env.PATH = process.env.PATH
    return { ...env, ...extra }
}

function startServer(dataDir, port, extra) {
    const logs = []
    const child = spawn(
        process.execPath,
        [
            '-r',
            path.join(ROOT, 'scripts/refuse-sso-load.cjs'),
            '-r',
            path.join(ROOT, 'scripts/smoke-fake-model.cjs'),
            path.join(SERVER, 'bin/run'),
            'start'
        ],
        { cwd: SERVER, env: childEnv(dataDir, port, extra), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const keep = (chunk) => {
        logs.push(String(chunk))
        if (logs.length > 200) logs.shift()
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
    return { child, logs, stop, dataDir, port, base: `http://127.0.0.1:${port}` }
}

async function waitForPing(server) {
    const deadline = Date.now() + 12 * 60 * 1000
    let last = ''
    while (Date.now() < deadline) {
        if (server.child.exitCode !== null) throw new Error(`server exited ${server.child.exitCode}\n${server.logs.join('').slice(-2000)}`)
        try {
            const response = await fetch(`${server.base}/api/v1/ping`, { signal: AbortSignal.timeout(2000) })
            const text = await response.text()
            if (response.status === 200 && text.includes('pong')) return
            last = `${response.status} ${text.slice(0, 120)}`
        } catch (error) {
            last = error instanceof Error ? error.name : 'waiting'
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`server did not answer ping (${last})\n${server.logs.join('').slice(-2000)}`)
}

async function launchBrowser() {
    const { chromium } = require('playwright')
    const args = ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1']
    try {
        return await chromium.launch({ channel: 'chrome', args })
    } catch {
        return chromium.launch({ args })
    }
}

async function newPage(browser, size = WIDE) {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: 'light' })
    await context.addInitScript(() => {
        localStorage.setItem('isDarkMode', 'false')
    })
    await context.route(/workos\.com/i, (route) => route.abort())
    const page = await context.newPage()
    page.on('dialog', (dialog) => dialog.accept())
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    return { context, page }
}

// Tall enough that the whole Admin group shows in the sidebar.
const ADMIN_VIEW = { width: 1440, height: 1400 }
const ADMIN_ORDER = ['Users', 'Teams', 'Roles', 'Server Settings', 'Logs', 'Audit log', 'Version History']

async function assertAdminMenu(page, rel) {
    const tops = []
    for (const label of ADMIN_ORDER) {
        const item = page.locator('nav, aside, .MuiDrawer-root').getByText(label, { exact: true }).last()
        const box = await item.boundingBox()
        if (!box || box.y + box.height > ADMIN_VIEW.height) throw new Error(`${rel}: Admin > ${label} is not on screen`)
        tops.push(box.y)
    }
    if (tops.some((top, i) => i && top <= tops[i - 1]))
        throw new Error(`${rel}: the Admin menu is not in the order ${ADMIN_ORDER.join(', ')}`)
}

// A frame with a canvas on screen is dark. Admin, settings, sign-in and list pages stay light.
const CANVAS_PATH = /^\/(canvas|agentcanvas|v2\/agentcanvas|harnesscanvas|etlcanvas)(\/|$)/

async function shot(page, rel, size = WIDE) {
    if (size) await page.setViewportSize(size)
    await themeFor(page, CANVAS_PATH.test(new URL(page.url()).pathname))
    const file = path.join(IMAGES, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    await page.screenshot({ path: file, animations: 'disabled' })
    console.log('wrote', rel)
}

async function shotBox(page, locator, rel, clip) {
    const box = await locator.boundingBox()
    if (!box) throw new Error(`no box for ${rel}`)
    const file = path.join(IMAGES, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    const region = clip
        ? { x: box.x, y: box.y, width: Math.min(clip.width, box.width), height: Math.min(clip.height, box.height) }
        : { x: box.x, y: box.y, width: box.width, height: box.height }
    await page.screenshot({ path: file, animations: 'disabled', clip: region })
    console.log('wrote', rel, `${Math.round(region.width)}x${Math.round(region.height)}`)
}

function setupCodeFrom(server) {
    const joined = server.logs.join('')
    const match = joined.match(/Setup code:\s*([A-Za-z0-9_-]+)/)
    if (!match) throw new Error(`no setup code in the log\n${joined.slice(-1500)}`)
    return match[1]
}

async function register(page, base, person, code) {
    await page.goto(`${base}/setup#code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Create the owner account' }).waitFor()
    await page.getByTestId('setup-name').fill(person.name)
    await page.getByTestId('setup-email').fill(person.email)
    await page.getByTestId('setup-password').fill(PASSWORD)
    await page.getByTestId('setup-confirm').fill(PASSWORD)
    await page.getByTestId('setup-create-account').click()
    await page.getByRole('heading', { name: 'Chatflows' }).waitFor({ timeout: 30000 })
}

async function signIn(page, base, email, password = PASSWORD) {
    await page.goto(`${base}/signin`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Sign In' }).waitFor()
    await page.getByPlaceholder('user@company.com').fill(email)
    await page.locator('#break-glass-form input[type="password"]').fill(password)
    await page.locator('#break-glass-form button[type="submit"]').click()
}

async function openAccountMenu(page) {
    await page.locator('header .MuiAvatar-root').last().click()
    await page.getByText('Logout').waitFor()
}

async function openSettings(page, base) {
    await page.goto(`${base}/server-settings`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Server settings' }).waitFor()
    await page.getByTestId('rail-signin').waitFor()
}

async function section(page, id) {
    await page.getByTestId(`rail-${id}`).click()
}

async function fillNumber(page, key, value) {
    const input = page.locator(`#field-${key}`)
    await input.click()
    await input.fill(String(value))
    await input.blur()
}

async function chooseOption(page, key, name) {
    await page.locator(`#field-${key}`).click()
    await page.getByRole('option', { name, exact: true }).click()
}

async function authKitThrough(page, { email } = {}) {
    const dialog = page.getByRole('dialog', { name: 'Set up AuthKit' })
    await dialog.waitFor()
    await dialog.getByTestId('authkit-api-key').fill(FAKE_AUTHKIT_KEY)
    await dialog.getByTestId('authkit-client-id').fill(FAKE_CLIENT_ID)
    await dialog.getByTestId('authkit-environment').first().waitFor()
    await shot(page, 'server-settings/authkit-step-keys.png')
    await dialog.getByTestId('authkit-next').click()
    await dialog.getByText('Add these in WorkOS').waitFor()
    await shot(page, 'server-settings/authkit-step-addresses.png')
    await dialog.getByTestId('authkit-next').click()
    if (email) await dialog.getByTestId('authkit-email').fill(email)
    await dialog.getByTestId('authkit-generate-seal').click()
    await dialog.getByTestId('authkit-seal').waitFor()
    await shot(page, 'server-settings/authkit-step-seal.png')
    await dialog.getByTestId('authkit-next').click()
    await dialog.getByTestId('authkit-check').getByText('API key').waitFor({ timeout: 20000 })
    await shot(page, 'server-settings/authkit-step-check.png')
    await dialog.getByRole('button', { name: 'Close' }).click()
}

async function holdRestart(page, mode) {
    await page.route('**/api/v1/server-settings/restart', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ restarting: true }) })
    )
    let probes = 0
    await page.route('**/api/v1/ping', (route) => {
        probes += 1
        if (mode === 'starting' || probes === 1) {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ status: 'starting', step: 'Loading the building blocks (the slowest step)' })
            })
        }
        return route.fulfill({ status: 200, contentType: 'text/plain', body: 'pong' })
    })
    if (mode === 'failed') {
        await page.route('**/api/v1/server-settings', async (route) => {
            const url = new URL(route.request().url())
            if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/server-settings') return route.continue()
            const response = await route.fetch()
            const json = await response.json()
            json.rolledBack = true
            json.retryAvailable = true
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
        })
    }
    await page.getByTestId('settings-restart').click()
    await page.getByTestId('restart-screen').waitFor()
    const expect = mode === 'starting' ? 'Starting:' : mode === 'failed' ? 'The new settings did not start' : 'Cuttlely is back'
    await page.getByText(expect).first().waitFor({ timeout: 8000 })
    await shot(page, `server-settings/restart-screen-${mode === 'starting' ? 'starting' : mode === 'failed' ? 'failed' : 'back'}.png`)
    await page.unroute('**/api/v1/server-settings/restart')
    await page.unroute('**/api/v1/ping')
    await page.unroute('**/api/v1/server-settings')
    await page.keyboard.press('Escape')
}

async function captureRosa(browser) {
    const server = startServer(mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-rosa-')), 44117, {
        CUTTLELY_LOCAL_ADMIN: 'true',
        LOG_LEVEL: 'info'
    })
    try {
        console.log('rosa', server.base)
        await waitForPing(server)
        const { context, page } = await newPage(browser)
        try {
            const code = setupCodeFrom(server)
            await page.goto(`${server.base}/setup#code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' })
            await page.getByRole('heading', { name: 'Create the owner account' }).waitFor()
            await shot(page, 'from-source/organization-setup.png')
            await register(page, server.base, ROSA, code)
            await shot(page, 'from-source/first-signed-in.png', TALL)

            await openAccountMenu(page)
            await shot(page, 'sign-in/account-menu.png', TALL)
            await page.keyboard.press('Escape')

            await page.getByRole('button', { name: 'Import' }).click()
            await page.getByRole('menuitem', { name: 'Import Langflow JSON' }).waitFor()
            await shot(page, 'bring-your-flows/chatflows-import-buttons.png', TALL)
            await page.getByRole('menuitem', { name: /JSON$/ }).first().click()
            const wizard = page.getByRole('dialog', { name: 'Flowise migration wizard' })
            await wizard.waitFor()
            await shot(page, 'bring-your-flows/wizard-upload.png')
            await wizard.locator('input[type="file"]').setInputFiles(path.join(EXAMPLES, 'bakery-helper.json'))
            await wizard.getByText('Ready to open, with items to finish').waitFor()
            await shot(page, 'bring-your-flows/wizard-scan.png')
            await wizard.getByRole('button', { name: 'Next' }).click()
            await wizard.getByText('Nothing from the file was copied').waitFor()
            await shot(page, 'bring-your-flows/wizard-credentials.png')
            await wizard.getByRole('button', { name: 'Next' }).click()
            await wizard.getByRole('heading', { name: 'Deprecated' }).waitFor()
            await wizard.getByRole('button', { name: 'Next' }).click()
            await wizard.getByRole('button', { name: 'Open migrated canvas' }).waitFor()
            await shot(page, 'bring-your-flows/wizard-result.png')
            await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'classic'))
            await wizard.getByRole('button', { name: 'Open migrated canvas' }).click()
            await page.getByText('ChatOpenAI').first().waitFor({ timeout: 30000 })
            await page.getByText('Conversation Chain').first().waitFor()
            await page
                .locator('.react-flow__controls-fitview')
                .click({ timeout: 3000 })
                .catch(() => {})
            await page
                .locator('input[value="gpt-4.1-mini"]')
                .first()
                .waitFor({ timeout: 5000 })
                .catch(() => {})
            await page.waitForTimeout(400)
            await shot(page, 'bring-your-flows/wizard-opened-canvas.png')

            await page.goto(`${server.base}/chatflows`, { waitUntil: 'domcontentloaded' })
            await page.getByRole('heading', { name: 'Chatflows' }).waitFor()
            await page.evaluate(() => localStorage.setItem('cuttlely.canvasLook', 'classic'))
            const chooser = page.waitForEvent('filechooser')
            await page.getByRole('button', { name: 'Import' }).click()
            await page.getByRole('menuitem', { name: 'Import Langflow JSON' }).click()
            await (await chooser).setFiles(path.join(EXAMPLES, 'bakery-greeter.json'))
            await page.getByText('Bakery greeter').first().waitFor({ timeout: 30000 })
            await page.getByText('Imported from Langflow.').waitFor()
            await page
                .locator('.react-flow__controls-fitview')
                .click({ timeout: 3000 })
                .catch(() => {})
            await page.waitForTimeout(400)
            await shot(page, 'bring-your-flows/langflow-opened.png')

            await openSettings(page, server.base)
            await shot(page, 'server-settings/server-settings-signin.png')
            await shot(page, 'server-settings/server-settings-get-started.png')
            await page.getByTestId('authkit-open').click()
            await authKitThrough(page)

            await section(page, 'models')
            await page.getByTestId('models-credentials-hint').waitFor()
            await shot(page, 'server-settings/server-settings-models.png')

            await section(page, 'storage')
            await page.getByTestId('test-storage-run').click()
            await page.getByTestId('test-storage-result').getByText('can write').waitFor({ timeout: 20000 })
            await shot(page, 'server-settings/test-connection-storage-ok.png')

            await section(page, 'analyst')
            await page.locator('#field-CUTTLELY_POSTGRES_URL').fill('postgres://bakery@127.0.0.1:1/demo')
            await page.getByTestId('test-analyst-run').click()
            await page.getByTestId('test-analyst-result').getByText('Could not connect').waitFor({ timeout: 20000 })
            // The result opens in a Collapse, and the page keeps room under its last setting for the pinned unsaved-change
            // bar. Once the Collapse has finished opening, the end of the page shows the result clear of the bar.
            await page.locator('.MuiCollapse-entered', { has: page.getByTestId('test-analyst-result') }).waitFor()
            await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
            await page.waitForTimeout(300)
            await shot(page, 'server-settings/test-connection-analyst-failed.png')
            const resetDraft = page.getByRole('button', { name: 'Reset' })
            if (await resetDraft.isVisible()) await resetDraft.click()

            await section(page, 'database')
            await page.getByTestId('database-card').waitFor()
            await page
                .getByRole('heading', { name: 'Server settings' })
                .first()
                .evaluate((node) => {
                    for (let el = node.parentElement; el; el = el.parentElement) el.scrollTop = 0
                    window.scrollTo(0, 0)
                })
            await page.waitForTimeout(300)
            await shot(page, 'server-settings/database-card.png')
            await page.getByTestId('database-switch').click()
            const database = page.getByRole('dialog').last()
            await database.getByTestId('db-choice-postgres').waitFor()
            await shot(page, 'server-settings/database-switch-choose.png')
            await database.getByTestId('db-next-step').click()
            await database.locator('[data-testid="db-host"]').fill('127.0.0.1')
            await database.getByLabel('Port').fill('1')
            await database.getByLabel('Database name').fill('bakery')
            await database.locator('[data-testid="db-user"]').fill('bakery')
            await database.getByTestId('db-next-step').click()
            await database.getByText('Connect and sign in').waitFor({ timeout: 20000 })
            await shot(page, 'server-settings/database-switch-test.png')
            await database.getByRole('button', { name: 'Close' }).click()

            await section(page, 'all')
            await page.getByRole('heading', { name: 'All settings' }).waitFor()
            await page.getByTestId('copy-env').waitFor()
            await shot(page, 'server-settings/server-settings-all-settings.png')
            copyFileSync(
                path.join(IMAGES, 'server-settings/server-settings-all-settings.png'),
                path.join(IMAGES, 'server-settings/server-settings-all.png')
            )
            console.log('wrote server-settings/server-settings-all.png')

            await page.getByLabel('Search settings').fill('timeout')
            await page.getByText('MCP sign-in wait').waitFor()
            await shot(page, 'server-settings/server-settings-search.png')
            await page.getByLabel('Clear search').click()
            await page.reload({ waitUntil: 'domcontentloaded' })
            await page.getByTestId('rail-analyst').waitFor()

            await section(page, 'analyst')
            await fillNumber(page, 'CUTTLELY_ANALYST_ROW_CAP', '40')
            await section(page, 'runtime')
            await fillNumber(page, 'CUTTLELY_HERMES_KEEP_WARM_MINUTES', '30')
            await section(page, 'advanced')
            await fillNumber(page, 'CUSTOM_MCP_AUTHORIZE_TIMEOUT_MS', '20')
            await page.getByTestId('settings-review').click()
            const reviewTitle = page.getByRole('heading', { name: /Review/ })
            await reviewTitle.waitFor()
            const reviewText = await reviewTitle.innerText()
            if (reviewText !== 'Review 3 changes') {
                const body = await page.getByRole('dialog').innerText()
                throw new Error(`expected Review 3 changes, got ${reviewText}\n${body.slice(0, 700)}`)
            }
            await shot(page, 'server-settings/server-settings-review.png')
            await page.getByRole('button', { name: 'Back' }).click()
            await page.getByRole('button', { name: 'Reset' }).click()

            await section(page, 'storage')
            await chooseOption(page, 'STORAGE_TYPE', 'S3 or compatible')
            await section(page, 'security')
            await fillNumber(page, 'TRUST_PROXY', '1').catch(async () => {
                await page.locator('#field-TRUST_PROXY').fill('1')
            })
            await page.getByTestId('settings-review').click()
            await page.getByRole('heading', { name: 'Review 2 changes' }).waitFor()
            await page.getByTestId('review-confirm').fill('RESTART')
            await shot(page, 'server-settings/server-settings-review-high-risk.png')
            await page.getByRole('button', { name: 'Back' }).click()
            await page.getByRole('button', { name: 'Reset' }).click()

            await section(page, 'analyst')
            await fillNumber(page, 'CUTTLELY_ANALYST_ROW_CAP', '80')
            await fillNumber(page, 'CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS', '20')
            await section(page, 'runtime')
            await fillNumber(page, 'CUTTLELY_HERMES_KEEP_WARM_MINUTES', '30')
            await section(page, 'advanced')
            await fillNumber(page, 'CUSTOM_MCP_AUTHORIZE_TIMEOUT_MS', '20')
            await fillNumber(page, 'CUSTOM_MCP_TOOL_NAME_MAX_LENGTH', '64')
            await fillNumber(page, 'CUSTOM_MCP_TOOL_DESCRIPTION_MAX_LENGTH', '512')
            await page.getByTestId('settings-save-bar-text').getByText('6 unsaved changes').waitFor()
            await page.getByTestId('settings-review').click()
            await page.getByTestId('review-save').click()
            await page.getByText('Saved. Restart Cuttlely to apply.').waitFor()
            await section(page, 'security')
            await shot(page, 'server-settings/server-settings-saved.png')
            await section(page, 'advanced')
            await page.getByTestId('setting-LOG_LEVEL').scrollIntoViewIfNeeded()
            await shot(page, 'server-settings/server-settings-locked.png')
            await section(page, 'history')
            await page.getByTestId('settings-history').waitFor()
            await page.waitForTimeout(400)
            await shot(page, 'server-settings/server-settings-history.png')

            await holdRestart(page, 'starting')
            await page.reload({ waitUntil: 'domcontentloaded' })
            await page.getByTestId('settings-restart').waitFor()
            await holdRestart(page, 'back')
            await page.reload({ waitUntil: 'domcontentloaded' })
            await page.getByTestId('settings-restart').waitFor()
            await holdRestart(page, 'failed')
        } finally {
            // Sign-out is done below on a fresh navigation if still signed in.
            await context.close()
        }

        const signedOut = await newPage(browser)
        try {
            await signedOut.page.goto(`${server.base}/signin`, { waitUntil: 'domcontentloaded' })
            await signedOut.page.getByRole('heading', { name: 'Sign In' }).waitFor()
            await shot(signedOut.page, 'sign-in/signin-break-glass.png')
            copyFileSync(path.join(IMAGES, 'sign-in/signin-break-glass.png'), path.join(IMAGES, 'from-source/first-open-signin.png'))
            console.log('wrote from-source/first-open-signin.png')
            await signedOut.page.getByPlaceholder('user@company.com').fill(ROSA.email)
            await signedOut.page.locator('#break-glass-form input[type="password"]').fill('wrong-pass')
            await signedOut.page.locator('#break-glass-form button[type="submit"]').click()
            await signedOut.page.getByText('Invalid email or password.').waitFor()
            await shot(signedOut.page, 'sign-in/signin-wrong-password.png')
        } finally {
            await signedOut.context.close()
        }
        const exited = new Promise((resolve) => server.child.once('exit', resolve))
        server.stop()
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))])
        const closed = startServer(server.dataDir, 44120, { LOG_LEVEL: 'info' })
        try {
            console.log('not configured', closed.base)
            await waitForPing(closed)
            const off = await newPage(browser)
            try {
                await off.page.goto(`${closed.base}/signin`, { waitUntil: 'domcontentloaded' })
                await off.page.getByText('Sign-in is not configured.').waitFor()
                await shot(off.page, 'sign-in/signin-not-configured.png')
            } finally {
                await off.context.close()
            }
        } finally {
            closed.stop()
            rmSync(server.dataDir, { recursive: true, force: true })
        }
    } catch (error) {
        server.stop()
        throw error
    }
}

async function captureSetup(browser) {
    const server = startServer(mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-setup-')), 44118, { LOG_LEVEL: 'info' })
    try {
        console.log('setup', server.base)
        await waitForPing(server)
        const joined = server.logs.join('')
        const link = joined.match(/https?:\/\/\S+\/setup#code=[A-Za-z0-9_-]+/)
        if (!link) throw new Error(`no setup link in the log\n${joined.slice(-1500)}`)
        const { context, page } = await newPage(browser)
        try {
            await page.goto(link[0].replace('://localhost', '://127.0.0.1'), { waitUntil: 'domcontentloaded' })
            await page.getByTestId('setup-choose-password').waitFor()
            await shot(page, 'server-settings/setup-link-choose.png')
            await page.getByTestId('setup-choose-authkit').click()
            const dialog = page.getByRole('dialog', { name: 'Set up AuthKit' })
            await dialog.waitFor()
            await dialog.getByTestId('authkit-api-key').fill(FAKE_AUTHKIT_KEY)
            await dialog.getByTestId('authkit-client-id').fill(FAKE_CLIENT_ID)
            await shot(page, 'server-settings/setup-link-authkit.png')
            await dialog.getByRole('button', { name: 'Cancel' }).click()
            await page.getByTestId('setup-choose-password').click()
            await page.getByText('Create the owner account').waitFor()
            await shot(page, 'server-settings/setup-link-password.png')
            const bad = new URL(link[0].replace('://localhost', '://127.0.0.1'))
            bad.hash = 'code=not-a-real-code'
            bad.search = ''
            await page.goto(bad.toString(), { waitUntil: 'domcontentloaded' })
            await page.getByTestId('setup-code').waitFor()
            await page.getByText('This setup link is not right').waitFor()
            await shot(page, 'server-settings/setup-link-closed.png')
        } finally {
            await context.close()
        }
    } finally {
        server.stop()
        rmSync(server.dataDir, { recursive: true, force: true })
    }
}

async function captureRoles(browser, only = null) {
    const want = (rel) => !only || only.has(rel)
    const server = startServer(mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-roles-')), 44119, {
        CUTTLELY_LOCAL_ADMIN: 'true',
        LOG_LEVEL: 'info'
    })
    try {
        console.log('roles', server.base)
        await waitForPing(server)
        const { context, page } = await newPage(browser)
        try {
            await register(page, server.base, CASEY, setupCodeFrom(server))
            await page.goto(`${server.base}/roles`, { waitUntil: 'domcontentloaded' })
            await page.getByRole('button', { name: 'Add Role' }).click()
            const dialog = page.getByRole('dialog', { name: 'Create New Role' })
            await dialog.locator('input').nth(0).fill('Reader')
            await dialog.locator('input').nth(1).fill('Can open chatflows and harnesses.')
            await dialog
                .locator('label')
                .filter({ hasText: /^View$/ })
                .first()
                .click()
            if (want('roles/create-role.png')) await shotBox(page, dialog, 'roles/create-role.png', { width: 900, height: 850 })
            await dialog.getByRole('button', { name: 'Create Role' }).click()
            await page.getByText('Reader').first().waitFor()

            await page.goto(`${server.base}/users`, { waitUntil: 'domcontentloaded' })
            await page.getByRole('button', { name: 'Add User' }).click()
            const add = page.getByRole('dialog', { name: 'Add User' })
            await add.locator('input').nth(0).fill(AVERY.name)
            await add.locator('input').nth(1).fill(AVERY.email)
            const roleBox = add.locator('[role="combobox"]').last()
            await roleBox.click()
            await page.getByRole('option', { name: 'Reader' }).click()
            await shotBox(page, add, 'roles/add-user.png', { width: 600, height: 498 })
            await add.getByRole('button', { name: 'Create User' }).click()
            await page.getByText(AVERY.name).waitFor()
            // A fresh load drops the User created notice, which would sit over the Admin menu.
            await page.reload({ waitUntil: 'domcontentloaded' })
            await page.getByText(AVERY.name).waitFor()
            await page.getByText('INVITED', { exact: true }).first().waitFor()
            await shot(page, 'roles/users-list.png', ADMIN_VIEW)
            await assertAdminMenu(page, 'roles/users-list.png')

            if (want('roles/roles-list.png')) {
                await page.goto(`${server.base}/roles`, { waitUntil: 'domcontentloaded' })
                await page.getByText('Reader').first().waitFor()
                await shot(page, 'roles/roles-list.png')
            }
        } finally {
            await context.close()
        }
    } finally {
        server.stop()
        rmSync(server.dataDir, { recursive: true, force: true })
    }
}

async function safeBoot(browser) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-safe-'))
    const first = startServer(dataDir, 44121, { CUTTLELY_LOCAL_ADMIN: 'true', LOG_LEVEL: 'info' })
    try {
        await waitForPing(first)
        const { context, page } = await newPage(browser)
        try {
            await register(page, first.base, ROSA, setupCodeFrom(first))
            await openSettings(page, first.base)
            await section(page, 'analyst')
            await fillNumber(page, 'CUTTLELY_ANALYST_ROW_CAP', '90')
            await page.getByTestId('settings-review').click()
            await page.getByTestId('review-save').click()
            await page.getByText('Saved. Restart Cuttlely to apply.').waitFor()
        } finally {
            await context.close()
        }
    } finally {
        first.stop()
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
    const settingsDir = path.join(dataDir, 'cuttlely', 'settings')
    writeFileSync(path.join(settingsDir, 'boot.json'), JSON.stringify({ pending: 2 }) + '\n')
    const second = startServer(dataDir, 44122, { CUTTLELY_LOCAL_ADMIN: 'true', LOG_LEVEL: 'info' })
    try {
        console.log('safe boot', second.base)
        await waitForPing(second)
        const { context, page } = await newPage(browser)
        try {
            await signIn(page, second.base, ROSA.email)
            await page.getByRole('heading', { name: 'Chatflows' }).waitFor({ timeout: 30000 })
            await openSettings(page, second.base)
            await page.getByTestId('safe-boot-banner').waitFor()
            await shot(page, 'server-settings/server-settings-safe-boot.png')
        } finally {
            await context.close()
        }
    } finally {
        second.stop()
        rmSync(dataDir, { recursive: true, force: true })
    }
}

async function captureTesting(browser) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-testing-'))
    const port = await freePort()
    const server = startServer(dataDir, port, { CUTTLELY_LOCAL_ADMIN: 'true', CUTTLELY_CHECK_MAX_SECONDS: '90', LOG_LEVEL: 'info' })
    try {
        console.log('testing section', server.base)
        await waitForPing(server)
        const { context, page } = await newPage(browser, TALL)
        try {
            await register(page, server.base, ROSA, setupCodeFrom(server))
            await page.evaluate(() => localStorage.setItem('cuttlely.serverSettings.getStartedDismissed', '1'))
            await openSettings(page, server.base)
            await section(page, 'testing')
            await page.getByTestId('setting-CUTTLELY_PUBLISH_CHECK').waitFor()
            await page.getByTestId('lock-CUTTLELY_CHECK_MAX_SECONDS').waitFor()
            await page.getByTestId('range-CUTTLELY_CHECK_MAX_SECONDS').waitFor()
            await page.getByTestId('readonly-PORT').waitFor()
            await page.getByRole('heading', { name: 'Testing and Limits' }).scrollIntoViewIfNeeded()
            await page.setViewportSize({ width: 1440, height: 2200 })
            const file = path.join(IMAGES, 'server-settings/testing-and-limits.png')
            mkdirSync(path.dirname(file), { recursive: true })
            await page.screenshot({ path: file, animations: 'disabled' })
            console.log('wrote server-settings/testing-and-limits.png')
        } finally {
            await context.close()
        }
    } finally {
        server.stop()
        rmSync(dataDir, { recursive: true, force: true })
    }
}

const LOCAL_PEOPLE = [
    { name: 'Ada Baker', email: 'ada.baker@example.com', role: 'Admin' },
    { name: 'Bea Chen', email: 'bea.chen@example.com', role: 'Builder' },
    { name: 'Cam Diaz', email: 'cam.diaz@example.com', role: 'Viewer' }
]

async function api(page, base, method, url, body) {
    return page.evaluate(
        async ({ base, method, url, body }) => {
            const response = await fetch(`${base}${url}`, {
                method,
                credentials: 'include',
                headers: { 'content-type': 'application/json', 'x-request-from': 'internal' },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await response.text()
            return { status: response.status, text }
        },
        { base, method, url, body }
    )
}

async function captureLocalUsers(browser) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'cuttlely-docs-local-'))
    const port = await freePort()
    const server = startServer(dataDir, port, {
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_LOCAL_USERS: 'true',
        LOG_LEVEL: 'info'
    })
    try {
        console.log('local users', server.base)
        await waitForPing(server)
        const { context, page } = await newPage(browser, { width: 1440, height: 1100 })
        try {
            await register(page, server.base, ROSA, setupCodeFrom(server))
            const signedIn = await page.evaluate(() => {
                const raw = localStorage.getItem('user')
                return raw ? JSON.parse(raw) : null
            })
            const organizationId = signedIn && signedIn.activeOrganizationId
            if (!organizationId) throw new Error('signed-in user has no organization')
            const workspaces = await api(page, server.base, 'GET', `/api/v1/workspace?organizationId=${organizationId}`)
            if (workspaces.status !== 200) throw new Error(`workspaces ${workspaces.status} ${workspaces.text.slice(0, 300)}`)
            const workspaceList = JSON.parse(workspaces.text)
            const rows = Array.isArray(workspaceList) ? workspaceList : workspaceList.workspaces || workspaceList.data || []
            const team = rows.find((item) => item.name === 'Default Workspace') || rows[0]
            if (!team?.id) throw new Error(`no team in ${workspaces.text.slice(0, 300)}`)
            const roles = await api(page, server.base, 'GET', `/api/v1/role?organizationId=${organizationId}`)
            if (roles.status !== 200) throw new Error(`roles ${roles.status} ${roles.text.slice(0, 300)}`)
            const roleBody = JSON.parse(roles.text)
            const roleRows = Array.isArray(roleBody) ? roleBody : roleBody.roles || roleBody.data || []
            let viewerLink = ''
            for (const person of LOCAL_PEOPLE) {
                const role = roleRows.find((item) => String(item.name).toLowerCase() === person.role.toLowerCase())
                if (!role?.id) throw new Error(`missing role ${person.role}`)
                const created = await api(page, server.base, 'POST', '/api/v1/account/invite', {
                    user: { name: person.name, email: person.email },
                    workspace: { id: team.id },
                    role: { id: role.id },
                    link: true
                })
                if (created.status !== 200) {
                    const safe = created.text.replace(/#token=[^"\\]+/g, '#token=[redacted]')
                    throw new Error(`invite ${person.email} ${created.status} ${safe.slice(0, 300)}`)
                }
                const body = JSON.parse(created.text)
                if (typeof body.link !== 'string' || !body.link.includes('#token=')) {
                    throw new Error(`invite did not return a one-time link for ${person.email}`)
                }
                if (person.role === 'Viewer') viewerLink = body.link
            }
            const token = decodeURIComponent(new URL(viewerLink).hash.replace(/^#token=/, ''))
            viewerLink = ''
            const accepted = await fetch(`${server.base}/api/v1/auth/local/accept`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-request-from': 'internal' },
                body: JSON.stringify({ token, password: PASSWORD })
            })
            if (accepted.status !== 200) throw new Error(`accept failed ${accepted.status}`)
            const member = await newPage(browser)
            try {
                await member.page.goto(`${server.base}/signin`, { waitUntil: 'domcontentloaded' })
                const form = member.page.locator('#local-users-form')
                await form.waitFor()
                await form.locator('input').nth(0).fill('cam.diaz@example.com')
                await form.locator('input[type="password"]').fill(PASSWORD)
                await form.getByRole('button', { name: 'Sign in' }).click()
                await member.page.getByRole('heading', { name: 'Chatflows' }).waitFor({ timeout: 30000 })
            } finally {
                await member.context.close()
            }
            await page.goto(`${server.base}/users`, { waitUntil: 'domcontentloaded' })
            await page.getByText('Ada Baker').waitFor()
            await page.getByText('Owner, Admin, Builder, and Viewer are built-in.').waitFor()
            await page.locator('tr', { hasText: 'Ada Baker' }).locator('button[aria-label="expand row"]').click()
            await page.getByRole('heading', { name: 'Assigned Roles' }).waitFor()
            await page.getByRole('cell', { name: 'Admin' }).waitFor()
            await shot(page, 'users/users-list.png', ADMIN_VIEW)
            await assertAdminMenu(page, 'users/users-list.png')
            await page.keyboard.press('Escape')

            await page.locator('tr', { hasText: 'Cam Diaz' }).locator('button[title="Sessions"]').click()
            await page.getByRole('heading', { name: 'Sessions' }).waitFor()
            await page.getByText('Open sign-ins for Cam Diaz').waitFor()
            await page.getByText(/Started /).waitFor()
            await shot(page, 'users/sessions-list.png', ADMIN_VIEW)
            await assertAdminMenu(page, 'users/sessions-list.png')

            const saved = await api(page, server.base, 'PUT', '/api/v1/server-settings', {
                values: { CUTTLELY_AUDIT_RETENTION_DAYS: 120 }
            })
            if (saved.status !== 200) throw new Error(`settings ${saved.status} ${saved.text}`)
            await page.goto(`${server.base}/audit`, { waitUntil: 'domcontentloaded' })
            await page.getByRole('heading', { name: 'Audit log' }).waitFor()
            await page.getByLabel('Type').click()
            await page.getByRole('option', { name: 'Settings changed' }).click()
            await page.getByRole('columnheader', { name: 'Detail' }).waitFor()
            await page.getByText('CUTTLELY_AUDIT_RETENTION_DAYS').waitFor()
            await shot(page, 'audit/audit-log.png', ADMIN_VIEW)
            await assertAdminMenu(page, 'audit/audit-log.png')
        } finally {
            await context.close()
        }
    } finally {
        server.stop()
        rmSync(dataDir, { recursive: true, force: true })
    }
}

async function main() {
    if (!existsSync(path.join(SERVER, 'dist/ui'))) throw new Error('Build first: pnpm build')
    const browser = await launchBrowser()
    try {
        if (process.env.DOCS_SHOTS === 'testing') {
            await captureTesting(browser)
            return
        }
        if (process.env.DOCS_SHOTS === 'roles') {
            await captureRoles(browser, new Set(['roles/add-user.png', 'roles/users-list.png']))
            return
        }
        if (process.env.DOCS_SHOTS === 'local-users') {
            await captureLocalUsers(browser)
            return
        }
        await captureLocalUsers(browser)
        await captureRosa(browser)
        await captureSetup(browser)
        await captureRoles(browser)
        await safeBoot(browser)
        if (existsSync(path.join(IMAGES, 'server-settings/server-settings-signin-dark.png'))) {
            rmSync(path.join(IMAGES, 'server-settings/server-settings-signin-dark.png'))
            console.log('removed server-settings/server-settings-signin-dark.png')
        }
    } finally {
        await browser.close()
    }
    const png = readFileSync(path.join(IMAGES, 'server-settings/server-settings-signin.png'))
    if (png.readUInt32BE(16) !== 1440) throw new Error('signin shot is not 1440 wide')
    console.log('docs shots done')
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
