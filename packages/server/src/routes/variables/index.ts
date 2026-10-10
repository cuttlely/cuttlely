import express from 'express'
import variablesController from '../../controllers/variables'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'

const router = express.Router()

// CREATE
router.post('/', requirePermission('variables:create'), variablesController.createVariable)

// READ
router.get('/', requirePermission('variables:view'), variablesController.getAllVariables)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('variables:create,variables:update'), variablesController.updateVariable)

// DELETE
router.delete(['/', '/:id'], requirePermission('variables:delete'), variablesController.deleteVariable)

export default router
