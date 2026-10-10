import { useAuth } from '@/hooks/useAuth'
import { useSelector } from 'react-redux'

// Import all view components
import Executions from '@/views/agentexecutions'
import Agentflows from '@/views/agentflows'
import APIKey from '@/views/apikey'
import Assistants from '@/views/assistants'
import Login from '@/views/auth/login'
import Unauthorized from '@/views/auth/unauthorized'
import Chatflows from '@/views/chatflows'
import Credentials from '@/views/credentials'
import Documents from '@/views/docstore'
import Marketplaces from '@/views/marketplaces'
import RolesPage from '@/views/roles'
import Tools from '@/views/tools'
import UsersPage from '@/views/users'
import Variables from '@/views/variables'
import Workspaces from '@/views/workspace'

/**
 * Component that redirects users to the first accessible page based on their permissions
 * This prevents 403 errors when users don't have access to the default chatflows page
 */
export const DefaultRedirect = () => {
    const { hasPermission, hasDisplay } = useAuth()
    const isGlobal = useSelector((state) => state.auth.isGlobal)
    const isAuthenticated = useSelector((state) => state.auth.isAuthenticated)

    // Define the order of routes to check (based on the menu order in dashboard.js)
    const routesToCheck = [
        { component: Chatflows, permission: 'chatflows:view' },
        { component: Agentflows, permission: 'agentflows:view' },
        { component: Executions, permission: 'executions:view' },
        { component: Assistants, permission: 'assistants:view' },
        { component: Marketplaces, permission: 'templates:marketplace,templates:custom' },
        { component: Tools, permission: 'tools:view' },
        { component: Credentials, permission: 'credentials:view' },
        { component: Variables, permission: 'variables:view' },
        { component: APIKey, permission: 'apikeys:view' },
        { component: Documents, permission: 'documentStores:view' },
        { component: RolesPage, permission: 'roles:manage', display: 'feat:roles' },
        { component: UsersPage, permission: 'users:manage', display: 'feat:users' },
        { component: Workspaces, permission: 'workspace:view', display: 'feat:workspaces' }
    ]

    // If user is not authenticated, show login page
    if (!isAuthenticated) {
        return <Login />
    }

    // The organization owner lands on chatflows. Other users, including open source, use the permission list below.
    if (isGlobal) {
        return <Chatflows />
    }

    // Check each route in order and return the first accessible component
    for (const route of routesToCheck) {
        const { component: Component, permission, display } = route

        // Check permission if specified
        const hasRequiredPermission = !permission || hasPermission(permission)

        // Check display flag if specified
        const hasRequiredDisplay = !display || hasDisplay(display)

        // If user has both required permission and display access, return this component
        if (hasRequiredPermission && hasRequiredDisplay) {
            return <Component />
        }
    }

    // If no accessible routes found, show unauthorized page
    // This should rarely happen as most users should have at least one permission
    return <Unauthorized />
}
