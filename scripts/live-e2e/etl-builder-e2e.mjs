// Build with AI for ETL pipelines, with a real model. Builds a pipeline from each plain description of the bundled
// sample data through the route the canvas uses, saves it as a new pipeline, runs it, checks that chunks landed in
// the store, runs it again to check that nothing was stored twice, searches it with its first starter question,
// and opens it on its canvas.
// With ETL_BUILDER_UI=1 (or =only to skip the API part) it then builds the descriptions on screen: Build with AI on
// a new ETL canvas, the pipeline lands saved under its own name and runs. It runs in the new look (the default),
// then once more with Classic cards.
// Env: E2E_BASE_URL, E2E_ADMIN_FILE, E2E_PLAYWRIGHT, E2E_REPO (the checkout the server runs from), BUILDER_OUT.
import fs from 'node:fs'
import path from 'node:path'
import { BASE, api, log, redact, waitRun } from './lib.mjs'
import { MODEL, asSaved, buildingModel, ensureCredential, fitView, signedInPage, starterConfig } from './builder-lib.mjs'

const OUT = process.env.BUILDER_OUT || path.join(process.cwd(), '..', 'etl-builder-out')
fs.mkdirSync(OUT, { recursive: true })
const REPO = path.resolve(process.env.E2E_REPO || process.cwd())
const CATALOG = path.join(REPO, 'samples', 'etl', 'data', 'outdoor-catalog.csv')
const stamp = Date.now().toString(36)

export const DATA = [
    `The outdoor product catalog CSV at ${CATALOG}. Each row is one product: sku is the id, name, category and description are the text, price is metadata. People search products by what they do.`,
    `The how-to guides in this repository at ${REPO}: only the markdown files under docs/how-to, so people can search the guides.`,
    `Just README.md and AGENTS.md from the repository at ${REPO}, split into small chunks of about 400 characters.`,
    `Only the product descriptions from the catalog CSV at ${CATALOG} (sku is the id), with the whitespace cleaned up before it is stored.`
]

const UI = process.env.ETL_BUILDER_UI || ''
const credential = await ensureCredential()
const model = buildingModel(credential)
const results = []

const counters = (run) => {
    const c = run.counters || {}
    return { chunks: c.chunks || 0, embedded: c.embedded || 0, skipped: c.skipped || 0, deleted: c.deleted || 0 }
}

// ETL runs finish as succeeded (or partial when some rows were rejected).
const DONE = ['succeeded', 'partial', 'completed', 'failed', 'cancelled']
const finished = (run) => ['succeeded', 'completed'].includes(run?.status)
const runOnce = async (id) => waitRun((await api('POST', `/etl/pipelines/${id}/runs`, {})).id, { until: DONE })

// Two runs of a saved pipeline and a search with its first starter question.
async function runTwiceAndSearch(id, question) {
    const first = await runOnce(id)
    const second = finished(first) ? await runOnce(id) : null
    const detail = await api('GET', `/etl/pipelines/${id}`)
    const found = finished(first) && question ? await api('POST', `/etl/pipelines/${id}/search`, { query: question, k: 3 }) : null
    return {
        first: { status: first.status, error: first.error ? redact(String(first.error)).slice(0, 300) : undefined, ...counters(first) },
        second: second ? { status: second.status, ...counters(second) } : null,
        stored: detail?.stats?.chunks ?? null,
        hits: (found?.results || []).length,
        topHit: redact(String(found?.results?.[0]?.text || found?.results?.[0]?.pageContent || '')).slice(0, 160)
    }
}

// Chunks each description may store: the 33 catalog rows, or only the two top-level files for #3.
const CHUNKS = [
    [33, 33],
    [1, Infinity],
    [1, 120],
    [33, 33]
]
const passes = (r, index) =>
    finished(r.first) &&
    r.first.chunks >= CHUNKS[index][0] &&
    r.first.chunks <= CHUNKS[index][1] &&
    finished(r.second) &&
    r.second.embedded === 0 &&
    (r.stored === null || r.stored === r.first.chunks || r.stored >= r.first.embedded) &&
    r.hits > 0

