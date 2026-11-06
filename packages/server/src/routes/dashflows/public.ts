import express, { Request, Response, NextFunction } from 'express'
import { runtime } from '../../services/dashflows'
import { dashFlowsEnabled } from '../../services/dashflows/enabled'
import harnessesService from '../../services/harnesses'
import { harnessRunRateLimit } from '../../services/harnesses/apiAccess'
import { resolveTeamAccess } from '../../identity/rbac'
import { isDraining, isShuttingDown, trackBackgroundRun } from '../../settings/runs'
import { AppError } from '../../errors/appError'

const router = express.Router()
router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!dashFlowsEnabled()) return next(new AppError(404, 'Public dashboard not found.'))
    next()
})
const action =
    (fn: (req: Request, res: Response, store: any, view: any) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const store = (await runtime()).dashStore()
            const view = store.publicView(req.params.token)
            await harnessesService.getHarness(view.publication.definition.harness, view.workspace)
            await fn(req, res, store, view)
        } catch (error) {
            const status = (error as any).status || (error as any).statusCode || 500
            next(
                new AppError(
                    status,
                    status === 429
                        ? 'Report limit reached. Try again later.'
                        : status === 404
                        ? 'Public dashboard not found.'
                        : 'This public dashboard action is unavailable.'
                )
            )
        }
    }
const reportAccess = async (view: any) => {
    const access = await resolveTeamAccess(view.owner, view.workspace)
    if (
        !access.owner &&
        !access.permissions?.some((p: string) => ['chatflows:create', 'chatflows:update', 'agentflows:create'].includes(p))
    )
        throw new AppError(403, 'Report access revoked.')
}
export function hasPublishedAccount(snapshot: any, id: string): boolean {
    if (!/^001[A-Za-z0-9]{15}$/.test(id)) return false
    const unpack = (v: any) => {
        try {
            return typeof v === 'string' ? JSON.parse(v) : v
        } catch {
            return null
        }
    }
    for (const card of snapshot.cards || []) {
        for (const row of [...(card.rows || []), ...(card.evidenceRows || [])]) {
            if (row.account_id === id) return true
            const rows = unpack(row.deal_details) || unpack(unpack(row.risk_quarter_payload)?.inline_rows)
            if (Array.isArray(rows) && rows.slice(0, 100).some((r: any) => r?.account_id === id)) return true
        }
    }
    return false
}
router.get(
    '/:token',
    harnessRunRateLimit('read'),
    action(async (_req, res, _store, view) => res.json(view.publication))
)
router.post(
    '/:token/accounts/:accountId/report',
    harnessRunRateLimit('start', 3),
    action(async (req, res, store, view) => {
        if (isDraining() || isShuttingDown()) throw new AppError(503, 'Restarting.')
        await reportAccess(view)
        if (!hasPublishedAccount(view.publication.snapshot, req.params.accountId)) throw new AppError(404, 'Account not published.')
        const slot = store.reservePublicReport(req.params.token)
        const started = await harnessesService.startBackgroundRun(
            view.publication.definition.harness,
            {
                question: `Run the full account health report for the verified Salesforce account ID ${req.params.accountId}. Use the ID-based full health source. Preserve exact source facts, dates, coverage and unknowns. Do not resolve or substitute a different account.`
            },
            { workspaceId: view.workspace, source: 'api', caller: { via: 'session' }, track: trackBackgroundRun }
        )
        store.attachPublicReport(slot, started.runId)
        return res.status(202).json({ runId: started.runId })
    })
)
router.get(
    '/:token/reports/:runId',
    harnessRunRateLimit('read'),
    action(async (req, res, store, view) => {
        await reportAccess(view)
        if (!store.hasPublicReport(req.params.token, req.params.runId)) throw new AppError(404, 'Report not published.')
        const result = await harnessesService.getRunResult(view.publication.definition.harness, req.params.runId, view.workspace)
        return res.json({
            finished: result.finished,
            status: result.status,
            error: result.error ? 'Report failed.' : undefined,
            result: result.finished ? { text: result.result?.text || '' } : null
        })
    })
)
export default router
