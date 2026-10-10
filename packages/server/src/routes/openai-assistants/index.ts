import express from 'express'
import openaiAssistantsController from '../../controllers/openai-assistants'
import { requirePermission } from '../../identity/rbac'

const router = express.Router()

// CREATE

// READ
router.get('/', requirePermission('assistants:view'), openaiAssistantsController.getAllOpenaiAssistants)
router.get(['/', '/:id'], requirePermission('assistants:view'), openaiAssistantsController.getSingleOpenaiAssistant)

// UPDATE

// DELETE

export default router
