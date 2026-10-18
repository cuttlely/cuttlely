import express from 'express'
import apikeyController from '../../controllers/apikey'
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
// Before '/:id', which would otherwise take 'apikey' as a chatflow id.
router.get('/apikey/', chatflowsController.getChatflowByApiKey)
router.get('/apikey/:apikey', apikeyController.refuseApiKeyInUrl)
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,chatflows:delete,agentflows:view,agentflows:update,agentflows:delete'),
    requireHarnessCanvasAccess({ body: false }),
    chatflowsController.getChatflowById
)

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
// The secret lets a caller run the flow's webhook, which uses the flow's own key: same rule as MCP and the schedule.
router.post(
    '/:id/webhook-secret',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireFlowRunnableByKey(),
    chatflowsController.setWebhookSecret
)
router.delete(
    '/:id/webhook-secret',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireFlowRunnableByKey(),
    chatflowsController.clearWebhookSecret
)

// CHECK FOR CHANGE
router.get(
    '/has-changed/:id/:lastUpdatedDateTime',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireHarnessCanvasAccess({ body: false }),
    chatflowsController.checkIfChatflowHasChanged
)

// SCHEDULE
router.get(
    '/:id/schedule/status',
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    requireHarnessCanvasAccess({ body: false }),
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
    requireHarnessCanvasAccess({ body: false }),
    chatflowsController.getScheduleTriggerLogs
)
router.delete(
    '/:id/schedule/trigger-logs',
    requireAnyPermission('chatflows:update,agentflows:update,executions:delete'),
    requireHarnessCanvasAccess({ body: false }),
    chatflowsController.deleteScheduleTriggerLogs
)

export default router
