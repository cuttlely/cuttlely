/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import EvidencePanel from './EvidencePanel'
import ExecutiveTooltip from './ExecutiveTooltip'
jest.mock('./AccountReport', () => ({
    __esModule: true,
    default: ({ row }) => require('react').createElement('div', { 'data-testid': 'selected-account' }, row.account_name),
    accountIdentity: (row) => (row?.account_id?.startsWith('001') ? row.account_id : null)
}))
let container, root
beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.useRealTimers()
})
it('shows all 100 cached details with coverage, human labels and exact account drill-down', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
        account_id: `001${String(i).padStart(15, '0')}`,
        account_name: `Demo company ${i}`,
        renewal_date: '2026-12-15',
        renewal_acv: '12000.50',
        risk_radar: 'High Risk'
    }))
    const evidence = {
        card: { title: 'Open pipeline', kind: 'metric', scope: 'Next 30 days', valueField: 'deal_count' },
        snapshot: {
            rows: [{ deal_count: 250, deal_details: rows, next_page: 2 }],
            source: { params: {}, pin: 'synthetic' },
            fetchedAt: '2026-11-06T00:00:00Z'
        }
    }
    act(() => root.render(createElement(EvidencePanel, { evidence, harness: 'example', canRun: true, onClose: () => {} })))
    expect(container.querySelectorAll('.df-account-link')).toHaveLength(100)
    expect(container.textContent).toContain('100 of 250 source records')
    expect(container.textContent).toContain('limited selection')
    expect(container.textContent).toContain('Dec 15, 2026')
    expect(container.textContent).toContain('12,000.50')
    act(() => container.querySelectorAll('.df-account-link')[99].click())
    expect(container.querySelector('[data-testid="selected-account"]').textContent).toBe('Demo company 99')
})
it('explicitly explains when the source has no individual records', () => {
    const evidence = {
        card: { title: 'Retention', kind: 'metric', scope: 'YTD', valueField: 'retention_pct' },
        snapshot: { rows: [{ retention_pct: '77.9' }], source: { params: {} }, fetchedAt: '2026-11-06T00:00:00Z' }
    }
    act(() => root.render(createElement(EvidencePanel, { evidence, harness: 'example', onClose: () => {} })))
    expect(container.textContent).toContain('not individual account records')
    expect(container.querySelectorAll('.df-account-link')).toHaveLength(0)
})
it('opens an executive tooltip with account name, precise value, scope and freshness on focus', () => {
    jest.useFakeTimers()
    const card = { title: 'Renewal exposure', valueField: 'renewal_acv', labelField: 'account_id', scope: 'Next quarter · source units' }
    const row = {
        account_name: 'Demo company',
        account_id: '001000000000000AAA',
        renewal_acv: '12000.50',
        renewal_date: '2026-12-15',
        risk_radar: 'High Risk'
    }
    act(() =>
        root.render(
            createElement(
                ExecutiveTooltip,
                { card, row, snapshot: { fetchedAt: '2026-11-06T00:00:00Z' } },
                createElement('button', null, 'Inspect')
            )
        )
    )
    act(() => {
        container.querySelector('button').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        jest.advanceTimersByTime(250)
    })
    const tip = document.querySelector('[role="tooltip"]')
    expect(tip.textContent).toContain('Demo company')
    expect(tip.textContent).toContain('12,000.50')
    expect(tip.textContent).toContain('Dec 15, 2026')
    expect(tip.textContent).toContain('Snapshot refreshed')
    expect(tip.textContent).not.toContain(row.account_id)
})
