import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pathToFileURL } from 'url'
import { StatusCodes } from 'http-status-codes'
import { In } from 'typeorm'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { Workspace } from '../../database/entities/identity'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { databaseEntities } from '../../utils'
import logger from '../../utils/logger'
import { userFacingError } from './userFacingError'
import flowVersionsService from '../flow-versions'

// The server build targets CommonJS, and tsc rewrites import() into require(), which cannot load etl/*.mjs.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

let apiModule: Promise<any> | undefined
let configured = false

async function loadEtl(file = 'api.mjs'): Promise<any> {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'etl', file)
        if (fs.existsSync(candidate)) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `ETL module ${file} was not found in this checkout.`)
}

// Reuses the Workspace import this service already has. Harness calls this instead of importing the entity.
export async function orgIdForWorkspace(workspaceId?: string | null) {
    if (!workspaceId) return undefined
    const workspace = await getRunningExpressApp().AppDataSource.getRepository(Workspace).findOneBy({ id: workspaceId })
    return workspace?.organizationId || undefined
}

async function contextFor(pipeline: { id: string; workspaceId?: string | null } | null) {
    const appServer = getRunningExpressApp()
    const orgId = await orgIdForWorkspace(pipeline?.workspaceId)
    const componentNodes = appServer.nodesPool.componentNodes
    return {
        componentNodes,
        flowOptions: {
            appDataSource: appServer.AppDataSource,
            databaseEntities,
            logger,
            componentNodes,
            chatflowid: pipeline?.id,
            workspaceId: pipeline?.workspaceId || undefined,
            orgId
        }
    }
}

async function etl(): Promise<any> {
    if (!apiModule) {
        apiModule = loadEtl().catch((error) => {
            apiModule = undefined
            throw error
        })
    }
    const api = await apiModule
    if (!configured) {
        configured = true
        api.configureRunner({
            contextFor,
            onError: (error: unknown, run: { id: string }) => logger.warn(`[etl] run ${run.id} failed: ${getErrorMessage(error)}`)
        })
    }
    return api
}

function asFlowiseError(error: any): InternalFlowiseError {
    const status =
        error instanceof InternalFlowiseError
            ? error.statusCode
            : error?.etlError
            ? error.status || StatusCodes.BAD_REQUEST
            : StatusCodes.INTERNAL_SERVER_ERROR
    return new InternalFlowiseError(status, userFacingError(error))
}

async function call<T>(fn: (api: any) => T | Promise<T>): Promise<T> {
    try {
        return await fn(await etl())
    } catch (error) {
        throw asFlowiseError(error)
    }
}

// Every pipeline, run, schedule and upload is reached through a pipeline in the caller's workspace. A missing
// workspace id is a 400, and a pipeline in another workspace (or with none) is a 404, the same as a missing one.
async function requirePipeline(api: any, id: string, workspaceId?: string) {
    return api.pipelineInWorkspace(id, workspaceId)
}

async function requireRunAccess(api: any, runId: string, workspaceId?: string) {
    return api.runInWorkspace(runId, workspaceId)
}

const validatePipelineFlow = (chatflow: ChatFlow) =>
    call((api) => api.validatePipelineName(chatflow.id, chatflow.name, chatflow.workspaceId))

const syncPipelineFromFlow = (chatflow: ChatFlow) =>
    call((api) =>
        api.recordVersion({ id: chatflow.id, name: chatflow.name, workspaceId: chatflow.workspaceId, flowData: chatflow.flowData })
    )

// Deleting a pipeline removes its vectors from its store too. A store that cannot be reached does not stop the delete
// (the flow is already gone); the log says how many vectors were left there.
const deletePipeline = (id: string) =>
    call(async (api) => {
        const result = await api.deletePipeline(id)
        for (const failure of result?.errors || []) {
            logger.warn(`[etl] pipeline ${id} deleted, but its vectors in ${failure.store} could not be removed: ${failure.error}`)
        }
        return result
    })

