import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { databaseEntities } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { orgIdForWorkspace } from '../etl'

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
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Harness module ${file} was not found.`)
}

const listHarnesses = async () => {
    const store = await loadHarness('store.mjs')
    return store.listHarnesses()
}

const getHarness = async (name: string) => {
    const store = await loadHarness('store.mjs')
    const harness = store.getHarness(name)
    if (!harness) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Harness ${name} was not found.`)
    }
    return harness
}

const saveHarness = async (body: Record<string, unknown>) => {
    try {
        const store = await loadHarness('store.mjs')
        const profile = await loadHarness('profile.mjs')
        const { overwrite, ...record } = body
        const existing = typeof record.name === 'string' ? store.getHarness(record.name) : null
        const saved = store.saveHarness(record, { overwrite: Boolean(overwrite) || Boolean(existing) })
        profile.compileProfileCached(saved)
        warmHarnesses([saved.name])
        return saved
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
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

const deleteHarness = async (name: string) => {
    const store = await loadHarness('store.mjs')
    store.deleteHarness(name)
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
    if (code === 'not_found') return new InternalFlowiseError(StatusCodes.NOT_FOUND, message)
    if (code === 'bad_name' || code === 'bad_session') return new InternalFlowiseError(StatusCodes.BAD_REQUEST, message)
    if (code === 'busy') return new InternalFlowiseError(StatusCodes.CONFLICT, message)
    if ((error as { harnessError?: boolean })?.harnessError) return new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, message)
    return new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, message)
}

const requireHarness = async (name: string) => {
    const store = await loadHarness('store.mjs')
    let harness
    try {
        harness = store.getHarness(name)
    } catch (error) {
        throw httpHarnessError(error)
    }
    if (!harness) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Harness ${name} was not found.`)
    }
    return harness
}

const listRuns = async (name: string) => {
    await requireHarness(name)
    const history = await loadHarness('history.mjs')
    return history.listRuns(name, { limit: 50 })
}

const getRun = async (name: string, runId: string) => {
    await requireHarness(name)
    const history = await loadHarness('history.mjs')
    const run = history.getRun(name, runId)
    if (!run) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Run ${runId} was not found.`)
    }
    return run
}

const assertRunRequest = async (name: string, body: Record<string, unknown>) => {
    const harness = await requireHarness(name)
    const question = questionOf(body || {})
    if (!question.trim()) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'A harness run needs a question.')
    }
    if (question.length > QUESTION_LIMIT) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `That question is longer than ${QUESTION_LIMIT} characters.`)
    }
    const rawChatId = body?.chatId
    if (rawChatId != null && rawChatId !== '') {
        if (typeof rawChatId !== 'string' || !CHAT_ID.test(rawChatId)) {
            throw new InternalFlowiseError(
                StatusCodes.BAD_REQUEST,
                'chatId must be 1–128 characters of letters, numbers, "_", ".", ":", or "-".'
            )
        }
    }
    return { harness, question, chatId: typeof rawChatId === 'string' && rawChatId ? rawChatId : `playground-${randomUUID()}` }
}

const startRun = async (
    name: string,
    body: Record<string, unknown>,
    opts: { source?: string; signal?: AbortSignal; onEvent?: (event: { type: string }) => void } = {}
) => {
    const prepared = await assertRunRequest(name, body)
    await configureRuntime()
    let runtime: { componentNodes?: unknown; flowOptions?: Record<string, unknown> } | null = null
    try {
        runtime = await contextFor(prepared.harness)
    } catch (error) {
        logger.warn(`[harness] ${name} playground context unavailable: ${getErrorMessage(error)}`)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Harness runtime context is not available.')
    }
    const engine = await loadHarness('run.mjs')
    const queued = engine.runQueuedHarness
    const run = process.env.CUTTLELY_HARNESS_QUEUE !== 'off' && typeof queued === 'function' ? queued : engine.runHarness
    let recorded: Record<string, unknown> | null = null
    try {
        const payload = await run({
            name,
            chatId: prepared.chatId,
            input: prepared.question,
            source: opts.source === 'playground' || opts.source === 'api' ? opts.source : 'api',
            componentNodes: runtime?.componentNodes,
            flowOptions: runtime?.flowOptions,
            onEvent: opts.onEvent,
            signal: opts.signal,
            onRecorded: (row: Record<string, unknown>) => {
                recorded = row
            }
        })
        if (!recorded) {
            const history = await loadHarness('history.mjs')
            recorded = history.listRuns(name, { limit: 20 }).find((row: { chatId?: string }) => row.chatId === prepared.chatId) || null
        }
        return { payload, run: recorded, chatId: prepared.chatId }
    } catch (error) {
        const wrapped = httpHarnessError(error) as InternalFlowiseError & { harnessRun?: unknown }
        wrapped.harnessRun = recorded
        throw wrapped
    }
}

export default {
    startHarnessRuntime,
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    warmHarnesses,
    listRuns,
    getRun,
    assertRunRequest,
    startRun
}
