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
    return await mod.dashStore().save(req.params.id || null, workspace, req.user!.id, definition, req.body.revision)
}

type StartedRefresh = { mod: any; store: any; claim: any; harnessRecord?: any }

export async function refreshDashboard(id: string, workspace: string, started?: StartedRefresh, preferCache = false) {
    const mod = started?.mod ?? (await runtime())
    const store = started?.store ?? mod.dashStore()
    const claim = started?.claim ?? (await store.claim(id, workspace))
    // Store calls return promises on both backends; a sync mock is accepted too.
    const attempt = (work: () => unknown): Promise<unknown> => {
        try {
            return Promise.resolve(work())
        } catch (error) {
            return Promise.reject(error)
        }
    }
    const interruptForRestart = () =>
        attempt(() => store.cancel(id, workspace, claim.token, 'interrupted')).catch(() => {
            /* Already finished or superseded. */
        })
    // The bridge awaits beforeCall once the tool is prepared and before the source starts, so a cancel that lands while
    // the node is being prepared stops the call there. It awaits beforeRetry before each retry of the tool with another
    // argument shape, so a cancel that lands during an attempt stops the retry. assertCall then runs synchronously
    // before each attempt; it can only see a failed awaited store check, which sets this flag.
    let fenced: unknown
    const assertNotRestarting = () => {
        if (isDraining() || isShuttingDown()) {
            void interruptForRestart()
            throw new AppError(503, 'Refresh interrupted by server restart.')
        }
        if (fenced) throw fenced
    }
    const assertActive = async () => {
        assertNotRestarting()
        try {
            await store.assertActive(id, workspace, claim)
        } catch (error) {
            fenced = error
            throw error
        }
    }
    const heartbeat = setInterval(() => {
        if (isDraining() || isShuttingDown()) {
            void interruptForRestart()
            clearInterval(heartbeat)
            return
        }
        attempt(() => store.heartbeat(id, workspace, claim)).then(
            (renewed) => {
                if (!renewed) clearInterval(heartbeat)
            },
            () => {
                // A transient lock or connection error must not disable every subsequent renewal.
                logger.warn('[dashflows] Refresh heartbeat write failed; retrying on the next tick.')
            }
        )
    }, 15000)
    heartbeat.unref()
    const removeDrainListener = onDrainStart(() => {
        void interruptForRestart()
        clearInterval(heartbeat)
    })
    // Progress writes for this claim stay in order.
    let progressChain: Promise<unknown> = Promise.resolve()
    try {
        await assertActive()
        // Access-key admission may pin the authorized canvas. Prefer that record so a same-name
        // recreation between the pin check and materialization cannot substitute an ungranted id.
        const record = started?.harnessRecord ?? (await harnessesService.getHarness(claim.definition.harness, workspace))
        const bridge = await loadHarness('bridge.mjs')
        const context = await contextFor(record)
        const snapshot = await mod.materializeCached(
            claim.definition,
            record,
            async (item: any, args: unknown) => {
                await assertActive()
                const result = await bridge.executeSpecialistTool(record.name, item.specialist, item.name, args, {
                    harness: record,
                    bindingIndex: item.bindingIndex,
                    ...context,
                    beforeCall: assertActive,
                    beforeRetry: assertActive,
                    assertCall: assertNotRestarting
                })
                await assertActive()
                return result
            },
            await store.queryCache(id, workspace, claim),
            preferCache,
            (progress: unknown) =>
                (progressChain = progressChain.then(async () => {
                    await assertActive()
                    await store.progress(id, workspace, claim, progress)
                })),
            claim.resumeSince
        )
        return await store.settle(id, workspace, claim, snapshot, null)
    } catch (error) {
        // Raw database errors can contain source data or infrastructure details. Keep them off shared reads.
        await store.settle(
            id,
            workspace,
            claim,
            null,
            'Refresh failed. Last good snapshot retained. Check the tested source and parameters.'
        )
        if (error instanceof mod.DashFlowError) throw new AppError((error as any).status, (error as Error).message)
        throw new AppError(422, 'Refresh failed. Check source availability, query validation and parameter types.')
    } finally {
        clearInterval(heartbeat)
        removeDrainListener?.()
    }
}

export async function startDashboardRefresh(
    id: string,
    workspace: string,
    preferCache = false,
    expectedRevision?: number,
    expectedHarnessId?: string
) {
    if (isDraining() || isShuttingDown()) throw new AppError(503, 'Cuttlely is restarting. Try again in a minute.')
    const mod = await runtime()
    const store = mod.dashStore()
    const claim = await store.claim(id, workspace)
    if (expectedRevision !== undefined && claim.revision !== expectedRevision) {
        await store.cancel(id, workspace, claim.token)
        throw new AppError(409, 'Dashboard changed after authorization. Retry the refresh.')
    }
    let harnessRecord: any
    if (expectedHarnessId !== undefined) {
        harnessRecord = await harnessesService.getHarness(claim.definition.harness, workspace)
        if (!harnessRecord || harnessRecord.orphaned || harnessRecord.chatflowId !== expectedHarnessId) {
            await store.cancel(id, workspace, claim.token)
            throw new AppError(409, 'Harness changed after authorization. Retry the refresh.')
        }
    }
    if (isDraining() || isShuttingDown()) {
        await store.cancel(id, workspace, claim.token)
        throw new AppError(503, 'Cuttlely is restarting. Try again in a minute.')
    }
    void trackBackgroundRun(refreshDashboard(id, workspace, { mod, store, claim, harnessRecord }, preferCache)).catch(() => {
        /* The durable error is returned by later reads. */
    })
    return { id, refreshing: true, refreshProgress: (await store.status(id, workspace)).refreshProgress }
}

let timer: NodeJS.Timeout | undefined
let ticking = false
export async function tickDashflows() {
    if (!dashFlowsEnabled() || ticking || isDraining() || isShuttingDown()) return
    ticking = true
    try {
        const mod = await runtime()
        for (const row of await mod.dashStore().due()) {
            if (isDraining() || isShuttingDown()) break
            const access = await resolveTeamAccess(row.owner, row.workspace)
            if (isDraining() || isShuttingDown()) break
            if (!access.owner && !access.permissions?.includes('chatflows:update')) {
                const claim = await mod.dashStore().claim(row.id, row.workspace)
                await mod
                    .dashStore()
                    .settle(row.id, row.workspace, claim, null, 'Scheduled refresh requires the owner’s current team access.')
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
