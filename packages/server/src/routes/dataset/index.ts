import express from 'express'
import datasetController from '../../controllers/dataset'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'
const router = express.Router()

// get all datasets
router.get('/', requirePermission('datasets:view'), datasetController.getAllDatasets)
// get new dataset
router.get(['/set', '/set/:id'], requirePermission('datasets:view'), datasetController.getDataset)
// Create new dataset
router.post(['/set', '/set/:id'], requirePermission('datasets:create'), datasetController.createDataset)
// Update dataset
router.put(['/set', '/set/:id'], requireAnyPermission('datasets:create,datasets:update'), datasetController.updateDataset)
// Delete dataset via id
router.delete(['/set', '/set/:id'], requirePermission('datasets:delete'), datasetController.deleteDataset)

// Create new row in a given dataset
router.post(['/rows', '/rows/:id'], requirePermission('datasets:create'), datasetController.addDatasetRow)
// Update row for a dataset
router.put(['/rows', '/rows/:id'], requireAnyPermission('datasets:create,datasets:update'), datasetController.updateDatasetRow)
// Delete dataset row via id
router.delete(['/rows', '/rows/:id'], requirePermission('datasets:delete'), datasetController.deleteDatasetRow)
// PATCH delete by ids
router.patch('/rows', requirePermission('datasets:delete'), datasetController.patchDeleteRows)

// Update row for a dataset
router.post(['/reorder', '/reorder'], requireAnyPermission('datasets:create,datasets:update'), datasetController.reorderDatasetRow)

export default router
