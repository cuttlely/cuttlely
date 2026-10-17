import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { StatusCodes } from 'http-status-codes'
import { DataSource } from 'typeorm'
import { User, Workspace } from '../../database/entities/identity'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { requireWorkspaceId } from '../../identity/workspaceScope'
import { databaseEntities } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { orgIdForWorkspace } from '../etl'
import flowDraftsService from '../flow-drafts'
import { openHarnessRunTrace } from '../../metrics/tracing'
import { recordCompletedRun } from '../usage'
import { chatImages } from './chatImages'

// The server build targets CommonJS, and tsc rewrites import() into require().
// require() cannot load the ESM harness package, so keep a real dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

export async function loadHarness(file: string) {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', 'harness', file), path.join(dir, 'harness', file)]
        const candidate = candidates.find((item) => fs.existsSync(item))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Harness module ${file} was not found.`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function workspaceOf(workspaceId?: string | null): string {
    return requireWorkspaceId(workspaceId)
}

function notFound(name: string) {
    return new AppError(StatusCodes.NOT_FOUND, `Harness ${name} was not found.`)
}

function nameClash(name: string) {
    return new AppError(StatusCodes.CONFLICT, `Harness name "${name}" is already used in another team. Choose a different name.`)
}

// The install's default team for a harness saved before harnesses stored one. Same rule as a pipeline:
// CUTTLELY_ETL_DEFAULT_WORKSPACE_ID when it names a workspace, otherwise the only workspace.
async function defaultWorkspaceId(): Promise<string | null> {
    try {
        const repo = getRunningExpressApp().AppDataSource.getRepository(Workspace)
        const configured = (process.env.CUTTLELY_ETL_DEFAULT_WORKSPACE_ID || '').trim()
        if (configured) {
            if (await repo.findOneBy({ id: configured })) return configured
            logger.warn('[harness] CUTTLELY_ETL_DEFAULT_WORKSPACE_ID does not name a workspace; ignoring it')
        }
        const found = await repo.find({ select: { id: true }, take: 2 })
        return found.length === 1 ? found[0].id : null
    } catch (error) {
        logger.warn(`[harness] default workspace lookup failed: ${getErrorMessage(error)}`)
        return null
    }
}

function quoteIdent(dataSource: DataSource, name: string): string {
    const escape = dataSource.driver?.escape
    return typeof escape === 'function' ? escape.call(dataSource.driver, name) : `"${name}"`
}

// The canvas team column is quoted for the driver. Postgres folds an unquoted workspaceId to workspaceid,
// and the column was created quoted.
export function canvasTeamQuery(dataSource: DataSource, chatflowId: string) {
    const table = 'chat_flow'
    const column = (name: string) => `${quoteIdent(dataSource, table)}.${quoteIdent(dataSource, name)}`
    return dataSource
        .createQueryBuilder()
        .select(column('workspaceId'), 'workspaceId')
        .from(table, table)
        .where(`${column('id')} = :id`, { id: chatflowId })
}

// A stored team wins. A file with none takes its canvas's team, else the install default. A canvas lookup
// that throws leaves the file with no team: the default is not a substitute for a failed read.
async function ownerOf(record: { workspaceId?: string | null; chatflowId?: string | null }): Promise<string | null> {
    if (typeof record?.workspaceId === 'string' && record.workspaceId) return record.workspaceId
    const chatflowId = typeof record?.chatflowId === 'string' ? record.chatflowId : ''
    if (UUID.test(chatflowId)) {
        const found = await canvasWorkspace(chatflowId)
        if (found.failed) return null
        if (found.workspaceId) return found.workspaceId
    }
    return defaultWorkspaceId()
}

async function canvasWorkspace(chatflowId: string): Promise<{ failed: boolean; workspaceId: string | null }> {
    if (!UUID.test(chatflowId)) return { failed: false, workspaceId: null }
    try {
        const row = await canvasTeamQuery(getRunningExpressApp().AppDataSource, chatflowId).getRawOne()
        const id = row?.workspaceId ?? row?.workspaceid
        return { failed: false, workspaceId: typeof id === 'string' && id ? id : null }
    } catch (error) {
        logger.warn(`[harness] canvas workspace lookup failed: ${getErrorMessage(error)}`)
        return { failed: true, workspaceId: null }
    }
}

// The workspace comparison. Another team's harness is a 404, the same response as a missing name.
function inWorkspace(owner: string | null, workspaceId: string) {
    return Boolean(owner) && owner === workspaceId
}

const listHarnesses = async (workspaceId?: string | null) => {
    const ws = workspaceOf(workspaceId)
    const store = await loadHarness('store.mjs')
    const visible = []
    for (const row of store.listHarnesses()) {
        const owner = await ownerOf(row)
        if (!inWorkspace(owner, ws)) continue
        if (!row.workspaceId && owner) {
            visible.push(store.claimWorkspace(row.name, owner) || { ...row, workspaceId: owner })
        } else visible.push(row)
    }
    return visible
}

const getHarness = async (name: string, workspaceId?: string | null) => requireHarness(name, workspaceId)

const saveHarness = async (body: Record<string, unknown>, workspaceId?: string | null) => {
    const ws = workspaceOf(workspaceId)
    try {
        const store = await loadHarness('store.mjs')
        const profile = await loadHarness('profile.mjs')
        const { overwrite, ...record } = body
        delete record.workspaceId
        const name = typeof record.name === 'string' ? record.name : ''
        let existing = null
        if (name) {
            try {
                existing = store.getHarness(name)
            } catch (error) {
                throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
            }
        }
        if (existing) {
            const owner = await ownerOf(existing)
            // No resolved team is not this caller. The file, including its run history, stays as it is.
            if (!inWorkspace(owner, ws)) throw nameClash(name)
            if (!existing.workspaceId && owner) store.claimWorkspace(name, owner)
        }
        const saved = store.saveHarness({ ...record, workspaceId: ws }, { overwrite: Boolean(overwrite) || Boolean(existing) })
        profile.compileProfileCached(saved)
        warmHarnesses([saved.name])
        return saved
    } catch (error) {
        if (error instanceof AppError) throw error
        const code = (error as { code?: string })?.code
        if (code === 'name_clash') throw nameClash(typeof body?.name === 'string' ? body.name : '')
        throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
}

// A canvas save uses the chat flow's team. A name that already belongs to another team is refused before the file is written.
export async function assertNameAvailable(name: string, workspaceId?: string | null) {
    const ws = workspaceOf(workspaceId)
    const store = await loadHarness('store.mjs')
    let existing
    try {
        existing = store.getHarness(name)
    } catch {
        return
    }
    if (!existing) return
    const owner = await ownerOf(existing)
    if (!inWorkspace(owner, ws)) throw nameClash(name)
    if (!existing.workspaceId && owner) store.claimWorkspace(name, owner)
}

export async function backfillHarnessWorkspaces() {
    const store = await loadHarness('store.mjs')
    const rows = store.listHarnesses().filter((row: { workspaceId?: string }) => !row.workspaceId)
    if (!rows.length) return null
    let fromFlow = 0
    let fromDefault = 0
    let unassigned = 0
    for (const row of rows) {
        const found = await canvasWorkspace(typeof row.chatflowId === 'string' ? row.chatflowId : '')
        if (found.failed) {
            unassigned += 1
            continue
        }
        const fromCanvas = found.workspaceId
        const owner = fromCanvas || (await defaultWorkspaceId())
        if (!owner) {
            unassigned += 1
            continue
        }
        store.claimWorkspace(row.name, owner)
        if (fromCanvas) fromFlow += 1
        else fromDefault += 1
    }
    logger.info(
        `[harness] workspace backfill: ${rows.length} harness(es) had no team; ${fromFlow} took their canvas's team, ` +
            `${fromDefault} the default team, ${unassigned} left hidden from every team`
    )
    return { harnesses: rows.length, fromFlow, fromDefault, unassigned }
}

