import express from 'express'
import openaiRealTimeController from '../../controllers/openai-realtime'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

// GET
router.get(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:create,chatflows:update,chatflows:delete'),
    openaiRealTimeController.getAgentTools
)

// EXECUTE
router.post(
    ['/', '/:id'],
    requireAnyPermission('chatflows:view,chatflows:create,chatflows:update,chatflows:delete'),
    openaiRealTimeController.executeAgentTool
)

export default router
