/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
const mockAllowed = { delete: true }

jest.mock('@/api/harnesses', () => ({
    __esModule: true,
    default: { listHarnesses: jest.fn(), deleteHarness: jest.fn(), getHarness: jest.fn(), listRuns: jest.fn() }
}))
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ setError: () => {}, handleError: () => {} }) }))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn(), useParams: () => ({ name: 'navi-harness' }) }))
jest.mock('@/layout/MainLayout/ViewHeader', () => ({
    __esModule: true,
    default: ({ title, children }) => require('react').createElement('header', null, title, children)
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
            const permission = rest.permissionId
            delete rest.permissionId
            delete rest.display
            return permission === 'chatflows:delete,agentflows:delete' && !mockAllowed.delete ? null : React.createElement(Tag, rest)
        }
        Gated.displayName = `Gated(${Tag})`
        return Gated
    }
    return { PermissionButton: gate('button'), StyledPermissionButton: gate('button'), PermissionIconButton: gate('button') }
})
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('react-redux', () => ({ useSelector: (selector) => selector({ customization: { isDarkMode: false } }) }))
jest.mock('@/ui-component/button/FlowListMenu', () => ({ __esModule: true, default: () => null }))
jest.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: jest.fn() }))
jest.mock('@/views/chatmessage/HarnessRunTrace', () => ({
    __esModule: true,
    default: () => null,
    questionFromInputPreview: () => '',
    tryItTraceQuestion: () => ''
}))
jest.mock('../../../../../packages/harness/trace.mjs', () => ({
    emptyTrace: () => ({}),
    failTrace: () => ({}),
    reduceHarnessEvent: () => ({})
}))
jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))
jest.mock('@/utils/harnessCanvasChat', () => ({ harnessCanvasRunPath: () => '', harnessRunPath: () => '' }))
jest.mock('./HarnessSchedule', () => ({ __esModule: true, default: () => null }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'

import harnessesApi from '@/api/harnesses'
import Harnesses from './index'
import HarnessHome from './HarnessHome'

const teams = [
    { name: 'navi', chatflowId: 'c1', specialists: [{}, {}] },
    { name: 'NAVI-B', specialists: [{}] },
    { name: 'navi-harness', chatflowId: 'c2', orphaned: true, specialists: [{}] }
]

let container
let root

async function render(component) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
        root.render(createElement(component))
    })
}

const button = (label) =>
    [...document.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') || item.textContent) === label)

beforeEach(() => {
    mockAllowed.delete = true
    harnessesApi.listHarnesses.mockResolvedValue({ data: teams })
    harnessesApi.deleteHarness.mockReset()
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
})

describe('Agent Team card delete', () => {
    it('asks with the team name, deletes, and reloads the list', async () => {
        harnessesApi.deleteHarness.mockResolvedValue({ data: { name: 'NAVI-B', deleted: true } })
        await render(Harnesses)
        await act(async () => fireEvent.click(button('Delete NAVI-B')))
        expect(document.body.textContent).toContain('Delete agent team "NAVI-B"?')
        harnessesApi.listHarnesses.mockResolvedValue({ data: teams.filter((team) => team.name !== 'NAVI-B') })
        await act(async () => fireEvent.click(button('Delete')))
        expect(harnessesApi.deleteHarness).toHaveBeenCalledWith('NAVI-B')
        expect(harnessesApi.listHarnesses).toHaveBeenCalledTimes(2)
        expect(container.textContent).not.toContain('NAVI-B')
    })

    it('shows a permission message on 403 and keeps the card', async () => {
        harnessesApi.deleteHarness.mockRejectedValue({ response: { status: 403, data: { message: 'Forbidden' } } })
        await render(Harnesses)
        await act(async () => fireEvent.click(button('Delete navi')))
        await act(async () => fireEvent.click(button('Delete')))
        expect(document.body.textContent).toContain('You do not have permission to delete this agent team.')
        expect(container.textContent).toContain('navi')
    })

    it('hides the delete button without delete permission', async () => {
        mockAllowed.delete = false
        await render(Harnesses)
        expect(button('Delete navi')).toBeUndefined()
    })

    it('marks an orphan card and keeps it deletable', async () => {
        await render(Harnesses)
        expect(container.textContent).toContain('navi-harness Canvas deleted. This team cannot run.')
        expect(button('Delete navi-harness')).toBeDefined()
    })
})

describe('opening an orphan', () => {
    it('shows a clear message instead of the run page', async () => {
        harnessesApi.getHarness.mockResolvedValue({ data: { name: 'navi-harness', chatflowId: 'c2', orphaned: true, specialists: [{}] } })
        harnessesApi.listRuns.mockResolvedValue({ data: [] })
        await render(HarnessHome)
        expect(container.textContent).toContain('The canvas this agent team was built from has been deleted')
        expect(container.textContent).not.toContain('Try it')
    })
})