async function contextFor(record: { chatflowId?: string; workspaceId?: string | null } | null) {
    const appServer = getRunningExpressApp()
    const componentNodes = appServer.nodesPool.componentNodes
    return {
        componentNodes,
        flowOptions: {
            appDataSource: appServer.AppDataSource,
            databaseEntities,
            logger,
            componentNodes,
            chatflowid: record?.chatflowId,
            workspaceId: record?.workspaceId || undefined,
            orgId: await orgIdForWorkspace(record?.workspaceId),
            baseURL: process.env.CUTTLELY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
            cachePool: appServer.cachePool
        }
    }
}

let runtimeConfigured: Promise<void> | undefined

// Registers once. contextFor itself runs only when a server-initiated harness run asks for options.
function configureRuntime(): Promise<void> {
    if (!runtimeConfigured) {
        runtimeConfigured = loadHarness('run.mjs')
            .then(async (engine) => {
                engine.configureHarnessRuntime({ contextFor })
                const gateway = await loadHarness('gateway.mjs')
                await gateway.startGateway()
            })
            .catch((error) => {
                runtimeConfigured = undefined
                throw error
            })
    }
    return runtimeConfigured
}

// The server calls this once it listens. Importing this module starts nothing: CLI commands such as `pnpm user` load it
// too (oclif reads every command), and the running server already holds the gateway port.
const startHarnessRuntime = () =>
    void configureRuntime().catch((error) => logger.warn(`[harness] runtime context was not configured: ${getErrorMessage(error)}`))

