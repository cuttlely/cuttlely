import { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { StatusCodes } from 'http-status-codes'
import { IsNull, Not } from 'typeorm'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { AuditType, safeRecordAudit } from '../../identity/auditLog'
import type { IHarnessCaller } from '../../Interface'
import { rateLimitClientKey } from '../../utils/rateLimit'
import logger from '../../utils/logger'

export const HARNESS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const HARNESS_ALLOWLIST_MAX = 200
const INVALID_NAME = '<invalid>'
/** Stands for a `harnessName` that is not text. No harness is named this, and no key lists it. */
export const INVALID_HARNESS_REFERENCE = INVALID_NAME

/** Runs started per minute per API key, or per person for a signed-in caller. */
export const HARNESS_RUN_START_LIMIT = 60
/** Status and result reads per minute, on the same key. */
export const HARNESS_RUN_READ_LIMIT = 600
const RATE_WINDOW_MS = 60 * 1000

interface Caller {
    id?: unknown
    apiKeyId?: unknown
    activeWorkspaceId?: unknown
    activeOrganizationId?: unknown
}

interface StoredKey {
    workspaceId?: string | null
    harnesses?: unknown
}

type KeyLookup = (id: string) => Promise<StoredKey | null | undefined>

let installedLookup: KeyLookup | null = null

/** Tests install a lookup. Production reads the apikey row. */
export function setHarnessKeyLookup(lookup: KeyLookup | null): void {
    installedLookup = lookup
}

// Loaded on first use: the route module is imported while the app and its data source are still being built.
async function storedKey(id: string): Promise<StoredKey | null | undefined> {
    if (installedLookup) return installedLookup(id)
    const { getDataSource } = await import('../../DataSource')
    const { ApiKey } = await import('../../database/entities/ApiKey')
    return getDataSource().getRepository(ApiKey).findOneBy({ id })
}

/**
 * A deleted harness leaves every key's list in that team, so a later harness with the same name is not granted.
 * One transaction: either every list drops the name or none does, and a failure reaches the caller.
 */
export async function removeHarnessFromKeyLists(workspaceId: string, name: string): Promise<number> {
    const { getDataSource } = await import('../../DataSource')
    const { ApiKey } = await import('../../database/entities/ApiKey')
    return getDataSource().transaction(async (manager) => {
        const repo = manager.getRepository(ApiKey)
        let changed = 0
        for (const key of await repo.findBy({ workspaceId })) {
            const list = harnessAllowlist(key.harnesses)
            if (!list.includes(name)) continue
            key.harnesses = list.filter((item) => item !== name)
            await repo.save(key)
            changed += 1
        }
        return changed
    })
}

/**
 * At startup: a flow bound to an API key runs its Harness cards under that key's list, so a card that names a harness
 * the key does not list is refused on every call. Each such pair is logged once so an operator can fix the list.
 */
export async function warnKeysMissingBoundHarnesses(): Promise<Array<{ chatflowId: string; apiKeyId: string; harness: string }>> {
    const found: Array<{ chatflowId: string; apiKeyId: string; harness: string }> = []
    try {
        const { getDataSource } = await import('../../DataSource')
        const { ApiKey } = await import('../../database/entities/ApiKey')
        const { ChatFlow } = await import('../../database/entities/ChatFlow')
        const dataSource = getDataSource()
        const bound = await dataSource.getRepository(ChatFlow).find({
            where: { apikeyid: Not(IsNull()) },
            select: ['id', 'apikeyid', 'workspaceId', 'flowData']
        })
        const lists = new Map<string, string[]>()
        for (const flow of bound) {
            const names = referencedHarnessNames(flow.flowData)
            const keyId = typeof flow.apikeyid === 'string' ? flow.apikeyid : ''
            if (!names.length || !keyId) continue
            let list = lists.get(`${keyId}:${flow.workspaceId}`)
            if (!list) {
                const key = await dataSource.getRepository(ApiKey).findOneBy({ id: keyId })
                list = key && key.workspaceId === flow.workspaceId ? harnessAllowlist(key.harnesses) : []
                lists.set(`${keyId}:${flow.workspaceId}`, list)
            }
            for (const name of names) {
                if (list.includes(name)) continue
                found.push({ chatflowId: flow.id, apiKeyId: keyId, harness: name })
                logger.warn(
                    `[harness] API key ${keyId} is bound to flow ${flow.id}, whose Harness card names ${safeHarnessName(name)}. ` +
                        "That harness is not on the key's list, so the card is refused when the flow runs. Add it to the key or change the card."
                )
            }
        }
    } catch (error) {
        logger.warn(`[harness] bound API keys were not checked: ${getErrorMessage(error)}`)
    }
    return found
}

function callerOf(req: Request): Caller {
    return (req.user || {}) as Caller
}

/** A name that is safe to write to an audit row or a log line. Anything else is recorded as `<invalid>`. */
export function safeHarnessName(value: unknown): string {
    return typeof value === 'string' && HARNESS_NAME.test(value) ? value : INVALID_NAME
}

/** The API gate builds an API-key caller without a user id. A signed-in person always has one. */
export function isApiKeyCaller(req: Request): boolean {
    const user = callerOf(req)
    return typeof user.id !== 'string' || !user.id
}

/** The calling key's id, or null for a signed-in person. */
export function callerApiKeyId(req: Request): string | null {
    if (!isApiKeyCaller(req)) return null
    const keyId = callerOf(req).apiKeyId
    return typeof keyId === 'string' && keyId ? keyId : ''
}

/** A stored or submitted list: harness names only, no duplicates, at most HARNESS_ALLOWLIST_MAX. */
export function harnessAllowlist(value: unknown): string[] {
    let raw = value
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw)
        } catch {
            return []
        }
    }
    if (!Array.isArray(raw)) return []
    const out: string[] = []
    for (const item of raw) {
        if (typeof item !== 'string' || !HARNESS_NAME.test(item) || out.includes(item)) continue
        out.push(item)
        if (out.length >= HARNESS_ALLOWLIST_MAX) break
    }
    return out
}

