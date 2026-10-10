// Build with AI with a real model. Builds workflows from plain descriptions through the route the canvas uses,
// saves each the way the canvas does, asks it one of its starter questions, and opens it in a browser. Then
// drives the Build with AI button once on screen: build, confirm before replacing, Undo, save, starter questions.
// The OpenAI key is read from OPENAI_API_KEY only to store it as a credential; it is never printed.
// Env: E2E_BASE_URL, E2E_ADMIN_FILE, E2E_PLAYWRIGHT (playwright index.mjs), BUILDER_OUT (screenshots, outside the repo).
import fs from 'node:fs'
import path from 'node:path'
import { BASE, api, log, redact } from './lib.mjs'

const OUT = process.env.BUILDER_OUT || path.join(process.cwd(), '..', 'builder-e2e-out')
const MODEL = process.env.BUILDER_MODEL || 'gpt-4.1-mini'
const CREDENTIAL = process.env.BUILDER_CREDENTIAL || 'OpenAI demo'
const ONLY_UI = process.env.BUILDER_ONLY_UI === '1'
fs.mkdirSync(OUT, { recursive: true })

const PROMPTS = [
    'A friendly cooking helper that answers questions about recipes and kitchen basics.',
    'Sort each customer message into billing, technical or other, and answer each kind with its own specialist.',
    'Translate the text into French, then have a second step check the translation and fix any mistakes.',
    'An agent that solves math questions and unit conversions with a calculator tool.',
    'Plan a short blog post: first outline it, then write it, then sum it up in one sentence for social media.'
]
const UI_PROMPT = 'An assistant that explains a word in simple English, then gives one example sentence.'
const UI_REPLACE_PROMPT = 'Answer gardening questions in three short bullet points.'

async function ensureCredential() {
    const list = await api('GET', '/credentials')
    const found = list.find((c) => c.name === CREDENTIAL && c.credentialName === 'openAIApi')
    if (found) return found.id
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY is not set')
    const created = await api('POST', '/credentials', {
        name: CREDENTIAL,
        credentialName: 'openAIApi',
        plainDataObj: { openAIApiKey: key }
    })
    log(`created credential "${CREDENTIAL}"`)
    return created.id
}

const buildingModel = (credential) => ({
    name: 'chatOpenAI',
    credential,
    inputs: { FLOWISE_CREDENTIAL_ID: credential, modelName: MODEL, temperature: 0.2 }
})

// What the canvas does on save: a card's own credential moves from its inputs to data.credential.
const asSaved = (nodes) =>
    nodes.map((node) => {
        const data = { ...node.data, inputs: { ...(node.data.inputs || {}) } }
        if ('FLOWISE_CREDENTIAL_ID' in data.inputs) {
            data.credential = data.inputs.FLOWISE_CREDENTIAL_ID
            delete data.inputs.FLOWISE_CREDENTIAL_ID
        }
        return { ...node, data: { ...data, selected: false } }
    })

const starterConfig = (questions) =>
    JSON.stringify({ starterPrompts: Object.fromEntries(questions.map((prompt, i) => [String(i), { prompt }])) })

const answerText = (reply) => {
    if (!reply) return ''
    if (typeof reply.text === 'string' && reply.text.trim()) return reply.text
    if (typeof reply.json === 'object') return JSON.stringify(reply.json)
    return ''
}

const results = []
const credential = await ensureCredential()
const model = buildingModel(credential)

if (!ONLY_UI) {
    for (const [index, prompt] of PROMPTS.entries()) {
        const n = index + 1
        const started = Date.now()
        const result = await api('POST', '/builder/workflow/build', { question: prompt, selectedChatModel: model })
        const seconds = Math.round((Date.now() - started) / 1000)
        if (!result?.ok) {
            log(`#${n} FAILED the check after ${seconds}s:`, redact(JSON.stringify(result?.problems)))
            results.push({ n, prompt, ok: false, problems: result?.problems })
            continue
        }
        const flow = await api('POST', '/chatflows', {
            name: `Built ${n}: ${result.title || 'workflow'}`,
            type: 'AGENTFLOW',
            deployed: false,
            flowData: JSON.stringify({ nodes: asSaved(result.nodes), edges: result.edges, viewport: { x: 0, y: 0, zoom: 1 } }),
            chatbotConfig: starterConfig(result.starterQuestions)
        })
        const question = result.starterQuestions[0]
        const reply = await api('POST', `/internal-prediction/${flow.id}`, { question, streaming: false })
        const answer = answerText(reply)
        const parts = result.nodes.map((node) => node.data.name)
        log(
            `#${n} built in ${seconds}s${result.repaired ? ' (after one repair)' : ''}: "${result.title}", ${parts.length} cards, ${
                result.edges.length
            } links, missing credentials: ${result.missingCredentials.length}; answer ${answer.length} chars`
        )
        results.push({
            n,
            prompt,
            // A real answer: text, and no reference to another card left unfilled.
            ok: Boolean(answer.trim()) && !/{{\s*[\w$.]+\s*}}/.test(answer),
            repaired: result.repaired,
            title: result.title,
            flowId: flow.id,
            parts,
            starterQuestions: result.starterQuestions,
            missingCredentials: result.missingCredentials,
            question,
            answer: redact(answer).slice(0, 400)
        })
    }
}

const { chromium } = await import(process.env.E2E_PLAYWRIGHT)
const login = JSON.parse(fs.readFileSync(process.env.E2E_ADMIN_FILE, 'utf8'))
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1366, height: 820 } })
const page = await context.newPage()
await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' })
const form = page
    .locator('form')
    .filter({ has: page.locator('input[type=password]') })
    .first()