// Runs in the background: a failed warm-up only means the next chat pays the cold start.
const warmHarnesses = (names?: string[]) => {
    if (process.env.CUTTLELY_WARM_HERMES === 'false') return
    configureRuntime()
        .then(() => loadHarness('run.mjs'))
        .then((engine) => engine.warmHarnessProfiles({ names }))
        .catch((error) => logger.warn(`[harness] Hermes warm-up failed: ${getErrorMessage(error)}`))
}

const deleteHarness = async (name: string, workspaceId?: string | null) => {
    await requireHarness(name, workspaceId)
    const store = await loadHarness('store.mjs')
    store.deleteHarness(name)
    try {
        const schedules = await loadHarness('schedule.mjs')
        schedules.deleteSchedule(name)
    } catch (error) {
        logger.warn(`[harness] ${name} schedule was not removed: ${getErrorMessage(error)}`)
    }
    return { name, deleted: true }
}

const QUESTION_LIMIT = 100000
const CHAT_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function questionOf(body: Record<string, unknown>) {
    if (typeof body?.question === 'string') return body.question
    if (typeof body?.input === 'string') return body.input
    return ''
}

function httpHarnessError(error: unknown) {
    const code = (error as { code?: string })?.code
    const message = getErrorMessage(error)
    if (code === 'not_found') return new AppError(StatusCodes.NOT_FOUND, message)
    if (code === 'name_clash') return new AppError(StatusCodes.CONFLICT, message)
    if (code === 'bad_name' || code === 'bad_session' || code === 'bad_schedule') return new AppError(StatusCodes.BAD_REQUEST, message)
    if (code === 'busy') return new AppError(StatusCodes.CONFLICT, message)
    if ((error as { harnessError?: boolean })?.harnessError) return new AppError(StatusCodes.UNPROCESSABLE_ENTITY, message)
    return new AppError(StatusCodes.INTERNAL_SERVER_ERROR, message)
}

const requireHarness = async (name: string, workspaceId?: string | null) => {
    const ws = workspaceOf(workspaceId)
    const store = await loadHarness('store.mjs')
    let harness
    try {
        harness = store.getHarness(name)
    } catch (error) {
        throw httpHarnessError(error)
    }
    if (!harness) throw notFound(name)
    const owner = await ownerOf(harness)
    if (!inWorkspace(owner, ws)) throw notFound(name)
    if (!harness.workspaceId && owner) {
        const claimed = store.claimWorkspace(name, owner)
        if (claimed) harness = claimed
    }
    return harness
}

const listRuns = async (name: string, workspaceId?: string | null) => {
    await requireHarness(name, workspaceId)
    const history = await loadHarness('history.mjs')
    return history.listRuns(name, { limit: 50 })
}

const getRun = async (name: string, runId: string, workspaceId?: string | null) => {
    await requireHarness(name, workspaceId)
    const history = await loadHarness('history.mjs')
    const run = history.getRun(name, runId)
    if (!run) {
        throw new AppError(StatusCodes.NOT_FOUND, `Run ${runId} was not found.`)
    }
    return run
}

const assertRunRequest = async (name: string, body: Record<string, unknown>, workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    const question = questionOf(body || {})
    if (!question.trim()) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'A harness run needs a question.')
    }
    if (question.length > QUESTION_LIMIT) {
        throw new AppError(StatusCodes.BAD_REQUEST, `That question is longer than ${QUESTION_LIMIT} characters.`)
    }
    const rawChatId = body?.chatId
    if (rawChatId != null && rawChatId !== '') {
        if (typeof rawChatId !== 'string' || !CHAT_ID.test(rawChatId)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'chatId must be 1–128 characters of letters, numbers, "_", ".", ":", or "-".')
        }
    }
    return { harness, question, chatId: typeof rawChatId === 'string' && rawChatId ? rawChatId : `playground-${randomUUID()}` }
}

function recordedId(row: Record<string, unknown> | null): string | undefined {
    return row && typeof row.id === 'string' ? row.id : undefined
}

