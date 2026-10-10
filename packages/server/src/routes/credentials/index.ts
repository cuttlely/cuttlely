import express from 'express'
import credentialsController from '../../controllers/credentials'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'
const router = express.Router()

// CREATE
router.post('/', requirePermission('credentials:create'), credentialsController.createCredential)

// READ
router.get('/', requirePermission('credentials:view'), credentialsController.getAllCredentials)
router.get(['/', '/:id'], requireAnyPermission('credentials:create,credentials:update'), credentialsController.getCredentialById)

// REVEAL
router.get('/:id/reveal', requireAnyPermission('credentials:create,credentials:update'), credentialsController.revealCredentialById)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('credentials:create,credentials:update'), credentialsController.updateCredential)

// DELETE
router.delete(['/', '/:id'], requirePermission('credentials:delete'), credentialsController.deleteCredentials)

export default router
