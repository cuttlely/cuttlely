import express from 'express'
import evaluationsController from '../../controllers/evaluations'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

router.get('/', requirePermission('evaluations:view'), evaluationsController.getAllEvaluations)
// These paths have to be registered before /:id, or Express treats "versions" and "is-outdated" as ids.
router.get('/is-outdated/:id', requirePermission('evaluations:view'), evaluationsController.isOutdated)
router.get('/versions/:id', requirePermission('evaluations:view'), evaluationsController.getVersions)
router.post('/run-again/:id', requireAnyPermission('evaluations:create,evaluations:run'), evaluationsController.runAgain)
router.post('/', requirePermission('evaluations:create'), evaluationsController.createEvaluation)
router.patch('/', requirePermission('evaluations:delete'), evaluationsController.patchDeleteEvaluations)
router.get('/:id', requirePermission('evaluations:view'), evaluationsController.getEvaluation)
router.delete('/:id', requirePermission('evaluations:delete'), evaluationsController.deleteEvaluation)
export default router