// The queue worker copies the saved history id onto the job result. It is not part of the public payload.
function takeJobRunId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('runId' in payload)) return undefined
    const record = payload as { runId?: unknown }
    const runId = typeof record.runId === 'string' ? record.runId : undefined
    delete record.runId
    return runId
}

const startRun = async (
    name: string,
    body: Record<string, unknown>,
    opts: {
        source?: string
        signal?: AbortSignal
        onEvent?: (event: { type: string }) => void
        // Set only for the canvas and Try it. The external runs route leaves this unset and reads the saved harness.
        record?: Record<string, unknown>
        workspaceId?: string | null
        // Publish check. The try profile is still used. History, the session and captured analyst rows are not.
        replay?: boolean
        // An id already returned to the caller. The run history row uses it.
        runId?: string
    } = {}
) => {
    const prepared = await assertRunRequest(name, body, opts.workspaceId)
    await configureRuntime()
    let runtime: { componentNodes?: unknown; flowOptions?: Record<string, unknown> } | null = null
    try {
        runtime = await contextFor(prepared.harness)
    } catch (error) {
        logger.warn(`[harness] ${name} playground context unavailable: ${getErrorMessage(error)}`)
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Harness runtime context is not available.')
    }
    const engine = await loadHarness('run.mjs')
    const queued = engine.runQueuedHarness
    // A draft roster exists only in this process. The queue worker would load the saved harness instead.
    const run = !opts.record && process.env.CUTTLELY_HARNESS_QUEUE !== 'off' && typeof queued === 'function' ? queued : engine.runHarness
    const traceWorkspaceId = typeof prepared.harness.workspaceId === 'string' ? prepared.harness.workspaceId : undefined
    let harnessTrace: ReturnType<typeof openHarnessRunTrace> | undefined
    let recorded: Record<string, unknown> | null = null
    const flowOptions = { ...(runtime?.flowOptions || {}) }
    // The server context copies the harness file. The run compares the caller's team.
    if (typeof opts.workspaceId === 'string' && opts.workspaceId) flowOptions.workspaceId = opts.workspaceId
    try {
        // A cross-team refusal happens before a span is opened.
        if (typeof engine.assertHarnessWorkspace === 'function') engine.assertHarnessWorkspace(name, flowOptions, opts.record)
        harnessTrace = openHarnessRunTrace({
            name,
            workspaceId: traceWorkspaceId,
            question: prepared.question,
            replay: opts.replay === true,
            draft: Boolean(opts.record)
        })
        const payload = await run({
            name,
            chatId: prepared.chatId,
            input: prepared.question,
            source: opts.source === 'playground' || opts.source === 'api' || opts.source === 'schedule' ? opts.source : 'api',
            componentNodes: runtime?.componentNodes,
            flowOptions,
            onEvent: (event: { type: string }) => {
                harnessTrace?.event(event as Record<string, unknown>)
                opts.onEvent?.(event)
            },
            signal: opts.signal,
            record: opts.record,
            replay: opts.replay === true,
            runId: opts.runId,
            onRecorded: (row: Record<string, unknown>) => {
                recorded = row
            }
        })
        // An external worker writes history in its own process, so onRecorded does not run here.
        // The worker puts that saved id on the job result. Drop it before the response is returned.
        const jobRunId = takeJobRunId(payload)
        if (!recorded && jobRunId) recorded = { id: jobRunId }
        const runId = recordedId(recorded)
        harnessTrace?.finish({
            text: typeof (payload as { text?: unknown } | undefined)?.text === 'string' ? (payload as { text: string }).text : undefined,
            runId
        })
        // Public runs, a canvas draft try, and a publish-check replay all finish here.
        // startCanvasRun and replayCheck call startRun, so this is the only usage write.
        const workspaceId = prepared.harness.workspaceId
        if (workspaceId) {
            try {
                void recordCompletedRun(getRunningExpressApp().AppDataSource, {
                    workspaceId,
                    flowId: prepared.harness.name,
                    result: payload
                })
            } catch (error) {
                logger.warn(`[usage] harness token totals were not saved: ${getErrorMessage(error)}`)
            }
        }
        return { payload, run: recorded, chatId: prepared.chatId }
    } catch (error) {
        if (!recorded) {
            const carried = error && typeof error === 'object' ? (error as { runId?: unknown }).runId : undefined
            if (typeof carried === 'string') recorded = { id: carried }
        }
        if ((error as { code?: string }).code !== 'wrong_workspace') harnessTrace?.fail(error, { runId: recordedId(recorded) })
        const wrapped = httpHarnessError(error) as AppError & { harnessRun?: unknown }
        wrapped.harnessRun = recorded
        throw wrapped
    }
}

