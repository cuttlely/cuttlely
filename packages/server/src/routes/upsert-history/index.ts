import express from 'express'
import { requireAnyPermission } from '../../identity/rbac'
import upsertHistoryController from '../../controllers/upsert-history'
const router = express.Router()

// CREATE

// READ
router.get(['/', '/:id'], requireAnyPermission('chatflows:view,documentStores:view'), upsertHistoryController.getAllUpsertHistory)

// PATCH
router.patch('/', requireAnyPermission('chatflows:update,documentStores:upsert-config'), upsertHistoryController.patchDeleteUpsertHistory)

// DELETE

export default router
