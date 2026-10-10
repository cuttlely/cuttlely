import express from 'express'
import flowDraftsController from '../../controllers/flow-drafts'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

router.get('/:chatflowId', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getDraft)
router.put('/:chatflowId', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.saveDraft)
router.delete('/:chatflowId', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.discardDraft)
router.post('/:chatflowId/publish', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.publishDraft)
router.post('/:chatflowId/rollback', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.rollbackLive)
router.get('/:chatflowId/check', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getCheckSetup)
router.post('/:chatflowId/check', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.startCheck)
router.get('/:chatflowId/check/:checkId', requireAnyPermission('chatflows:view,agentflows:view'), flowDraftsController.getCheck)
router.delete('/:chatflowId/check/:checkId', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.stopCheck)
router.put('/:chatflowId/settings', requireAnyPermission('chatflows:update,agentflows:update'), flowDraftsController.updateSettings)

export default router