// Starts a run in the background and returns its id at once. The caller polls the run and then its result.
// The run goes through startRun, so tracing, token totals, and run history match a run that waits.
const startBackgroundRun = async (
    name: string,
    body: Record<string, unknown>,
    opts: {
        workspaceId: string
        source?: 'api' | 'schedule'
        onSettled?: (outcome: { runId: string; status: string; error?: unknown }) => void
    }
) => {
    const prepared = await assertRunRequest(name, body, opts.workspaceId)
    const source = opts.source || 'api'
    const chatId = typeof body?.chatId === 'string' && body.chatId ? prepared.chatId : `${source}-${randomUUID()}`
    const history = await loadHarness('history.mjs')
    const queued = history.queueHarnessRun({ name: prepared.harness.name, chatId, source, input: prepared.question })
    if (!queued?.id) throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'The run could not be recorded.')
    const runId: string = queued.id
    void startRun(name, { ...body, question: prepared.question, chatId }, { source, workspaceId: opts.workspaceId, runId })
        .then((outcome) => {
            try {
                history.saveRunResult(prepared.harness.name, runId, outcome.payload)
            } catch (error) {
                logger.warn(`[harness] ${name} result for ${runId} was not saved: ${getErrorMessage(error)}`)
            }
            opts.onSettled?.({ runId, status: 'finished' })
        })
        .catch((error) => {
            try {
                history.failQueuedRun(prepared.harness.name, runId, error)
            } catch (historyError) {
                logger.warn(`[harness] ${name} run ${runId} was not marked failed: ${getErrorMessage(historyError)}`)
            }
            logger.warn(`[harness] ${name} background run ${runId} failed: ${getErrorMessage(error)}`)
            opts.onSettled?.({ runId, status: 'failed', error })
        })
    return { runId, harness: prepared.harness.name as string, chatId, status: 'queued' as const }
}

const FINISHED = new Set(['succeeded', 'completed_with_errors', 'failed', 'cancelled'])

const getRunResult = async (name: string, runId: string, workspaceId?: string | null) => {
    const run = await getRun(name, runId, workspaceId)
    const history = await loadHarness('history.mjs')
    const finished = FINISHED.has(run.status)
    return {
        runId: run.id,
        harness: run.harness,
        status: run.status,
        finished,
        source: run.source,
        chatId: run.chatId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        latencyMs: run.latencyMs,
        tokens: run.tokens,
        error: run.error,
        result: finished ? history.getRunResult(name, runId) : null
    }
}

// A run left queued or running when the last process stopped can never finish. Inline and off runs belong to this
// process, so every open row is closed. External workers keep their rows until the lock time has passed.
const closeInterruptedRuns = async () => {
    try {
        const history = await loadHarness('history.mjs')
        const lock = await loadHarness('lock.mjs')
        const external =
            String(process.env.CUTTLELY_HARNESS_QUEUE || '')
                .trim()
                .toLowerCase() === 'external'
        const ttl = external ? Number(lock.lockTtlMs()) : 0
        if (external && !ttl) return 0
        const closed = history.interruptOpenRuns({ before: external ? Date.now() - (ttl + 15000) : Date.now() })
        if (closed) logger.info(`[harness] closed ${closed} run(s) left open by an earlier process`)
        return closed
    } catch (error) {
        logger.warn(`[harness] open runs were not closed: ${getErrorMessage(error)}`)
        return 0
    }
}

async function ownerSummary(ownerId: string) {
    try {
        const user = await getRunningExpressApp().AppDataSource.getRepository(User).findOneBy({ id: ownerId })
        return { id: ownerId, name: user?.name || null, email: user?.email || null }
    } catch {
        return { id: ownerId, name: null, email: null }
    }
}

// A schedule stored for the same name in another team is not this team's schedule.
async function scheduleIn(name: string, workspaceId: string) {
    const schedules = await loadHarness('schedule.mjs')
    const schedule = schedules.getSchedule(name)
    return schedule && schedule.workspaceId === workspaceId ? schedule : null
}

async function presentSchedule(schedule: Record<string, any> | null) {
    if (!schedule) return { schedule: null }
    const { workspaceId: _workspaceId, ownerId, ...rest } = schedule
    // A run cut off by a restart never reported back to the schedule. The run history row has its outcome.
    if (rest.lastResult === 'running' && rest.lastRunId) {
        const history = await loadHarness('history.mjs')
        const status = history.getRun(rest.harness, rest.lastRunId)?.status
        if (status && status !== 'running' && status !== 'queued') rest.lastResult = status
    }
    return { schedule: { ...rest, owner: await ownerSummary(ownerId) } }
}

