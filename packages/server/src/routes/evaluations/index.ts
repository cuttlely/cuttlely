import express from 'express'
import evaluationsController from '../../controllers/evaluations'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

router.get('/', requirePermission('evaluations:view'), evaluationsController.getAllEvaluations)
router.get('/:id', requirePermission('evaluations:view'), evaluationsController.getEvaluation)
router.delete('/:id', requirePermission('evaluations:delete'), evaluationsController.deleteEvaluation)
router.post('/', requirePermission('evaluations:create'), evaluationsController.createEvaluation)
router.get('/is-outdated/:id', evaluationsController.isOutdated)
router.post('/run-again/:id', requireAnyPermission('evaluations:create,evaluations:run'), evaluationsController.runAgain)
router.get('/versions/:id', requirePermission('evaluations:view'), evaluationsController.getVersions)
router.patch('/', requirePermission('evaluations:delete'), evaluationsController.patchDeleteEvaluations)
export default router
