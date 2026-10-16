const mockAuth = { permissions: [], isGlobal: false }

jest.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({
        hasPermission: (permission) => permission.split(',').some((key) => mockAuth.permissions.includes(key)),
        hasDisplay: () => true
    })
}))

jest.mock('react-redux', () => ({
    useSelector: (select) => select({ auth: { isGlobal: mockAuth.isGlobal, isAuthenticated: true } })
}))

// A declaration, not a const: jest.mock calls are hoisted above it.
function mockPage(name) {
    return { __esModule: true, default: () => name }
}
jest.mock('@/views/agentexecutions', () => mockPage('Executions'))
jest.mock('@/views/agentflows', () => mockPage('Agentflows'))
jest.mock('@/views/apikey', () => mockPage('APIKey'))
jest.mock('@/views/assistants', () => mockPage('Assistants'))
jest.mock('@/views/auth/login', () => mockPage('Login'))
jest.mock('@/views/auth/unauthorized', () => mockPage('Unauthorized'))
jest.mock('@/views/chatflows', () => mockPage('Chatflows'))
jest.mock('@/views/credentials', () => mockPage('Credentials'))
jest.mock('@/views/docstore', () => mockPage('Documents'))
jest.mock('@/views/datasets', () => mockPage('Datasets'))
jest.mock('@/views/evaluators', () => mockPage('Evaluators'))
jest.mock('@/views/evaluations', () => mockPage('Evaluations'))
jest.mock('@/views/marketplaces', () => mockPage('Marketplaces'))
jest.mock('@/views/roles', () => mockPage('Roles'))
jest.mock('@/views/tools', () => mockPage('Tools'))
jest.mock('@/views/users', () => mockPage('Users'))
jest.mock('@/views/variables', () => mockPage('Variables'))
jest.mock('@/views/workspace', () => mockPage('Teams'))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultRedirect } from './DefaultRedirect'

const landing = (permissions, isGlobal = false) => {
    mockAuth.permissions = permissions
    mockAuth.isGlobal = isGlobal
    return renderToStaticMarkup(createElement(DefaultRedirect))
}

describe('DefaultRedirect', () => {
    it('checks Users, then Teams, before Roles, like the Admin menu', () => {
        expect(landing(['roles:manage', 'users:manage', 'workspace:view'])).toBe('Users')
        expect(landing(['roles:manage', 'workspace:view'])).toBe('Teams')
        expect(landing(['roles:manage'])).toBe('Roles')
    })

    it('still prefers the pages before Admin', () => {
        expect(landing(['evaluations:view', 'users:manage'])).toBe('Evaluations')
        expect(landing(['chatflows:view', 'users:manage'])).toBe('Chatflows')
    })

    it('sends the organization owner to Chatflows and a role with no page to Unauthorized', () => {
        expect(landing([], true)).toBe('Chatflows')
        expect(landing([])).toBe('Unauthorized')
    })
})