const getHarnessSchedule = async (name: string, workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    return presentSchedule(await scheduleIn(harness.name, workspaceOf(workspaceId)))
}

const saveHarnessSchedule = async (name: string, body: Record<string, unknown>, opts: { workspaceId?: string | null; ownerId: string }) => {
    const harness = await requireHarness(name, opts.workspaceId)
    const schedules = await loadHarness('schedule.mjs')
    try {
        const saved = schedules.saveSchedule(harness.name, body || {}, {
            workspaceId: workspaceOf(opts.workspaceId),
            ownerId: opts.ownerId
        })
        return presentSchedule(saved)
    } catch (error) {
        throw httpHarnessError(error)
    }
}

const setHarnessScheduleStatus = async (name: string, status: 'active' | 'paused', workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    if (!(await scheduleIn(harness.name, workspaceOf(workspaceId)))) {
        throw new AppError(StatusCodes.NOT_FOUND, `Harness ${harness.name} has no schedule.`)
    }
    const schedules = await loadHarness('schedule.mjs')
    try {
        return presentSchedule(schedules.setScheduleStatus(harness.name, status))
    } catch (error) {
        throw httpHarnessError(error)
    }
}

const deleteHarnessSchedule = async (name: string, workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    if (!(await scheduleIn(harness.name, workspaceOf(workspaceId)))) {
        throw new AppError(StatusCodes.NOT_FOUND, `Harness ${harness.name} has no schedule.`)
    }
    const schedules = await loadHarness('schedule.mjs')
    schedules.deleteSchedule(harness.name)
    return { harness: harness.name, deleted: true }
}

// Canvas chat and Try it. The draft canvas when one exists, otherwise the Live canvas. The saved harness and its
// profile are not written. The try compiles under its own id and is removed when the run ends.
const startCanvasRun = async (
    chatflow: { id: string; name: string; type?: string | null; flowData: string; workspaceId: string },
    body: Record<string, unknown>,
    opts: { source?: string; signal?: AbortSignal; onEvent?: (event: { type: string }) => void } = {}
) => {
    const flowData = await flowDraftsService.flowDataForTestChat(chatflow)
    const sync = await loadHarness('sync-from-flow.mjs')
    const appServer = getRunningExpressApp()
    const roster = sync.rosterFromFlow({
        name: chatflow.name,
        chatflowId: chatflow.id,
        flowData,
        workspaceId: chatflow.workspaceId,
        componentNodes: appServer.nodesPool?.componentNodes
    })
    return await startRun(chatflow.name, body, {
        ...opts,
        workspaceId: chatflow.workspaceId,
        record: { ...roster, tryId: randomBytes(8).toString('hex') }
    })
}

// Publish check. Live and the draft each get their own try profile, the same one the canvas uses.
// Nothing is written to run history, the session, or the analyst capture for this chat.
const replayCheck = async (
    chatflow: { id: string; name: string; flowData: string; workspaceId: string },
    flowData: string,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {}
) => {
    // Another team's harness is a 404 before the canvas is read, so that file's credentials are not copied.
    await assertRunRequest(chatflow.name, body, chatflow.workspaceId)
    const sync = await loadHarness('sync-from-flow.mjs')
    const appServer = getRunningExpressApp()
    const roster = sync.rosterFromFlow({
        name: chatflow.name,
        chatflowId: chatflow.id,
        flowData,
        workspaceId: chatflow.workspaceId,
        componentNodes: appServer.nodesPool?.componentNodes
    })
    return await startRun(chatflow.name, body, {
        source: 'playground',
        signal: opts.signal,
        workspaceId: chatflow.workspaceId,
        replay: true,
        record: { ...roster, tryId: randomBytes(8).toString('hex') }
    })
}

export default {
    startHarnessRuntime,
    backfillHarnessWorkspaces,
    assertNameAvailable,
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    warmHarnesses,
    listRuns,
    getRun,
    assertRunRequest,
    startRun,
    startBackgroundRun,
    getRunResult,
    closeInterruptedRuns,
    getHarnessSchedule,
    saveHarnessSchedule,
    setHarnessScheduleStatus,
    deleteHarnessSchedule,
    startCanvasRun,
    replayCheck,
    chatImages
}
