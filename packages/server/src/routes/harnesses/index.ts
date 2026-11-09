import express from 'express'
import harnessesController from '../../controllers/harnesses'
import { requireAnyPermission } from '../../identity/rbac'
import { harnessRunRateLimit, requireHarnessAccess } from '../../services/harnesses/apiAccess'
import { accessContext } from '../../services/accessKeys/authorization'

const router = express.Router()
// Scoped execution has explicit operation and resource grants. Legacy/session edit gates stay intact.
function requireRunPermission(req: express.Request, res: express.Response, next: express.NextFunction) {
    const context = accessContext(req)
    const scoped = context?.routeAdmission?.operation === 'harness:run' && !context.key.accessPolicy?.legacy
    return requireAnyPermission(scoped ? 'chatflows:view,agentflows:view' : 'chatflows:create,chatflows:update,agentflows:create')(
        req,
        res,
        next
    )
}

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
    requireRunPermission,
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
router.get(
    '/:name/runs/:runId/diagnostics',
    harnessRunRateLimit('read'),
    requireAnyPermission('chatflows:update,agentflows:create'),
    requireHarnessAccess(),
    harnessesController.getRunDiagnostics
)
router.post(
    '/:name/runs',
    harnessRunRateLimit('start'),
    requireRunPermission,
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
router.put(
    '/:name/category',
    requireAnyPermission('chatflows:update,agentflows:update'),
    requireHarnessAccess(),
    harnessesController.setHarnessCategory
)
router.get('/:name', requireAnyPermission('chatflows:view,agentflows:view'), requireHarnessAccess(), harnessesController.getHarness)
router.delete(
    '/:name',
    requireAnyPermission('chatflows:delete,agentflows:delete'),
    requireHarnessAccess(),
    harnessesController.deleteHarness
)

export default router
