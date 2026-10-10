import express from 'express'
import evaluatorsController from '../../controllers/evaluators'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// get all datasets
router.get('/', requirePermission('evaluators:view'), evaluatorsController.getAllEvaluators)
// get new dataset
router.get(['/', '/:id'], requirePermission('evaluators:view'), evaluatorsController.getEvaluator)
// Create new dataset
router.post(['/', '/:id'], requirePermission('evaluators:create'), evaluatorsController.createEvaluator)
// Update dataset
router.put(['/', '/:id'], requireAnyPermission('evaluators:create,evaluators:update'), evaluatorsController.updateEvaluator)
// Delete dataset via id
router.delete(['/', '/:id'], requirePermission('evaluators:delete'), evaluatorsController.deleteEvaluator)

export default router
