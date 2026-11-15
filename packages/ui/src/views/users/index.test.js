import { act, create } from 'react-test-renderer'
import Users from './index'
import mockUserApi from '@/api/user'

const mockConfirm = jest.fn()
const mockRequest = jest.fn()
const mockDispatch = jest.fn()
let mockNarrow = false
let mockLocalUsers = true
const mockCurrentUser = { id: 'owner-1', activeOrganizationId: 'org-1', activeWorkspaceId: 'team-1', isOrganizationAdmin: true }
const mockRows = [
    {
        organizationId: 'org-1',
        userId: 'pending',
        isOrgOwner: true,
        status: 'invited',
        roleCount: 0,
        user: { id: 'pending', name: 'Pending', email: 'pending@example.com', status: 'invited' }
    },
    {
        organizationId: 'org-1',
        userId: 'owner-1',
        isOrgOwner: true,
        status: 'active',
        roleCount: 0,
        user: { id: 'owner-1', email: 'owner@example.com', status: 'active' }
    },
    {
        organizationId: 'org-1',
        userId: 'owner-2',
        isOrgOwner: true,
        status: 'active',
        roleCount: 0,
        user: { id: 'owner-2', email: 'second@example.com', status: 'active' }
    }
]
jest.mock('react-redux', () => ({
    useDispatch: () => mockDispatch,
    useSelector: (select) => select({ customization: { isDarkMode: false }, auth: { user: mockCurrentUser } })
}))
jest.mock('react-router-dom', () => ({ Link: 'a' }))
jest.mock('@mui/material', () => ({ ...jest.requireActual('@mui/material'), Chip: 'chip', useMediaQuery: () => mockNarrow }))
jest.mock('@/api/user', () => ({
    getAllUsersByOrganizationId: jest.fn(),
    getSignInOptions: jest.fn(),
    getWorkspacesByOrganizationIdUserId: jest.fn(),
    createPasswordResetLink: jest.fn(),
    deleteOrganizationUser: jest.fn(),
    disableUser: jest.fn(),
    enableUser: jest.fn()
}))
jest.mock(
    '@/hooks/useApi',
    () => (api) =>
        api === mockUserApi.getAllUsersByOrganizationId
            ? { data: mockRows, loading: false, request: mockRequest }
            : api === mockUserApi.getSignInOptions
            ? { data: { localUsers: mockLocalUsers }, request: mockRequest }
            : { data: null, request: mockRequest }
)
jest.mock('@/hooks/useConfirm', () => () => ({ confirm: mockConfirm }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ error: null, setError: jest.fn() }) }))
jest.mock('@/store/context/ConfigContext', () => ({ useConfig: () => ({ isOpenSource: true }) }))
jest.mock('@/ui-component/cards/MainCard', () => 'main')
jest.mock('@/layout/MainLayout/ViewHeader', () => 'header')
jest.mock('@/ErrorBoundary', () => () => null)
jest.mock('@/ui-component/dialog/ConfirmDialog', () => () => null)
jest.mock('@/views/workspace/EditWorkspaceUserRoleDialog', () => () => null)
jest.mock('@/views/users/UserSessionsDrawer', () => () => null)
jest.mock('./ResetPasswordDialog', () => 'reset-password-dialog')
jest.mock('./UserTeamAccessDrawer', () => 'team-access-drawer')
jest.mock('@/ui-component/dialog/InviteUsersDialog', () => () => null)
jest.mock('@/ui-component/dialog/CreateUserDialog', () => () => null)
jest.mock('@/ui-component/button/RBACButtons', () => ({
    PermissionButton: 'button',
    PermissionIconButton: 'button',
    StyledPermissionButton: 'button'
}))