/** A create or update body. A missing field is an empty list. Anything that is not a list of names is a 400. */
export function parseHarnessAllowlist(value: unknown): string[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'harnesses must be an array of harness names.')
    }
    const bad = value.find((item) => !HARNESS_NAME.test(item))
    if (bad !== undefined) throw new AppError(StatusCodes.BAD_REQUEST, `"${String(bad).slice(0, 80)}" is not a harness name.`)
    const list = harnessAllowlist(value)
    if (new Set(value).size > HARNESS_ALLOWLIST_MAX) {
        throw new AppError(StatusCodes.BAD_REQUEST, `An API key can list at most ${HARNESS_ALLOWLIST_MAX} harnesses.`)
    }
    return list
}

/**
 * The harnesses the calling key may run, read from its row on each call. Null for a signed-in person.
 * A key whose row is gone or belongs to another team gets an empty list.
 */
export async function callerKeyHarnesses(req: Request): Promise<string[] | null> {
    const keyId = callerApiKeyId(req)
    if (keyId === null) return null
    if (!keyId) return []
    const key = await storedKey(keyId)
    if (!key || key.workspaceId !== callerOf(req).activeWorkspaceId) return []
    return harnessAllowlist(key.harnesses)
}

/** Who this request acts for. A key that the gate could not name gets an empty id, which every harness check refuses. */
export async function harnessCallerFor(req: Request): Promise<IHarnessCaller> {
    const keyId = callerApiKeyId(req)
    if (keyId === null) return { via: 'session' }
    return { via: 'api_key', apiKeyId: keyId, harnesses: (await callerKeyHarnesses(req)) || [] }
}

const MAX_REFERENCE_DEPTH = 64

/**
 * Every harness a chatflow or agentflow canvas names: a Harness card, an Agent's harness tool
 * (`agentSelectedToolConfig.harnessName`), or any other `harnessName` value at any depth. `malformed` is true when a
 * `harnessName` holds anything but a string, a string with surrounding whitespace, or sits deeper than the scan reads;
 * `''` and null mean no harness is chosen yet.
 */
export function harnessReferences(flowData: unknown): { names: string[]; malformed: boolean } {
    let parsed: unknown = flowData
    // Always parsed: a text search for "harnessName" misses a key written with JSON escapes, such as harness\u004eame.
    if (typeof flowData === 'string') {
        try {
            parsed = JSON.parse(flowData)
        } catch {
            return { names: [], malformed: false }
        }
    }
    const names = new Set<string>()
    let malformed = false
    const walk = (value: unknown, depth: number) => {
        if (!value || typeof value !== 'object') return
        if (depth > MAX_REFERENCE_DEPTH) {
            // Past the scan depth a name is not read, so a harnessName down there is refused, not ignored.
            // JSON.stringify writes every key plainly, so an escaped key is found too.
            try {
                if (JSON.stringify(value).includes('"harnessName"')) malformed = true
            } catch {
                malformed = true
            }
            return
        }
        if (Array.isArray(value)) {
            for (const item of value) walk(item, depth + 1)
            return
        }
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key !== 'harnessName') walk(item, depth + 1)
            else if (typeof item === 'string') {
                // The runtime does not trim, so " payroll " would be checked as payroll and then fail to run.
                if (item !== item.trim()) malformed = true
                else if (item) names.add(item)
            } else if (item !== null && item !== undefined) {
                // The runtime once turned ["payroll"] into "payroll" while this scan saw no name at all.
                malformed = true
            }
        }
    }
    walk(parsed, 0)
    return { names: [...names], malformed }
}

