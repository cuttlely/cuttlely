import express from 'express'
import chatMessagesController from '../../controllers/chat-messages'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// CREATE

// READ
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatMessagesController.getAllInternalChatMessages
)

// UPDATE

// DELETE

export default router
