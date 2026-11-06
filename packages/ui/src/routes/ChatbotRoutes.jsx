import { lazy } from 'react'

// project imports
import Loadable from '@/ui-component/loading/Loadable'
import MinimalLayout from '@/layout/MinimalLayout'

// canvas routing
const PublicDashboard = Loadable(lazy(() => import('@/views/dashflows')))
const ChatbotFull = Loadable(lazy(() => import('@/views/chatbot')))

// ==============================|| CANVAS ROUTING ||============================== //

const ChatbotRoutes = {
    path: '/',
    element: <MinimalLayout />,
    children: [
        { path: '/public/dashboards/:token', element: <PublicDashboard publicLink /> },
        {
            path: '/chatbot/:id',
            element: <ChatbotFull />
        }
    ]
}

export default ChatbotRoutes
