// Build with AI for harnesses, with a real model. Builds a team from each plain description through the route
// the canvas uses, saves it as a new harness, asks one of its starter questions through a chat flow that calls
// the harness by name, checks that Harness Prime handed the work to at least one specialist and got a real
// answer, and opens the harness on its canvas.
// With HARNESS_BUILDER_UI=1 (or =only to skip the API part) it then builds the same teams on screen: Build with
// AI on a new harness canvas, the team lands saved under its own name, its starter questions wait in the test
// chat, one is asked, and a team that names a service lists the credential it still needs. It runs in the new
// look (the default), then once more with Classic cards.
// Env: E2E_BASE_URL, E2E_ADMIN_FILE, E2E_PLAYWRIGHT, BUILDER_OUT (screenshots, outside the repo).
import fs from 'node:fs'
import path from 'node:path'
import { BASE, api, buildNode, log, redact, upsertFlow } from './lib.mjs'
import { MODEL, asSaved, buildingModel, ensureCredential, fitView, signedInPage, starterConfig } from './builder-lib.mjs'

const OUT = process.env.BUILDER_OUT || path.join(process.cwd(), '..', 'harness-builder-out')
fs.mkdirSync(OUT, { recursive: true })
const stamp = Date.now().toString(36)

export const TEAMS = [
    'A study team: a science explainer who teaches a topic in plain words, and a quiz writer who makes three practice questions.',
    'A trip planning team with an itinerary planner and a budget specialist who works out costs with a calculator.',
    'A support team for our product notes: a specialist that searches a small knowledge base about the Lumen desk lamp (three brightness levels, USB-C charging, two-year warranty), and a writer who turns the facts into a friendly reply.',
    'A writing team: an outliner, a drafter, and an editor who tightens the final text.',
    'A cooking team with a recipe finder who suggests dishes and a nutrition specialist who estimates calories.'
]

// A harness name the server accepts: a letter first, then letters, digits, dashes or underscores.
const harnessName = (title, n) =>
    `${
        String(title || 'team')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^[^A-Za-z]+|-+$/g, '')
            .slice(0, 40) || 'team'
    }-${stamp}-${n}`

const UI = process.env.HARNESS_BUILDER_UI || ''
const SERVICE_TEAM = "A news team: a researcher who searches the web with Tavily for today's headlines, and a writer who sums them up."

const credential = await ensureCredential()
const model = buildingModel(credential)
const results = []

// The latest run of a harness and which of its specialists Harness Prime handed work to.
const consultedIn = async (name) => {
    const harness = await api('GET', `/harnesses/${name}`)
    const runs = await api('GET', `/harnesses/${name}/runs`)
    const run = (runs || [])[0] || {}
    const specialists = (harness.specialists || []).map((s) => s.name)
    const consulted = [...new Set((run.agents || []).map((a) => a.name).filter((a) => specialists.includes(a)))]
    return { specialists, run, consulted }
}

