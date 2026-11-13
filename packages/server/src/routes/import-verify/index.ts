import express from 'express'
import importVerifyController from '../../controllers/import-verify'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

const gate = [
    requireAnyPermission('chatflows:update,agentflows:update'),
    requirePermission('credentials:view'),
    requireHarnessCanvasAccess({ idParam: 'chatflowId', body: false, draft: true })
]

router.get('/:chatflowId', ...gate, importVerifyController.status)
router.post('/:chatflowId', ...gate, importVerifyController.start)
router.post('/:chatflowId/cancel', ...gate, importVerifyController.cancel)

export default router
