import { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { AuditType, safeRecordAudit } from '../../identity/auditLog'
import { rateLimitClientKey } from '../../utils/rateLimit'
import logger from '../../utils/logger'

export const HARNESS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const HARNESS_ALLOWLIST_MAX = 200
const INVALID_NAME = '<invalid>'

/** Runs started per minute per API key, or per person for a signed-in caller. */
export const HARNESS_RUN_START_LIMIT = 60
/** Status and result reads per minute, on the same key. */
export const HARNESS_RUN_READ_LIMIT = 600
/** Schedule saves, pauses, resumes, and deletes per minute per person. */
export const HARNESS_SCHEDULE_WRITE_LIMIT = 30
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

/** A deleted harness leaves every key's list in that team, so a later harness with the same name is not granted. */
export async function removeHarnessFromKeyLists(workspaceId: string, name: string): Promise<number> {
    const { getDataSource } = await import('../../DataSource')
    const { ApiKey } = await import('../../database/entities/ApiKey')
    const repo = getDataSource().getRepository(ApiKey)
    let changed = 0
    for (const key of await repo.findBy({ workspaceId })) {
        const list = harnessAllowlist(key.harnesses)
        if (!list.includes(name)) continue
        key.harnesses = list.filter((item) => item !== name)
        await repo.save(key)
        changed += 1
    }
    return changed
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

/** The list a key has for a flow prediction. An unknown key, or one in another team, runs no harness. */
export async function keyHarnessesFor(keyId: string, workspaceId: string): Promise<string[]> {
    const key = await storedKey(keyId)
    if (!key || key.workspaceId !== workspaceId) return []
    return harnessAllowlist(key.harnesses)
}

/** Harness names a chatflow or agentflow canvas names on its Harness cards. */
export function referencedHarnessNames(flowData: unknown): string[] {
    if (typeof flowData !== 'string' || !flowData.includes('"harness"')) return []
    let parsed: { nodes?: Array<{ data?: { name?: string; inputs?: { harnessName?: unknown } } }> }
    try {
        parsed = JSON.parse(flowData)
    } catch {
        return []
    }
    const names = new Set<string>()
    for (const node of parsed?.nodes || []) {
        if (node?.data?.name !== 'harness') continue
        const name = node.data.inputs?.harnessName
        if (typeof name === 'string' && name.trim()) names.add(name.trim())
    }
    return [...names]
}

/**
 * Refuses an API key that saves a chatflow, agentflow, or draft whose Harness card names a harness that is not on the
 * key's list. A keyless flow runs for anyone who has its id, so the save is where the key's list is enforced.
 */
export function refuseUnlistedHarnessCards(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        const named = referencedHarnessNames(req.body?.flowData)
        if (!named.length) {
            next()
            return
        }
        void callerKeyHarnesses(req)
            .then((allowed) => {
                const refused = named.find((name) => !(allowed || []).includes(name))
                if (!refused) {
                    next()
                    return
                }
                const label = callerLabel(req)
                logger.warn(
                    `[harness] API key ${label.keyId || 'unknown'} was refused a canvas that names harness ${safeHarnessName(refused)}`
                )
                res.status(StatusCodes.FORBIDDEN).json({
                    message: `This API key may not save a Harness card for "${safeHarnessName(refused)}".`
                })
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

/** A schedule runs with its owner's permissions, so only a signed-in person can set or change one. */
export function scheduleOwner(req: Request): string {
    const id = callerOf(req).id
    if (isApiKeyCaller(req) || typeof id !== 'string' || !id) {
        throw new AppError(StatusCodes.FORBIDDEN, 'A schedule runs as a person, so an API key cannot change one. Sign in to set it.')
    }
    return id
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

const RATE_LIMITS = { start: HARNESS_RUN_START_LIMIT, read: HARNESS_RUN_READ_LIMIT, schedule: HARNESS_SCHEDULE_WRITE_LIMIT }
const RATE_NOUNS = { start: 'harness runs', read: 'harness status reads', schedule: 'harness schedule changes' }

/**
 * Counted in this process's memory. Several server processes behind one address each keep their own count, so the
 * effective limit is this number times the process count.
 */
export function harnessRunRateLimit(kind: 'start' | 'read' | 'schedule', max?: number): RequestHandler {
    const limit = max ?? RATE_LIMITS[kind]
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
                message: `Too many ${RATE_NOUNS[kind]}. The limit is ${limit} a minute.`
            })
        }
    })
}
