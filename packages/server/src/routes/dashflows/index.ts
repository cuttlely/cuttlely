import { accessContext } from '../../services/accessKeys/authorization'
import { bearerDashboardReport, bearerDashboardResult } from '../../services/accessKeys/dashflowReports'
import express, { Request, Response, NextFunction } from 'express'
import { requireAnyPermission } from '../../identity/rbac'
import { requireWorkspaceIdFromReq } from '../../identity/workspaceScope'
import { harnessRunRateLimit } from '../../services/harnesses/apiAccess'
import { runtime, saveDashboard, sources, startDashboardRefresh } from '../../services/dashflows'
import { dashFlowsEnabled } from '../../services/dashflows/enabled'
import harnessesService from '../../services/harnesses'
import { AppError } from '../../errors/appError'

const router = express.Router()
// Team links require an interactive session; a harness API key cannot enumerate snapshots.
router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!dashFlowsEnabled()) return next(new AppError(403, 'Dashflows BETA is off. Turn it on in Admin > Server Settings > Experimental.'))
    if (!req.user?.id && (!req.user?.apiKeyId || !accessContext(req)))
        return next(new AppError(403, 'Sign in to your team to use Dashflows.'))
    next()
})
const view = requireAnyPermission('chatflows:view')
const edit = requireAnyPermission('chatflows:update')
const action =
    (fn: (req: Request, res: Response, workspace: string) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            await fn(req, res, requireWorkspaceIdFromReq(req))
        } catch (error) {
            const mod = await runtime()
            next(error instanceof mod.DashFlowError ? new AppError((error as any).status, (error as Error).message) : error)
        }
    }
router.get(
    '/',
    edit,
    action(async (_req, res, ws) => res.json((await runtime()).dashStore().list(ws)))
)
router.get(
    '/sources/:name',
    edit,
    action(async (req, res, ws) => res.json(await sources(req.params.name, ws)))
)
router.post(
    '/',
    edit,
    action(async (req, res, ws) => res.json(await saveDashboard(req, ws)))
)
router.post('/:id/accounts/:accountId/report', edit, harnessRunRateLimit('start', 3), bearerDashboardReport)
router.get('/:id/reports/:runId', view, harnessRunRateLimit('read'), bearerDashboardResult)
router.get(
    '/:id/published',
    view,
    action(async (req, res, ws) => {
        const result = (await runtime()).dashStore().published(req.params.id, ws)
        await harnessesService.getHarness(result.definition.harness, ws)
        res.setHeader('Cache-Control', 'no-store')
        return res.json(result)
    })
)
router.get(
    '/:id',
    edit,
    action(async (req, res, ws) => {
        res.setHeader('Cache-Control', 'no-store')
        return res.json((await runtime()).dashStore().get(req.params.id, ws))
    })
)
router.get(
    '/:id/refresh-status',
    edit,
    action(async (req, res, ws) => res.json((await runtime()).dashStore().status(req.params.id, ws)))
)
router.put(
    '/:id',
    edit,
    action(async (req, res, ws) => res.json(await saveDashboard(req, ws)))
)
router.post(
    '/:id/refresh',
    edit,
    harnessRunRateLimit('start'),
    action(async (req, res, ws) => res.status(202).json(await startDashboardRefresh(req.params.id, ws, req.body?.preferCache === true)))
)
router.post(
    '/:id/publish',
    edit,
    action(async (req, res, ws) =>
        res.json((await runtime()).dashStore().publish(req.params.id, ws, req.body.revision, req.body.public === true))
    )
)
router.delete(
    '/:id/publish',
    edit,
    action(async (req, res, ws) => {
        ;(await runtime()).dashStore().unpublish(req.params.id, ws)
        res.sendStatus(204)
    })
)
export default router

export { default as publicDashflowsRouter } from './public'
