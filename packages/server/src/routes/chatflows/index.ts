import express from 'express'
import apikeyController from '../../controllers/apikey'
import chatflowsController from '../../controllers/chatflows'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// CREATE
router.post(
    '/',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    chatflowsController.saveChatflow
)

// READ
router.get(
    '/',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatflowsController.getAllChatflows
)
// Before '/:id', which would otherwise take 'apikey' as a chatflow id.
router.get('/apikey/', chatflowsController.getChatflowByApiKey)
router.get('/apikey/:apikey', apikeyController.refuseApiKeyInUrl)
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,chatflows:delete,agentflows:view,agentflows:update,agentflows:delete'),
    chatflowsController.getChatflowById
)

// UPDATE
router.put(
    ['/', '/:id'],
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
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
