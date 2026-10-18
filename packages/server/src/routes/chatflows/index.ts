import express from 'express'
import chatflowsController from '../../controllers/chatflows'
import { requireAnyPermission } from '../../identity/rbac'
import { requireFlowRunnableByKey, requireHarnessCanvasAccess, scopeChatflowListToKey } from '../../services/harnesses/apiAccess'
const router = express.Router()

// An API key also needs a HARNESS canvas's name, and every harness a sent canvas names, on its own list.
// CREATE
router.post(
    '/',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    requireHarnessCanvasAccess(),
    chatflowsController.saveChatflow
)

// READ
router.get(
    '/',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    scopeChatflowListToKey(),
    chatflowsController.getAllChatflows
)
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,chatflows:delete,agentflows:view,agentflows:update,agentflows:delete'),
    requireHarnessCanvasAccess({ body: false }),
    chatflowsController.getChatflowById
)
router.get(['/apikey/', '/apikey/:apikey'], chatflowsController.getChatflowByApiKey)

// UPDATE
router.put(
    ['/', '/:id'],
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    requireHarnessCanvasAccess(),
    chatflowsController.updateChatflow
)

// DELETE
router.delete(
    ['/', '/:id'],
    requireAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'),
    requireHarnessCanvasAccess({ body: false }),
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
// A schedule runs the flow under its own key: an API key may switch it only on a flow it could run itself.
router.patch(
    '/:id/schedule/enabled',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireFlowRunnableByKey(),
    chatflowsController.toggleScheduleEnabled
)
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
