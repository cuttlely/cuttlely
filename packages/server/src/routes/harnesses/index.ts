import express from 'express'
import harnessesController from '../../controllers/harnesses'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

router.get('/', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.listHarnesses)
router.post('/', requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'), harnessesController.saveHarness)
router.get('/:name/runs', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.listRuns)
router.get('/:name/runs/:runId', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.getRun)
router.post('/:name/runs', requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'), harnessesController.createRun)
router.get('/:name', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.getHarness)
router.delete('/:name', requireAnyPermission('chatflows:delete,agentflows:delete'), harnessesController.deleteHarness)

export default router
