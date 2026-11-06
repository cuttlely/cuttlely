import { Request } from 'express'
import harnessesService, { contextFor, loadHarness } from '../harnesses'
import { resolveTeamAccess } from '../../identity/rbac'
import { isDraining, isShuttingDown, onDrainStart, trackBackgroundRun } from '../../settings/runs'
import { AppError } from '../../errors/appError'
import logger from '../../utils/logger'
import { dashFlowsEnabled } from './enabled'

export const runtime = () => loadHarness('dashflows.mjs')

export async function sources(name: string, workspace: string) {
    const record = await harnessesService.getHarness(name, workspace)
    const mod = await runtime()
    return { harness: name, sources: mod.catalog(record) }
}

export async function saveDashboard(req: Request, workspace: string) {
    const mod = await runtime()
    const definition = mod.validateDefinition(req.body.definition)
    const record = await harnessesService.getHarness(definition.harness, workspace)
    for (const card of definition.cards) {
        const { item } = mod.sourceFor(record, card.source)
        if (item.hash !== card.hash) throw new AppError(409, 'The tested source changed. Select it again.')
    }
    return mod.dashStore().save(req.params.id || null, workspace, req.user!.id, definition, req.body.revision)
}

type StartedRefresh = { mod: any; store: any; claim: any }

export async function refreshDashboard(id: string, workspace: string, started?: StartedRefresh, preferCache = false) {
    const mod = started?.mod ?? (await runtime())
    const store = started?.store ?? mod.dashStore()
    const claim = started?.claim ?? store.claim(id, workspace)
    try {
        const record = await harnessesService.getHarness(claim.definition.harness, workspace)
        const bridge = await loadHarness('bridge.mjs')
        const context = await contextFor(record)
        const snapshot = await mod.materializeCached(
            claim.definition,
            record,
            (item: any, args: unknown) =>
                bridge.executeSpecialistTool(record.name, item.specialist, item.name, args, {
                    harness: record,
                    bindingIndex: item.bindingIndex,
                    ...context
                }),
            store.queryCache(id, workspace),
            preferCache
        )
        return store.settle(id, workspace, claim, snapshot, null)
    } catch (error) {
        // Raw database errors can contain source data or infrastructure details. Keep them off shared reads.
        store.settle(id, workspace, claim, null, 'Refresh failed. Last good snapshot retained. Check the tested source and parameters.')
        if (error instanceof mod.DashFlowError) throw new AppError((error as any).status, (error as Error).message)
        throw new AppError(422, 'Refresh failed. Check source availability, query validation and parameter types.')
    }
}

export async function startDashboardRefresh(id: string, workspace: string, preferCache = false) {
    if (isDraining() || isShuttingDown()) throw new AppError(503, 'Cuttlely is restarting. Try again in a minute.')
    const mod = await runtime()
    const store = mod.dashStore()
    const claim = store.claim(id, workspace)
    void trackBackgroundRun(refreshDashboard(id, workspace, { mod, store, claim }, preferCache)).catch(() => {
        /* The durable error is returned by later reads. */
    })
    return { id, refreshing: true }
}

let timer: NodeJS.Timeout | undefined
let ticking = false
export async function tickDashflows() {
    if (!dashFlowsEnabled() || ticking || isDraining() || isShuttingDown()) return
    ticking = true
    try {
        const mod = await runtime()
        for (const row of mod.dashStore().due()) {
            if (isDraining() || isShuttingDown()) break
            const access = await resolveTeamAccess(row.owner, row.workspace)
            if (!access.owner && !access.permissions?.includes('chatflows:update')) {
                const claim = mod.dashStore().claim(row.id, row.workspace)
                mod.dashStore().settle(row.id, row.workspace, claim, null, 'Scheduled refresh requires the owner’s current team access.')
                continue
            }
            try {
                await trackBackgroundRun(refreshDashboard(row.id, row.workspace))
            } catch {
                /* The durable error is shown beside the last good snapshot. */
            }
        }
    } finally {
        ticking = false
    }
}
export function startDashflowScheduler(initError: unknown) {
    if (!dashFlowsEnabled() || initError || timer) return
    const tick = () => void tickDashflows().catch(() => logger.warn('[dashflows] refresh tick failed'))
    timer = setInterval(tick, 60000)
    timer.unref()
    onDrainStart(() => {
        clearInterval(timer)
        timer = undefined
    })
    tick()
}
