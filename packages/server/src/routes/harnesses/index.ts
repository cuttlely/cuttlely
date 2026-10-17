import express from 'express'
import harnessesController from '../../controllers/harnesses'
import { requireAnyPermission } from '../../identity/rbac'
import { harnessRunRateLimit, requireHarnessAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// Every route that runs a harness or reads its runs also checks an API key's own harness list.
router.get('/', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.listHarnesses)
router.post('/', requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'), harnessesController.saveHarness)
router.get('/:name/runs', requireAnyPermission('chatflows:view,agentflows:view'), requireHarnessAccess(), harnessesController.listRuns)
router.post(
    '/:name/runs/async',
    harnessRunRateLimit('start'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    requireHarnessAccess({ auditDenial: true }),
    harnessesController.startBackgroundRun
)
router.get(
    '/:name/runs/:runId/result',
    harnessRunRateLimit('read'),
    requireAnyPermission('chatflows:view,agentflows:view'),
    requireHarnessAccess(),
    harnessesController.getRunResult
)
router.get('/:name/runs/:runId', requireAnyPermission('chatflows:view,agentflows:view'), requireHarnessAccess(), harnessesController.getRun)
router.post(
    '/:name/runs',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    requireHarnessAccess({ auditDenial: true }),
    harnessesController.createRun
)
router.get('/:name', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.getHarness)
router.delete('/:name', requireAnyPermission('chatflows:delete,agentflows:delete'), harnessesController.deleteHarness)

export default router
