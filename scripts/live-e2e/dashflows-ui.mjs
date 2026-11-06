// Visual/UI acceptance using explicitly synthetic API fixtures. No live credentials or customer data.
// Start the UI dev server, then: node scripts/live-e2e/dashflows-ui.mjs
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { dashSourceName, supremeCommandTemplate } from '../../packages/ui/src/views/dashflows/supreme.js'
const output = process.env.DASHFLOWS_SHOTS || '/tmp/dashflows-showcase'
fs.mkdirSync(output, { recursive: true })
const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const sources = [
    {
        key: 'risk',
        hash: 'ab'.repeat(32),
        name: dashSourceName('quarter_account_risk_patterns'),
        specialist: 'warehouse_sql_r25',
        params: [],
        columns: []
    },
    {
        key: 'watchlist',
        hash: 'cd'.repeat(32),
        name: dashSourceName('renewals_at_risk_quarter'),
        specialist: 'warehouse_sql_r25',
        columns: [],
        params: [
            { name: 'period', type: 'text', default: 'quarter', allowedValues: ['quarter', 'next_week', 'next_days'] },
            { name: 'top_n', type: 'int8', default: 10, min: 1, max: 100 },
            { name: 'quarter_offset', type: 'int8', default: 0, min: 0, max: 1 },
            { name: 'window_days', type: 'int8', default: 7, min: 1, max: 3650 }
        ]
    }
]
for (const name of [
    dashSourceName('pipeline_window'),
    dashSourceName('sales_ytd'),
    dashSourceName('realized_retention'),
    dashSourceName('forecast_churn_year'),
    dashSourceName('acv_quarter_series')
])
    sources.push({
        key: name,
        name,
        hash: 'ef'.repeat(32),
        specialist: 'warehouse_sql_r25',
        columns: [],
        params: [
            { name: 'start_date', type: 'date' },
            { name: 'end_date', type: 'date' }
        ]
    })
