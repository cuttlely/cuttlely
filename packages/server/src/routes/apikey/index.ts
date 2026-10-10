import express from 'express'
import apikeyController from '../../controllers/apikey'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'
const router = express.Router()

// CREATE
router.post('/', requirePermission('apikeys:create'), apikeyController.createApiKey)

// READ
router.get('/', requirePermission('apikeys:view'), apikeyController.getAllApiKeys)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('apikeys:create,apikeys:update'), apikeyController.updateApiKey)

// DELETE
router.delete(['/', '/:id'], requirePermission('apikeys:delete'), apikeyController.deleteApiKey)

export default router
