import express from 'express'
import flowDraftsController from '../../controllers/flow-drafts'
import { requireAnyPermission } from '../../identity/rbac'
import { refuseUnlistedHarnessCards } from '../../services/harnesses/apiAccess'

const router = express.Router()

router.get('/:chatflowId', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getDraft)
router.put(
    '/:chatflowId',
    requireAnyPermission('chatflows:update,agentflows:update'),
    refuseUnlistedHarnessCards(),
    flowDraftsController.saveDraft
)
router.delete('/:chatflowId', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.discardDraft)
router.post('/:chatflowId/publish', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.publishDraft)
router.post('/:chatflowId/rollback', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.rollbackLive)
router.get('/:chatflowId/check', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getCheckSetup)
// Registered before /check/:checkId so "history" is not read as a check id.
router.get('/:chatflowId/check/history', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getCheckHistory)
router.post('/:chatflowId/check', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.startCheck)
router.get('/:chatflowId/check/:checkId', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getCheck)
router.delete('/:chatflowId/check/:checkId', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.stopCheck)
router.put('/:chatflowId/settings', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.updateSettings)

export default router
