import express from 'express'
import assistantsController from '../../controllers/assistants'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

// CREATE
router.post('/', requirePermission('assistants:create'), assistantsController.createAssistant)

// READ
router.get('/', requirePermission('assistants:view'), assistantsController.getAllAssistants)
router.get(['/', '/:id'], requirePermission('assistants:view'), assistantsController.getAssistantById)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('assistants:create,assistants:update'), assistantsController.updateAssistant)

// DELETE
router.delete(['/', '/:id'], requirePermission('assistants:delete'), assistantsController.deleteAssistant)

router.get('/components/chatmodels', assistantsController.getChatModels)
router.get('/components/docstores', assistantsController.getDocumentStores)
router.get('/components/tools', assistantsController.getTools)

// Generate Assistant Instruction
router.post('/generate/instruction', assistantsController.generateAssistantInstruction)

export default router