const ONLY = process.env.ETL_BUILDER_ONLY ? Number(process.env.ETL_BUILDER_ONLY) : 0
for (const [index, prompt] of (UI === 'only' ? [] : DATA).entries()) {
    if (ONLY && index + 1 !== ONLY) continue
    const n = index + 1
    const started = Date.now()
    const result = await api('POST', '/builder/etl/build', { question: prompt, selectedChatModel: model })
    const seconds = Math.round((Date.now() - started) / 1000)
    if (!result?.ok) {
        log(`#${n} FAILED the check after ${seconds}s:`, redact(JSON.stringify(result?.problems)))
        results.push({ n, prompt, ok: false, problems: result?.problems })
        continue
    }
    const name = `${result.title} ${stamp}-${n}`
    const parts = result.nodes.map((node) => node.data.name)
    let saved
    try {
        saved = await api(
            'POST',
            '/chatflows',
            {
                name,
                type: 'ETL',
                deployed: false,
                flowData: JSON.stringify({ nodes: asSaved(result.nodes), edges: result.edges, viewport: { x: 0, y: 0, zoom: 1 } }),
                chatbotConfig: starterConfig(result.starterQuestions)
            },
            { retry: false }
        )
    } catch (error) {
        log(`#${n} built but did not save: ${redact(error.message).slice(0, 300)}`)
        results.push({ n, prompt, ok: false, title: result.title, parts, saveError: redact(error.message).slice(0, 300) })
        continue
    }
    const question = result.starterQuestions[0]
    const run = await runTwiceAndSearch(saved.id, question)
    log(
        `#${n} built in ${seconds}s${result.repaired ? ' (after one repair)' : ''}: "${result.title}"; parts ${parts.join(', ')}; run 1 ${
            run.first.status
        } chunks ${run.first.chunks} embedded ${run.first.embedded}; run 2 ${run.second?.status} embedded ${run.second?.embedded} skipped ${
            run.second?.skipped
        }; stored ${run.stored}; search "${question}" ${run.hits} hits`
    )
    results.push({
        n,
        prompt,
        ok: passes(run, index),
        repaired: result.repaired,
        title: result.title,
        name,
        canvasId: saved.id,
        parts,
        starterQuestions: result.starterQuestions,
        missingCredentials: result.missingCredentials,
        question,
        ...run
    })
}

// Every built pipeline opens on the ETL canvas with all its cards drawn, at the size of the docs pictures.
const { browser, page } = await signedInPage({ width: 1280, height: 800 })
for (const r of results.filter((x) => x.canvasId)) {
    await page.goto(`${BASE}/etlcanvas/${r.canvasId}`, { waitUntil: 'networkidle' })
    await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    await fitView(page)
    r.drawn = await page.locator('.react-flow__node').count()
    r.opened = r.drawn === r.parts.length
    await page.screenshot({ path: path.join(OUT, `etl-${r.n}.png`) })
    log(`#${r.n} opened on the ETL canvas: ${r.drawn}/${r.parts.length} cards drawn`)
}

