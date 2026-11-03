/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement as h } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import SortableTable from './SortableTable'

function table(prefix = '') {
    return h(
        SortableTable,
        {},
        h('thead', {}, h('tr', {}, h('th', {}, `${prefix}Account`), h('th', {}, 'ACV'))),
        h(
            'tbody',
            {},
            h('tr', { key: 'a' }, h('td', {}, h('a', { href: '/alpha' }, 'Alpha')), h('td', {}, '$10,000.00')),
            h('tr', { key: 'b' }, h('td', {}, 'Bravo'), h('td', {}, '$900.00')),
            h('tr', { key: 'c' }, h('td', {}, 'Charlie'), h('td', {}, 'Unknown'))
        )
    )
}

test('canvas table retains source order until clicked, toggles numeric order and preserves complete cells', () => {
    const { container, rerender } = render(table())
    const names = () => Array.from(container.querySelectorAll('tbody tr'), (row) => row.cells[0].textContent)
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    fireEvent.click(screen.getByRole('button', { name: 'Sort by ACV, ascending' }))
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    fireEvent.click(screen.getByRole('button', { name: 'Sort by ACV, descending' }))
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(container.querySelector('th[aria-sort="descending"]').textContent).toContain('ACV')
    expect(container.querySelector('a').getAttribute('href')).toBe('/alpha')
    rerender(table())
    expect(container.querySelector('th[aria-sort="descending"]')).not.toBeNull()
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie'])
})

test('separate tables keep independent sorting state', () => {
    const { container } = render(h('div', {}, table(), table('Other ')))
    fireEvent.click(screen.getAllByRole('button', { name: 'Sort by ACV, ascending' })[0])
    const tables = container.querySelectorAll('table')
    expect(tables[0].tBodies[0].rows[0].cells[0].textContent).toBe('Bravo')
    expect(tables[1].tBodies[0].rows[0].cells[0].textContent).toBe('Alpha')
})
