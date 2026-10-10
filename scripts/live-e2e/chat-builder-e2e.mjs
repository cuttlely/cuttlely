// Build with AI for chatflows, with a real model. Builds an assistant from each plain description through the route
// the canvas uses and saves it the way the canvas saves a built chatflow the first time: Live stays empty and the
// built cards become the draft. Then the test chat (which runs the draft) answers one starter question, and the
// publish check offers the starter questions and asks them on Live and on the draft.
// With CHAT_BUILDER_UI=1 (or =only to skip the API part) it then builds on screen: Build with AI on a new chatflow
// canvas, the cards land unsaved, the first save is a draft, a starter question is answered in the test chat, and
// the Publish dialog's check runs the starter questions. It runs in the new look (the default), then once more with
// Classic cards.
// Env: E2E_BASE_URL, E2E_ADMIN_FILE, E2E_PLAYWRIGHT, BUILDER_OUT (screenshots, outside the repo).
import fs from 'node:fs'
import path from 'node:path'
import { BASE, api, log, redact, sleep } from './lib.mjs'
import { MODEL, asSaved, buildingModel, ensureCredential, fitView, signedInPage, starterConfig } from './builder-lib.mjs'

const OUT = process.env.BUILDER_OUT || path.join(process.cwd(), '..', 'chat-builder-out')
fs.mkdirSync(OUT, { recursive: true })
const stamp = Date.now().toString(36)
const EMPTY = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })

export const ASSISTANTS = [
    'A math helper that uses a calculator to work out sums, percentages and tips.',
    'A support assistant for the Lumen desk lamp that answers only from these facts: it has three brightness levels, charges over USB-C, and has a two-year warranty.',
    'A friendly assistant that helps me write short, polite emails.',
    'A study buddy that remembers our conversation and quizzes me on world capitals.',
    'A cooking assistant that suggests simple recipes and works out calories per serving with a calculator.'
]
const SERVICE = 'A research assistant that searches the web with Tavily and sums up what it finds.'
const UI = process.env.CHAT_BUILDER_UI || ''

const credential = await ensureCredential()
const model = buildingModel(credential)
const results = []

// The publish check with the questions it offers: start it, wait for it, and read every answer on the draft.
async function publishCheck(id, starters) {
    const setup = await api('GET', `/flow-drafts/${id}/check`)
    // Recent questions come first (the test chat already asked one starter), then the starters not asked yet.
    const offered = (setup.questions || []).map((q) => q.text)
    const covered = starters.every((starter) => offered.some((text) => text.toLowerCase() === starter.toLowerCase()))
    if (setup.unavailable || !offered.length) return { offered, covered, unavailable: setup.unavailable?.message || null, cases: [] }
    let check
    try {
        check = await api('POST', `/flow-drafts/${id}/check`, { questions: offered })
    } catch (error) {
        return { offered, covered, unavailable: redact(error.message).slice(0, 300), cases: [] }
    }
    for (let i = 0; i < 120 && check.status === 'running'; i += 1) {
        await sleep(2000)
        check = await api('GET', `/flow-drafts/${id}/check/${check.id}`)
    }
    return {
        offered,
        covered,
        status: check.status,
        cases: (check.cases || []).map((c) => ({
            question: c.question,
            draftAnswered: Boolean(c.draft && !c.draft.error && String(c.draft.text || '').trim()),
            draft: redact(String(c.draft?.text || c.draft?.error || '')).slice(0, 160),
            live: redact(String(c.live?.text || c.live?.error || '')).slice(0, 120)
        }))
    }
}

