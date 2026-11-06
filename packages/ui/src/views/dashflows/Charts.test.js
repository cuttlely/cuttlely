/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import Chart, { chartOrderedRows, sortedRows } from './Charts'

it('sorts rendered values while retaining original evidence row indices and nulls last', () => {
    const rows = [{ value: '12' }, { value: null }, { value: '90' }]
    expect(sortedRows(rows, 'value', 'value-desc').map((r) => r.index)).toEqual([2, 0, 1])
    expect(sortedRows(rows, 'value', 'value-asc').map((r) => r.index)).toEqual([0, 2, 1])
    expect(rows[0].value).toBe('12')
})

it('trend keeps returned observation order even with a saved value-sort config', () => {
    const rows = [
        { period: 'A', amount: '10' },
        { period: 'B', amount: '30' },
        { period: 'C', amount: '20' }
    ]
    const saved = { kind: 'trend', valueField: 'amount', labelField: 'period', sort: 'value-desc', title: 'Trajectory' }
    expect(chartOrderedRows(saved, rows).map((r) => r.index)).toEqual([0, 1, 2])
    expect(chartOrderedRows(saved, rows).map((r) => r.row.period)).toEqual(['A', 'B', 'C'])
    // bar still honors value-sort
    expect(chartOrderedRows({ ...saved, kind: 'bar' }, rows).map((r) => r.index)).toEqual([1, 2, 0])
})

it('trend SVG plots left-to-right in observation order despite saved value-desc', () => {
    const inspect = jest.fn()
    const rows = [
        { period: 'A', amount: '10' },
        { period: 'B', amount: '30' },
        { period: 'C', amount: '20' }
    ]
    const card = { kind: 'trend', valueField: 'amount', labelField: 'period', sort: 'value-desc', title: 'Trajectory' }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(createElement(Chart, { card, rows, inspect })))
    const circles = [...container.querySelectorAll('circle')]
    expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual(['A: 10', 'B: 30', 'C: 20'])
    const xs = circles.map((c) => Number(c.getAttribute('cx')))
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
    expect(container.querySelector('.df-chart-ends').textContent).toBe('AC')
    act(() => circles[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(inspect).toHaveBeenCalledWith(1)
    act(() => root.unmount())
    container.remove()
})
