import express from 'express'
import chatMessageController from '../../controllers/chat-messages'
import { requireAnyPermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

// An API key needs a HARNESS canvas's name on its own list to read, abort or clear its chat.
const router = express.Router()

// CREATE
// NOTE: Unused route
// router.post(['/', '/:id'], chatMessageController.createChatMessage)

// READ
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    requireHarnessCanvasAccess({ body: false }),
    chatMessageController.getAllChatMessages
)

// UPDATE
router.put(
    ['/abort/', '/abort/:chatflowid/:chatid'],
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    requireHarnessCanvasAccess({ idParam: 'chatflowid', body: false }),
    chatMessageController.abortChatMessage
)

// DELETE
router.delete(
    ['/', '/:id'],
    requireAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'),
    requireHarnessCanvasAccess({ body: false }),
    chatMessageController.removeAllChatMessages
)

export default router
