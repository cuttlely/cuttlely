import express from 'express'
import flowDraftsController from '../../controllers/flow-drafts'
import { requireAnyPermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// An API key needs a HARNESS canvas's name on its own list for every route here, and every harness a saved draft names.
const canvasOnly = requireHarnessCanvasAccess({ idParam: 'chatflowId', body: false })

router.get('/:chatflowId', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowDraftsController.getDraft)
router.put(
    '/:chatflowId',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireHarnessCanvasAccess({ idParam: 'chatflowId' }),
    flowDraftsController.saveDraft
)
router.delete('/:chatflowId', requireAnyPermission('chatflows:update,agentflows:update'), canvasOnly, flowDraftsController.discardDraft)
router.post(
    '/:chatflowId/publish',
    requireAnyPermission('chatflows:update,agentflows:update'),
    canvasOnly,
    flowDraftsController.publishDraft
)
router.post(
    '/:chatflowId/rollback',
    requireAnyPermission('chatflows:update,agentflows:update'),
    canvasOnly,
    flowDraftsController.rollbackLive
)
router.get('/:chatflowId/check', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowDraftsController.getCheckSetup)
// Registered before /check/:checkId so "history" is not read as a check id.
router.get(
    '/:chatflowId/check/history',
    requireAnyPermission('chatflows:view,agentflows:view'),
    canvasOnly,
    flowDraftsController.getCheckHistory
)
router.post('/:chatflowId/check', requireAnyPermission('chatflows:update,agentflows:update'), canvasOnly, flowDraftsController.startCheck)
router.get('/:chatflowId/check/:checkId', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowDraftsController.getCheck)
router.delete(
    '/:chatflowId/check/:checkId',
    requireAnyPermission('chatflows:update,agentflows:update'),
    canvasOnly,
    flowDraftsController.stopCheck
)
router.put(
    '/:chatflowId/settings',
    requireAnyPermission('chatflows:update,agentflows:update'),
    canvasOnly,
    flowDraftsController.updateSettings
)

export default router
