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
import { safeHarnessName } from './apiAccess'
import { harnessCanvasDelete } from './canvasDelete'
import type { IHarnessCaller } from '../../Interface'
import { harnessNodeOptions } from '../../utils/apiKeyAccess'

// The server build targets CommonJS, and tsc rewrites import() into require().
// require() cannot load the ESM harness package, so keep a real dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

// Tests hand in their own harness modules. Null is the real package.
let harnessModuleOverride: ((file: string) => Promise<any>) | null = null
export function setHarnessModuleLoader(loader: ((file: string) => Promise<any>) | null) {
    harnessModuleOverride = loader
}

export async function loadHarness(file: string) {
    if (harnessModuleOverride) return harnessModuleOverride(file)
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
        const shown = !row.workspaceId && owner ? store.claimWorkspace(row.name, owner) || { ...row, workspaceId: owner } : row
        // An orphan stays on the list, marked, so it can be deleted from its card.
        visible.push((await isOrphan(shown)) ? { ...shown, orphaned: true } : shown)
    }
    return visible
}

const getHarness = async (name: string, workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    return (await isOrphan(harness)) ? { ...harness, orphaned: true } : harness
}

const saveHarness = async (body: Record<string, unknown>, workspaceId?: string | null) => {
    const ws = workspaceOf(workspaceId)
    try {
        const store = await loadHarness('store.mjs')
        const profile = await loadHarness('profile.mjs')
        const { overwrite, ...record } = body
        delete record.workspaceId
        const name = typeof record.name === 'string' ? record.name : ''
        // The name lock is held from the lookup through the compile, so a delete of the name cannot run in between
        // and leave this save writing over profiles it kept.
        const save = () => withProfileLock(() => saveUnderName(store, profile, record, overwrite, ws, name))
        if (!name) return await save()
        return await withNameLock(name, save)
    } catch (error) {
        if (error instanceof AppError) throw error
        const code = (error as { code?: string })?.code
        if (code === 'name_clash') throw nameClash(typeof body?.name === 'string' ? body.name : '')
        throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
}

type HarnessModule = Awaited<ReturnType<typeof loadHarness>>

function assertNoProfileConflicts(profile: HarnessModule, record: Record<string, unknown>, name: string) {
    let taken: string[] = []
    try {
        taken = profile.profileDestinationConflicts({ ...record, name })
    } catch (error) {
        // A roster that cannot be resolved (two specialists that land in one profile) would fail its compile after the
        // record is written, so it is refused here, before anything is written.
        throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
    if (taken.length) {
        throw new AppError(
            StatusCodes.CONFLICT,
            `Harness "${name}" was not saved: ${taken
                .map((entry) => `profiles/${entry}`)
                .join(', ')} belongs to another harness. Choose another harness or specialist name.`
        )
    }
}

// A record that belongs to another canvas is refused before it is claimed, as the store would refuse the save.
function assertSameCanvas(existing: { chatflowId?: unknown } | null, record: { chatflowId?: unknown } | null | undefined, name: string) {
    const had = typeof existing?.chatflowId === 'string' ? existing.chatflowId : ''
    const given = typeof record?.chatflowId === 'string' ? record.chatflowId : ''
    if (had && given && had !== given) {
        throw new AppError(StatusCodes.CONFLICT, `Harness name "${name}" is already used. Choose a different name.`)
    }
}

async function saveUnderName(
    store: HarnessModule,
    profile: HarnessModule,
    record: Record<string, unknown>,
    overwrite: unknown,
    ws: string,
    name: string
) {
    let existing = null
    if (name) {
        try {
            existing = store.getHarness(name)
        } catch (error) {
            throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
        }
    }
    // First, before anything is claimed or cleared: a refused save leaves the record and every profile as they were.
    // An update is checked like a new name.
    assertNoProfileConflicts(profile, record, name)
    if (existing) {
        const owner = await ownerOf(existing)
        // No resolved team is not this caller. The file, including its run history, stays as it is.
        if (!inWorkspace(owner, ws)) throw nameClash(name)
        assertSameCanvas(existing, record, name)
        if (!existing.workspaceId && owner) store.claimWorkspace(name, owner)
    } else if (name) {
        await clearStaleNameData(name, record as { specialists?: Array<{ name?: unknown }> })
    }
    // Again with no await between it, the save and the compile: two names whose specialists join to the same profile
    // (a + b--c, a--b + c) cannot both pass.
    assertNoProfileConflicts(profile, record, name)
    const saved = store.saveHarness({ ...record, workspaceId: ws }, { overwrite: Boolean(overwrite) || Boolean(existing) })
    profile.compileProfileCached(saved)
    warmHarnesses([saved.name])
    return saved
}

// A canvas save uses the chat flow's team. A name that already belongs to another team is refused before the file is written.
// `claiming` is a HARNESS canvas save that creates the record when the name is new.
export async function assertNameAvailable(
    name: string,
    workspaceId?: string | null,
    opts: { claiming?: boolean; readOnly?: boolean; record?: { specialists?: Array<{ name?: unknown }> } | null } = {}
) {
    const ws = workspaceOf(workspaceId)
    const store = await loadHarness('store.mjs')
    // A roster that would compile into another harness's profile is refused before anything is claimed or cleared.
    if (opts.record) assertNoProfileConflicts(await loadHarness('profile.mjs'), opts.record as Record<string, unknown>, name)
    let existing
    try {
        existing = store.getHarness(name)
    } catch {
        return
    }
    if (!existing) {
        if (opts.claiming && !opts.readOnly) await clearStaleNameData(name, opts.record)
        else await assertNotStaged(name)
        return
    }
    const owner = await ownerOf(existing)
    if (!inWorkspace(owner, ws)) throw nameClash(name)
    if (opts.readOnly) return
    assertSameCanvas(existing, opts.record as { chatflowId?: unknown } | null, name)
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

// The start script stops waiting for the gateway after CUTTLELY_GATEWAY_WAIT_SECONDS (180 by default) and then never
// starts Hermes, so /health is held for at most CUTTLELY_BOOT_RECOMPILE_HOLD_SECONDS (60 by default). Profiles still
// compiling after that finish while Hermes starts; the next boot finds anything left.
export async function recompileBeforeHermes(gateway: { holdGatewayHealth: () => () => void }): Promise<void> {
    const release = gateway.holdGatewayHealth()
    const seconds = Number(process.env.CUTTLELY_BOOT_RECOMPILE_HOLD_SECONDS)
    const holdMs = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000
    const cap = setTimeout(() => {
        logger.warn(`[harness] profile recompile still running after ${holdMs / 1000}s; the gateway answers health now`)
        release()
    }, holdMs)
    try {
        await recompileOutdatedHarnessProfiles()
    } catch (error) {
        logger.warn(`[harness] profile recompile at start failed: ${getErrorMessage(error)}`)
    } finally {
        clearTimeout(cap)
        release()
    }
}

// Each record is read again and compiled under its name lock and the profile lock (the order saves use), so a save,
// sync or delete that ran while this waited is what gets compiled, or the deleted record is skipped. One failure
// is logged and the rest still run.
export async function recompileOutdatedHarnessProfiles(): Promise<Array<{ name: string; status: string; error?: string }>> {
    const [profile, store] = await Promise.all([loadHarness('profile.mjs'), loadHarness('store.mjs')])
    let names: string[]
    try {
        names = store.listHarnessNames()
    } catch (error) {
        logger.warn(`[harness] profiles were not checked for an older compiler: ${getErrorMessage(error)}`)
        return []
    }
    const results: Array<{ name: string; status: string; error?: string }> = []
    for (const name of names) {
        const done = await withNameLock(name, () =>
            withProfileLock(async () => {
                let record
                try {
                    record = store.getHarness(name)
                } catch (error) {
                    // One unreadable record is reported; the others still run.
                    logger.warn(`[harness] ${name} profile was not recompiled: ${getErrorMessage(error)}`)
                    return [{ name, status: 'failed', error: getErrorMessage(error) }]
                }
                return record ? profile.recompileOutdatedProfiles([record], { log: logger }) : []
            })
        )
        results.push(...done)
    }
    return results
}

// Registers once. contextFor itself runs only when a server-initiated harness run asks for options.
function configureRuntime(): Promise<void> {
    if (!runtimeConfigured) {
        runtimeConfigured = loadHarness('run.mjs')
            .then(async (engine) => {
                engine.configureHarnessRuntime({ contextFor })
                // Before the gateway answers: the start script launches Hermes only once /health answers, and Hermes
                // reads each profile's config.yaml from disk. A compile binds the listener, so /health is held meanwhile.
                const gateway = await loadHarness('gateway.mjs')
                await recompileBeforeHermes(gateway)
                await gateway.startGateway()
                // Logs (or, with CUTTLELY_HARNESS_ORPHAN_SWEEP=delete, removes) profiles whose harness was deleted.
                const cleanup = await loadHarness('cleanup.mjs')
                await cleanup.sweepOrphanHarnessProfiles().catch((error: unknown) => {
                    logger.warn(`[harness] orphan profile sweep failed: ${getErrorMessage(error)}`)
                })
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

// Tests replace these to make a step fail, or to stand in for the chat flow delete.
export const harnessDeleteHooks = {
    removeSchedule: async (name: string): Promise<unknown> => (await loadHarness('schedule.mjs')).deleteSchedule(name),
    // The chat flow service registers its delete when it loads, so this module does not import it.
    deleteCanvas: async (chatflowId: string, workspaceId: string): Promise<unknown> => {
        if (!harnessCanvasDelete.run) {
            throw new AppError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                `The canvas ${chatflowId} could not be deleted: the chat flow service is not loaded.`
            )
        }
        return harnessCanvasDelete.run(chatflowId, workspaceId)
    }
}

type HarnessRow = { name: string; chatflowId?: string | null; workspaceId?: string | null; [key: string]: unknown }
type CanvasState = { state: 'present' | 'missing' | 'unknown'; workspaceId?: string | null; type?: string | null }

// The canvas row a harness was built from. 'unknown' is a failed lookup: callers never treat it as a missing canvas.
export function canvasRowQuery(dataSource: DataSource, chatflowId: string) {
    const table = 'chat_flow'
    const column = (name: string) => `${quoteIdent(dataSource, table)}.${quoteIdent(dataSource, name)}`
    return dataSource
        .createQueryBuilder()
        .select(column('id'), 'id')
        .addSelect(column('workspaceId'), 'workspaceId')
        .addSelect(column('type'), 'type')
        .from(table, table)
        .where(`${column('id')} = :id`, { id: chatflowId })
}

export const harnessCanvasLookup = {
    find: async (chatflowId: string): Promise<CanvasState> => {
        try {
            const row = await canvasRowQuery(getRunningExpressApp().AppDataSource, chatflowId).getRawOne()
            if (!row) return { state: 'missing' }
            const ws = row.workspaceId ?? row.workspaceid
            return { state: 'present', workspaceId: typeof ws === 'string' && ws ? ws : null, type: row.type ?? null }
        } catch (error) {
            logger.warn(`[harness] canvas lookup failed: ${getErrorMessage(error)}`)
            return { state: 'unknown' }
        }
    }
}

async function canvasState(record: { chatflowId?: string | null }): Promise<CanvasState | null> {
    const chatflowId = typeof record?.chatflowId === 'string' ? record.chatflowId : ''
    if (!UUID.test(chatflowId)) return null
    return harnessCanvasLookup.find(chatflowId)
}

// A harness built on a canvas whose canvas row is gone. A harness saved through the API has no canvas and is never an orphan.
async function isOrphan(record: { chatflowId?: string | null }): Promise<boolean> {
    return (await canvasState(record))?.state === 'missing'
}

// Key lists and the schedule go before the file, and a failure keeps the harness: a later harness with this name
// must not inherit the old key grants or the old owner's schedule. The file holds the roster, specialists and playbooks.
async function removeHarnessRecord(name: string, workspaceId: string) {
    // Gateway tokens first: when revocation fails, nothing of the harness is removed.
    if (!(await revokeRuntimeTokens(name))) {
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Harness "${name}" was not deleted, because its gateway tokens could not be revoked. Try again.`
        )
    }
    try {
        await removeRevokedHarness(name, workspaceId)
    } catch (error) {
        await reopenRuntimeTokens(name)
        throw error
    }
}

async function removeRevokedHarness(name: string, workspaceId: string) {
    try {
        const { removeHarnessFromKeyLists } = await import('./apiAccess')
        await removeHarnessFromKeyLists(workspaceId, name)
    } catch (error) {
        logger.warn(`[harness] ${name} was not deleted: removing it from API key lists failed: ${getErrorMessage(error)}`)
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Harness "${name}" was not deleted, because it could not be removed from API key lists. Try again.`
        )
    }
    try {
        await harnessDeleteHooks.removeSchedule(name)
    } catch (error) {
        logger.warn(`[harness] ${name} was not deleted: removing its schedule failed: ${getErrorMessage(error)}`)
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Harness "${name}" was not deleted, because its schedule could not be removed. Try again.`
        )
    }
    // Revokes the harness gateway tokens, removes the store file, then its runtime profile and specialist profiles.
    const cleanup = await loadHarness('cleanup.mjs')
    try {
        await cleanup.deleteHarnessAndProfiles(name, { revoked: true })
    } catch (error) {
        logger.warn(`[harness] ${name} was not deleted: ${getErrorMessage(error)}`)
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Harness "${name}" was not deleted, because its gateway tokens could not be revoked. Try again.`
        )
    }
}

// Run history and stored results of a deleted harness. Best effort: a leftover run row is not readable once the
// harness is gone, because every run route needs the harness first.
export async function purgeHarnessRuns(names: string[]) {
    if (!names.length) return
    try {
        const lock = await loadHarness('lock.mjs')
        lock.immediate((db: { prepare: (sql: string) => { all: (...a: unknown[]) => any[]; run: (...a: unknown[]) => unknown } }) => {
            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_history', 'run_results')")
                .all()
                .map((row: { name: string }) => row.name)
            for (const table of tables) {
                for (const name of names) db.prepare(`DELETE FROM ${table} WHERE harness_name = ?`).run(name)
            }
        })
    } catch (error) {
        logger.warn(`[harness] run history cleanup for ${names.join(', ')} failed: ${getErrorMessage(error)}`)
    }
}

const STAGED = '.json.deleting'

async function storeDir(): Promise<string> {
    const { harnessStoreDir } = await loadHarness('paths.mjs')
    return harnessStoreDir()
}

// A name that has no harness record yet. A schedule or run rows left under it by an earlier delete whose cleanup
// failed are cleared first, so a new harness, possibly in another team, never sees the old team's history or schedule.
// A failure refuses the save.
// A staged canvas delete still holds the name until its transaction ends: it may roll back and need it again.
async function assertNotStaged(name: string) {
    if (fs.existsSync(path.join(await storeDir(), `${name}${STAGED}`))) {
        throw new AppError(StatusCodes.CONFLICT, `Harness name "${name}" is being deleted. Try again in a moment.`)
    }
}

// One writer per harness name in this process: a canvas delete holds the name from staging until its commit or
// restore, and a canvas sync holds it from the name check through the record write, so the two never interleave.
const nameLocks = new Map<string, Promise<void>>()
export async function acquireNameLock(name: string): Promise<() => void> {
    const previous = nameLocks.get(name) || Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => held)
    nameLocks.set(name, tail)
    await previous
    let released = false
    return () => {
        if (released) return
        released = true
        release()
        if (nameLocks.get(name) === tail) nameLocks.delete(name)
    }
}

// A restart clears every in-process lock. Tests call this to stand in for one.
export function resetNameLocks() {
    nameLocks.clear()
}

// Profile directories are shared across names (a + b--c and a--b + c join to the same one), so every save holds this
// one lock from its conflict check through its compile. It is always taken after the name lock, never before, and
// nothing holding it waits for a name lock.
const PROFILE_LOCK = '\u0000profiles'

export function withProfileLock<T>(fn: () => Promise<T>): Promise<T> {
    return withNameLock(PROFILE_LOCK, fn)
}

export async function withNameLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = await acquireNameLock(name)
    try {
        return await fn()
    } finally {
        release()
    }
}

// A canvas sync: the name check and the record write hold the name lock. The check claims the name with the roster
// about to be written, so a delete that finished while this waited leaves nothing the write would compile over.
export async function syncUnderNameLock<T>(
    name: string,
    workspaceId: string | null | undefined,
    roster: { specialists?: Array<{ name?: unknown }> } | null,
    write: () => Promise<T>
): Promise<T> {
    return withNameLock(name, () =>
        withProfileLock(async () => {
            await assertNameAvailable(name, workspaceId, { claiming: true, record: roster })
            return write()
        })
    )
}

// record: the harness about to be saved, when known. The profile names it compiles into (fitted names of long names
// included) are checked for leftovers too.
export async function clearStaleNameData(name: string, record?: { specialists?: Array<{ name?: unknown }> } | null) {
    await assertNotStaged(name)
    // Profiles, sessions and specialist workspaces an earlier delete could not remove (a runtime that did not confirm
    // it stopped, a file that could not be removed) must not pass to the new harness. When they cannot be removed now,
    // the save is refused.
    let leftover: string[] = []
    try {
        const cleanup = await loadHarness('cleanup.mjs')
        const expected: string[] = []
        if (Array.isArray(record?.specialists)) {
            const profile = await loadHarness('profile.mjs')
            for (const specialist of record!.specialists!) {
                try {
                    expected.push(profile.specialistProfileName(name, specialist?.name))
                } catch {
                    // A name that cannot get a profile fails the save later, with its own message.
                }
            }
        }
        const outcome = await cleanup.removeHarnessProfiles(name, { reason: 'name saved again', expected })
        leftover = outcome?.error ? ['(error)'] : outcome?.kept || []
    } catch (error) {
        logger.warn(`[harness] leftover profiles of ${name} could not be removed: ${getErrorMessage(error)}`)
        leftover = ['(error)']
    }
    if (leftover.length) {
        throw new AppError(
            StatusCodes.SERVICE_UNAVAILABLE,
            `Harness "${name}" was not saved, because profiles left by an earlier harness with this name could not be removed. Try again.`
        )
    }
    try {
        await harnessDeleteHooks.removeSchedule(name)
        const lock = await loadHarness('lock.mjs')
        lock.immediate((db: { prepare: (sql: string) => { all: (...a: unknown[]) => any[]; run: (...a: unknown[]) => unknown } }) => {
            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_history', 'run_results')")
                .all()
                .map((row: { name: string }) => row.name)
            for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE harness_name = ?`).run(name)
        })
    } catch (error) {
        logger.warn(`[harness] stale data under ${name} could not be cleared: ${getErrorMessage(error)}`)
        throw new AppError(
            StatusCodes.SERVICE_UNAVAILABLE,
            `Harness "${name}" was not saved, because data left by an earlier harness with this name could not be cleared. Try again.`
        )
    }
}

// Moves a staged record back without ever replacing a record saved under the name since. COPYFILE_EXCL fails when one exists.
function putBack(from: string, to: string) {
    try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
    } catch (error) {
        if ((error as { code?: string })?.code !== 'EEXIST') throw error
        logger.warn(`[harness] ${path.basename(to)} was saved again while its delete was pending; the staged copy is dropped`)
    }
    fs.rmSync(from, { force: true })
}

type KeyListManager = Parameters<typeof import('./apiAccess').removeHarnessFromKeyLists>[2]

/**
 * The cascade from a HARNESS canvas delete. The chat flow delete calls this inside its database transaction, after the
 * canvas row delete, with that transaction's manager:
 * - API key grants are removed through the same manager, so they commit or roll back with the canvas.
 * - Each record file is moved aside to `<name>.json.deleting`, not removed. `restore` moves it back when the transaction
 *   fails; `commit` removes it after the transaction commits. A process that stops in between leaves the staged file,
 *   and the startup cleanup puts it back when the canvas is still there or removes it when the canvas is gone.
 * - The schedule and run history are in the harness database, outside the transaction. `commit` removes them, and a
 *   later harness with the same name clears anything left (clearStaleNameData).
 */
export async function removeHarnessesForCanvas(chatflowId: string, workspaceId: string, manager?: KeyListManager) {
    const store = await loadHarness('store.mjs')
    const fromCanvas = (row: HarnessRow | null | undefined) =>
        Boolean(row) && row!.chatflowId === chatflowId && (!row!.workspaceId || row!.workspaceId === workspaceId)
    let rows: HarnessRow[] = store.listHarnesses().filter(fromCanvas)
    const dir = await storeDir()
    const staged: string[] = []
    const releases: Array<() => void> = []
    for (const row of rows) releases.push(await acquireNameLock(row.name))
    // Read again under the locks: while this waited, a record may have been deleted, or replaced by a harness of another
    // canvas or team, which this cascade must not touch.
    rows = rows.filter((row) => fromCanvas(store.getHarness(row.name)))
    const releaseAll = () => releases.forEach((release) => release())
    const putAllBack = () => {
        for (const name of staged) {
            const from = path.join(dir, `${name}${STAGED}`)
            if (fs.existsSync(from)) putBack(from, path.join(dir, `${name}.json`))
        }
    }
    const revokedNames: string[] = []
    const reopenAll = async () => {
        for (const name of revokedNames) await reopenRuntimeTokens(name)
    }
    const restore = async () => {
        try {
            putAllBack()
        } finally {
            releaseAll()
            await reopenAll()
        }
    }
    // Gateway tokens before anything in the canvas transaction: a failure throws, so the canvas delete rolls back
    // with every grant, record, schedule and run still in place.
    for (const row of rows) {
        if (!(await revokeRuntimeTokens(row.name))) {
            releaseAll()
            await reopenAll()
            throw new AppError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                `Harness "${row.name}" was not deleted, because its gateway tokens could not be revoked. Try again.`
            )
        }
        revokedNames.push(row.name)
    }
    try {
        const { removeHarnessFromKeyLists } = await import('./apiAccess')
        for (const row of rows) {
            await removeHarnessFromKeyLists(row.workspaceId || workspaceId, row.name, manager)
            fs.renameSync(path.join(dir, `${row.name}.json`), path.join(dir, `${row.name}${STAGED}`))
            staged.push(row.name)
        }
    } catch (error) {
        await restore()
        throw error
    }
    // The name locks stay held until every profile, schedule and run of the deleted names is gone, so a canvas sync
    // cannot save the name again halfway through the cleanup.
    const commit = async () => {
        try {
            const finished: string[] = []
            for (const name of staged) {
                // Tokens first: when revocation fails the staged record, schedule and runs stay; the startup settle retries.
                if (!(await revokeRuntimeTokens(name))) continue
                fs.rmSync(path.join(dir, `${name}${STAGED}`), { force: true })
                await removeRuntimeProfiles(name)
                // Stopping the runtime awaits: a record saved under the name meanwhile (outside the lock) owns the
                // schedule and runs now, so they stay.
                if (fs.existsSync(path.join(dir, `${name}.json`))) {
                    logger.warn(`[harness] ${name} was saved again during its delete; its schedule and runs are kept`)
                    continue
                }
                finished.push(name)
                await harnessDeleteHooks
                    .removeSchedule(name)
                    .catch((error: unknown) =>
                        logger.warn(`[harness] schedule cleanup for deleted ${name} failed: ${getErrorMessage(error)}`)
                    )
            }
            await purgeHarnessRuns(finished)
        } finally {
            releaseAll()
        }
    }
    return { names: [...staged], restore, commit }
}

// A delete that stopped after revokeRuntimeTokens: the harness stays and may register tokens again.
async function reopenRuntimeTokens(name: string) {
    try {
        const cleanup = await loadHarness('cleanup.mjs')
        cleanup.reopenHarness(name)
    } catch (error) {
        logger.warn(`[harness] could not reopen gateway tokens of ${name}: ${getErrorMessage(error)}`)
    }
}

// Revokes the gateway tokens of a harness being deleted. false (logged) when that failed: nothing is removed then.
async function revokeRuntimeTokens(name: string): Promise<boolean> {
    try {
        const cleanup = await loadHarness('cleanup.mjs')
        cleanup.revokeHarness(name)
        return true
    } catch (error) {
        logger.warn(`[harness] kept ${name}: revoking its gateway tokens failed: ${getErrorMessage(error)}`)
        return false
    }
}

// After the record file is gone: its runtime profile and specialist profiles. A failure is logged; the startup sweep
// reports what is left.
async function removeRuntimeProfiles(name: string) {
    try {
        const cleanup = await loadHarness('cleanup.mjs')
        await cleanup.removeHarnessProfiles(name, { revoked: true })
    } catch (error) {
        logger.warn(`[harness] runtime profiles of deleted ${name} were not removed: ${getErrorMessage(error)}`)
    } finally {
        await reopenRuntimeTokens(name)
    }
}

// Startup: finish or undo a canvas delete that stopped between staging a record and the end of its transaction.
async function settleStagedDeletes() {
    const dir = await storeDir()
    if (!fs.existsSync(dir)) return { restored: [] as string[], finished: [] as string[] }
    const restored: string[] = []
    const finished: string[] = []
    for (const entry of fs.readdirSync(dir).filter((item) => item.endsWith(STAGED))) {
        const file = path.join(dir, entry)
        const name = entry.slice(0, -STAGED.length)
        let row: HarnessRow
        try {
            row = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
            logger.warn(`[harness] staged delete ${entry} could not be read: ${getErrorMessage(error)}`)
            continue
        }
        const canvas = await canvasState(row)
        if (canvas?.state === 'present') {
            putBack(file, path.join(dir, `${name}.json`))
            restored.push(name)
        } else if (canvas?.state === 'missing') {
            // Under the name lock, like a delete: a save of the name waits until the cleanup is over, and a record
            // saved under the name before it took the lock keeps its schedule and runs.
            const done = await withNameLock(name, async () => {
                if (!(await revokeRuntimeTokens(name))) return false
                fs.rmSync(file, { force: true })
                await removeRuntimeProfiles(name)
                if (fs.existsSync(path.join(dir, `${name}.json`))) {
                    logger.warn(`[harness] ${name} was saved again during its delete; its schedule and runs are kept`)
                    return false
                }
                await harnessDeleteHooks.removeSchedule(name).catch(() => undefined)
                await purgeHarnessRuns([name])
                return true
            })
            if (done) finished.push(name)
        }
    }
    return { restored, finished }
}

/**
 * The card delete. A harness with its canvas goes through the chat flow delete, which removes the canvas, its messages
 * and the harness record in one transaction. A harness without a canvas (saved through the API, or an orphan whose
 * canvas is already gone) is removed directly.
 */
const deleteHarness = async (name: string, workspaceId?: string | null) => {
    const harness = await requireHarness(name, workspaceId)
    const ws = harness.workspaceId || workspaceOf(workspaceId)
    const canvas = await canvasState(harness)
    if (canvas?.state === 'unknown') {
        throw new AppError(
            StatusCodes.SERVICE_UNAVAILABLE,
            `Harness "${name}" was not deleted, because its canvas could not be read. Try again.`
        )
    }
    const store = await loadHarness('store.mjs')
    // A record under the name that is not the one this delete started with was saved since, and is left alone.
    const replaced = () => {
        const current = store.getHarness(name)
        return (
            Boolean(current) &&
            (current.chatflowId !== harness.chatflowId ||
                (current.workspaceId || ws) !== ws ||
                // Deleted and saved again under the same name and team: a new record, with its own creation time.
                (current.createdAt || '') !== (harness.createdAt || ''))
        )
    }
    if (canvas?.state === 'present' && canvas.type === 'HARNESS' && canvas.workspaceId === ws) {
        // The cascade removes the record, its profiles and its runs under the name lock.
        await harnessDeleteHooks.deleteCanvas(harness.chatflowId, ws)
        if (replaced()) return { name, deleted: true }
    }
    // The name lock is held through the record, profile and run cleanup, so a canvas sync cannot save the name midway.
    return withNameLock(name, async () => {
        if (replaced()) return { name, deleted: true }
        if (store.getHarness(name)) await removeHarnessRecord(name, ws)
        // Stopping the runtime awaits: a record saved meanwhile owns the run history under the name now.
        if (!store.getHarness(name)) await purgeHarnessRuns([name])
        return { name, deleted: true }
    })
}

/**
 * Startup cleanup for harness records left behind by canvas deletes made before the cascade existed. Only a canvas
 * lookup that answered "no such row" counts; a failed lookup leaves the record alone. Running it again finds nothing.
 */
export async function removeOrphanHarnesses() {
    const settled = await settleStagedDeletes()
    if (settled.restored.length) logger.info(`[harness] restored ${settled.restored.join(', ')}: the canvas delete did not finish`)
    const store = await loadHarness('store.mjs')
    const removed: string[] = []
    for (const row of store.listHarnesses() as HarnessRow[]) {
        if (!(await isOrphan(row))) continue
        try {
            const owner = await ownerOf(row)
            // Checked again under the lock: while this waited, another delete may have finished and a canvas sync saved
            // a new harness under the name, which this sweep must not touch.
            const done = await withNameLock(row.name, async () => {
                const current = store.getHarness(row.name) as HarnessRow | undefined
                if (!current || current.chatflowId !== row.chatflowId || (current.workspaceId || '') !== (row.workspaceId || ''))
                    return false
                if (!(await isOrphan(current))) return false
                await removeHarnessRecord(row.name, owner || '')
                return true
            })
            if (!done) continue
            removed.push(row.name)
        } catch (error) {
            logger.warn(`[harness] orphan ${row.name} was kept: ${getErrorMessage(error)}`)
        }
    }
    // A name saved again while its runtime was shutting down keeps its run history.
    await purgeHarnessRuns(removed.filter((name) => !store.getHarness(name)))
    if (removed.length) logger.info(`[harness] removed ${removed.length} harness(es) whose canvas was deleted: ${removed.join(', ')}`)
    return { removed: [...settled.finished, ...removed] }
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
    if (code === 'name_clash' || code === 'name_taken') return new AppError(StatusCodes.CONFLICT, message)
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

// apiKeyId null is a signed-in person, who sees every run. A key sees only the runs it started.
type CallerScope = { apiKeyId?: string | null }

const listRuns = async (name: string, workspaceId?: string | null, scope: CallerScope = {}) => {
    await requireHarness(name, workspaceId)
    const history = await loadHarness('history.mjs')
    return history.listRuns(name, { limit: 50, apiKeyId: scope.apiKeyId ?? null })
}

const getRun = async (name: string, runId: string, workspaceId?: string | null, scope: CallerScope = {}) => {
    await requireHarness(name, workspaceId)
    const history = await loadHarness('history.mjs')
    const run = history.getRun(name, runId, { apiKeyId: scope.apiKeyId ?? null })
    if (!run) {
        throw new AppError(StatusCodes.NOT_FOUND, `Run ${runId} was not found.`)
    }
    return run
}

// A harness route acts for a person or an API key. Anything else, including no caller, is refused before the harness is read.
function assertRouteCaller(name: string, caller: IHarnessCaller | undefined): asserts caller is IHarnessCaller {
    if (caller?.via === 'session') return
    if (caller?.via === 'api_key' && typeof caller.apiKeyId === 'string' && caller.apiKeyId && Array.isArray(caller.harnesses)) {
        if (caller.harnesses.includes(name)) return
        throw new AppError(StatusCodes.FORBIDDEN, `This API key may not run harness "${safeHarnessName(name)}".`)
    }
    throw new AppError(StatusCodes.FORBIDDEN, 'A harness run needs a signed-in person or an API key.')
}

function callerKeyId(caller: IHarnessCaller): string | null {
    return caller.via === 'api_key' ? caller.apiKeyId : null
}

const assertRunRequest = async (
    name: string,
    body: Record<string, unknown>,
    workspaceId: string | null | undefined,
    caller: IHarnessCaller | undefined
) => {
    assertRouteCaller(name, caller)
    const scope: CallerScope = { apiKeyId: callerKeyId(caller) }
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
        // A chat's turns are the context of the next one, so another caller's chat is not continued.
        const history = await loadHarness('history.mjs')
        if (history.chatBelongsToOtherCaller(harness.name, rawChatId, scope.apiKeyId ?? null)) {
            throw new AppError(StatusCodes.FORBIDDEN, 'That chatId belongs to another caller. Use a new chatId.')
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
        // Who the run acts for. An API key's id is stored on the history row.
        caller: IHarnessCaller
    }
) => {
    const prepared = await assertRunRequest(name, body, opts.workspaceId, opts.caller)
    const apiKeyId = callerKeyId(opts.caller)
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
    const flowOptions: Record<string, unknown> = { ...(runtime?.flowOptions || {}), ...harnessNodeOptions(opts.caller) }
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
            apiKeyId: apiKeyId || undefined,
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
        caller: IHarnessCaller
        // Counts the run as in progress until it settles, so a restart or shutdown waits for it.
        track?: <T>(run: Promise<T>) => Promise<T>
        onSettled?: (outcome: { runId: string; status: string; error?: unknown }) => void
    }
) => {
    // Counted before the first await: a caller that checked for a drain just before this call is then waited for by a
    // drain that begins during the awaits below, instead of the drain seeing nothing in progress.
    let release = () => {}
    if (opts.track) void opts.track(new Promise<void>((resolve) => (release = resolve)))
    let running: ReturnType<typeof startRun>
    let prepared: Awaited<ReturnType<typeof assertRunRequest>>
    let runId: string
    let chatId: string
    let history: Awaited<ReturnType<typeof loadHarness>>
    try {
        prepared = await assertRunRequest(name, body, opts.workspaceId, opts.caller)
        const apiKeyId = callerKeyId(opts.caller)
        const source = opts.source || 'api'
        chatId = typeof body?.chatId === 'string' && body.chatId ? prepared.chatId : `${source}-${randomUUID()}`
        history = await loadHarness('history.mjs')
        const queued = history.queueHarnessRun({
            name: prepared.harness.name,
            chatId,
            source,
            input: prepared.question,
            apiKeyId
        })
        if (!queued?.id) throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'The run could not be recorded.')
        runId = queued.id
        running = startRun(
            name,
            { ...body, question: prepared.question, chatId },
            { source, workspaceId: opts.workspaceId, runId, caller: opts.caller }
        )
    } catch (error) {
        release()
        throw error
    }
    void running
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
        .finally(release)
    return { runId, harness: prepared.harness.name as string, chatId, status: 'queued' as const }
}

const FINISHED = new Set(['succeeded', 'completed_with_errors', 'failed', 'cancelled'])

const getRunResult = async (name: string, runId: string, workspaceId?: string | null, scope: CallerScope = {}) => {
    const run = await getRun(name, runId, workspaceId, scope)
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

// A run left queued or running when its process stopped can never finish. Another process, an external worker, or a
// second server on the same data, may still own a newer row, so in every queue mode only rows that started before the
// turn lock time (plus 15 seconds) are closed. A lock time of 0 never expires, and then nothing is closed.
// A row that began shortly before this start is left at first, and nothing else would ever close it in inline mode,
// so a second pass runs once the lock time (plus 15 seconds) has passed and closes rows that began before this start.
const closeInterruptedRuns = async (opts: { schedule?: (run: () => void, delayMs: number) => void } = {}): Promise<number> => {
    const processStart = Date.now()
    try {
        const history = await loadHarness('history.mjs')
        const lock = await loadHarness('lock.mjs')
        const ttl = Number(lock.lockTtlMs())
        if (!Number.isFinite(ttl) || ttl <= 0) return 0
        const closed = history.interruptOpenRuns({ before: processStart - (ttl + 15000) })
        if (closed) logger.info(`[harness] closed ${closed} run(s) left open by an earlier process`)
        const schedule = opts.schedule ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs).unref())
        schedule(() => {
            try {
                const late = history.interruptOpenRuns({ before: processStart })
                if (late) logger.info(`[harness] closed ${late} run(s) an earlier process left open just before this start`)
            } catch (error) {
                logger.warn(`[harness] open runs were not closed: ${getErrorMessage(error)}`)
            }
        }, ttl + 15000)
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

// The question is shown redacted, the same way run history stores it. An API key sees the owner's name only.
export const SCHEDULE_START_STALE_MS = 60 * 1000

export async function presentSchedule(
    schedule: Record<string, any> | null,
    view: { apiKeyCaller?: boolean } = {},
    now = Date.now()
): Promise<{ schedule: Record<string, unknown> | null }> {
    if (!schedule) return { schedule: null }
    const { workspaceId: _workspaceId, ownerId, ...rest } = schedule
    const trace = await loadHarness('trace.mjs')
    rest.question = trace.redactSecrets(String(rest.question || ''))
    // A claim that never reached a run (the process stopped between the claim and the start) stays `starting`.
    // The start takes a moment, so after a minute it is shown as failed. The next due time runs as usual.
    const claimedAt = Date.parse(String(rest.updatedAt || ''))
    if (rest.lastResult === 'starting' && Number.isFinite(claimedAt) && now - claimedAt > SCHEDULE_START_STALE_MS) {
        rest.lastResult = 'failed'
        rest.lastReason = 'The run did not start. The server may have stopped while it was starting this due time.'
    }
    // A run cut off by a restart never reported back to the schedule. The run history row has its outcome.
    if (rest.lastResult === 'running' && rest.lastRunId) {
        const history = await loadHarness('history.mjs')
        const status = history.getRun(rest.harness, rest.lastRunId)?.status
        if (status && status !== 'running' && status !== 'queued') rest.lastResult = status
    }
    const owner = await ownerSummary(ownerId)
    return { schedule: { ...rest, owner: view.apiKeyCaller ? { name: owner.name } : owner } }
}

const getHarnessSchedule = async (name: string, workspaceId?: string | null, view: { apiKeyCaller?: boolean } = {}) => {
    const harness = await requireHarness(name, workspaceId)
    return presentSchedule(await scheduleIn(harness.name, workspaceOf(workspaceId)), view)
}

const saveHarnessSchedule = async (name: string, body: Record<string, unknown>, opts: { workspaceId?: string | null; ownerId: string }) => {
    const harness = await requireHarness(name, opts.workspaceId)
    const schedules = await loadHarness('schedule.mjs')
    // The page shows the question redacted. Saving that text back unchanged keeps the stored question.
    const stored = await scheduleIn(harness.name, workspaceOf(opts.workspaceId))
    const input = { ...(body || {}) }
    if (stored && typeof input.question === 'string') {
        const trace = await loadHarness('trace.mjs')
        const shown = trace.redactSecrets(String(stored.question || ''))
        if (shown !== stored.question && input.question.trim() === shown.trim()) input.question = stored.question
    }
    try {
        const saved = schedules.saveSchedule(harness.name, input, {
            workspaceId: workspaceOf(opts.workspaceId),
            ownerId: opts.ownerId
        })
        return presentSchedule(saved)
    } catch (error) {
        throw httpHarnessError(error)
    }
}

// Resuming makes the person who resumes it the owner, the same as saving, so it runs with their permissions.
const setHarnessScheduleStatus = async (
    name: string,
    status: 'active' | 'paused',
    workspaceId: string | null | undefined,
    opts: { ownerId?: string } = {}
) => {
    const harness = await requireHarness(name, workspaceId)
    if (!(await scheduleIn(harness.name, workspaceOf(workspaceId)))) {
        throw new AppError(StatusCodes.NOT_FOUND, `Harness ${harness.name} has no schedule.`)
    }
    const schedules = await loadHarness('schedule.mjs')
    try {
        return presentSchedule(schedules.setScheduleStatus(harness.name, status, status === 'active' ? { ownerId: opts.ownerId } : {}))
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
    opts: { source?: string; signal?: AbortSignal; onEvent?: (event: { type: string }) => void; caller: IHarnessCaller }
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
    opts: { signal?: AbortSignal; caller: IHarnessCaller | undefined }
) => {
    // Another team's harness is a 404 before the canvas is read, so that file's credentials are not copied.
    // An API key that does not list this harness, or no caller at all, is refused here too.
    assertRouteCaller(chatflow.name, opts.caller)
    await assertRunRequest(chatflow.name, body, chatflow.workspaceId, opts.caller)
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
        caller: opts.caller,
        replay: true,
        record: { ...roster, tryId: randomBytes(8).toString('hex') }
    })
}

export default {
    startHarnessRuntime,
    backfillHarnessWorkspaces,
    removeOrphanHarnesses,
    removeHarnessesForCanvas,
    withNameLock,
    withProfileLock,
    recompileOutdatedHarnessProfiles,
    recompileBeforeHermes,
    syncUnderNameLock,
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
