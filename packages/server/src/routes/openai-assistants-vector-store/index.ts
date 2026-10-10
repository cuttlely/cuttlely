import express from 'express'
import openaiAssistantsVectorStoreController from '../../controllers/openai-assistants-vector-store'
import { getMulterStorage } from '../../utils'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

// CREATE
router.post('/', requirePermission('assistants:create'), openaiAssistantsVectorStoreController.createAssistantVectorStore)

// READ
router.get('/:id', requirePermission('assistants:view'), openaiAssistantsVectorStoreController.getAssistantVectorStore)

// LIST
router.get('/', requirePermission('assistants:view'), openaiAssistantsVectorStoreController.listAssistantVectorStore)

// UPDATE
router.put(
    ['/', '/:id'],
    requireAnyPermission('assistants:create,assistants:update'),
    openaiAssistantsVectorStoreController.updateAssistantVectorStore
)

// DELETE
router.delete(['/', '/:id'], requirePermission('assistants:delete'), openaiAssistantsVectorStoreController.deleteAssistantVectorStore)

// UPLOAD FILES — permission check must precede multer to reject unauthorized requests before file parsing
router.post(
    '/:id',
    requireAnyPermission('assistants:create,assistants:update'),
    getMulterStorage().array('files'),
    openaiAssistantsVectorStoreController.uploadFilesToAssistantVectorStore
)

// DELETE FILES
router.patch(
    ['/', '/:id'],
    requirePermission('assistants:update'),
    openaiAssistantsVectorStoreController.deleteFilesFromAssistantVectorStore
)

export default router
