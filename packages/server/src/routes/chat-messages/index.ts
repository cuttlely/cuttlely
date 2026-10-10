import express from 'express'
import chatMessageController from '../../controllers/chat-messages'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// CREATE
// NOTE: Unused route
// router.post(['/', '/:id'], chatMessageController.createChatMessage)

// READ
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatMessageController.getAllChatMessages
)

// UPDATE
router.put(
    ['/abort/', '/abort/:chatflowid/:chatid'],
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    chatMessageController.abortChatMessage
)

// DELETE
router.delete(
    ['/', '/:id'],
    requireAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'),
    chatMessageController.removeAllChatMessages
)

export default router
