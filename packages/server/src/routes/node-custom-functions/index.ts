import express from 'express'
import nodesRouter from '../../controllers/nodes'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// CREATE

// READ
router.post(
    '/',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    nodesRouter.executeCustomFunction
)

// UPDATE

// DELETE

export default router