/**
 * The names for a key-list check. A malformed `harnessName` adds `<invalid>`, which is on no key's list, so every
 * key-list check refuses that canvas.
 */
export function referencedHarnessNames(flowData: unknown): string[] {
    const { names, malformed } = harnessReferences(flowData)
    return malformed ? [...names, INVALID_NAME] : names
}

/** Every save path, for a person or a key: a `harnessName` that is not a string is 400 and nothing is written. */
export function assertHarnessReferencesWellFormed(flowData: unknown): void {
    if (!harnessReferences(flowData).malformed) return
    throw new AppError(
        StatusCodes.BAD_REQUEST,
        'A harness name on this canvas is not plain text. Pick the harness again on each Harness card.'
    )
}

/** The first name this caller may not use, or null. A save with no caller, or a keyless flow's caller, may use none. */
export function harnessRefusedFor(caller: IHarnessCaller | undefined, names: string[]): string | null {
    if (!names.length || caller?.via === 'session') return null
    if (caller?.via !== 'api_key') return names[0]
    return names.find((name) => !caller.harnesses.includes(name)) ?? null
}

/** The save-side check every chatflow write path runs: create, update, import, draft, publish, roll back, restore. */
export function assertCallerMayUseHarnesses(caller: IHarnessCaller | undefined, names: string[]): void {
    const refused = harnessRefusedFor(caller, names)
    if (refused === null) return
    const shown = safeHarnessName(refused)
    if (caller?.via === 'api_key') {
        logger.warn(`[harness] API key ${caller.apiKeyId || 'unknown'} was refused a canvas that names harness ${shown}`)
        throw new AppError(StatusCodes.FORBIDDEN, `This API key may not use harness "${shown}".`)
    }
    throw new AppError(StatusCodes.FORBIDDEN, `Saving a canvas that names harness "${shown}" needs a signed-in person or an API key.`)
}

type StoredFlow = { id: string; name: string; type?: string | null; flowData?: string | null; apikeyid?: string | null }
type FlowLookup = (id: string, workspaceId: string) => Promise<StoredFlow | null | undefined>

let installedFlowLookup: FlowLookup | null = null

/** Tests install a lookup. Production reads the chat_flow row in the caller's team. */
export function setHarnessFlowLookup(lookup: FlowLookup | null): void {
    installedFlowLookup = lookup
}

async function storedFlow(id: string, workspaceId: string): Promise<StoredFlow | null | undefined> {
    if (installedFlowLookup) return installedFlowLookup(id, workspaceId)
    const { getDataSource } = await import('../../DataSource')
    const { ChatFlow } = await import('../../database/entities/ChatFlow')
    return getDataSource()
        .getRepository(ChatFlow)
        .findOne({ where: { id, workspaceId }, select: ['id', 'name', 'type', 'flowData', 'apikeyid'] })
}

/** What a chatflow route touches, from the body it was sent and the row it names. */
export function canvasHarnessNames(body: Record<string, unknown> | undefined, stored: StoredFlow | null | undefined): string[] {
    const names = new Set<string>()
    const sent = body && typeof body === 'object' ? body : {}
    if (stored?.type === 'HARNESS' && typeof stored.name === 'string') names.add(stored.name)
    const type = 'type' in sent ? sent.type : stored?.type
    if (type === 'HARNESS' && typeof sent.name === 'string' && sent.name) names.add(sent.name)
    // A canvas that is rebound or unbound runs its stored cards under a different key, or under no key at all.
    const rebinding = 'apikeyid' in sent && (sent.apikeyid ?? null) !== (stored?.apikeyid ?? null)
    const flowData = sent.flowData !== undefined ? sent.flowData : rebinding ? stored?.flowData : undefined
    for (const name of referencedHarnessNames(flowData)) names.add(name)
    return [...names]
}

/**
 * The per-key list on routes that read or write one chatflow row. An API key needs every HARNESS canvas the request
 * touches (in the body or the stored row) and every harness the sent canvas names on its own list. A signed-in person
 * is checked by role only. `body: false` checks the stored row only.
 */
