import express from 'express'
import executionController from '../../controllers/executions'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// READ
router.get('/', requireAnyPermission('executions:view'), executionController.getAllExecutions)
router.get(['/', '/:id'], requireAnyPermission('executions:view'), executionController.getExecutionById)

// PUT
router.put(['/', '/:id'], requireAnyPermission('executions:update'), executionController.updateExecution)

// DELETE - single execution or multiple executions
router.delete('/:id', requireAnyPermission('executions:delete'), executionController.deleteExecutions)
router.delete('/', requireAnyPermission('executions:delete'), executionController.deleteExecutions)

export default router
