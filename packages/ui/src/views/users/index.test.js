import { act, create } from 'react-test-renderer'
import Users from './index'
import mockUserApi from '@/api/user'

const mockConfirm = jest.fn()
const mockRequest = jest.fn()
const mockDispatch = jest.fn()
let mockNarrow = false
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
    useSelector: (select) =>
        select({ customization: { isDarkMode: false }, auth: { user: { id: 'owner-1', activeOrganizationId: 'org-1' } } })
}))
jest.mock('react-router-dom', () => ({ Link: 'a' }))
jest.mock('@mui/material', () => ({ ...jest.requireActual('@mui/material'), Chip: 'chip', useMediaQuery: () => mockNarrow }))
jest.mock('@/api/user', () => ({
    getAllUsersByOrganizationId: jest.fn(),
    getWorkspacesByOrganizationIdUserId: jest.fn(),
    deleteOrganizationUser: jest.fn()
}))
jest.mock(
    '@/hooks/useApi',
    () => (api) =>
        api === mockUserApi.getAllUsersByOrganizationId
            ? { data: mockRows, loading: false, request: mockRequest }
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
        mockUserApi.deleteOrganizationUser.mockResolvedValue({ data: { id: 'pending' } })
    })
    afterEach(() => act(() => view?.unmount()))
    const button = () => view.root.findByProps({ title: 'Cancel invitation' })
    const mount = () =>
        act(() => {
            view = create(<Users />)
        })

    it.each([false, true])('renders cancellation only on the pending owner at narrow=%s', (narrow) => {
        mockNarrow = narrow
        mount()
        expect(view.root.findAllByProps({ title: 'Cancel invitation' })).toHaveLength(1)
        expect(view.root.findAllByProps({ title: 'Delete' })).toHaveLength(0)
        expect(view.root.findAllByProps({ title: 'Change role' })).toHaveLength(0)
        const labels = view.root.findAll((node) => node.props.label === 'Owner invitation pending')
        expect(labels.length).toBeGreaterThan(0)
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