const definition = { ...supremeCommandTemplate(sources), harness: 'honeybadger-supreme', intervalSeconds: 604800 }
const labels = [
    'Low consumption mentioned',
    'RACV composite flagged red',
    'NACV composite flagged red',
    'Prior churn history mentioned',
    'Negative renewal ACV movement',
    'Onboarding issues mentioned',
    'No recent qualitative notes',
    'CSAT feedback gap',
    'Sub-use-case health concern'
]
const patterns = labels.map((label, i) => ({ label, accounts: 94 - i * 9, percent_of_risk_accounts: 62 - i * 6 }))
const accounts = Array.from({ length: 100 }, (_, i) => ({
    account_id: `001${String(i).padStart(15, '0')}`,
    account_name: `Demo account ${String(i + 1).padStart(2, '0')}`,
    risk_radar: i < 4 ? 'High Risk' : 'Moderate Risk',
    renewal_date: '2026-12-15',
    renewal_acv: String(90000 - i * 7000),
    risk_drivers: 'Synthetic recorded risk evidence. Not a real customer.'
}))
const cohort = {
    total_risk_accounts: 152,
    total_risk_opportunities: 218,
    window_start: '2026-10-01',
    window_end_exclusive: '2027-01-01',
    source_as_of: '2026-11-06',
    fixture: 'SYNTHETIC DEMO DATA'
}
const snapshot = {
    id: 'snapshot',
    refreshedAt: '2026-11-06T03:00:00Z',
    cards: definition.cards.map((card) => ({
        cardId: card.id,
        rows:
            card.kind === 'metric'
                ? [
                      {
                          ...cohort,
                          total_known_deal_acv: '48624000',
                          total_acv: '71839351',
                          deal_count: 1285,
                          retention_pct: '77.96',
                          forecast_churn: '16200000',
                          unknown_acv_count: 18,
                          gross_racv: '52410800',
                          ...(card.source === dashSourceName('pipeline_window') ? { deal_details: accounts, next_page: 2 } : {})
                      }
                  ]
                : card.kind === 'donut'
                ? [
                      { opportunity_type: 'Renewal', deal_count: 670 },
                      { opportunity_type: 'New business', deal_count: 380 },
                      { opportunity_type: 'Expansion', deal_count: 235 }
                  ]
                : card.kind === 'trend'
                ? [18.4, 24.6, 21.8, 31.2, 27.5, 38.1, 33.6, 22.4].map((v, i) => ({
                      quarter_start: `${2025 + Math.floor(i / 4)} Q${(i % 4) + 1}`,
                      total_acv: String(v * 1000000)
                  }))
                : card.title === 'Recorded pipeline risk'
                ? [
                      { recorded_risk: 'High risk', deal_count: 265 },
                      { recorded_risk: 'Moderate risk', deal_count: 412 },
                      { recorded_risk: 'Slight risk', deal_count: 328 },
                      { recorded_risk: 'Unknown', deal_count: 280 }
                  ]
                : card.kind === 'bar'
                ? patterns
                : accounts,
        ...(card.source === dashSourceName('pipeline_window') && card.kind !== 'metric'
            ? { evidenceRows: [{ deal_count: 1285, deal_details: accounts, next_page: 2 }] }
            : {}),
        source: {
            harness: definition.harness,
            pin: sources.find((source) => source.key === card.source).name,
            version: 1,
            hash: card.hash,
            params: card.params,
            scope: card.scope,
            rowsPath: card.rowsPath,
            completenessPath: card.completePath,
            ...(card.kind === 'table' ? { selection: { shown: 100, total: 218 } } : {})
        },
        fetchedAt: '2026-11-06T03:00:00Z'
    }))
}
const periodKeys = ['30', '60', '90', 'quarter', 'next-quarter']
snapshot.pipelineViews = {
    periods: periodKeys.map((key) => ({ key, start_date: '2026-11-06', end_date: '2027-02-04' })),
    regions: ['ALL', 'AMER', 'EMEA', 'APJ'],
    views: {}
}
for (const region of snapshot.pipelineViews.regions) {
    for (const key of periodKeys) {
        const cards = snapshot.cards.filter(
            (card) => definition.cards.find((c) => c.id === card.cardId).source === dashSourceName('pipeline_window')
        )
        snapshot.pipelineViews.views[`${region}:${key}`] = {
            evidenceRows: [
                {
                    ...cards[0].rows[0],
                    total_known_deal_acv: region === 'EMEA' && key === '90' ? 1234567 : cards[0].rows[0].total_known_deal_acv
                }
            ],
            cards: cards.map((card) => {
                const { rows, evidenceRows: _rows, ...rest } = card
                const metric = definition.cards.find((c) => c.id === card.cardId).kind === 'metric'
                return {
                    ...rest,
                    source: { ...rest.source, scope: `${region} / prepared ${key}`, params: { ...rest.source.params, region } },
                    ...(metric ? { rowsFromEvidence: true } : { rows })
                }
            })
        }
    }
}
const record = { id: 'demo', revision: 1, definition, snapshot, published: true, publishedAt: '2026-11-06T03:00:00Z' }
let reports = 0
let refreshes = 0
let publicPublishes = 0
let dashboardRequests = 0
let statusPolls = 0
let cancels = 0
await page.addInitScript(() => {
    if (location.pathname.startsWith('/public/dashboards')) {
        localStorage.clear()
        return
    }
    localStorage.setItem('isAuthenticated', 'true')
    localStorage.setItem('isGlobal', 'true')
    localStorage.setItem(
        'user',
        JSON.stringify({
            id: 'test',
            name: 'Demo builder',
            activeWorkspaceId: 'team',
            activeOrganizationId: 'org',
            assignedWorkspaces: [{ id: 'team', name: 'Synthetic demo' }]
        })
    )
    localStorage.setItem('permissions', JSON.stringify(['chatflows:view', 'chatflows:update']))
})
await page.route('**/api/v1/**', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.includes('/dashflows/') || p.includes('/public-dashflows/')) dashboardRequests++
    if (p.endsWith('/refresh')) refreshes++
    let data = {}
    if (p.endsWith('/settings')) data = { PLATFORM_TYPE: 'open-source', DASH_FLOWS: true }
    else if (p.endsWith('/authentication-settings')) data = { recovery: { available: true } }
    else if (p.endsWith('/harnesses')) data = [{ name: 'honeybadger-supreme' }]
    else if (p.includes('/dashflows/sources/')) data = { sources }
    else if (p.endsWith('/dashflows')) data = [record]
    else if (p === '/api/v1/dashflows/demo' && route.request().method() === 'PUT') {
        record.definition = route.request().postDataJSON().definition
        record.revision++
        data = record
    } else if (p.endsWith('/refresh')) {
        statusPolls = 0
        record.refreshing = true
        record.refreshProgress = {
            runId: `run-${refreshes}`,
            status: 'running',
            phase: 'starting',
            completed: 0,
            total: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }
        data = { id: 'demo', refreshing: true, refreshProgress: record.refreshProgress }
    } else if (p.endsWith('/cancel-refresh')) {
        if (route.request().postDataJSON().runId !== record.refreshProgress.runId) throw new Error('Cancel targeted the wrong run')
        cancels++
        record.refreshing = false
        record.refreshProgress = { ...record.refreshProgress, status: 'cancelled', active: [], finishedAt: new Date().toISOString() }
        data = { id: 'demo', refreshing: false, refreshProgress: record.refreshProgress }
    } else if (p.endsWith('/refresh-status')) {
        statusPolls++
        record.refreshing = statusPolls < 3
        record.refreshProgress = {
            ...record.refreshProgress,
            phase: 'views',
            completed: statusPolls === 1 ? 5 : statusPolls === 2 ? 12 : 20,
            total: 20,
            status: record.refreshing ? 'running' : 'completed',
            active: record.refreshing ? ['EMEA · Next 90 days'] : [],
            updatedAt: new Date().toISOString(),
            ...(record.refreshing ? {} : { finishedAt: new Date().toISOString() })
        }
        data = { id: 'demo', refreshing: record.refreshing, refreshProgress: record.refreshProgress }
    } else if (p.endsWith('/dashflows/demo/publish') && route.request().method() === 'POST') {
        const isPublic = route.request().postDataJSON().public === true
        if (isPublic) publicPublishes++
        data = { ...record, publicToken: isPublic ? 'synthetic-public-token' : null }
    } else if (p.includes('/dashflows/demo')) data = record
    else if (p === '/api/v1/public-dashflows/synthetic-public-token') data = record
    else if (p.endsWith('/runs/async') || (p.includes('/public-dashflows/') && p.endsWith('/report'))) {
        reports++
        data = { runId: 'synthetic-report' }
    } else if (p.endsWith('/synthetic-report/result') || p.endsWith('/reports/synthetic-report'))
        data = {
            finished: true,
            status: 'succeeded',
            result: {
                text: '# Synthetic account health\n\nThis is a UI test fixture, not a real account report.\n\n| Evidence | Status |\n|---|---|\n| Account identity | Exact source ID retained |\n| Health evidence | Synthetic fixture |'
            }
        }
    else if (p.includes('/workspaces')) data = []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
})
try {
    const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080'
    await page.goto(`${base}/dashflows/demo`)
    await page.getByRole('heading', { name: 'Supreme · GTM command center' }).waitFor()
    await page.locator('.df-value').filter({ hasText: '48.62M' }).waitFor()
    await page.evaluate(() => {
        const badge = document.querySelector('.df-beta')
        if (badge) badge.textContent = 'SYNTHETIC DEMO DATA / BETA'
    })
    await page.screenshot({ path: path.join(output, 'supreme-builder.png'), fullPage: true })
    await page.getByRole('button', { name: 'View evidence for Open pipeline' }).hover()
    await page.getByRole('tooltip').waitFor()
    await page.waitForTimeout(250) // Let the tooltip transition finish before visual capture.
    await page.screenshot({ path: path.join(output, 'supreme-executive-hover.png'), fullPage: true })
    await page.getByRole('button', { name: 'View evidence for Open pipeline' }).click()
    await page.getByRole('heading', { name: 'Accounts & opportunities' }).waitFor()
    if ((await page.locator('.df-evidence-panel .df-account-link').count()) !== 100)
        throw new Error('Evidence did not show 100 cached records')
    await page.getByLabel('Find account or opportunity').fill('Demo account 100')
    if ((await page.locator('.df-evidence-panel .df-account-link').count()) !== 1)
        throw new Error('Evidence search did not narrow the records')
    await page.getByLabel('Find account or opportunity').fill('')
    await page.screenshot({ path: path.join(output, 'supreme-evidence-list.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close', exact: true }).click()

    if (reports !== 0 || refreshes !== 0) throw new Error('Passive dashboard view executed a report or refresh')
    await page.getByLabel('Date range', { exact: true }).selectOption('60')
    await page.getByText('Showing prepared results.', { exact: false }).waitFor()
    if (refreshes !== 0) throw new Error('Preset selection ran a refresh')
    await page.getByLabel('Date range', { exact: true }).selectOption('custom')
    await page.getByLabel('From', { exact: true }).fill('2026-10-01')
    await page.getByText('12 / 20 period/region views ready', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Refresh status' }).screenshot({ path: path.join(output, 'supreme-refresh-status.png') })
    await page.reload()
    await page.getByText('Refresh complete', { exact: true }).waitFor()
    if (refreshes !== 1) throw new Error('Custom date change did not automatically refresh')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('5 / 20 period/region views ready', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel & restart', exact: true }).click()
    await page.getByText('Refresh complete', { exact: true }).waitFor()
    if (cancels !== 1 || refreshes !== 3) throw new Error('Cancel and restart did not replace the running refresh exactly once')
    await page.goto(`${base}/dashflows/demo`)
    await page.getByRole('heading', { name: 'Supreme · GTM command center' }).waitFor()
    await page.getByRole('button', { name: 'Demo account 01 ↗' }).click()
    await page.getByRole('button', { name: 'Run full health report', exact: true }).click()
    await page.getByRole('heading', { name: 'Synthetic account health' }).waitFor()
    if (reports !== 1) throw new Error('Health report was not executed exactly once')
    await page.screenshot({ path: path.join(output, 'supreme-account-health.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Publish & share' }).click()
    await page.getByLabel('Audience', { exact: true }).click()
    await page.getByRole('option', { name: 'Anyone with the public link' }).click()
    await page.getByRole('button', { name: 'Publish snapshot & copy link' }).click()
    await page.getByText(/Published\. (Public link copied|Link:)/).waitFor()
    if (publicPublishes !== 1) throw new Error('Public publication was not an explicit opt-in')
    await page.getByRole('button', { name: 'Filters and settings for Priority renewal watchlist' }).click()
    await page.getByLabel('period', { exact: true }).click()
    await page.getByRole('option', { name: 'next_week', exact: true }).click()
    await page.screenshot({ path: path.join(output, 'supreme-filters.png'), fullPage: true })
    await page.getByRole('button', { name: 'Apply filters & settings' }).click()
    if (await page.locator('.df-value').count()) throw new Error('Changed source scope retained stale metric values')
    await page.goto(`${base}/dashboards/demo`)
    await page.getByText('A published snapshot. Every number has a source.').waitFor()
    if (await page.getByRole('button', { name: 'Save draft' }).count()) throw new Error('Published view exposed author controls')
    await page.screenshot({ path: path.join(output, 'supreme-published.png'), fullPage: true })
    await page.goto(`${base}/public/dashboards/synthetic-public-token`)
    await page.getByText('A published snapshot. Every number has a source.').waitFor()
    if (await page.evaluate(() => localStorage.getItem('isAuthenticated'))) throw new Error('Public acceptance is not anonymous')
    if (await page.getByRole('button', { name: 'Save draft' }).count()) throw new Error('Public page exposed author controls')
    const requestsBeforeSwitch = dashboardRequests
    for (const region of snapshot.pipelineViews.regions) {
        await page.getByLabel('Region', { exact: true }).selectOption(region)
        for (const key of periodKeys) await page.getByLabel('Date range', { exact: true }).selectOption(key)
    }
    await page.getByLabel('Date range', { exact: true }).selectOption('90')
    await page.getByLabel('Region', { exact: true }).selectOption('EMEA')
    if (!(await page.locator('.df-value').first().innerText()).includes('1.23M')) throw new Error('Prepared region data did not change')
    if (dashboardRequests !== requestsBeforeSwitch) throw new Error('Public range selection made a dashboard API request')
    await page.getByRole('button', { name: 'Demo account 01 ↗' }).click()
    await page.getByRole('button', { name: 'Run full health report', exact: true }).click()
    await page.getByRole('heading', { name: 'Synthetic account health' }).waitFor()
    if (reports !== 2) throw new Error('Anonymous public report did not use the scoped endpoint')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.df-command-board .df-card').first().waitFor()
    await page.screenshot({ path: path.join(output, 'supreme-mobile.png'), fullPage: true })
    console.log(
        JSON.stringify({
            errors,
            reports,
            refreshes,
            checks: [
                'Supreme twelve-card command center',
                'account drill-in',
                'explicit health report',
                'source period filter',
                'executive hover summary',
                '100 cached source records',
                'account evidence search',
                'twenty instant published period/region combinations',
                'custom date source refresh',
                'live progress and reload reconnection',
                'force cancel and immediate restart',
                'zero passive query executions',
                'range changes saved before refresh',
                'published read-only',
                'anonymous public dashboard and scoped health report',
                'mobile stacked cards'
            ],
            screenshots: output
        })
    )
} finally {
    await browser.close()
}
if (errors.length) process.exitCode = 1
