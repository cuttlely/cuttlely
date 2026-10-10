import express from 'express'
import marketplacesController from '../../controllers/marketplaces'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// READ
router.get('/templates', requirePermission('templates:marketplace'), marketplacesController.getAllTemplates)

router.post('/custom', requireAnyPermission('templates:flowexport,templates:toolexport'), marketplacesController.saveCustomTemplate)

// READ
router.get('/custom', requirePermission('templates:custom'), marketplacesController.getAllCustomTemplates)

// DELETE
router.delete(['/', '/custom/:id'], requirePermission('templates:custom-delete'), marketplacesController.deleteCustomTemplate)

export default router