const ONLY = process.env.CHAT_BUILDER_ONLY ? Number(process.env.CHAT_BUILDER_ONLY) : 0
for (const [index, prompt] of (UI === 'only' ? [] : ASSISTANTS).entries()) {
    if (ONLY && index + 1 !== ONLY) continue
    const n = index + 1
    const started = Date.now()
    const result = await api('POST', '/builder/chat/build', { question: prompt, selectedChatModel: model })
    const seconds = Math.round((Date.now() - started) / 1000)
    if (!result?.ok) {
        log(`#${n} FAILED the check after ${seconds}s:`, redact(JSON.stringify(result?.problems)))
        results.push({ n, prompt, ok: false, problems: result?.problems })
        continue
    }
    const parts = result.nodes.map((node) => node.data.name)
    const created = await api('POST', '/chatflows', {
        name: `${result.title} ${stamp}-${n}`,
        type: 'CHATFLOW',
        deployed: false,
        flowData: EMPTY,
        chatbotConfig: starterConfig(result.starterQuestions)
    })
    const flowData = JSON.stringify({ nodes: asSaved(result.nodes), edges: result.edges, viewport: { x: 0, y: 0, zoom: 1 } })
    const status = await api('PUT', `/flow-drafts/${created.id}`, { flowData })
    const question = result.starterQuestions[0]
    // A chat that fails is a finding, not a crash: note it and keep going.
    const reply = await api('POST', `/internal-prediction/${created.id}`, { question, chatId: `chat-builder-${stamp}-${n}` }).catch(
        (error) => {
            log(`#${n} test chat failed:`, redact(String(error.message || error)).slice(0, 300))
            return null
        }
    )
    const answer = String(reply?.text || '')
    const check = await publishCheck(created.id, result.starterQuestions)
    const answered = check.cases.filter((c) => c.draftAnswered).length
    log(
        `#${n} built in ${seconds}s${result.repaired ? ' (after one repair)' : ''}: "${result.title}"; parts ${parts.join(', ')}; draft ${
            status?.draft ? 'saved' : 'MISSING'
        }; test chat answer ${answer.length} chars; publish check offered ${check.offered.length} questions${
            check.covered ? ' covering all 3 starters' : ' MISSING starters'
        }, ${answered}/${check.cases.length} answered on the draft (${check.status || check.unavailable})`
    )
    results.push({
        n,
        prompt,
        ok:
            Boolean(status?.draft) &&
            Boolean(answer.trim()) &&
            check.covered &&
            result.starterQuestions.length === 3 &&
            check.status === 'done' &&
            answered === check.cases.length,
        repaired: result.repaired,
        title: result.title,
        canvasId: created.id,
        parts,
        starterQuestions: result.starterQuestions,
        missingCredentials: result.missingCredentials,
        question,
        answer: redact(answer).slice(0, 400),
        check
    })
}

