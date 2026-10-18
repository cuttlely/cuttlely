import express from 'express'
import chatMessagesController from '../../controllers/chat-messages'
import { requireAnyPermission } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// CREATE

// READ
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    requireHarnessCanvasAccess({ body: false }),
    chatMessagesController.getAllInternalChatMessages
)

// UPDATE

// DELETE

export default router
