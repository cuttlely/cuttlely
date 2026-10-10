import express from 'express'
import toolsController from '../../controllers/tools'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'

const router = express.Router()

// CREATE
router.post('/', requirePermission('tools:create'), toolsController.createTool)

// READ
router.get('/', requirePermission('tools:view'), toolsController.getAllTools)
router.get(['/', '/:id'], requireAnyPermission('tools:view'), toolsController.getToolById)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('tools:update,tools:create'), toolsController.updateTool)

// DELETE
router.delete(['/', '/:id'], requirePermission('tools:delete'), toolsController.deleteTool)

export default router