const listPipelines = (workspaceId?: string) => call((api) => api.listPipelineSummaries({ workspaceId }))

const getPipelineDetail = (id: string, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.pipelineDetail(id)
    })

const getVersion = (id: string, version: number, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.versionDetail(id, version)
    })

const preview = (id: string, body: Record<string, any>, workspaceId?: string) =>
    call(async (api) => {
        let flowData = body?.flowData
        if (!workspaceId)
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'No active workspace. Sign in to a workspace and try again.')
        const known = api.getPipeline(id)
        if (known) await requirePipeline(api, id, workspaceId)
        if (!flowData) {
            // Only a chat flow in the caller's workspace (an unsaved pipeline has no ETL row to check yet).
            const chatflow = await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id, workspaceId })
            flowData = chatflow?.flowData
        }
        if (!flowData) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Add nodes to the canvas before previewing.')
        const ctx = await contextFor(known || { id, workspaceId })
        return api.previewPipeline({
            pipelineId: id,
            flowData,
            limit: Math.min(Number(body?.limit) || 5, 50),
            embed: Boolean(body?.embed),
            ctx
        })
    })

const startRun = (id: string, body: Record<string, any>, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.startRun(id, { mode: body?.mode, settings: body?.settings || {} })
    })

const listRuns = (id: string, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.pipelineRuns(id, 50)
    })

const getRun = (runId: string, after: number, workspaceId?: string) =>
    call(async (api) => {
        await requireRunAccess(api, runId, workspaceId)
        return api.runDetail(runId, { after })
    })

const controlRun = (runId: string, action: 'pause' | 'resume' | 'cancel', workspaceId?: string) =>
    call(async (api) => {
        await requireRunAccess(api, runId, workspaceId)
        if (action === 'pause') return api.pauseRun(runId)
        if (action === 'resume') return api.resumeRun(runId)
        return api.cancelRun(runId)
    })

const search = (id: string, body: Record<string, any>, workspaceId?: string) =>
    call(async (api) => {
        const pipeline = await requirePipeline(api, id, workspaceId)
        return api.searchPipeline(pipeline.id, body?.query, { k: body?.k, ctx: await contextFor(pipeline) })
    })

// Uploads go under the pipeline's workspace folder, after the pipeline passed the workspace check.
const upload = (id: string, readable: Readable, fileName: string, workspaceId?: string) =>
    call(async (api) => {
        const pipeline = await requirePipeline(api, id, workspaceId)
        return api.saveUpload(readable, fileName, { workspaceId, pipelineId: pipeline.id })
    })

const listSamples = () => call((api) => api.listSamples())

const importSample = (sampleId: string, workspaceId?: string) =>
    call(async (api) => {
        if (!workspaceId)
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'No active workspace. Sign in to a workspace and try again.')
        const sample = api.loadSample(sampleId)
        const repo = getRunningExpressApp().AppDataSource.getRepository(ChatFlow)
        let name = sample.name
        for (let n = 2; api.getPipelineByName(name, workspaceId); n += 1) name = `${sample.name} ${n}`
        const chatflow = repo.create({
            name,
            flowData: sample.flowData,
            type: EnumChatflowType.ETL,
            deployed: false,
            isPublic: false,
            workspaceId
        })
        const saved = await repo.save(chatflow)
        void flowVersionsService.recordFlowVersion(saved)
        await syncPipelineFromFlow(saved)
        return saved
    })

