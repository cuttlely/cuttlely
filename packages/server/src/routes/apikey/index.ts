import {
    accessKeyOptions,
    validateAccessKey,
    createAccessKey,
    updateAccessKey,
    rotateAccessKey,
    revokeAccessKey,
    revokeAccessCredential
} from '../../services/accessKeys/management'
import express from 'express'
import apikeyController from '../../controllers/apikey'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'
const router = express.Router()

router.get('/options', requireAnyPermission('apikeys:view,apikeys:create,apikeys:update'), accessKeyOptions)
router.post('/validate', requireAnyPermission('apikeys:create,apikeys:update'), validateAccessKey)
router.post('/:id/rotate', requirePermission('apikeys:update'), rotateAccessKey)
router.post('/:id/credentials/:credentialId/revoke', requirePermission('apikeys:update'), revokeAccessCredential)

// CREATE
router.post('/', requirePermission('apikeys:create'), createAccessKey)

// READ
router.get('/', requirePermission('apikeys:view'), apikeyController.getAllApiKeys)

// UPDATE
router.put(['/', '/:id'], requireAnyPermission('apikeys:create,apikeys:update'), updateAccessKey)

// DELETE
router.delete(['/', '/:id'], requirePermission('apikeys:delete'), revokeAccessKey)

export default router
