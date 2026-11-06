/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DashboardCard } from './index'

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
    expect(container.textContent).toContain('123456789.0123456789')
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
    expect(buttons[1].title).toContain('South: 7')
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