// The instance's default workspace for pipelines saved before every pipeline had one: CUTTLELY_ETL_DEFAULT_WORKSPACE_ID
// when it names an existing workspace, else the only workspace when there is exactly one. Otherwise null, and those
// pipelines stay visible to no workspace until their chat flow is saved again.
async function defaultWorkspaceId(): Promise<string | null> {
    const repo = getRunningExpressApp().AppDataSource.getRepository(Workspace)
    const configured = (process.env.CUTTLELY_ETL_DEFAULT_WORKSPACE_ID || '').trim()
    if (configured) {
        if (await repo.findOneBy({ id: configured })) return configured
        logger.warn(`[etl] CUTTLELY_ETL_DEFAULT_WORKSPACE_ID does not name a workspace; ignoring it`)
    }
    const found = await repo.find({ select: { id: true }, take: 2 })
    return found.length === 1 ? found[0].id : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One-time backfill: each pipeline with no workspace takes its chat flow's workspace, else the default one.
export async function backfillPipelineWorkspaces(api: any) {
    if (!api.unassignedPipelineCount()) return null
    const appServer = getRunningExpressApp()
    // Chat flow ids are UUIDs; Postgres rejects anything else in a uuid IN (...) list, and such a pipeline has no chat flow.
    const ids: string[] = api.unassignedPipelineIds().filter((id: string) => UUID.test(id))
    const flows = ids.length
        ? await appServer.AppDataSource.getRepository(ChatFlow).find({ select: { id: true, workspaceId: true }, where: { id: In(ids) } })
        : []
    const flowWorkspaces: Record<string, string> = {}
    for (const flow of flows) if (flow.workspaceId) flowWorkspaces[flow.id] = flow.workspaceId
    const counts = api.backfillWorkspaces({ flowWorkspaces, defaultWorkspaceId: await defaultWorkspaceId() })
    logger.info(
        `[etl] workspace backfill: ${counts.pipelines} pipeline(s) had no workspace; ${counts.fromFlow} took their chat flow's, ` +
            `${counts.fromDefault} the default workspace, ${counts.unassigned} left unassigned (visible to no workspace)`
    )
    if (counts.unassigned) {
        logger.warn(
            `[etl] ${counts.unassigned} pipeline(s) have no workspace and stay hidden from every workspace; set ` +
                'CUTTLELY_ETL_DEFAULT_WORKSPACE_ID to the workspace they belong to and restart, or save them again from their chat flow'
        )
    }
    return counts
}

const resumeEtlRuns = () => {
    etl()
        .then(async (api) => {
            await backfillPipelineWorkspaces(api).catch((error) =>
                logger.warn(`[etl] workspace backfill failed: ${getErrorMessage(error)}`)
            )
            const resumed = api.bootEtl()
            if (resumed.length) logger.info(`[etl] resuming ${resumed.length} interrupted run(s) from their checkpoints`)
            logger.info('[etl] scheduler started')
        })
        .catch((error) => logger.warn(`[etl] could not resume runs: ${getErrorMessage(error)}`))
}

const listSchedules = (id: string, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.listSchedules(id)
    })

const saveSchedule = (id: string, body: Record<string, any>, workspaceId?: string) =>
    call(async (api) => {
        await requirePipeline(api, id, workspaceId)
        return api.createSchedule(id, body || {})
    })

const updateSchedule = (scheduleId: string, body: Record<string, any>, workspaceId?: string) =>
    call(async (api) => {
        api.scheduleInWorkspace(scheduleId, workspaceId)
        return api.updateSchedule(scheduleId, body || {})
    })

const controlSchedule = (scheduleId: string, action: 'pause' | 'resume' | 'delete', workspaceId?: string) =>
    call(async (api) => {
        api.scheduleInWorkspace(scheduleId, workspaceId)
        if (action === 'pause') return api.pauseSchedule(scheduleId)
        if (action === 'resume') return api.resumeSchedule(scheduleId)
        return api.deleteSchedule(scheduleId)
    })

export default {
    validatePipelineFlow,
    syncPipelineFromFlow,
    deletePipeline,
    listPipelines,
    getPipelineDetail,
    getVersion,
    preview,
    startRun,
    listRuns,
    getRun,
    controlRun,
    search,
    upload,
    listSamples,
    importSample,
    resumeEtlRuns,
    listSchedules,
    saveSchedule,
    updateSchedule,
    controlSchedule
}
