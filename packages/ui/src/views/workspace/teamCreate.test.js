/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
const mockNavigate = jest.fn()
const mockStoreDispatch = jest.fn()
const mockDispatch = jest.fn()
const mockUser = {
    id: 'user-1',
    activeOrganizationId: 'org-1',
    activeWorkspaceId: 'team-default',
    activeWorkspace: 'Default Workspace',
    assignedWorkspaces: [
        { id: 'team-default', name: 'Default Workspace' },
        { id: 'team-field', name: 'Field' }
    ]
}
const mockState = {
    auth: {
        isAuthenticated: true,
        isGlobal: true,
        permissions: ['workspace:create', 'workspace:delete', 'workspace:update'],
        features: {},
        user: mockUser
    },
    customization: { isDarkMode: false }
}

jest.mock('react-redux', () => ({
    useDispatch: () => mockDispatch,
    useSelector: (selector) => selector(mockState)
}))
jest.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
    Link: ({ children }) => require('react').createElement('span', null, children)
}))
jest.mock('@/store', () => ({
    store: {
        dispatch: (action) => mockStoreDispatch(action),
        getState: () => mockState,
        subscribe: () => () => {}
    }
}))
jest.mock('@/store/context/ErrorContext', () => ({
    useError: () => ({ error: null, setError: () => {}, handleError: () => {} })
}))
jest.mock('@/store/context/ConfigContext', () => ({
    useConfig: () => ({ isOpenSource: true, isEnterpriseLicensed: false, isCloud: false, loading: false })
}))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/api/workspace', () => ({
    __esModule: true,
    default: {
        getAllWorkspacesByOrganizationId: jest.fn(),
        switchWorkspace: jest.fn(),
        createWorkspace: jest.fn(),
        updateWorkspace: jest.fn(),
        deleteWorkspace: jest.fn()
    }
}))
jest.mock('@/api/user', () => ({
    __esModule: true,
    default: { getAllUsersByWorkspaceId: jest.fn() }
}))
jest.mock('@/api/auth', () => ({
    __esModule: true,
    default: { refreshSession: jest.fn() }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import authApi from '@/api/auth'
import workspaceApi from '@/api/workspace'
import ConfirmContextProvider from '@/store/context/ConfirmContextProvider'
import { enqueueSnackbar } from '@/store/actions'
import authReducer, { workspaceSwitchSuccess } from '@/store/reducers/authSlice'
import Workspaces from './index'

const theme = createTheme()
theme.palette.teal = { main: '#0d9488' }

const teams = [
    {
        id: 'team-default',
        name: 'Default Workspace',
        description: 'home',
        userCount: 1,
        updatedDate: '2026-01-01T00:00:00.000Z',
        isOrgDefault: true
    },
    {
        id: 'team-field',
        name: 'Field',
        description: 'ops',
        userCount: 1,
        updatedDate: '2026-01-02T00:00:00.000Z',
        isOrgDefault: false
    }
]

let container
let root

function buttonByText(text) {
    return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
}

async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
    })
}

async function renderTeams() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme }, createElement(ConfirmContextProvider, null, createElement(Workspaces))))
    })
    await settle()
}

beforeEach(() => {
    document.body.innerHTML = '<div id="portal"></div>'
    mockUser.activeWorkspaceId = 'team-default'
    mockUser.activeWorkspace = 'Default Workspace'
    mockNavigate.mockReset()
    mockStoreDispatch.mockReset()
    mockDispatch.mockReset()
    workspaceApi.getAllWorkspacesByOrganizationId.mockReset()
    workspaceApi.getAllWorkspacesByOrganizationId.mockResolvedValue({ data: teams })
    workspaceApi.switchWorkspace.mockReset()
    workspaceApi.switchWorkspace.mockResolvedValue({
        data: { id: 'user-1', activeWorkspaceId: 'team-new', activeWorkspace: 'Field Notes', assignedWorkspaces: [] }
    })
    workspaceApi.createWorkspace.mockReset()
    workspaceApi.deleteWorkspace.mockReset()
    authApi.refreshSession.mockReset()
    authApi.refreshSession.mockResolvedValue({
        data: {
            id: 'user-1',
            activeWorkspaceId: 'team-default',
            activeWorkspace: 'Default Workspace',
            assignedWorkspaces: [
                { id: 'team-default', name: 'Default Workspace' },
                { id: 'team-new', name: 'Field Notes' }
            ]
        }
    })
    mockUser.assignedWorkspaces = [
        { id: 'team-default', name: 'Default Workspace' },
        { id: 'team-field', name: 'Field' }
    ]
})

async function submitNewTeam(name) {
    await act(async () => {
        fireEvent.click(document.getElementById('btn_createTeam'))
    })
    const dialog = document.querySelector('[role="dialog"]')
    const nameInput = dialog.querySelector('input')
    await act(async () => {
        fireEvent.change(nameInput, { target: { value: name } })
    })
    await act(async () => {
        fireEvent.click(buttonByText('Add'))
    })
    await settle()
}

afterEach(() => {
    if (root) act(() => root.unmount())
    document.body.innerHTML = ''
})