export function requireHarnessCanvasAccess(opts: { idParam?: string; body?: boolean } = {}): RequestHandler {
    const idParam = opts.idParam ?? 'id'
    const readBody = opts.body !== false
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        const workspaceId = callerOf(req).activeWorkspaceId
        const id = req.params?.[idParam]
        void (async () => {
            const stored = typeof id === 'string' && id && typeof workspaceId === 'string' ? await storedFlow(id, workspaceId) : null
            const caller = await harnessCallerFor(req)
            const refused = harnessRefusedFor(caller, canvasHarnessNames(readBody ? req.body : undefined, stored))
            if (refused === null) {
                next()
                return
            }
            const label = callerLabel(req)
            logger.warn(`[harness] API key ${label.keyId || 'unknown'} was refused a canvas that names harness ${safeHarnessName(refused)}`)
            res.status(StatusCodes.FORBIDDEN).json({ message: `This API key may not use harness "${safeHarnessName(refused)}".` })
        })().catch((error) => {
            logger.warn(`[harness] allowlist check failed: ${getErrorMessage(error)}`)
            if (!res.headersSent) res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: 'Permission check failed' })
        })
    }
}

/**
 * MCP settings and the schedule switch start runs that use the flow's own key, or no key. An API key may change them
 * only on a flow bound to itself or to no key, and only when every harness the stored flow names is on its list, so
 * it cannot borrow another key's list or reach a harness off its own. A person is checked by role only.
 */
export function requireFlowRunnableByKey(opts: { idParam?: string } = {}): RequestHandler {
    const idParam = opts.idParam ?? 'id'
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        const workspaceId = callerOf(req).activeWorkspaceId
        const id = req.params?.[idParam]
        void (async () => {
            const stored = typeof id === 'string' && id && typeof workspaceId === 'string' ? await storedFlow(id, workspaceId) : null
            // A flow that is not in the team is the controller's 404.
            if (!stored) {
                next()
                return
            }
            const caller = await harnessCallerFor(req)
            const keyId = caller.via === 'api_key' ? caller.apiKeyId : ''
            const boundKey = typeof stored.apikeyid === 'string' && stored.apikeyid ? stored.apikeyid : null
            if (!keyId || (boundKey !== null && boundKey !== keyId)) {
                logger.warn(`[harness] API key ${keyId || 'unknown'} was refused flow ${stored.id}: it is bound to another key`)
                res.status(StatusCodes.FORBIDDEN).json({ message: 'This API key may not change a flow bound to another API key.' })
                return
            }
            const names = new Set(canvasHarnessNames(undefined, stored))
            for (const name of referencedHarnessNames(stored.flowData)) names.add(name)
            const refused = harnessRefusedFor(caller, [...names])
            if (refused === null) {
                next()
                return
            }
            logger.warn(`[harness] API key ${keyId} was refused flow ${stored.id}, which names harness ${safeHarnessName(refused)}`)
            res.status(StatusCodes.FORBIDDEN).json({ message: `This API key may not use harness "${safeHarnessName(refused)}".` })
        })().catch((error) => {
            logger.warn(`[harness] allowlist check failed: ${getErrorMessage(error)}`)
            if (!res.headersSent) res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: 'Permission check failed' })
        })
    }
}

/**
 * GET /chatflows for an API key leaves out HARNESS canvases whose name is not on the key's list. The controller hands
 * this list to the query, so paging and the total count already leave those rows out.
 */
export function scopeChatflowListToKey(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        void callerKeyHarnesses(req)
            .then((allowed) => {
                res.locals.harnessCanvasScope = allowed || []
                next()
            })
            .catch((error) => {
                logger.warn(`[harness] allowlist check failed: ${getErrorMessage(error)}`)
                if (!res.headersSent) res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: 'Permission check failed' })
            })
    }
}

/** A key may hand out only harnesses it already holds. A person is checked by role only. */
export async function assertCallerMayGrant(req: Request, names: string[]): Promise<void> {
    const own = await callerKeyHarnesses(req)
    if (own === null) return
    const extra = names.find((name) => !own.includes(name))
    if (extra) throw new AppError(StatusCodes.FORBIDDEN, `This API key may not grant harness "${safeHarnessName(extra)}".`)
}