const ONLY = process.env.HARNESS_BUILDER_ONLY ? Number(process.env.HARNESS_BUILDER_ONLY) : 0
for (const [index, prompt] of (UI === 'only' ? [] : TEAMS).entries()) {
    if (ONLY && index + 1 !== ONLY) continue
    const n = index + 1
    const started = Date.now()
    const result = await api('POST', '/builder/harness/build', { question: prompt, selectedChatModel: model })
    const seconds = Math.round((Date.now() - started) / 1000)
    if (!result?.ok) {
        log(`#${n} FAILED the check after ${seconds}s:`, redact(JSON.stringify(result?.problems)))
        results.push({ n, prompt, ok: false, problems: result?.problems })
        continue
    }
    const name = harnessName(result.title, n)
    const canvas = await api('POST', '/chatflows', {
        name,
        type: 'HARNESS',
        deployed: false,
        flowData: JSON.stringify({ nodes: asSaved(result.nodes), edges: result.edges, viewport: { x: 0, y: 0, zoom: 1 } }),
        chatbotConfig: starterConfig(result.starterQuestions)
    })
    const chatNode = await buildNode('harness', 'harness_0', { inputs: { harnessName: name, returnDirect: true } })
    const chat = await upsertFlow({ name: `Ask ${name}`, type: 'CHATFLOW', nodes: [chatNode], edges: [] })
    const question = result.starterQuestions[0]
    const reply = await api('POST', `/prediction/${chat.id}`, { question, chatId: `builder-${stamp}-${n}` })
    const answer = String(reply?.text || '')
    const { specialists, run, consulted } = await consultedIn(name)
    const parts = result.nodes.map((node) => node.data.name)
    log(
        `#${n} built in ${seconds}s${result.repaired ? ' (after one repair)' : ''}: "${
            result.title
        }" as ${name}, specialists ${specialists.join(', ')}; parts ${parts.join(', ')}; missing credentials ${
            result.missingCredentials.length
        }; consulted ${consulted.join(', ') || 'none'}; answer ${answer.length} chars`
    )
    results.push({
        n,
        prompt,
        ok: Boolean(answer.trim()) && run.status === 'succeeded' && consulted.length > 0 && !/Harness returned no text/.test(answer),
        repaired: result.repaired,
        title: result.title,
        name,
        canvasId: canvas.id,
        chatflowId: chat.id,
        parts,
        specialists,
        starterQuestions: result.starterQuestions,
        missingCredentials: result.missingCredentials,
        question,
        runStatus: run.status,
        consulted,
        answer: redact(answer).slice(0, 500)
    })
}

