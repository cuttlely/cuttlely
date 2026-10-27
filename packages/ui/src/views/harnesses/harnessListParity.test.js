/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */

jest.mock('@/api/harnesses', () => ({
    __esModule: true,
    default: { listHarnesses: jest.fn(), deleteHarness: jest.fn(), updateHarnessCategory: jest.fn() }
}))
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ setError: () => {}, handleError: () => {} }) }))
jest.mock('react-router-dom', () => ({
    useNavigate: () => jest.fn(),
    Link: ({ to, children }) => require('react').createElement('a', { href: to }, children)
}))
jest.mock('@/layout/MainLayout/ViewHeader', () => ({
    __esModule: true,
    default: ({ title, children, search, onSearchChange }) =>
        require('react').createElement(
            'header',
            null,
            title,
            require('react').createElement('input', {
                'aria-label': 'Search harnesses',
                value: search,
                onChange: (event) => onSearchChange(event.target.value)
            }),
            children
        )
}))
jest.mock('@/ui-component/cards/MainCard', () => ({
    __esModule: true,
    default: ({ children }) => require('react').createElement('main', null, children)
}))
jest.mock('@/ui-component/cards/ItemCard', () => ({
    __esModule: true,
    default: ({ data }) => require('react').createElement('article', null, `${data.name} ${data.description}`)
}))
jest.mock('@/ui-component/flow/WhichFlow', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/flow/TryTheDemo', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/flow/buildChoices', () => ({ HARNESS_LABEL: 'Agent Team' }))
jest.mock('@/i18n', () => ({ t: (key) => key }))
jest.mock('@/ui-component/button/RBACButtons', () => {
    const React = require('react')
    const gate = (Tag) => {
        const Gated = (props) => {
            const rest = { ...props }
            delete rest.permissionId
            delete rest.display
            delete rest.startIcon
            return React.createElement(Tag, rest)
        }
        Gated.displayName = `Gated(${Tag})`
        return Gated
    }
    return { PermissionButton: gate('button'), StyledPermissionButton: gate('button'), PermissionIconButton: gate('button') }
})
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('react-redux', () => ({ useSelector: (selector) => selector({ customization: { isDarkMode: false } }) }))
jest.mock('@/ui-component/button/FlowListMenu', () => ({ __esModule: true, default: () => null }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import harnessesApi from '@/api/harnesses'
import Harnesses from './index'

const teams = [
    { name: 'ZZ-TEST-alpha', category: 'sales;ops', updatedAt: '2026-01-01T00:00:00Z' },
    { name: 'ZZ-TEST-beta', updatedAt: '2026-02-01T00:00:00Z' }
]
let container
let root

beforeEach(async () => {
    localStorage.clear()
    jest.clearAllMocks()
    harnessesApi.listHarnesses.mockResolvedValue({ data: teams })
    harnessesApi.updateHarnessCategory.mockResolvedValue({ data: teams[0] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Harnesses)))
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    localStorage.clear()
})

it('reuses the table sorting, category chips, search and category dialog', async () => {
    await act(async () => fireEvent.click(within(container).getByTitle('List View')))
    expect(localStorage.getItem('harnessDisplayStyle')).toBe('list')
    const table = within(container).getByRole('table')
    expect(within(table).getByText('sales')).toBeTruthy()
    expect(within(table).getByText('ops')).toBeTruthy()
    const rowNames = () => [...table.querySelectorAll('tbody tr')].map((row) => row.querySelector('a').textContent)
    expect(rowNames()).toEqual(['ZZ-TEST-beta', 'ZZ-TEST-alpha'])
    expect(within(table).getByRole('link', { name: 'ZZ-TEST-alpha' }).getAttribute('href')).toBe('/harnesses/ZZ-TEST-alpha')
    await act(async () => fireEvent.click(within(table).getByText('Name')))
    expect(rowNames()).toEqual(['ZZ-TEST-alpha', 'ZZ-TEST-beta'])
    expect(localStorage.getItem('harnessOrderBy')).toBe('name')
    await act(async () => fireEvent.click(within(table).getByText('Name')))
    expect(rowNames()).toEqual(['ZZ-TEST-beta', 'ZZ-TEST-alpha'])
    expect(localStorage.getItem('harnessOrder')).toBe('desc')

    await act(async () => fireEvent.change(within(container).getByLabelText('Search harnesses'), { target: { value: 'OPS' } }))
    expect(rowNames()).toEqual(['ZZ-TEST-alpha'])
    await act(async () => fireEvent.click(within(table).getByTitle('Update Category')))
    const dialog = within(document.body).getByRole('dialog')
    expect(within(dialog).getByText('sales')).toBeTruthy()
    expect(within(dialog).getByText('ops')).toBeTruthy()
    await act(async () => fireEvent.change(within(dialog).getByLabelText('Add a tag'), { target: { value: 'support' } }))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Submit' })))
    expect(harnessesApi.updateHarnessCategory).toHaveBeenCalledWith('ZZ-TEST-alpha', 'sales;ops;support')
    expect(harnessesApi.listHarnesses).toHaveBeenCalledTimes(2)

    await act(async () => fireEvent.click(within(container).getByTitle('Card View')))
    expect(within(container).getByText(/ZZ-TEST-alpha/)).toBeTruthy()
    expect(container.textContent).not.toContain('ZZ-TEST-beta')
})
