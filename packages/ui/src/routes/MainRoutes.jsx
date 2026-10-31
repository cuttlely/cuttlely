import { lazy } from 'react'

// project imports
import MainLayout from '@/layout/MainLayout'
import Loadable from '@/ui-component/loading/Loadable'

import { DefaultRedirect } from '@/routes/DefaultRedirect'
import { RequireAuth } from '@/routes/RequireAuth'

// chatflows routing
const Chatflows = Loadable(lazy(() => import('@/views/chatflows')))
const Promote = Loadable(lazy(() => import('@/views/promote')))
const ServerSettings = Loadable(lazy(() => import('@/views/serversettings')))
const AuthenticationSettings = Loadable(lazy(() => import('@/views/authentication')))
const PromoteFlow = Loadable(lazy(() => import('@/views/promote/PromoteFlow')))

// agents routing
const Agentflows = Loadable(lazy(() => import('@/views/agentflows')))
const Harnesses = Loadable(lazy(() => import('@/views/harnesses')))
const HarnessHome = Loadable(lazy(() => import('@/views/harnesses/HarnessHome')))
const Etl = Loadable(lazy(() => import('@/views/etl')))

// marketplaces routing
const Marketplaces = Loadable(lazy(() => import('@/views/marketplaces')))

// apikey routing
const APIKey = Loadable(lazy(() => import('@/views/apikey')))

// tools routing
const Tools = Loadable(lazy(() => import('@/views/tools')))

// assistants routing
const Assistants = Loadable(lazy(() => import('@/views/assistants')))
const OpenAIAssistantLayout = Loadable(lazy(() => import('@/views/assistants/openai/OpenAIAssistantLayout')))
const CustomAssistantLayout = Loadable(lazy(() => import('@/views/assistants/custom/CustomAssistantLayout')))
const CustomAssistantConfigurePreview = Loadable(lazy(() => import('@/views/assistants/custom/CustomAssistantConfigurePreview')))

// credentials routing
const Credentials = Loadable(lazy(() => import('@/views/credentials')))

// variables routing
const Variables = Loadable(lazy(() => import('@/views/variables')))

// documents routing
const Documents = Loadable(lazy(() => import('@/views/docstore')))
const Datasets = Loadable(lazy(() => import('@/views/datasets')))
const DatasetItems = Loadable(lazy(() => import('@/views/datasets/DatasetItems')))
const Evaluators = Loadable(lazy(() => import('@/views/evaluators')))
const Evaluations = Loadable(lazy(() => import('@/views/evaluations')))
const Usage = Loadable(lazy(() => import('@/views/usage')))
const EvaluationResult = Loadable(lazy(() => import('@/views/evaluations/EvaluationResult')))
const DocumentStoreDetail = Loadable(lazy(() => import('@/views/docstore/DocumentStoreDetail')))
const ShowStoredChunks = Loadable(lazy(() => import('@/views/docstore/ShowStoredChunks')))
const LoaderConfigPreviewChunks = Loadable(lazy(() => import('@/views/docstore/LoaderConfigPreviewChunks')))
const VectorStoreConfigure = Loadable(lazy(() => import('@/views/docstore/VectorStoreConfigure')))
const VectorStoreQuery = Loadable(lazy(() => import('@/views/docstore/VectorStoreQuery')))

// executions routing
const Executions = Loadable(lazy(() => import('@/views/agentexecutions')))

// enterprise features
const UsersPage = Loadable(lazy(() => import('@/views/users')))
const RolesPage = Loadable(lazy(() => import('@/views/roles')))
const Workspaces = Loadable(lazy(() => import('@/views/workspace')))
const WorkspaceDetails = Loadable(lazy(() => import('@/views/workspace/WorkspaceUsers')))
const VersionSettings = Loadable(lazy(() => import('@/views/versionsettings')))
const ServerLogs = Loadable(lazy(() => import('@/views/serverlogs')))
const AuditLog = Loadable(lazy(() => import('@/views/audit')))
const NotFound = Loadable(lazy(() => import('@/views/notfound')))

// ==============================|| MAIN ROUTING ||============================== //

