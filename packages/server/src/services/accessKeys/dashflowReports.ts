import { RequestHandler } from 'express'
import { ApiKeyReport } from '../../database/entities/ApiKeyReport'
import { AppError } from '../../errors/appError'
import { hasPublishedAccount } from '../../routes/dashflows/public'
import { trackBackgroundRun } from '../../settings/runs'
import { accessData } from './data'
import { runtime } from '../dashflows'
import harnessesService from '../harnesses'
import { harnessCallerFor } from '../harnesses/apiAccess'

const action =
    (fn: RequestHandler): RequestHandler =>
    (req, res, next) => {
        if (!req.user?.apiKeyId) return next(new AppError(403, 'Use a scoped access key for the Dashflows reports API.'))
        return fn(req, res, next)
    }
export const bearerDashboardReport: RequestHandler = action(async (req, res, next) => {
    try {
        const ws = req.user!.activeWorkspaceId!
        const view = (await runtime()).dashStore().published(req.params.id, ws)
        if (!hasPublishedAccount(view.snapshot, req.params.accountId)) throw new AppError(404, 'Account not published.')
        const expectedHarnessId = res.locals.accessKeyDashboardHarnessId as string | undefined
        let expectedChatflowId: string | undefined
        if (expectedHarnessId !== undefined) {
            const record = await harnessesService.getHarness(view.definition.harness, ws)
            if (!record || record.orphaned || record.chatflowId !== expectedHarnessId)
                throw new AppError(409, 'Harness changed after authorization. Retry the report.')
            expectedChatflowId = record.chatflowId
        }
        const started = await harnessesService.startBackgroundRun(
            view.definition.harness,
            {
                question: `Run the full account health report for the verified Salesforce account ID ${req.params.accountId}. Use the ID-based full health source. Preserve exact source facts, dates, coverage and unknowns. Do not resolve or substitute a different account.`
            },
            {
                workspaceId: ws,
                source: 'api',
                caller: await harnessCallerFor(req),
                track: trackBackgroundRun,
                expectedChatflowId
            }
        )
        const repo = (await accessData()).getRepository(ApiKeyReport)
        await repo.save(
            repo.create({ runId: started.runId, principalId: req.user!.apiKeyId!, dashboardId: req.params.id, createdAt: new Date() })
        )
        await repo
            .createQueryBuilder()
            .delete()
            .where('createdAt < :cutoff', { cutoff: new Date(Date.now() - 7 * 86400000) })
            .execute()
        res.status(202).json({ runId: started.runId })
    } catch (error) {
        next(error)
    }
})
export const bearerDashboardResult: RequestHandler = action(async (req, res, next) => {
    try {
        const receipt = await (await accessData()).getRepository(ApiKeyReport).findOneBy({
            runId: req.params.runId,
            principalId: req.user!.apiKeyId!,
            dashboardId: req.params.id
        })
        if (!receipt || receipt.createdAt.getTime() <= Date.now() - 7 * 86400000) throw new AppError(404, 'Report not found.')
        const view = (await runtime()).dashStore().published(req.params.id, req.user!.activeWorkspaceId!)
        const result = await harnessesService.getRunResult(view.definition.harness, req.params.runId, req.user!.activeWorkspaceId!, {
            apiKeyId: req.user!.apiKeyId!
        })
        res.json({
            finished: result.finished,
            status: result.status,
            error: result.error ? 'Report failed.' : undefined,
            result: result.finished ? { text: result.result?.text || '' } : null
        })
    } catch (error) {
        next(error)
    }
})