export async function noteHarnessAudit(
    req: Request,
    type: AuditType,
    summary: string,
    detail: Record<string, unknown>,
    workspaceId?: string | null
): Promise<void> {
    const user = callerOf(req)
    const organizationId = typeof user.activeOrganizationId === 'string' ? user.activeOrganizationId : ''
    if (!organizationId) return
    const userId = typeof user.id === 'string' && user.id ? user.id : null
    try {
        const { applicationSql } = await import('../../identity/production')
        await safeRecordAudit(applicationSql(), {
            type,
            organizationId,
            workspaceId: workspaceId ?? (typeof user.activeWorkspaceId === 'string' ? user.activeWorkspaceId : null),
            userId,
            actorId: userId,
            summary,
            detail
        })
    } catch (error) {
        logger.warn(`[harness] audit event was not saved: ${getErrorMessage(error)}`)
    }
}

/** Key id and name for logs and audit rows. Never the token. */
export function callerLabel(req: Request): { keyId?: string; via: 'api_key' | 'session' } {
    if (!isApiKeyCaller(req)) return { via: 'session' }
    const keyId = callerOf(req).apiKeyId
    return { via: 'api_key', ...(typeof keyId === 'string' && keyId ? { keyId } : {}) }
}

export async function noteBackgroundRunStarted(req: Request, started: { harness: string; runId: string }, workspaceId: string) {
    const label = callerLabel(req)
    const harness = safeHarnessName(started.harness)
    logger.info(`[harness] ${harness} run ${started.runId} started from the API (${label.via}${label.keyId ? ` ${label.keyId}` : ''})`)
    await noteHarnessAudit(
        req,
        'harness_run',
        'Harness run started',
        { harness, runId: started.runId, outcome: 'started', ...label },
        workspaceId
    )
}

export function noteBackgroundRunSettled(name: string, outcome: { runId: string; status: string }) {
    logger.info(`[harness] ${safeHarnessName(name)} run ${outcome.runId} ${outcome.status}`)
}

/**
 * The per-key harness allowlist. A signed-in person is checked by role only, before this runs.
 * An API key also needs the harness on its own list. An empty or missing list runs nothing.
 * The refusal is the same whether or not the harness exists, so the name is not confirmed.
 * `nameFrom: 'body'` reads the harness a save would write.
 */
export function requireHarnessAccess(opts: { auditDenial?: boolean; nameFrom?: 'params' | 'body' } = {}): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        const raw = opts.nameFrom === 'body' ? req.body?.name : req.params.name
        const name = typeof raw === 'string' ? raw : ''
        const shown = safeHarnessName(name)
        void callerKeyHarnesses(req)
            .then(async (allowed) => {
                if (shown !== INVALID_NAME && (allowed || []).includes(name)) {
                    next()
                    return
                }
                const label = callerLabel(req)
                logger.warn(`[harness] API key ${label.keyId || 'unknown'} was refused harness ${shown}: not on its allowlist`)
                if (opts.auditDenial) {
                    await noteHarnessAudit(req, 'harness_run', 'Harness run refused', {
                        harness: shown,
                        outcome: 'refused',
                        reason: 'not_on_allowlist',
                        ...label
                    })
                }
                res.status(StatusCodes.FORBIDDEN).json({ message: `This API key may not run harness "${shown}".` })
            })
            .catch((error) => {
                logger.warn(`[harness] allowlist check failed: ${getErrorMessage(error)}`)
                if (!res.headersSent) res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: 'Permission check failed' })
            })
    }
}

/** One bucket per API key, or per person, so callers behind one proxy do not share a limit. */
export function harnessRateKey(req: Request): string {
    const user = callerOf(req)
    if (typeof user.apiKeyId === 'string' && user.apiKeyId) return `key:${user.apiKeyId}`
    if (typeof user.id === 'string' && user.id) return `user:${user.id}`
    return `ip:${rateLimitClientKey(req)}`
}

/**
 * Counted in this process's memory. Several server processes behind one address each keep their own count, so the
 * effective limit is this number times the process count.
 */
export function harnessRunRateLimit(kind: 'start' | 'read', max?: number): RequestHandler {
    const limit = max ?? (kind === 'start' ? HARNESS_RUN_START_LIMIT : HARNESS_RUN_READ_LIMIT)
    return rateLimit({
        windowMs: RATE_WINDOW_MS,
        max: limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: harnessRateKey,
        handler: (req, res) => {
            logger.warn(
                `[harness] ${kind} rate limit reached for ${harnessRateKey(req).split(':')[0]} on ${safeHarnessName(req.params.name)}`
            )
            res.status(StatusCodes.TOO_MANY_REQUESTS).json({
                message: `Too many harness ${kind === 'start' ? 'runs' : 'status reads'}. The limit is ${limit} a minute.`
            })
        }
    })
}
