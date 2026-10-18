import express from 'express'
import flowConfigsController from '../../controllers/flow-configs'
import { requireAnyPermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'
const router = express.Router()

// CREATE

// READ
// Same checks as reading the chatflow: it returns that flow's node settings.
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    requireHarnessCanvasAccess({ body: false }),
    flowConfigsController.getSingleFlowConfig
)

// UPDATE

// DELETE

export default router
