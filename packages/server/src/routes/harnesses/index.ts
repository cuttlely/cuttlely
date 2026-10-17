import express from 'express'
import harnessesController from '../../controllers/harnesses'
import { requireAnyPermission } from '../../identity/rbac'
import { harnessRunRateLimit, requireHarnessAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// Every route that names a harness also checks an API key's own harness list. The list route filters to it.
router.get('/', requireAnyPermission('chatflows:view,agentflows:view'), harnessesController.listHarnesses)
router.post(
    '/',
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    requireHarnessAccess({ nameFrom: 'body' }),
    harnessesController.saveHarness
)
router.get(
    '/:name/runs',
    harnessRunRateLimit('read'),
    requireAnyPermission('chatflows:view,agentflows:view'),
    requireHarnessAccess(),
    harnessesController.listRuns
)
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
router.get(
    '/:name/runs/:runId',
    harnessRunRateLimit('read'),
    requireAnyPermission('chatflows:view,agentflows:view'),
    requireHarnessAccess(),
    harnessesController.getRun
)
router.post(
    '/:name/runs',
    harnessRunRateLimit('start'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    requireHarnessAccess({ auditDenial: true }),
    harnessesController.createRun
)
router.get(
    '/:name/schedule',
    requireAnyPermission('chatflows:view,agentflows:view'),
    requireHarnessAccess(),
    harnessesController.getSchedule
)
router.put(
    '/:name/schedule',
    harnessRunRateLimit('schedule'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    harnessesController.saveSchedule
)
router.post(
    '/:name/schedule/pause',
    harnessRunRateLimit('schedule'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    harnessesController.pauseSchedule
)
router.post(
    '/:name/schedule/resume',
    harnessRunRateLimit('schedule'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    harnessesController.resumeSchedule
)
router.delete(
    '/:name/schedule',
    harnessRunRateLimit('schedule'),
    requireAnyPermission('chatflows:create,chatflows:update,agentflows:create'),
    harnessesController.deleteSchedule
)
router.get('/:name', requireAnyPermission('chatflows:view,agentflows:view'), requireHarnessAccess(), harnessesController.getHarness)
router.delete(
    '/:name',
    requireAnyPermission('chatflows:delete,agentflows:delete'),
    requireHarnessAccess(),
    harnessesController.deleteHarness
)

export default router