await form.locator('input').first().fill(login.email)
await form.locator('input[type=password]').fill(login.password)
await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
const shot = (name) => page.screenshot({ path: path.join(OUT, name) })
const fit = async () => {
    await page
        .locator('.react-flow__controls-fitview')
        .click()
        .catch(() => {})
    await page.waitForTimeout(600)
}

// Every built workflow opens on the canvas with all its cards drawn.
for (const r of results.filter((x) => x.flowId)) {
    await page.goto(`${BASE}/v2/agentcanvas/${r.flowId}`, { waitUntil: 'networkidle' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    await fit()
    r.drawn = await page.locator('.react-flow__node').count()
    r.opened = r.drawn === r.parts.length
    await shot(`built-${r.n}.png`)
    log(`#${r.n} opened: ${r.drawn}/${r.parts.length} cards drawn`)
}

// On screen: the remembered model, Build with AI on an empty canvas, then confirm before replacing, and Undo.
const ui = { steps: [] }
const step = (name, ok, detail = '') => {
    ui.steps.push({ name, ok, detail })
    log(`UI ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
}
await page.evaluate((value) => window.localStorage.setItem('cuttlely.builderModel', JSON.stringify(value)), {
    name: model.name,
    credential,
    inputs: model.inputs
})
await page.goto(`${BASE}/v2/agentcanvas`, { waitUntil: 'networkidle' })
await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
const button = page.getByRole('button', { name: 'Build with AI' })
step('button named Build with AI', (await button.count()) === 1)
await button.click()
const dialog = page.getByRole('dialog', { name: 'Build with AI' })
await dialog.waitFor()
await dialog.getByPlaceholder('Describe your workflow').first().fill(UI_PROMPT)
await page.waitForTimeout(800)
step('prompt line Describe your workflow', (await dialog.getByText('Describe your workflow', { exact: true }).count()) >= 1)
await shot('ui-dialog.png')
const buildButton = dialog.getByRole('button', { name: 'Build', exact: true })
step('remembered model fills the dialog', await buildButton.isEnabled())
await buildButton.click()
await dialog.waitFor({ state: 'detached', timeout: 240000 })
await page.waitForTimeout(1500)
const firstCount = await page.locator('.react-flow__node').count()
step('builds in place on an empty canvas', firstCount > 1, `${firstCount} cards`)
await shot('ui-built.png')
const firstIds = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort())

await button.click()
await dialog.waitFor()
await dialog.getByPlaceholder('Describe your workflow').first().fill(UI_REPLACE_PROMPT)
await dialog.getByRole('button', { name: 'Build', exact: true }).click()
const landing = page.getByRole('dialog', { name: 'Your canvas already has cards' })
await landing.waitFor({ timeout: 240000 })
await page.waitForTimeout(500)
const focused = await page.evaluate(() => document.activeElement?.textContent || '')
step('asks before replacing, Start a new one is the default', focused.includes('Start a new one'), `focus on "${focused}"`)
await shot('ui-confirm.png')
await landing.getByRole('button', { name: 'Replace this canvas' }).click()
await page.waitForTimeout(1500)
const undo = page.getByRole('button', { name: 'Undo' })
step('Replace offers Undo', (await undo.count()) >= 1)
await shot('ui-replaced.png')
await undo.first().click()
await page.waitForTimeout(800)
const afterUndo = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort())
step('Undo brings the old cards back', JSON.stringify(afterUndo) === JSON.stringify(firstIds), `${afterUndo.length} cards`)

// Save: the first save carries the starter questions into the test chat.
await page.getByTitle(/^Save/).first().click()
const saveDialog = page.getByRole('dialog')
await saveDialog.locator('input').first().fill('Built on screen: word helper')
await saveDialog.getByRole('button', { name: 'Save' }).click()
await page.waitForURL(/\/v2\/agentcanvas\/[0-9a-f-]{36}/, { timeout: 20000 })
await page.waitForTimeout(1500)
const savedId = page.url().split('/').pop()
const saved = await api('GET', `/chatflows/${savedId}`)
const starters = Object.values(JSON.parse(saved.chatbotConfig || '{}').starterPrompts || {}).map((s) => s.prompt)
step('first save keeps the starter questions', starters.length === 3, starters.join(' | '))
await shot('ui-saved.png')
await page.getByRole('button', { name: 'chat', exact: true }).click()
await page.waitForTimeout(1500)
const starterShown = starters.length
    ? await page
          .getByText(starters[0])
          .first()
          .isVisible()
          .catch(() => false)
    : false
step('starter questions wait in the test chat', starterShown)
await shot('ui-test-chat.png')
if (starterShown) {
    await page.getByText(starters[0]).first().click()
    await page.waitForTimeout(20000)
    await shot('ui-test-chat-answer.png')
}
ui.flowId = savedId
await browser.close()

const summary = {
    model: MODEL,
    results: results.map(({ answer, ...rest }) => ({ ...rest, answerPreview: answer })),
    ui
}
fs.writeFileSync(path.join(OUT, 'builder-e2e.json'), JSON.stringify(summary, null, 2))
const failed = results.filter((r) => !r.ok || !r.opened).length + ui.steps.filter((s) => !s.ok).length
log(
    `builder e2e: ${results.filter((r) => r.ok && r.opened).length}/${results.length} built, checked, opened and answered; UI ${
        ui.steps.filter((s) => s.ok).length
    }/${ui.steps.length}`
)
process.exit(failed ? 1 : 0)
