import { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { AuditType, safeRecordAudit } from '../../identity/auditLog'
import { rateLimitClientKey } from '../../utils/rateLimit'
import logger from '../../utils/logger'

const HARNESS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const HARNESS_ALLOWLIST_MAX = 200

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

function callerOf(req: Request): Caller {
    return (req.user || {}) as Caller
}

/** The API gate builds an API-key caller without a user id. A signed-in person always has one. */
export function isApiKeyCaller(req: Request): boolean {
    const user = callerOf(req)
    return typeof user.id !== 'string' || !user.id
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
        throw new AppError(StatusCodes.PRECONDITION_FAILED, 'harnesses must be an array of harness names.')
    }
    const bad = value.find((item) => !HARNESS_NAME.test(item))
    if (bad !== undefined) throw new AppError(StatusCodes.BAD_REQUEST, `"${String(bad).slice(0, 80)}" is not a harness name.`)
    const list = harnessAllowlist(value)
    if (new Set(value).size > HARNESS_ALLOWLIST_MAX) {
        throw new AppError(StatusCodes.BAD_REQUEST, `An API key can list at most ${HARNESS_ALLOWLIST_MAX} harnesses.`)
    }
    return list
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
    logger.info(
        `[harness] ${started.harness} run ${started.runId} started from the API (${label.via}${label.keyId ? ` ${label.keyId}` : ''})`
    )
    await noteHarnessAudit(
        req,
        'harness_run',
        'Harness run started',
        { harness: started.harness, runId: started.runId, outcome: 'started', ...label },
        workspaceId
    )
}

export function noteBackgroundRunSettled(name: string, outcome: { runId: string; status: string }) {
    logger.info(`[harness] ${name} run ${outcome.runId} ${outcome.status}`)
}

async function keyMayRun(req: Request, name: string): Promise<boolean> {
    const user = callerOf(req)
    const keyId = typeof user.apiKeyId === 'string' ? user.apiKeyId : ''
    if (!keyId) return false
    // Read on each request so an edit to the list applies to the next call.
    const key = await storedKey(keyId)
    if (!key || key.workspaceId !== user.activeWorkspaceId) return false
    return harnessAllowlist(key.harnesses).includes(name)
}

/**
 * The per-key harness allowlist. A signed-in person is checked by role only, before this runs.
 * An API key also needs the harness on its own list. An empty or missing list runs nothing.
 * The refusal is the same whether or not the harness exists, so the name is not confirmed.
 */
export function requireHarnessAccess(opts: { auditDenial?: boolean } = {}): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isApiKeyCaller(req)) {
            next()
            return
        }
        const name = String(req.params.name || '')
        void keyMayRun(req, name)
            .then(async (allowed) => {
                if (allowed) {
                    next()
                    return
                }
                const label = callerLabel(req)
                logger.warn(`[harness] API key ${label.keyId || 'unknown'} was refused harness ${name.slice(0, 64)}: not on its allowlist`)
                if (opts.auditDenial) {
                    await noteHarnessAudit(req, 'harness_run', 'Harness run refused', {
                        harness: name.slice(0, 64),
                        outcome: 'refused',
                        reason: 'not_on_allowlist',
                        ...label
                    })
                }
                res.status(StatusCodes.FORBIDDEN).json({ message: `This API key may not run harness "${name.slice(0, 64)}".` })
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

export function harnessRunRateLimit(kind: 'start' | 'read' | 'schedule', max?: number): RequestHandler {
    const limit = max ?? RATE_LIMITS[kind]
    return rateLimit({
        windowMs: RATE_WINDOW_MS,
        max: limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: harnessRateKey,
        handler: (req, res) => {
            logger.warn(`[harness] ${kind} rate limit reached for ${harnessRateKey(req).split(':')[0]} on ${String(req.params.name || '')}`)
            res.status(StatusCodes.TOO_MANY_REQUESTS).json({
                message: `Too many ${RATE_NOUNS[kind]}. The limit is ${limit} a minute.`
            })
        }
    })
}