// Every built chatflow opens on the chatflow canvas showing its draft, at the size of the docs pictures.
const { browser, page } = await signedInPage({ width: 1280, height: 800 })
for (const r of results.filter((x) => x.canvasId)) {
    await page.goto(`${BASE}/canvas/${r.canvasId}`, { waitUntil: 'networkidle' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    await fitView(page)
    r.drawn = await page.locator('.react-flow__node').count()
    r.opened = r.drawn === r.parts.length
    await page.screenshot({ path: path.join(OUT, `chat-${r.n}.png`) })
    log(`#${r.n} opened on the chatflow canvas: ${r.drawn}/${r.parts.length} cards drawn`)
}

const ui = { steps: [] }
const step = (name, ok, detail = '') => {
    ui.steps.push({ name, ok, detail })
    log(`UI ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
}
const uiShot = (name) => page.screenshot({ path: path.join(OUT, name) })
const notice = () =>
    page
        .locator('#notistack-snackbar')
        .allInnerTexts()
        .then((t) => t.join(' '))
        .catch(() => '')

async function buildOnScreen(prompt, n) {
    await page.goto(`${BASE}/canvas`, { waitUntil: 'networkidle' })
    await page.evaluate((value) => window.localStorage.setItem('cuttlely.builderModel', JSON.stringify(value)), {
        name: model.name,
        credential,
        inputs: model.inputs
    })
    const button = page.getByRole('button', { name: 'Build with AI' })
    await button.waitFor({ timeout: 20000 })
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Build with AI' })
    await dialog.waitFor()
    await dialog.getByPlaceholder('Describe your assistant').first().fill(prompt)
    if (n === 1) {
        step(
            'button named Build with AI, prompt line Describe your assistant',
            (await dialog.getByText('Describe your assistant', { exact: true }).count()) >= 1
        )
        step('the dialog says nothing is saved until you save', (await dialog.getByText(/Nothing is saved until you save/).count()) === 1)
        const build = dialog.getByRole('button', { name: 'Build', exact: true })
        for (let i = 0; i < 40 && !(await build.isEnabled()); i++) await page.waitForTimeout(250)
        await page.waitForTimeout(500)
        await uiShot('ui-chat-dialog.png')
    }
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    const failed = dialog.getByText(/could not build a chatflow/)
    await Promise.race([dialog.waitFor({ state: 'detached', timeout: 300000 }), failed.waitFor({ timeout: 300000 })])
    if (await failed.count()) {
        const text = await failed.innerText()
        await page.keyboard.press('Escape')
        throw new Error(text.slice(0, 600))
    }
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(1500)
    return { landed: await notice(), url: page.url() }
}

async function saveFirst(n) {
    await page.locator('button[title^="Save"]').last().click()
    const save = page.getByRole('dialog').filter({ has: page.getByRole('textbox') })
    await save.waitFor({ timeout: 10000 })
    const field = save.getByRole('textbox').first()
    const prefilled = await field.inputValue()
    const name = prefilled || `Built assistant ${n}`
    await field.fill(`${name} ${stamp}-ui${n}`)
    await save.getByRole('button', { name: /^Save$/ }).click()
    await page.waitForURL(/\/canvas\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.waitForTimeout(2000)
    return { id: page.url().split('/').pop(), prefilled }
}

if (UI) {
    for (const [index, prompt] of ASSISTANTS.entries()) {
        const n = index + 1
        try {
            const { landed } = await buildOnScreen(prompt, n)
            step(
                `#${n} lands on the canvas unsaved`,
                /is on the canvas\. Save to keep it as a draft/.test(landed) && !/\/canvas\/[0-9a-f-]{36}/.test(page.url()),
                landed.slice(0, 160)
            )
            await fitView(page)
            const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
            if (n === 1)
                step(
                    'new look (default): cards drawn compact',
                    widths.length > 0 && Math.max(...widths) <= 270,
                    `widest ${Math.max(...widths)} px`
                )
            await uiShot(`ui-chat-${n}.png`)
            const { id, prefilled } = await saveFirst(n)
            step(`#${n} the Save box starts with the built name`, Boolean(prefilled), prefilled || 'empty')
            const status = await api('GET', `/flow-drafts/${id}`)
            const saved = await api('GET', `/chatflows/${id}`)
            const liveCards = JSON.parse(saved.flowData || '{}').nodes?.length || 0
            step(
                `#${n} the first save is a draft`,
                Boolean(status.draft) && liveCards === 0,
                `draft ${status.draft ? 'yes' : 'no'}, live cards ${liveCards}`
            )
            const starters = Object.values(JSON.parse(saved.chatbotConfig || '{}').starterPrompts || {}).map((s) => s.prompt)
            await page.getByRole('button', { name: 'chat', exact: true }).click()
            await page.waitForTimeout(1500)
            // The test chat loads the flow and its draft first, so give the starter chips a moment to appear.
            const shown = starters.length
                ? await page
                      .getByText(starters[0])
                      .first()
                      .waitFor({ state: 'visible', timeout: 10000 })
                      .then(() => true)
                      .catch(() => false)
                : false
            step(`#${n} starter questions wait in the test chat`, starters.length === 3 && shown, starters.join(' | '))
            if (shown) {
                await page.getByText(starters[0]).first().click()
                let answered = false
                for (let i = 0; i < 40 && !answered; i += 1) {
                    await page.waitForTimeout(3000)
                    const messages = await api('GET', `/chatmessage/${id}`).catch(() => [])
                    answered = (messages || []).some((m) => m.role === 'apiMessage' && String(m.content || '').trim())
                }
                await uiShot(`ui-chat-${n}-chat.png`)
                step(`#${n} the test chat answers from the draft`, answered)
                await page
                    .getByRole('button', { name: 'chat', exact: true })
                    .click()
                    .catch(() => {})
            }
            await page.getByTestId('publish-button').click()
            await page.getByTestId('publish-check').waitFor({ timeout: 15000 })
            await page.waitForTimeout(1000)
            const marked = await page.getByText('(starter question)').count()
            await page.getByTestId('check-run').click()
            await page.getByTestId('check-summary').waitFor({ timeout: 240000 })
            await uiShot(`ui-chat-${n}-check.png`)
            const cases = await page.getByTestId('check-case').count()
            step(
                `#${n} the Publish check runs the starter questions`,
                marked >= 1 && cases >= 3,
                `${marked} marked starter, ${cases} asked`
            )
            await page.keyboard.press('Escape')
        } catch (error) {
            step(`#${n} builds on screen`, false, redact(error.message).slice(0, 200))
        }
    }

    try {
        await buildOnScreen(SERVICE, 6)
        const text = await notice()
        await uiShot('ui-chat-missing-credentials.png')
        step(
            'an assistant that names a service lists the credential it needs by name',
            /needs .+/.test(text) && /Credentials page/.test(text),
            text.slice(0, 200)
        )
    } catch (error) {
        step('an assistant that names a service lists the credential it needs by name', false, redact(error.message).slice(0, 200))
    }

    try {
        await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'classic'))
        const { landed } = await buildOnScreen(ASSISTANTS[0], 7)
        await fitView(page)
        const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
        await uiShot('ui-chat-classic.png')
        step(
            'Classic cards: Build with AI lands the cards unsaved',
            /is on the canvas/.test(landed) && widths.length > 0 && Math.max(...widths) >= 290,
            `widest ${Math.max(...widths)} px`
        )
    } catch (error) {
        step('Classic cards: Build with AI works', false, redact(error.message).slice(0, 200))
    } finally {
        await page.evaluate(() => window.localStorage.removeItem('cuttlely.canvasLook')).catch(() => {})
    }
}
await browser.close()

fs.writeFileSync(path.join(OUT, 'chat-builder-e2e.json'), JSON.stringify({ model: MODEL, results, ui }, null, 2))
const passed = results.filter((r) => r.ok && r.opened).length
const uiPassed = ui.steps.filter((s) => s.ok).length
log(
    `chat builder e2e: ${passed}/${
        results.length
    } built, saved as a draft, answered in the test chat, checked with their starter questions and opened${
        UI ? `; UI ${uiPassed}/${ui.steps.length}` : ''
    }`
)
process.exit(passed === results.length && uiPassed === ui.steps.length ? 0 : 1)