const ui = { steps: [] }
const step = (name, ok, detail = '') => {
    ui.steps.push({ name, ok, detail })
    log(`UI ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
}
const uiShot = (name) => page.screenshot({ path: path.join(OUT, name) })

async function buildOnScreen(prompt, n) {
    await page.goto(`${BASE}/etlcanvas`, { waitUntil: 'networkidle' })
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
    await dialog.getByPlaceholder('Describe your data').first().fill(prompt)
    if (n === 1) {
        step(
            'button named Build with AI, prompt line Describe your data',
            (await dialog.getByText('Describe your data', { exact: true }).count()) >= 1
        )
        step('the dialog says it saves a new pipeline', (await dialog.getByText('saves it as a new pipeline').count()) === 1)
        const build = dialog.getByRole('button', { name: 'Build', exact: true })
        for (let i = 0; i < 40 && !(await build.isEnabled()); i++) await page.waitForTimeout(250)
        await page.waitForTimeout(500)
        await uiShot('ui-etl-dialog.png')
    }
    await dialog.getByRole('button', { name: 'Build', exact: true }).click()
    await page.waitForURL(/\/etlcanvas\/[0-9a-f-]{36}/, { timeout: 300000 })
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
    for (const [index, prompt] of DATA.entries()) {
        const n = index + 1
        try {
            const landed = await buildOnScreen(prompt, n)
            const cards = JSON.parse(landed.saved.flowData).nodes.length
            step(`#${n} lands as a new, named pipeline`, landed.saved.type === 'ETL' && Boolean(landed.saved.name), landed.saved.name)
            step(`#${n} says what was built`, /as a new pipeline/.test(landed.notice), landed.notice.slice(0, 160))
            await fitView(page)
            const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
            if (n === 1)
                step(
                    'new look (default): cards drawn compact',
                    widths.length > 0 && Math.max(...widths) <= 270,
                    `widest ${Math.max(...widths)} px`
                )
            step(`#${n} every card drawn`, widths.length === cards, `${widths.length}/${cards}`)
            await uiShot(`ui-etl-${n}.png`)
            const run = await runTwiceAndSearch(landed.canvasId, landed.starters[0])
            step(
                `#${n} runs, stores chunks, and a second run adds no duplicates`,
                passes(run, index),
                `chunks ${run.first.chunks}, run 2 embedded ${run.second?.embedded}, ${run.hits} hits`
            )
            if (n === 1) {
                // After the runs, the starter searches wait under Try retrieval; one click searches.
                await page.reload({ waitUntil: 'networkidle' })
                await page.getByRole('button', { name: 'Run', exact: true }).click()
                const chips = page.getByTestId('etl-starter-searches').getByRole('button')
                await chips.first().waitFor({ timeout: 20000 })
                const offered = await chips.allInnerTexts()
                await chips.first().click()
                await page
                    .getByText(/^score /)
                    .first()
                    .waitFor({ timeout: 20000 })
                await page
                    .getByText('Try retrieval', { exact: true })
                    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
                    .catch(() => {})
                await page.waitForTimeout(500)
                await uiShot('ui-etl-search.png')
                step(
                    'the starter searches wait under Try retrieval, and one click searches',
                    offered.length === landed.starters.length && (await page.getByText(/^score /).count()) > 0,
                    `${offered.length} offered, ${await page.getByText(/^score /).count()} hits`
                )
            }
        } catch (error) {
            step(`#${n} builds on screen`, false, redact(error.message).slice(0, 200))
        }
    }

    try {
        await page.evaluate(() => window.localStorage.setItem('cuttlely.canvasLook', 'classic'))
        const landed = await buildOnScreen(DATA[0], 7)
        await fitView(page)
        const widths = await page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.offsetWidth))
        const expected = JSON.parse(landed.saved.flowData).nodes.length
        await uiShot('ui-etl-classic.png')
        step(
            'Classic cards: Build with AI lands a new, named pipeline',
            landed.saved.type === 'ETL' && widths.length === expected && Math.max(...widths) >= 290,
            `${landed.saved.name}; ${widths.length}/${expected} cards, widest ${Math.max(...widths)} px`
        )
    } catch (error) {
        step('Classic cards: Build with AI works', false, redact(error.message).slice(0, 200))
    } finally {
        await page.evaluate(() => window.localStorage.removeItem('cuttlely.canvasLook')).catch(() => {})
    }
}
await browser.close()

fs.writeFileSync(path.join(OUT, 'etl-builder-e2e.json'), JSON.stringify({ model: MODEL, results, ui }, null, 2))
const passed = results.filter((r) => r.ok && r.opened).length
const uiPassed = ui.steps.filter((s) => s.ok).length
log(
    `etl builder e2e: ${passed}/${results.length} built, ran, stored chunks, added no duplicates on a second run, searched and opened${
        UI ? `; UI ${uiPassed}/${ui.steps.length}` : ''
    }`
)
process.exit(passed === results.length && uiPassed === ui.steps.length ? 0 : 1)
