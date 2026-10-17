import express from 'express'
import chatflowsController from '../../controllers/chatflows'
import { requireAnyPermission } from '../../identity/rbac'
import { refuseUnlistedHarnessCards } from '../../services/harnesses/apiAccess'
const router = express.Router()

// CREATE
router.post(
    '/',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    refuseUnlistedHarnessCards(),
    chatflowsController.saveChatflow
)

// READ
router.get(
    '/',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatflowsController.getAllChatflows
)
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,chatflows:delete,agentflows:view,agentflows:update,agentflows:delete'),
    chatflowsController.getChatflowById
)
router.get(['/apikey/', '/apikey/:apikey'], chatflowsController.getChatflowByApiKey)

// UPDATE
router.put(
    ['/', '/:id'],
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    refuseUnlistedHarnessCards(),
    chatflowsController.updateChatflow
)

// DELETE
router.delete(
    ['/', '/:id'],
    requireAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'),
    chatflowsController.deleteChatflow
)

// WEBHOOK SECRET
router.post('/:id/webhook-secret', requireAnyPermission('chatflows:update,agentflows:update'), chatflowsController.setWebhookSecret)
router.delete('/:id/webhook-secret', requireAnyPermission('chatflows:update,agentflows:update'), chatflowsController.clearWebhookSecret)

// CHECK FOR CHANGE
router.get(
    '/has-changed/:id/:lastUpdatedDateTime',
    requireAnyPermission('chatflows:update,agentflows:update'),
    chatflowsController.checkIfChatflowHasChanged
)

// SCHEDULE
router.get(
    '/:id/schedule/status',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatflowsController.getScheduleStatus
)
router.patch('/:id/schedule/enabled', requireAnyPermission('chatflows:update,agentflows:update'), chatflowsController.toggleScheduleEnabled)
router.get(
    '/:id/schedule/trigger-logs',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatflowsController.getScheduleTriggerLogs
)
router.delete(
    '/:id/schedule/trigger-logs',
    requireAnyPermission('chatflows:update,agentflows:update,executions:delete'),
    chatflowsController.deleteScheduleTriggerLogs
)

export default router
