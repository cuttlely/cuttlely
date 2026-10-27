let mockAuth
jest.mock('react-redux', () => ({ useSelector: (selector) => selector({ auth: mockAuth }) }))
jest.mock('@/store/context/ConfigContext', () => ({ useConfig: () => ({ isOpenSource: false }) }))

import { useAuth } from '@/hooks/useAuth'
import { HARNESS_CATEGORY_PERMISSION, flowCategoryPermission } from './flowCategoryPermission'

// useAuth only reads the store here, so it can run outside a component.
const allowed = (permissions, permissionId) => {
    mockAuth = { permissions, isGlobal: false, features: {}, user: {} }
    const { hasPermission } = useAuth() // eslint-disable-line react-hooks/rules-of-hooks
    return hasPermission(permissionId)
}

it('lets either update permission tag an agent team, as the harness category route does', () => {
    expect(allowed(['agentflows:update'], HARNESS_CATEGORY_PERMISSION)).toBe(true)
    expect(allowed(['chatflows:update'], HARNESS_CATEGORY_PERMISSION)).toBe(true)
    expect(allowed(['chatflows:view', 'agentflows:view'], HARNESS_CATEGORY_PERMISSION)).toBe(false)
})

it('keeps the Chatflows and Agentflows menus on their own permission', () => {
    expect(allowed(['agentflows:update'], flowCategoryPermission(false))).toBe(false)
    expect(allowed(['agentflows:update'], flowCategoryPermission(true))).toBe(true)
    expect(allowed(['chatflows:update'], flowCategoryPermission(true))).toBe(false)
})
