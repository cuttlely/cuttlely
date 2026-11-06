// Visual/UI acceptance using explicitly synthetic API fixtures. No live credentials or customer data.
// Start the UI dev server, then: node scripts/live-e2e/dashflows-ui.mjs
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { supremeRiskTemplate } from '../../packages/ui/src/views/dashflows/supreme.js'
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
        name: 'pq_quarter_account_risk_patterns',
        specialist: 'warehouse_sql_r25',
        params: [],
        columns: []
    },
    {
        key: 'watchlist',
        hash: 'cd'.repeat(32),
        name: 'pq_renewals_at_risk_quarter',
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
const definition = { ...supremeRiskTemplate(sources), harness: 'honeybadger-supreme', intervalSeconds: 3600 }
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
const accounts = Array.from({ length: 10 }, (_, i) => ({
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
        rows: card.kind === 'metric' ? [cohort] : card.kind === 'bar' ? patterns : accounts,
        source: {
            harness: definition.harness,
            pin: card.kind === 'table' ? sources[1].name : sources[0].name,
            version: 1,
            hash: card.hash,
            params: card.params,
            scope: card.scope,
            rowsPath: card.rowsPath,
            completenessPath: card.completePath,
            ...(card.kind === 'table' ? { selection: { shown: 10, total: 218 } } : {})
        },
        fetchedAt: '2026-11-06T03:00:00Z'
    }))
}
const record = { id: 'demo', revision: 1, definition, snapshot, published: true, publishedAt: '2026-11-06T03:00:00Z' }
let reports = 0
await page.addInitScript(() => {
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
    let data = {}
    if (p.endsWith('/settings')) data = { PLATFORM_TYPE: 'open-source' }
    else if (p.endsWith('/authentication-settings')) data = { recovery: { available: true } }
    else if (p.endsWith('/harnesses')) data = [{ name: 'honeybadger-supreme' }]
    else if (p.includes('/dashflows/sources/')) data = { sources }
    else if (p.endsWith('/dashflows')) data = [record]
    else if (p.includes('/dashflows/demo')) data = record
    else if (p.endsWith('/runs/async')) {
        reports++
        data = { runId: 'synthetic-report' }
    } else if (p.endsWith('/synthetic-report/result'))
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
    await page.getByRole('heading', { name: 'Supreme · Renewal intelligence' }).waitFor()
    await page.locator('.df-value').filter({ hasText: '152' }).waitFor()
    await page.evaluate(() => {
        const badge = document.querySelector('.df-beta')
        if (badge) badge.textContent = 'SYNTHETIC DEMO DATA / MVP'
    })
    await page.screenshot({ path: path.join(output, 'supreme-builder.png'), fullPage: true })
    if (reports !== 0) throw new Error('Passive dashboard view executed a report')
    await page.getByRole('button', { name: 'Demo account 01 ↗' }).click()
    await page.getByRole('button', { name: 'Run full health report', exact: true }).click()
    await page.getByRole('heading', { name: 'Synthetic account health' }).waitFor()
    if (reports !== 1) throw new Error('Health report was not executed exactly once')
    await page.screenshot({ path: path.join(output, 'supreme-account-health.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.df-stacked .df-card').first().waitFor()
    await page.screenshot({ path: path.join(output, 'supreme-mobile.png'), fullPage: true })
    console.log(
        JSON.stringify({
            errors,
            reports,
            checks: [
                'Supreme four-card showcase',
                'account drill-in',
                'explicit health report',
                'source period filter',
                'stale data cleared',
                'published read-only',
                'mobile stacked cards'
            ],
            screenshots: output
        })
    )
} finally {
    await browser.close()
}
if (errors.length) process.exitCode = 1
