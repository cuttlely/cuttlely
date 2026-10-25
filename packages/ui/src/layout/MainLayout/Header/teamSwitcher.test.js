/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
const mockUser = {
    id: 'user-1',
    activeOrganizationId: 'org-1',
    activeWorkspaceId: 'team-default',
    activeWorkspace: 'Default Workspace',
    assignedWorkspaces: [{ id: 'team-default', name: 'Default Workspace' }]
}
const mockState = {
    auth: {
        isAuthenticated: true,
        user: mockUser,
        features: {}
    },
    customization: { isDarkMode: false }
}
const mockConfig = {
    isEnterpriseLicensed: false,
    isCloud: false,
    isOpenSource: true,
    loading: false
}

jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn(),
    useSelector: (selector) => selector(mockState)
}))
jest.mock('react-router-dom', () => ({
    useNavigate: () => jest.fn()
}))
jest.mock('@/store', () => ({
    store: {
        dispatch: jest.fn(),
        getState: () => mockState,
        subscribe: () => () => {}
    }
}))
jest.mock('@/store/context/ErrorContext', () => ({
    useError: () => ({ setError: () => {}, handleError: () => {} })
}))
jest.mock('@/store/context/ConfigContext', () => ({
    useConfig: () => mockConfig
}))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/api/account.api', () => ({
    __esModule: true,
    default: { logout: jest.fn() }
}))
jest.mock('@/api/user', () => ({
    __esModule: true,
    default: {
        getWorkspacesByUserId: jest.fn(),
        getWorkspacesByOrganizationIdUserId: jest.fn()
    }
}))
jest.mock('@/api/workspace', () => ({
    __esModule: true,
    default: { switchWorkspace: jest.fn() }
}))
jest.mock('../LogoSection', () => ({ __esModule: true, default: () => null }))
jest.mock('./ProfileSection', () => ({ __esModule: true, default: () => null }))
jest.mock('./OrgWorkspaceBreadcrumbs', () => ({ __esModule: true, default: () => null }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import userApi from '@/api/user'
import Header from './index'

const theme = createTheme()
theme.typography.commonAvatar = { cursor: 'pointer', borderRadius: '8px' }
theme.typography.mediumAvatar = { width: '34px', height: '34px', fontSize: '1.2rem' }

let root

async function renderHeader(teams, options = {}) {
    mockConfig.isEnterpriseLicensed = options.isEnterpriseLicensed === true
    mockConfig.isCloud = options.isCloud === true
    mockConfig.isOpenSource = options.isOpenSource !== false
    mockUser.assignedWorkspaces = teams.map((team) => ({ id: team.id, name: team.name }))
    mockUser.activeWorkspaceId = teams[0].id
    mockUser.activeWorkspace = teams[0].name
    userApi.getWorkspacesByUserId.mockResolvedValue({
        data: teams.map((team) => ({ workspaceId: team.id, workspace: { name: team.name } }))
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme }, createElement(Header, { handleLeftDrawerToggle: () => {} })))
    })
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
    })
}

beforeEach(() => {
    document.body.innerHTML = ''
    userApi.getWorkspacesByUserId.mockReset()
})

afterEach(() => {
    if (root) act(() => root.unmount())
    document.body.innerHTML = ''
})

describe('header team switcher', () => {
    it('renders the team switcher in OSS with two teams and not with one', async () => {
        await renderHeader([
            { id: 'team-default', name: 'Default Workspace' },
            { id: 'team-field', name: 'Field' }
        ])
        expect(document.getElementById('workspace-switcher')).toBeTruthy()
        expect(document.getElementById('workspace-switcher').textContent).toContain('Default Workspace')
        act(() => root.unmount())
        root = undefined
        document.body.innerHTML = ''

        await renderHeader([{ id: 'team-default', name: 'Default Workspace' }])
        expect(document.getElementById('workspace-switcher')).toBeNull()
    })

    it('renders the team switcher on cloud with two teams and no enterprise license', async () => {
        await renderHeader(
            [
                { id: 'team-default', name: 'Default Workspace' },
                { id: 'team-field', name: 'Field' }
            ],
            { isCloud: true, isEnterpriseLicensed: false, isOpenSource: false }
        )
        expect(document.getElementById('workspace-switcher')).toBeTruthy()
        expect(document.getElementById('workspace-switcher').textContent).toContain('Default Workspace')
        act(() => root.unmount())
        root = undefined
        document.body.innerHTML = ''

        await renderHeader([{ id: 'team-default', name: 'Default Workspace' }], {
            isCloud: true,
            isEnterpriseLicensed: false,
            isOpenSource: false
        })
        expect(document.getElementById('workspace-switcher')).toBeNull()
    })
})
