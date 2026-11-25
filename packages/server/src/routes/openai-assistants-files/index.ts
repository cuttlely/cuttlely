import express from 'express'
import openaiAssistantsController from '../../controllers/openai-assistants'
import { receiveUploadedFiles } from '../../middlewares/receiveUploadedFiles'
import { authorizeAssistantFileDownload } from '../../utils/authorizeFlowAccess'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

// The flow's API key or a session in the flow's workspace
router.post('/download/', authorizeAssistantFileDownload, openaiAssistantsController.getFileFromAssistant)

// permission check must precede multer to reject unauthorized requests before file parsing
router.post(
    '/upload/',
    requireAnyPermission('assistants:create,assistants:update'),
    receiveUploadedFiles,
    openaiAssistantsController.uploadAssistantFiles
)

export default router