describe('Users invitation cancellation flow', () => {
    let view
    beforeEach(() => {
        jest.clearAllMocks()
        mockNarrow = false
        mockLocalUsers = true
        mockCurrentUser.activeWorkspaceId = 'team-1'
        mockConfirm.mockResolvedValue(true)
        mockUserApi.disableUser.mockResolvedValue({ data: { disabled: true } })
        mockUserApi.enableUser.mockResolvedValue({ data: { disabled: false } })
        mockUserApi.deleteOrganizationUser.mockResolvedValue({ data: { id: 'pending' } })
    })
    afterEach(() => {
        act(() => view?.unmount())
        mockRows.splice(3)
    })
    const button = () => view.root.findByProps({ title: 'Cancel invitation' })
    const mount = () =>
        act(() => {
            view = create(<Users />)
        })

    const addMember = (status = 'active') =>
        mockRows.push({
            organizationId: 'org-1',
            userId: 'member-1',
            status,
            roleCount: 1,
            user: { id: 'member-1', email: 'member@example.com', status }
        })

    it('does not submit a confirmed access change after the current team changes', async () => {
        addMember()
        let confirm
        mockConfirm.mockReturnValue(
            new Promise((resolve) => {
                confirm = resolve
            })
        )
        mount()
        let pending
        act(() => {
            pending = view.root.findByProps({ title: 'Disable user' }).props.onClick()
        })
        act(() => {
            mockCurrentUser.activeWorkspaceId = 'team-2'
            view.update(<Users />)
        })
        await act(async () => {
            confirm(true)
            await pending
        })
        expect(mockUserApi.disableUser).not.toHaveBeenCalled()
    })

    it('ignores a late mutation result after a team switch', async () => {
        addMember()
        let complete
        mockUserApi.disableUser.mockReturnValue(
            new Promise((resolve) => {
                complete = resolve
            })
        )
        mount()
        let pending
        await act(async () => {
            pending = view.root.findByProps({ title: 'Disable user' }).props.onClick()
            await Promise.resolve()
        })
        act(() => {
            mockCurrentUser.activeWorkspaceId = 'team-2'
            view.update(<Users />)
        })
        const requests = mockRequest.mock.calls.length
        await act(async () => {
            complete({ data: { disabled: true } })
            await pending
        })
        expect(mockRequest.mock.calls.length).toBe(requests)
        expect(mockDispatch).not.toHaveBeenCalledWith(
            expect.objectContaining({ notification: expect.objectContaining({ options: expect.objectContaining({ variant: 'success' }) }) })
        )
    })

    it.each([false, true])('disables a local member with confirmation and refresh at narrow=%s', async (narrow) => {
        mockNarrow = narrow
        addMember()
        mount()
        await act(async () => view.root.findByProps({ title: 'Disable user' }).props.onClick())
        expect(mockConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Disable user',
                description: expect.stringContaining('Automations using those keys may stop')
            })
        )
        expect(mockUserApi.disableUser).toHaveBeenCalledWith('member-1')
        expect(mockUserApi.enableUser).not.toHaveBeenCalled()
        expect(mockRequest).toHaveBeenLastCalledWith('org-1')
    })

    it('reactivates a disabled user without claiming that revoked keys are restored', async () => {
        addMember('disable')
        mount()
        await act(async () => view.root.findByProps({ title: 'Reactivate user' }).props.onClick())
        expect(mockConfirm).toHaveBeenCalledWith(
            expect.objectContaining({ description: expect.stringContaining('access keys are not restored') })
        )
        expect(mockUserApi.enableUser).toHaveBeenCalledWith('member-1')
        expect(mockUserApi.disableUser).not.toHaveBeenCalled()
    })

    it('does not disable on cancellation or offer local-only actions in SSO mode', async () => {
        addMember()
        mockConfirm.mockResolvedValue(false)
        mount()
        await act(async () => view.root.findByProps({ title: 'Disable user' }).props.onClick())
        expect(mockUserApi.disableUser).not.toHaveBeenCalled()
        act(() => view.unmount())
        mockLocalUsers = false
        mount()
        expect(view.root.findAllByProps({ title: 'Disable user' })).toHaveLength(0)
    })

    it('prevents duplicate access changes while confirmation and the request are pending', async () => {
        addMember()
        let confirm, complete
        mockConfirm.mockReturnValue(
            new Promise((resolve) => {
                confirm = resolve
            })
        )
        mockUserApi.disableUser.mockReturnValue(
            new Promise((resolve) => {
                complete = resolve
            })
        )
        mount()
        const click = view.root.findByProps({ title: 'Disable user' }).props.onClick
        let pending
        act(() => {
            pending = click()
            click()
        })
        expect(mockConfirm).toHaveBeenCalledTimes(1)
        await act(async () => {
            confirm(true)
            await Promise.resolve()
        })
        await act(async () => click())
        expect(mockUserApi.disableUser).toHaveBeenCalledTimes(1)
        await act(async () => {
            complete({ data: { disabled: true } })
            await pending
        })
    })

    it.each([403, 404, 409, 502])('shows access-change refusals (%s) and refreshes the directory', async (status) => {
        addMember()
        mockUserApi.disableUser.mockRejectedValue({ response: { status, data: { message: 'Access change refused.' } } })
        mount()
        await act(async () => view.root.findByProps({ title: 'Disable user' }).props.onClick())
        expect(mockDispatch).toHaveBeenCalledWith(
            expect.objectContaining({ notification: expect.objectContaining({ message: 'Access change refused.' }) })
        )
        expect(mockRequest).toHaveBeenLastCalledWith('org-1')
    })

    it('wires a labeled team-access view to the selected person', () => {
        addMember()
        mount()
        const buttons = view.root.findAllByType('button').filter((node) => node.children.includes('View team access'))
        act(() => buttons[buttons.length - 1].props.onClick())
        const drawer = view.root.findByType('team-access-drawer')
        expect(drawer.props).toMatchObject({ userId: 'member-1', organizationId: 'org-1', userName: 'member@example.com' })
        expect(drawer.props.loadAccess).toBe(mockUserApi.getWorkspacesByOrganizationIdUserId)
    })

    it.each([false, true])('renders cancellation only on the pending owner at narrow=%s', (narrow) => {
        mockNarrow = narrow
        mount()
        expect(view.root.findAllByProps({ title: 'Cancel invitation' })).toHaveLength(1)
        expect(view.root.findAllByProps({ title: 'Delete' })).toHaveLength(0)
        expect(view.root.findAllByProps({ title: 'Change role' })).toHaveLength(0)
        expect(view.root.findAllByProps({ title: 'Reset password' })).toHaveLength(0)
        const labels = view.root.findAll((node) => node.props.label === 'Owner invitation pending')
        expect(labels.length).toBeGreaterThan(0)
    })

    it.each([false, true])('opens reset only for the selected active non-owner at narrow=%s', (narrow) => {
        mockNarrow = narrow
        for (const status of ['active', 'invited', 'disabled']) {
            mockRows.push({
                organizationId: 'org-1',
                userId: status,
                status,
                roleCount: 1,
                user: { id: status, email: `${status}@example.com`, status }
            })
        }
        mount()
        const actions = view.root.findAllByProps({ title: 'Reset password' })
        expect(actions).toHaveLength(1)
        expect(actions[0].props.permissionId).toBe('users:manage')
        act(() => actions[0].props.onClick())
        const dialog = view.root.findByType('reset-password-dialog')
        expect(dialog.props).toMatchObject({ userId: 'active', userEmail: 'active@example.com' })
        expect(dialog.props.createLink).toBe(mockUserApi.createPasswordResetLink)
        act(() => dialog.props.onClose())
        expect(view.root.findAllByType('reset-password-dialog')).toHaveLength(0)
    })

    it('does not call delete when the confirmation is canceled', async () => {
        mockConfirm.mockResolvedValue(false)
        mount()
        await act(async () => button().props.onClick())
        expect(mockConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                description: 'Cancel the pending owner invitation for pending@example.com? This revokes their invite links.'
            })
        )
        expect(mockUserApi.deleteOrganizationUser).not.toHaveBeenCalled()
    })

    it('submits the selected ids once while confirmation and deletion are pending', async () => {
        let confirm
        let complete
        mockConfirm.mockReturnValue(
            new Promise((resolve) => {
                confirm = resolve
            })
        )
        mockUserApi.deleteOrganizationUser.mockReturnValue(
            new Promise((resolve) => {
                complete = resolve
            })
        )
        mount()
        const click = button().props.onClick
        let pending
        act(() => {
            pending = click()
            click()
        })
        expect(mockConfirm).toHaveBeenCalledTimes(1)
        await act(async () => {
            confirm(true)
            await Promise.resolve()
        })
        await act(async () => click())
        expect(mockUserApi.deleteOrganizationUser).toHaveBeenCalledTimes(1)
        expect(mockUserApi.deleteOrganizationUser).toHaveBeenCalledWith('org-1', 'pending', true)
        await act(async () => {
            complete({ data: { id: 'pending' } })
            await pending
        })
        expect(mockRequest).toHaveBeenLastCalledWith('org-1')
    })

    it.each([403, 409])('surfaces the server refusal for status %s and allows retry', async (status) => {
        mockConfirm.mockResolvedValue(true)
        mockUserApi.deleteOrganizationUser.mockRejectedValue({ response: { status, data: { message: 'Refresh the user list.' } } })
        mount()
        await act(async () => button().props.onClick())
        expect(mockDispatch).toHaveBeenCalledWith(
            expect.objectContaining({ notification: expect.objectContaining({ message: 'Refresh the user list.' }) })
        )
        await act(async () => button().props.onClick())
        expect(mockUserApi.deleteOrganizationUser).toHaveBeenCalledTimes(2)
    })
})
