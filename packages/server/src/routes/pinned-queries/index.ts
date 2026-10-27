import express from 'express'
import pinnedQueriesController from '../../controllers/pinned-queries'
import { requireAnyPermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// The flow id is in the path so an API key is checked against that canvas.
// Signed-in users pass the canvas check and are gated again on the flow type.
const gate = [
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireHarnessCanvasAccess({ idParam: 'chatflowId', body: false })
]

router.post('/:chatflowId/suggest', ...gate, pinnedQueriesController.suggest)
router.post('/:chatflowId/test', ...gate, pinnedQueriesController.test)

export default router