// Every built harness opens on the harness canvas with all its cards drawn.
// The size of the pictures in docs/images.
const { browser, page } = await signedInPage({ width: 1280, height: 800 })
for (const r of results.filter((x) => x.canvasId)) {
    await page.goto(`${BASE}/harnesscanvas/${r.canvasId}`, { waitUntil: 'networkidle' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    await fitView(page)
    r.drawn = await page.locator('.react-flow__node').count()
    r.opened = r.drawn === r.parts.length
    await page.screenshot({ path: path.join(OUT, `harness-${r.n}.png`) })
    log(`#${r.n} opened on the harness canvas: ${r.drawn}/${r.parts.length} cards drawn`)
}
// On screen: the same teams through the Build with AI button on a new harness canvas.
const ui = { steps: [], teams: [] }
const step = (name, ok, detail = '') => {
    ui.steps.push({ name, ok, detail })
    log(`UI ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
}
const uiShot = (name) => page.screenshot({ path: path.join(OUT, name) })

async function buildOnScreen(prompt, n) {
    await page.goto(`${BASE}/harnesscanvas`, { waitUntil: 'networkidle' })
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
    await dialog.getByPlaceholder('Describe your team').first().fill(prompt)
    if (n === 1) {
        step(
            'button named Build with AI, prompt line Describe your team',
            (await dialog.getByText('Describe your team', { exact: true }).count()) >= 1
        )
        await uiShot('ui-harness-dialog.png')
    }
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/\/harnesscanvas\/[0-9a-f-]{36}/, { timeout: 300000 })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(1500)
    const canvasId = page.url().split('/').pop()
    const saved = await api('GET', `/chatflows/${canvasId}`)
    const starters = Object.values(JSON.parse(saved.chatbotConfig || '{}').starterPrompts || {}).map((s) => s.prompt)
    const notice = await page
        .locator('#notistack-snackbar')
        .allInnerTexts()
        .then((t) => t.join(' '))
        .catch(() => '')
    return { canvasId, saved, starters, notice }
}

if (UI) {
    for (const [index, prompt] of TEAMS.entries()) {
        const n = index + 1
        const team = { n, prompt }
        try {
            const landed = await buildOnScreen(prompt, n)
            team.name = landed.saved.name
            team.canvasId = landed.canvasId
            step(
                `#${n} lands as a new, named harness`,
                landed.saved.type === 'HARNESS' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(landed.saved.name),
                landed.saved.name
            )
            await fitView(page)
            if (n === 1) {
                const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
                step(
                    'new look (default): cards drawn compact',
                    widths.length > 0 && Math.max(...widths) <= 270,
                    `widest ${Math.max(...widths)} px`
                )
            }
            const boxes = await page.locator('.react-flow__node').evaluateAll((els) =>
                els.map((e) => {
                    const r = e.getBoundingClientRect()
                    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
                })
            )
            const overlaps = boxes.filter((a, i) =>
                boxes.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
            ).length
            step(`#${n} new look: the cards are pressed together and none overlap`, overlaps === 0, `${overlaps} overlapping`)
            await uiShot(`ui-harness-${n}.png`)
            await page.getByRole('button', { name: 'chat', exact: true }).click()
            await page.waitForTimeout(1500)
            const shown = landed.starters.length
                ? await page
                      .getByText(landed.starters[0])
                      .first()
                      .isVisible()
                      .catch(() => false)
                : false
            step(`#${n} starter questions wait in the test chat`, landed.starters.length === 3 && shown, landed.starters.join(' | '))
            if (shown) {
                await page.getByText(landed.starters[0]).first().click()
                let routed = { consulted: [], run: {} }
                for (let i = 0; i < 40; i += 1) {
                    await page.waitForTimeout(5000)
                    routed = await consultedIn(landed.saved.name)
                    if (routed.run.status && routed.run.status !== 'running') break
                }
                await page.waitForTimeout(2000)
                await uiShot(`ui-harness-${n}-chat.png`)
                team.consulted = routed.consulted
                step(
                    `#${n} test chat answers through Prime and a specialist`,
                    routed.run.status === 'succeeded' && routed.consulted.length > 0,
                    `${routed.run.status}; ${routed.consulted.join(', ')}`
                )
            }
        } catch (error) {
            step(`#${n} built on screen`, false, error.message.slice(0, 200))
        }
        ui.teams.push(team)
    }
    try {
        const landed = await buildOnScreen(SERVICE_TEAM, 6)
        await uiShot('ui-harness-missing-credentials.png')
        step(
            'a team that names a service lists the credential it needs by name',
            /needs .+/.test(landed.notice) && /Credentials page/.test(landed.notice),
            landed.notice.slice(0, 200)
        )
    } catch (error) {
        step('a team that names a service lists the credential it needs by name', false, error.message.slice(0, 200))
    }

    // Classic cards: the same entry works for someone who picked the Classic look. The new look draws cards 260 px
    // wide, Classic 300 px, so the card width tells which look is on screen.
    try {
        await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'classic'))
        const landed = await buildOnScreen(TEAMS[0], 7)
        await fitView(page)
        const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
        const expected = JSON.parse(landed.saved.flowData).nodes.length
        await uiShot('ui-harness-classic.png')
        step(
            'Classic cards: Build with AI lands a new, named harness',
            landed.saved.type === 'HARNESS' && widths.length === expected && Math.max(...widths) >= 290,
            `${landed.saved.name}; ${widths.length}/${expected} cards, widest ${Math.max(...widths)} px`
        )
        await page.goto(`${BASE}/v2/agentcanvas`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Build with AI' }).click()
        const dialog = page.getByRole('dialog', { name: 'Build with AI' })
        await dialog.waitFor()
        const prompt = await dialog.getByPlaceholder('Describe your workflow').count()
        await uiShot('ui-workflow-classic-dialog.png')
        step('Classic cards: Build with AI opens on the workflow canvas', prompt >= 1)
        await page.keyboard.press('Escape')
    } catch (error) {
        step('Classic cards: Build with AI works', false, error.message.slice(0, 200))
    } finally {
        await page.evaluate(() => window.localStorage.removeItem('cuttlely.canvasLook')).catch(() => {})
    }
}
await browser.close()

fs.writeFileSync(
    path.join(OUT, 'harness-builder-e2e.json'),
    JSON.stringify({ model: MODEL, results: results.map(({ answer, ...rest }) => ({ ...rest, answerPreview: answer })), ui }, null, 2)
)
const passed = results.filter((r) => r.ok && r.opened).length
const uiPassed = ui.steps.filter((s) => s.ok).length
log(
    `harness builder e2e: ${passed}/${results.length} built, checked, routed through Prime to a specialist, answered and opened${
        UI ? `; UI ${uiPassed}/${ui.steps.length}` : ''
    }`
)
process.exit(passed === results.length && uiPassed === ui.steps.length ? 0 : 1)