const MainRoutes = {
    path: '/',
    element: <MainLayout />,
    children: [
        {
            path: '/',
            element: <DefaultRedirect />
        },
        {
            path: '/chatflows',
            element: (
                <RequireAuth permission={'chatflows:view'}>
                    <Chatflows />
                </RequireAuth>
            )
        },
        {
            path: '/harnesses',
            element: (
                <RequireAuth permission={'chatflows:view'}>
                    <Harnesses />
                </RequireAuth>
            )
        },
        {
            path: '/harnesses/:name',
            element: (
                <RequireAuth permission={'chatflows:view'}>
                    <HarnessHome />
                </RequireAuth>
            )
        },
        {
            path: '/etl',
            element: (
                <RequireAuth permission={'chatflows:view'}>
                    <Etl />
                </RequireAuth>
            )
        },
        {
            path: '/agentflows',
            element: (
                <RequireAuth permission={'agentflows:view'}>
                    <Agentflows />
                </RequireAuth>
            )
        },
        {
            path: '/executions',
            element: (
                <RequireAuth permission={'executions:view'}>
                    <Executions />
                </RequireAuth>
            )
        },
        {
            path: '/marketplaces',
            element: (
                <RequireAuth permission={'templates:marketplace,templates:custom'}>
                    <Marketplaces />
                </RequireAuth>
            )
        },
        {
            path: '/apikey',
            element: (
                <RequireAuth permission={'apikeys:view'}>
                    <APIKey />
                </RequireAuth>
            )
        },
        {
            path: '/tools',
            element: (
                <RequireAuth permission={'tools:view'}>
                    <Tools />
                </RequireAuth>
            )
        },
        {
            path: '/assistants',
            element: (
                <RequireAuth permission={'assistants:view'}>
                    <Assistants />
                </RequireAuth>
            )
        },
        {
            path: '/assistants/custom',
            element: (
                <RequireAuth permission={'assistants:view'}>
                    <CustomAssistantLayout />
                </RequireAuth>
            )
        },
        {
            path: '/assistants/custom/:id',
            element: (
                <RequireAuth permission={'assistants:view'}>
                    <CustomAssistantConfigurePreview />
                </RequireAuth>
            )
        },
        {
            path: '/assistants/openai',
            element: (
                <RequireAuth permission={'assistants:view'}>
                    <OpenAIAssistantLayout />
                </RequireAuth>
            )
        },
        {
            path: '/credentials',
            element: (
                <RequireAuth permission={'credentials:view'}>
                    <Credentials />
                </RequireAuth>
            )
        },
        {
            path: '/variables',
            element: (
                <RequireAuth permission={'variables:view'}>
                    <Variables />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <Documents />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/:storeId',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <DocumentStoreDetail />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/chunks/:storeId/:fileId',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <ShowStoredChunks />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/:storeId/:name',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <LoaderConfigPreviewChunks />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/vector/:storeId',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <VectorStoreConfigure />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/vector/:storeId/:docId',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <VectorStoreConfigure />
                </RequireAuth>
            )
        },
        {
            path: '/document-stores/query/:storeId',
            element: (
                <RequireAuth permission={'documentStores:view'}>
                    <VectorStoreQuery />
                </RequireAuth>
            )
        },
        {
            path: '/datasets',
            element: (
                <RequireAuth permission={'datasets:view'}>
                    <Datasets />
                </RequireAuth>
            )
        },
        {
            path: '/dataset_rows/:id',
            element: (
                <RequireAuth permission={'datasets:view'}>
                    <DatasetItems />
                </RequireAuth>
            )
        },
        {
            path: '/evaluators',
            element: (
                <RequireAuth permission={'evaluators:view'}>
                    <Evaluators />
                </RequireAuth>
            )
        },
        {
            path: '/evaluations',
            element: (
                <RequireAuth permission={'evaluations:view'}>
                    <Evaluations />
                </RequireAuth>
            )
        },
        {
            path: '/evaluation_results/:id',
            element: (
                <RequireAuth permission={'evaluations:view'}>
                    <EvaluationResult />
                </RequireAuth>
            )
        },
        {
            path: '/usage',
            element: (
                <RequireAuth permission={'chatflows:view,agentflows:view'}>
                    <Usage />
                </RequireAuth>
            )
        },
        {
            path: '/users',
            element: (
                <RequireAuth permission={'users:manage'} display={'feat:users'}>
                    <UsersPage />
                </RequireAuth>
            )
        },
        {
            path: '/roles',
            element: (
                <RequireAuth permission={'roles:manage'} display={'feat:roles'}>
                    <RolesPage />
                </RequireAuth>
            )
        },
        {
            path: '/workspaces',
            element: (
                <RequireAuth permission={'workspace:view'} display={'feat:workspaces'}>
                    <Workspaces />
                </RequireAuth>
            )
        },
        {
            path: '/workspace-users/:id',
            element: (
                <RequireAuth permission={'workspace:view'} display={'feat:workspaces'}>
                    <WorkspaceDetails />
                </RequireAuth>
            )
        },
        {
            path: '/authentication-settings',
            element: (
                <RequireAuth permission={'authentication:manage'}>
                    <AuthenticationSettings />
                </RequireAuth>
            )
        },
        {
            // Server-wide, so only the organization owner (no role holds this permission).
            path: '/server-settings',
            element: (
                <RequireAuth permission={'server:owner'}>
                    <ServerSettings />
                </RequireAuth>
            )
        },
        {
            path: '/logs',
            element: (
                <RequireAuth permission={'logs:view'}>
                    <ServerLogs />
                </RequireAuth>
            )
        },
        {
            path: '/audit',
            element: (
                <RequireAuth permission={'audit:view'}>
                    <AuditLog />
                </RequireAuth>
            )
        },
        {
            // Server-wide, so only the organization owner (no role holds this permission).
            path: '/version-history',
            element: (
                <RequireAuth permission={'server:owner'}>
                    <VersionSettings />
                </RequireAuth>
            )
        },
        {
            // New versions from Dev on a Prod server: server-wide, so only the organization owner.
            path: '/promote',
            element: (
                <RequireAuth permission={'server:owner'}>
                    <Promote />
                </RequireAuth>
            )
        },
        {
            path: '/promote/:id',
            element: (
                <RequireAuth permission={'server:owner'}>
                    <PromoteFlow />
                </RequireAuth>
            )
        },
        {
            path: '*',
            element: <NotFound />
        }
    ]
}

export default MainRoutes