describe('team create', () => {
    it('creating a team leaves the active workspace unchanged', async () => {
        workspaceApi.createWorkspace.mockResolvedValue({
            data: { id: 'team-new', name: 'Field Notes', organizationId: 'org-1', userCount: 1 }
        })
        await renderTeams()
        expect(document.body.textContent).toContain('Default Workspace')
        await act(async () => {
            fireEvent.click(document.getElementById('btn_createTeam'))
        })
        const dialog = document.querySelector('[role="dialog"]')
        expect(dialog).toBeTruthy()
        const nameInput = dialog.querySelector('input')
        await act(async () => {
            fireEvent.change(nameInput, { target: { value: 'Field Notes' } })
        })
        await act(async () => {
            fireEvent.click(buttonByText('Add'))
        })
        await settle()
        expect(workspaceApi.createWorkspace).toHaveBeenCalled()
        expect(workspaceApi.switchWorkspace).not.toHaveBeenCalled()
        expect(mockNavigate).not.toHaveBeenCalled()
        const switched = mockStoreDispatch.mock.calls.map((call) => call[0]).find((action) => action?.type === workspaceSwitchSuccess.type)
        expect(switched).toBeDefined()
        expect(switched.payload.activeWorkspaceId).toBe('team-default')
        expect(mockUser.activeWorkspaceId).toBe('team-default')
    })

    it('keeps the created team in the session list and shows an error toast when refresh fails', async () => {
        authApi.refreshSession.mockRejectedValue(new Error('Session unavailable'))
        const created = { id: 'team-new', name: 'Field Notes', organizationId: 'org-1', userCount: 1 }
        workspaceApi.createWorkspace.mockResolvedValue({ data: created })
        await renderTeams()
        await submitNewTeam('Field Notes')
        const actions = mockStoreDispatch.mock.calls.map(([action]) => action)
        const updated = actions.reduce(authReducer, mockState.auth)
        expect(updated.user.assignedWorkspaces).toEqual(
            expect.arrayContaining([
                { id: 'team-default', name: 'Default Workspace' },
                { id: 'team-field', name: 'Field' },
                expect.objectContaining({ id: 'team-new', name: 'Field Notes' })
            ])
        )
        expect(updated.user.activeWorkspaceId).toBe('team-default')
        expect(workspaceApi.switchWorkspace).not.toHaveBeenCalled()
        expect(mockDispatch.mock.calls.map(([action]) => action)).toContainEqual(
            expect.objectContaining({
                type: enqueueSnackbar({}).type,
                notification: expect.objectContaining({ options: expect.objectContaining({ variant: 'error' }) })
            })
        )
    })

    it('keeps the current team and lists the new team so the switcher can show it', async () => {
        const session = {
            id: 'user-1',
            activeWorkspaceId: 'team-default',
            activeWorkspace: 'Default Workspace',
            assignedWorkspaces: [
                { id: 'team-default', name: 'Default Workspace' },
                { id: 'team-new', name: 'Field Notes' }
            ]
        }
        authApi.refreshSession.mockResolvedValue({ data: session })
        workspaceApi.createWorkspace.mockResolvedValue({
            data: { id: 'team-new', name: 'Field Notes', organizationId: 'org-1', userCount: 1 }
        })
        await renderTeams()
        await submitNewTeam('Field Notes')
        expect(workspaceApi.createWorkspace).toHaveBeenCalled()
        expect(workspaceApi.switchWorkspace).not.toHaveBeenCalled()
        expect(authApi.refreshSession).toHaveBeenCalledTimes(1)
        const switched = mockStoreDispatch.mock.calls.map((call) => call[0]).find((action) => action?.type === workspaceSwitchSuccess.type)
        expect(switched?.payload).toEqual(session)
        expect(switched.payload.activeWorkspaceId).toBe('team-default')
        expect(switched.payload.assignedWorkspaces).toEqual(session.assignedWorkspaces)
        expect(mockUser.activeWorkspaceId).toBe('team-default')
    })
})

describe('team delete', () => {
    it('deleting the active team refetches the session', async () => {
        mockUser.activeWorkspaceId = 'team-field'
        mockUser.activeWorkspace = 'Field'
        const fallback = {
            id: 'user-1',
            activeOrganizationId: 'org-1',
            activeWorkspaceId: 'team-default',
            activeWorkspace: 'Default Workspace',
            assignedWorkspaces: [{ id: 'team-default', name: 'Default Workspace' }],
            permissions: [],
            features: {}
        }
        authApi.refreshSession.mockResolvedValue({ data: fallback })
        workspaceApi.deleteWorkspace.mockResolvedValue({ data: { id: 'team-field' } })
        await renderTeams()
        const remove = document.querySelector('button[title="Delete"]')
        expect(remove).toBeTruthy()
        await act(async () => {
            fireEvent.click(remove)
        })
        await act(async () => {
            fireEvent.click(buttonByText('Delete'))
        })
        await settle()
        expect(workspaceApi.deleteWorkspace).toHaveBeenCalledWith('team-field')
        expect(authApi.refreshSession).toHaveBeenCalledTimes(1)
        expect(workspaceApi.switchWorkspace).not.toHaveBeenCalled()
        const switched = mockStoreDispatch.mock.calls.map((call) => call[0]).find((action) => action?.type === workspaceSwitchSuccess.type)
        expect(switched?.payload).toEqual(fallback)
    })
})
