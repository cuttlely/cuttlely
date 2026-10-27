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
    default: ({ data, images, categories }) => {
        const React = require('react')
        return React.createElement(
            'article',
            null,
            `${data.name} ${data.description}`,
            ...(images || []).map((image) => React.createElement('img', { key: image.imageSrc, src: image.imageSrc, alt: image.label })),
            ...(categories || []).map((tag) => React.createElement('span', { key: tag, 'data-chip': tag }, tag))
        )
    }
}))
jest.mock('@/store/constant', () => ({ baseURL: 'http://ui.test' }))
jest.mock('@/ui-component/flow/WhichFlow', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/flow/TryTheDemo', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/flow/buildChoices', () => ({ HARNESS_LABEL: 'Agent Team' }))
jest.mock('@/i18n', () => ({ t: (key) => key }))
jest.mock('@/ui-component/button/RBACButtons', () => {
    const React = require('react')
    const gate = (Tag) => {
        const Gated = (props) => {
            // eslint-disable-next-line react/prop-types
            const rest = { ...props, 'data-permission': props.permissionId }
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
import { HARNESS_CATEGORY_PERMISSION } from '@/utils/flowCategoryPermission'
import { harnessCategories, harnessNodeImages } from '@/utils/harnessCard'
import Harnesses from './index'

const teams = [
    {
        name: 'ZZ-TEST-alpha',
        category: 'sales;ops',
        updatedAt: '2026-01-01T00:00:00Z',
        chief: { model: { nodeName: 'chatOpenAI', label: 'ChatOpenAI' } },
        specialists: [
            {
                name: 'researcher',
                model: { nodeName: 'chatAnthropic', label: 'ChatAnthropic' },
                modules: [{ nodeName: 'calculator', label: 'Calculator' }],
                mcpServers: [{ nodeName: 'customMCP', label: 'Custom MCP' }]
            },
            { name: 'writer', model: { nodeName: 'chatOpenAI', label: 'ChatOpenAI' }, modules: [], mcpServers: [] }
        ]
    },
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

const icon = (name) => `http://ui.test/api/v1/node-icon/${name}`

it('shows each member node icon once in the Nodes column and on the card', async () => {
    const cardIcons = () => [...container.querySelectorAll('article img')].map((img) => img.getAttribute('src'))
    expect(cardIcons()).toEqual([icon('chatOpenAI'), icon('chatAnthropic'), icon('calculator'), icon('customMCP')])

    await act(async () => fireEvent.click(within(container).getByTitle('List View')))
    const row = within(container).getByRole('link', { name: 'ZZ-TEST-alpha' }).closest('tr')
    const rowIcons = [...row.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(rowIcons).toEqual([icon('chatOpenAI'), icon('chatAnthropic'), icon('calculator'), icon('customMCP')])
    const betaRow = within(container).getByRole('link', { name: 'ZZ-TEST-beta' }).closest('tr')
    expect(betaRow.querySelectorAll('img')).toHaveLength(0)
})

it('shows category chips on cards', () => {
    const [alpha, beta] = container.querySelectorAll('article')
    expect([...alpha.querySelectorAll('[data-chip]')].map((chip) => chip.textContent)).toEqual(['sales', 'ops'])
    expect(beta.querySelectorAll('[data-chip]')).toHaveLength(0)
})

it('gates the tag action in both views on the permission the harness category route accepts', async () => {
    expect(HARNESS_CATEGORY_PERMISSION).toBe('chatflows:update,agentflows:update')
    const cardTags = within(container).getAllByTitle('Update Category')
    expect(cardTags).toHaveLength(2)
    for (const button of cardTags) expect(button.getAttribute('data-permission')).toBe(HARNESS_CATEGORY_PERMISSION)
    await act(async () => fireEvent.click(within(container).getByTitle('List View')))
    for (const button of within(container).getAllByTitle('Update Category')) {
        expect(button.getAttribute('data-permission')).toBe(HARNESS_CATEGORY_PERMISSION)
    }
})

it('builds node icons and chips from the stored record without failing on old shapes', () => {
    expect(harnessNodeImages({ chief: { model: { provider: 'openai', model: 'gpt' } }, specialists: [{ modules: ['x', null] }] })).toEqual(
        []
    )
    expect(harnessNodeImages(undefined)).toEqual([])
    expect(harnessNodeImages({ chief: { model: { nodeName: 'a b' } } }, '/base')).toEqual([
        { imageSrc: '/base/api/v1/node-icon/a%20b', label: 'a b' }
    ])
    expect(
        harnessNodeImages({
            chief: { model: { nodeName: 'chatOpenAI' }, fallbackModel: { nodeName: 'chatOllama', label: 'Ollama' } },
            specialists: [{ model: { nodeName: 'chatOpenAI' }, fallbackModel: { nodeName: 'chatGroq' } }]
        }).map((image) => image.label)
    ).toEqual(['chatOpenAI', 'Ollama', 'chatGroq'])
    expect(harnessCategories({ category: 'a;;b' })).toEqual(['a', 'b'])
    expect(harnessCategories({})).toEqual([])
})

it('the real card renders the chips and node icons it is given', async () => {
    const RealItemCard = jest.requireActual('@/ui-component/cards/ItemCard').default
    const { ThemeProvider, createTheme } = require('@mui/material/styles')
    const theme = createTheme({ palette: { card: { main: '#fff', hover: '#eee' } } })
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const cardRoot = createRoot(holder)
    await act(async () =>
        cardRoot.render(
            createElement(
                ThemeProvider,
                { theme },
                createElement(RealItemCard, {
                    data: { name: 'ZZ-TEST-alpha', type: 'HARNESS' },
                    images: harnessNodeImages(teams[0], 'http://ui.test'),
                    categories: harnessCategories(teams[0])
                })
            )
        )
    )
    expect(within(holder).getByText('sales')).toBeTruthy()
    expect(within(holder).getByText('ops')).toBeTruthy()
    expect(holder.querySelectorAll('img')).toHaveLength(3)
    expect(within(holder).getByText('+ 1 More')).toBeTruthy()
    act(() => cardRoot.unmount())
    holder.remove()
})
