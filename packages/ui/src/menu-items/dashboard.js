import { HARNESS_LABEL } from '@/ui-component/flow/buildChoices'

// assets
import {
    IconUsersGroup,
    IconHierarchy,
    IconBuildingStore,
    IconKey,
    IconTool,
    IconLock,
    IconRobot,
    IconVariable,
    IconFiles,
    IconStack2,
    IconUsers,
    IconLockCheck,
    IconListCheck,
    IconDatabaseImport,
    IconDatabase,
    IconClipboardCheck,
    IconChartHistogram,
    IconChartBar,
    IconShield,
    IconHistory,
    IconServerCog,
    IconFileText,
    IconListDetails
} from '@tabler/icons-react'

// constant
const icons = {
    IconHierarchy,
    IconUsersGroup,
    IconBuildingStore,
    IconKey,
    IconTool,
    IconLock,
    IconRobot,
    IconVariable,
    IconFiles,
    IconStack2,
    IconUsers,
    IconLockCheck,
    IconListCheck,
    IconDatabaseImport,
    IconDatabase,
    IconClipboardCheck,
    IconChartHistogram,
    IconChartBar,
    IconShield,
    IconHistory,
    IconServerCog,
    IconFileText,
    IconListDetails
}

// ==============================|| DASHBOARD MENU ITEMS ||============================== //

const dashboard = {
    id: 'dashboard',
    title: '',
    type: 'group',
    children: [
        {
            id: 'primary',
            title: '',
            type: 'group',
            children: [
                {
                    id: 'harnesses',
                    title: HARNESS_LABEL,
                    type: 'item',
                    url: '/harnesses',
                    icon: icons.IconUsersGroup,
                    breadcrumbs: true,
                    permission: 'chatflows:view'
                },
                {
                    id: 'chatflows',
                    title: 'Chatflows',
                    type: 'item',
                    url: '/chatflows',
                    icon: icons.IconHierarchy,
                    breadcrumbs: true,
                    permission: 'chatflows:view'
                },
                {
                    id: 'etl',
                    title: 'ETL',
                    type: 'item',
                    url: '/etl',
                    icon: icons.IconDatabaseImport,
                    breadcrumbs: true,
                    permission: 'chatflows:view'
                },
                {
                    id: 'agentflows',
                    title: 'Agentflows',
                    type: 'item',
                    url: '/agentflows',
                    icon: icons.IconUsersGroup,
                    breadcrumbs: true,
                    permission: 'agentflows:view'
                },
                {
                    id: 'executions',
                    title: 'Executions',
                    type: 'item',
                    url: '/executions',
                    icon: icons.IconListCheck,
                    breadcrumbs: true,
                    permission: 'executions:view'
                },
                {
                    id: 'assistants',
                    title: 'Assistants',
                    type: 'item',
                    url: '/assistants',
                    icon: icons.IconRobot,
                    breadcrumbs: true,
                    permission: 'assistants:view'
                },
                {
                    id: 'marketplaces',
                    title: 'Templates',
                    type: 'item',
                    url: '/marketplaces',
                    icon: icons.IconBuildingStore,
                    breadcrumbs: true,
                    permission: 'templates:marketplace,templates:custom'
                },
                {
                    id: 'tools',
                    title: 'Tools',
                    type: 'item',
                    url: '/tools',
                    icon: icons.IconTool,
                    breadcrumbs: true,
                    permission: 'tools:view'
                },
                {
                    id: 'credentials',
                    title: 'Credentials',
                    type: 'item',
                    url: '/credentials',
                    icon: icons.IconLock,
                    breadcrumbs: true,
                    permission: 'credentials:view'
                },
                {
                    id: 'variables',
                    title: 'Variables',
                    type: 'item',
                    url: '/variables',
                    icon: icons.IconVariable,
                    breadcrumbs: true,
                    permission: 'variables:view'
                },
                {
                    id: 'apikey',
                    title: 'API Keys',
                    type: 'item',
                    url: '/apikey',
                    icon: icons.IconKey,
                    breadcrumbs: true,
                    permission: 'apikeys:view'
                },
                {
                    id: 'document-stores',
                    title: 'Document Stores',
                    type: 'item',
                    url: '/document-stores',
                    icon: icons.IconFiles,
                    breadcrumbs: true,
                    permission: 'documentStores:view'
                },
                {
                    id: 'datasets',
                    title: 'Datasets',
                    type: 'item',
                    url: '/datasets',
                    activeRoutes: ['/dataset_rows'],
                    icon: icons.IconDatabase,
                    breadcrumbs: true,
                    permission: 'datasets:view'
                },
                {
                    id: 'evaluators',
                    title: 'Evaluators',
                    type: 'item',
                    url: '/evaluators',
                    icon: icons.IconClipboardCheck,
                    breadcrumbs: true,
                    permission: 'evaluators:view'
                },
                {
                    id: 'evaluations',
                    title: 'Evaluations',
                    type: 'item',
                    url: '/evaluations',
                    activeRoutes: ['/evaluation_results'],
                    icon: icons.IconChartHistogram,
                    breadcrumbs: true,
                    permission: 'evaluations:view'
                },
                {
                    id: 'usage',
                    title: 'Usage',
                    type: 'item',
                    url: '/usage',
                    icon: icons.IconChartBar,
                    breadcrumbs: true,
                    permission: 'chatflows:view,agentflows:view'
                }
            ]
        },
        {
            id: 'management',
            title: 'Admin',
            type: 'collapse',
            icon: icons.IconShield,
            children: [
                {
                    id: 'roles',
                    title: 'Roles',
                    type: 'item',
                    url: '/roles',
                    icon: icons.IconLockCheck,
                    breadcrumbs: true,
                    display: 'feat:roles',
                    permission: 'roles:manage'
                },
                {
                    id: 'users',
                    title: 'Users',
                    type: 'item',
                    url: '/users',
                    icon: icons.IconUsers,
                    breadcrumbs: true,
                    display: 'feat:users',
                    permission: 'users:manage'
                },
                {
                    // Server-wide: only the organization owner sees it (no role holds this permission).
                    id: 'serverSettings',
                    title: 'Server Settings',
                    type: 'item',
                    url: '/server-settings',
                    icon: icons.IconServerCog,
                    breadcrumbs: true,
                    permission: 'server:owner'
                },
                {
                    id: 'serverLogs',
                    title: 'Logs',
                    type: 'item',
                    url: '/logs',
                    icon: icons.IconFileText,
                    breadcrumbs: true,
                    permission: 'logs:view'
                },
                {
                    id: 'auditLog',
                    title: 'Audit log',
                    type: 'item',
                    url: '/audit',
                    icon: icons.IconListDetails,
                    breadcrumbs: true,
                    permission: 'audit:view'
                },
                {
                    // Server-wide: only the organization owner sees it (no role holds this permission).
                    id: 'versionHistory',
                    title: 'Version History',
                    type: 'item',
                    url: '/version-history',
                    icon: icons.IconHistory,
                    breadcrumbs: true,
                    permission: 'server:owner'
                },
                {
                    id: 'workspaces',
                    title: 'Teams',
                    type: 'item',
                    url: '/workspaces',
                    // A team's members page belongs to Teams too.
                    activeRoutes: ['/workspace-users'],
                    icon: icons.IconStack2,
                    breadcrumbs: true,
                    display: 'feat:workspaces',
                    permission: 'workspace:view'
                }
            ]
        }
    ]
}

export default dashboard
