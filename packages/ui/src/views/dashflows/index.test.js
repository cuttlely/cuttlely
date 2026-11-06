/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { assignParamValue, DASH_FLOWS_BADGE, DashboardCard, DashFlowsOff, pollDashboard, REFRESH_OPTIONS } from './index'

jest.mock('@/ui-component/markdown/MemoizedReactMarkdown', () => ({ MemoizedReactMarkdown: ({ children }) => children }))

jest.mock('@/api/client', () => ({ __esModule: true, default: {} }))
jest.mock('@/api/harnesses', () => ({ __esModule: true, default: {} }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
const card = { id: 'card', title: 'Synthetic metric', kind: 'metric', scope: 'October / sample', valueField: 'amount' }
let container, root
beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
})
it('retains decimal source bytes and opens the evidence for the exact snapshot', () => {
    const inspect = jest.fn()
    const snapshot = { rows: [{ amount: '123456789.0123456789' }] }
    act(() => root.render(createElement(DashboardCard, { data: { card, snapshot, inspect } })))
    expect(container.querySelector('.df-value span').dataset.exactValue).toBe('123456789.0123456789')
    expect(container.textContent).toContain('123.46M')
    act(() => container.querySelector('button.df-evidence').click())
    expect(inspect).toHaveBeenCalledWith(card, snapshot)
})
it('shows unavailable and empty as different states, never fabricated zeroes', () => {
    act(() => root.render(createElement(DashboardCard, { data: { card } })))
    expect(container.textContent).toContain('Ready for its first refresh')
    expect(container.querySelector('button.df-evidence').disabled).toBe(true)
    act(() => root.render(createElement(DashboardCard, { data: { card, snapshot: { rows: [] } } })))
    expect(container.textContent).toContain('No rows in this scope')
})
it('bar hover labels show exact values and drill into the selected source row', () => {
    const inspect = jest.fn()
    const bar = { ...card, kind: 'bar', labelField: 'region' }
    const snapshot = {
        rows: [
            { region: 'North', amount: '18.25' },
            { region: 'South', amount: '7' }
        ]
    }
    act(() => root.render(createElement(DashboardCard, { data: { card: bar, snapshot, inspect } })))
    const buttons = container.querySelectorAll('button.df-bar-row')
    expect(buttons[1].getAttribute('aria-label')).toContain('South: 7')
    act(() => buttons[1].click())
    expect(inspect).toHaveBeenCalledWith(bar, snapshot, 1)
})
it('renders source text as text, not HTML', () => {
    const table = { ...card, kind: 'table' }
    act(() =>
        root.render(createElement(DashboardCard, { data: { card: table, snapshot: { rows: [{ note: '<img src=x onerror=alert(1)>' }] } } }))
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
})

it('clicking an account in a sorted source table retains the original evidence row', () => {
    const inspect = jest.fn()
    const table = { ...card, kind: 'table', columns: ['account_name'] }
    const snapshot = {
        rows: [
            { account_id: '001000000000000AAA', account_name: 'Zeta demo' },
            { account_id: '001000000000000AAB', account_name: 'Alpha demo' }
        ]
    }
    act(() => root.render(createElement(DashboardCard, { data: { card: table, snapshot, inspect } })))
    act(() => container.querySelector('.df-sort-header').click())
    act(() => container.querySelector('.df-account-link').click())
    expect(inspect).toHaveBeenCalledWith(table, snapshot, 1)
})

it('labels the UI as BETA and offers only on-demand or weekly refresh', () => {
    expect(DASH_FLOWS_BADGE).toBe('BETA')
    expect(REFRESH_OPTIONS).toEqual([
        { value: 0, label: 'On demand' },
        { value: 604800, label: 'Every week' }
    ])
})

it('shows how to turn on the BETA when a deep link is off', () => {
    act(() => root.render(createElement(DashFlowsOff)))
    expect(container.textContent).toContain('Dashflows BETA is off')
    expect(container.textContent).toContain('Server Settings > Experimental')
    expect(container.textContent).toContain('BETA')
})

it('polls an accepted refresh until the stored result is ready', async () => {
    const fetchRecord = jest
        .fn()
        .mockResolvedValueOnce({ data: { id: 'demo', refreshing: true } })
        .mockResolvedValueOnce({ data: { id: 'demo', refreshing: false, snapshot: { id: 'new' } } })
    const pause = jest.fn(async () => {})
    await expect(pollDashboard(fetchRecord, pause)).resolves.toMatchObject({ refreshing: false, snapshot: { id: 'new' } })
    expect(fetchRecord).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledTimes(2)
})

it('keeps int8 and numeric parameter edits as exact digit strings', () => {
    const big = '9007199254740993'
    const next = assignParamValue({ account: '1' }, 'amount', big, 'numeric')
    expect(next.amount).toBe(big)
    expect(typeof next.amount).toBe('string')
    expect(assignParamValue(next, 'amount', '', 'numeric')).toEqual({ account: '1' })
})

it('aborts refresh polling when the signal is aborted', async () => {
    const controller = new AbortController()
    const fetchRecord = jest.fn().mockResolvedValue({ data: { refreshing: true } })
    const pause = jest.fn(async () => {
        controller.abort()
    })
    await expect(pollDashboard(fetchRecord, pause, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
it('shows ACV cents while retaining the exact source value for evidence', () => {
    const snapshot = { rows: [{ renewal_acv: '12345.6789' }] }
    act(() =>
        root.render(createElement(DashboardCard, { data: { card: { ...card, valueField: 'renewal_acv' }, snapshot, inspect: jest.fn() } }))
    )
    const value = container.querySelector('.df-value span')
    expect(value.textContent).toBe('12,345.68')
    expect(value.dataset.exactValue).toBe('12345.6789')
})
