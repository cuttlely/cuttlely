/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { act, create } from 'react-test-renderer'
import TeamMembers from '../workspace/WorkspaceUsers'
import mockUserApi from '@/api/user'

const mockRequest = jest.fn()
const mockWorkspace = { id: 'team-1', name: 'Example team' }
const mockMembers = [
    {
        userId: 'pending-owner',
        workspaceId: 'team-1',
        isOrgOwner: true,
        status: 'invited',
        user: { id: 'pending-owner', email: 'pending-owner@example.com' },
        role: { name: 'owner' }
    },
    {
        userId: 'pending',
        workspaceId: 'team-1',
        status: 'invited',
        user: { id: 'pending', email: 'pending@example.com' },
        role: { name: 'viewer' }
    },
    {
        userId: 'disabled',
        workspaceId: 'team-1',
        status: 'disable',
        user: { id: 'disabled', email: 'disabled@example.com' },
        role: { name: 'viewer' }
    }
]
jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn(),
    useSelector: (fn) => fn({ customization: {}, auth: { user: { id: 'owner', activeOrganizationId: 'org-1' } } })
}))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('@/api/user', () => ({ getAllUsersByWorkspaceId: jest.fn() }))
jest.mock('@/api/workspace', () => ({ getWorkspaceById: jest.fn() }))
jest.mock('@/hooks/useApi', () => (api) => ({
    data: api === mockUserApi.getAllUsersByWorkspaceId ? mockMembers : mockWorkspace,
    request: mockRequest,
    loading: false
}))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/hooks/useConfirm', () => () => ({ confirm: jest.fn() }))
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ error: null, setError: jest.fn() }) }))
jest.mock('@/store/context/ConfigContext', () => ({ useConfig: () => ({ isOpenSource: true }) }))
jest.mock('@/ui-component/cards/MainCard', () => 'main')
jest.mock('@/layout/MainLayout/ViewHeader', () => 'header')
jest.mock('@/ErrorBoundary', () => () => null)
jest.mock('@/ui-component/dialog/ConfirmDialog', () => () => null)
jest.mock('@/ui-component/dialog/InviteUsersDialog', () => 'invite-dialog')
jest.mock('@/ui-component/dialog/CreateUserDialog', () => 'create-user-dialog')
jest.mock('@/views/workspace/EditWorkspaceUserRoleDialog', () => 'role-dialog')
jest.mock('@/ui-component/button/RBACButtons', () => ({
    PermissionButton: 'button',
    StyledPermissionButton: 'button',
    PermissionIconButton: 'button'
}))
jest.mock('@mui/material', () => ({ ...jest.requireActual('@mui/material'), Chip: 'chip', Checkbox: 'checkbox' }))

it('shows effective pending/disabled state and edits a pending role without trying to add the member again', () => {
    window.history.replaceState({}, '', '/workspace-users/team-1')
    let view
    act(() => {
        view = create(<TeamMembers />)
    })
    try {
        expect(view.root.findAllByProps({ label: 'INVITED' })).toHaveLength(2)
        expect(view.root.findByProps({ label: 'Owner invitation pending' })).toBeTruthy()
        expect(view.root.findAllByProps({ label: 'DISABLED' }).length).toBeGreaterThan(0)
        const edit = view.root.findByProps({ title: 'Change invitation role' })
        act(() => edit.props.onClick())
        expect(view.root.findByType('role-dialog').props.dialogProps.data).toMatchObject({
            workspaceId: 'team-1',
            userId: 'pending',
            user: { id: 'pending' }
        })
        expect(view.root.findAllByType('invite-dialog')).toHaveLength(0)
    } finally {
        act(() => view.unmount())
    }
})
