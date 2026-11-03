/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
// The live status line on a running run card: one line per streamed event type, a ticking timer, and the optional
// enhanced line that waits a few seconds, stays out of announcements, and gives way to the next real event.
import { createElement } from 'react'
import { act, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createStore } from 'redux'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import HarnessRunTrace from './HarnessRunTrace'
import { emptyTrace, reduceHarnessEvent } from '../../../../../packages/harness/trace.mjs'

const theme = createTheme()
const store = createStore(() => ({ customization: { isDarkMode: false } }))
const card = (trace, props = {}) =>
    createElement(Provider, { store }, createElement(ThemeProvider, { theme }, createElement(HarnessRunTrace, { trace, ...props })))
const fold = (events) => events.reduce((trace, event) => reduceHarnessEvent(trace, event), emptyTrace('desk'))

const ROUTE = [
    { type: 'route', phase: 'start' },
    { type: 'route', phase: 'done', steps: [{ specialist: 'researcher' }, { specialist: 'sql_analyst' }] }
]
const QUERYING = [
    ...ROUTE,
    { type: 'specialist', phase: 'start', name: 'sql_analyst' },
    { type: 'tool', phase: 'start', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' }
]
const line = () => screen.getByTestId('live-status-line').textContent
const enhanced = () => screen.queryByTestId('live-status-enhanced')?.textContent || ''

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('live status line', () => {
    test('says what the run is doing for each streamed event type', () => {
        const cases = [
            [[ROUTE[0]], 'Picking specialists…'],
            [[...ROUTE, { type: 'specialist', phase: 'start', name: 'researcher' }], 'researcher is working…'],
            [QUERYING, 'sql_analyst is running a SQL query…'],
            [
                [...QUERYING, { type: 'tool', phase: 'done', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' }],
                'sql_analyst is thinking about the results…'
            ],
            [[...QUERYING, { type: 'handoff', phase: 'start' }], 'Pulling it together and writing the answer…']
        ]
        for (const [events, expected] of cases) {
            const { unmount } = render(card(fold(events)))
            expect(line()).toBe(expected)
            unmount()
        }
    })

    test('a running specialist row shows its own status and the timer ticks', () => {
        render(card(fold(QUERYING)))
        expect(screen.getByText('Running a SQL query…')).toBeTruthy()
        expect(screen.getByTestId('live-status-elapsed').textContent).toBe('0:00')
        act(() => jest.advanceTimersByTime(3000))
        expect(screen.getByTestId('live-status-elapsed').textContent).toBe('0:03')
        expect(screen.getByTestId('live-status-announce').textContent).toBe('sql_analyst is running a SQL query…')
    })

    test('a finished run shows no live line', () => {
        const trace = fold([...QUERYING, { type: 'final', trace: { ...fold(QUERYING), status: 'completed' } }])
        render(card(trace))
        expect(screen.queryByTestId('live-status')).toBeNull()
        expect(screen.getByText('Finished')).toBeTruthy()
    })

    test('the enhanced line waits, stays out of announcements, and clears when a real event arrives', () => {
        const { rerender } = render(card(fold(QUERYING)))
        expect(enhanced()).toBe('')
        act(() => jest.advanceTimersByTime(5000))
        expect(enhanced()).toBe('Cross-checking the numbers…')
        expect(screen.getByTestId('live-status-announce').textContent).not.toContain('Cross-checking')
        rerender(card(fold([...QUERYING, { type: 'tool', phase: 'done', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' }])))
        expect(line()).toBe('sql_analyst is thinking about the results…')
        expect(enhanced()).toBe('')
    })

    test('the enhanced line is off when the flow turns it off', () => {
        render(card(fold(QUERYING), { enhancedStatus: false }))
        act(() => jest.advanceTimersByTime(30000))
        expect(line()).toBe('sql_analyst is running a SQL query…')
        expect(enhanced()).toBe('')
    })
})
