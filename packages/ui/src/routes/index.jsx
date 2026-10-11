// routes
import MainRoutes from './MainRoutes'
import CanvasRoutes from './CanvasRoutes'
import ChatbotRoutes from './ChatbotRoutes'
import AuthRoutes from '@/routes/AuthRoutes'
import ExecutionRoutes from './ExecutionRoutes'

// ==============================|| ROUTES ||============================== //

// Children of the root route in src/index.jsx, which renders the app shell around them.
const routes = [MainRoutes, AuthRoutes, CanvasRoutes, ChatbotRoutes, ExecutionRoutes]

export default routes
