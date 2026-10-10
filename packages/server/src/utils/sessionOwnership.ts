import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { authSecret } from '../identity/authSecrets'
import logger from './logger'

/**
 * Binds a prediction chat id and memory session id to the caller.
 * An API-key or public caller keeps a client id only with the server-issued token.
 * A signed-in caller keeps it when this workspace and user already own it.
 * Anything else is a new id, so the request still runs and does not see the other session.
 */

const CACHE = Symbol.for('cuttlely.ownedSession')
const TOKEN_HEADER = 'x-cuttlely-session-token'

export type SessionCallerKind = 'user' | 'apiKey' | 'public'

export interface SessionCaller {
    kind: SessionCallerKind
    key: string
}

export interface OwnedSession {
    chatId: string
    sessionId: string
    sessionToken: string
    /** A client-supplied id was dropped. */
    rebound: boolean
}

export interface GrantStore {
    get(chatflowId: string, sessionId: string): string | undefined
    put(chatflowId: string, sessionId: string, callerKey: string): void
}

export interface ChatflowSessionRef {
    id: string
    apikeyid?: string | null
}

interface ResolveInput {
    chatflowId: string
    caller: SessionCaller
    secret: string
    clientChatId: unknown
    clientSessionId: unknown
    clientToken: unknown
    grants: GrantStore
    /** Resume and file reads refuse an id this caller does not own. */
    failClosed?: boolean
}

export function createMemoryGrantStore(): GrantStore {
    const rows = new Map<string, Map<string, string>>()
    return {
        get(chatflowId, sessionId) {
            return rows.get(chatflowId)?.get(sessionId)
        },
        put(chatflowId, sessionId, callerKey) {
            let flow = rows.get(chatflowId)
            if (!flow) {
                flow = new Map()
                rows.set(chatflowId, flow)
            }
            flow.set(sessionId, callerKey)
        }
    }
}

class FileGrantStore implements GrantStore {
    private readonly rows = new Map<string, Map<string, string>>()
    private loaded = false

    constructor(private readonly filePath: string) {}

    private load(): void {
        if (this.loaded) return
        this.loaded = true
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
            for (const [chatflowId, sessions] of Object.entries(parsed as Record<string, unknown>)) {
                if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) continue
                const flow = new Map<string, string>()
                for (const [sessionId, callerKey] of Object.entries(sessions as Record<string, unknown>)) {
                    if (typeof callerKey === 'string') flow.set(sessionId, callerKey)
                }
                this.rows.set(chatflowId, flow)
            }
        } catch {
            // Missing or unreadable file: start empty. Do not log the path contents.
        }
    }

    get(chatflowId: string, sessionId: string): string | undefined {
        this.load()
        return this.rows.get(chatflowId)?.get(sessionId)
    }

    put(chatflowId: string, sessionId: string, callerKey: string): void {
        this.load()
        let flow = this.rows.get(chatflowId)
        if (!flow) {
            flow = new Map()
            this.rows.set(chatflowId, flow)
        }
        if (flow.get(sessionId) === callerKey) return
        flow.set(sessionId, callerKey)
        const snapshot: Record<string, Record<string, string>> = {}
        for (const [flowId, sessions] of this.rows) {
            snapshot[flowId] = Object.fromEntries(sessions)
        }
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(snapshot))
        fs.renameSync(tmp, this.filePath)
    }
}

export function createFileGrantStore(filePath: string): GrantStore {
    return new FileGrantStore(filePath)
}

let secretOverride: string | undefined
let ephemeralSecret: string | undefined
let warnedEphemeral = false

function grantFilePath(): string {
    const dir = process.env.CUTTLELY_DATA_DIR || process.env.BLOB_STORAGE_PATH || path.join(os.homedir(), '.cuttlely')
    return path.join(dir, 'session-grants.json')
}

function defaultGrantStore(): GrantStore {
    return new FileGrantStore(grantFilePath())
}

let activeGrants: GrantStore | undefined

function grantStore(): GrantStore {
    if (!activeGrants) activeGrants = defaultGrantStore()
    return activeGrants
}

export function ownershipSecret(): string {
    if (secretOverride) return secretOverride
    try {
        return authSecret('TOKEN_HASH_SECRET')
    } catch {
        const fromEnv = process.env.TOKEN_HASH_SECRET
        if (fromEnv && fromEnv.trim()) return fromEnv.trim()
        if (!ephemeralSecret) ephemeralSecret = randomBytes(32).toString('base64url')
        if (!warnedEphemeral) {
            warnedEphemeral = true
            // The value stays in memory. Logging it would make every session token forgeable.
            logger.warn('[server]: session ownership secret is ephemeral until auth secrets load')
        }
        return ephemeralSecret
    }
}

/** Tests inject a store and secret. Production uses the data-dir file and TOKEN_HASH_SECRET. */
export function configureSessionOwnershipForTests(options: { grants?: GrantStore; secret?: string } = {}): void {
    secretOverride = options.secret
    activeGrants = options.grants ?? createMemoryGrantStore()
}

export function resetSessionOwnershipForTests(): void {
    secretOverride = undefined
    activeGrants = undefined
    ephemeralSecret = undefined
    warnedEphemeral = false
}

export function sessionCaller(req: Request, chatflow: ChatflowSessionRef, isInternal: boolean): SessionCaller {
    const userId = req.user?.id
    const workspaceId = req.user?.activeWorkspaceId
    if (isInternal && userId && workspaceId) {
        return { kind: 'user', key: `user:${workspaceId}:${userId}` }
    }
    if (!isInternal && chatflow.apikeyid) {
        return { kind: 'apiKey', key: `key:${chatflow.apikeyid}` }
    }
    return { kind: 'public', key: `public:${chatflow.id}` }
}

export function issueSessionToken(secret: string, callerKey: string, chatflowId: string, sessionId: string): string {
    return createHmac('sha256', secret)
        .update('chat-session-v1')
        .update('\0')
        .update(callerKey)
        .update('\0')
        .update(chatflowId)
        .update('\0')
        .update(sessionId)
        .digest('base64url')
}

export function sessionTokenMatches(secret: string, callerKey: string, chatflowId: string, sessionId: string, token: string): boolean {
    if (!token || token.length > 512) return false
    const expected = issueSessionToken(secret, callerKey, chatflowId, sessionId)
    const got = Buffer.from(token)
    const want = Buffer.from(expected)
    if (got.length !== want.length) return false
    return timingSafeEqual(got, want)
}

interface ClassifiedId {
    supplied: boolean
    id?: string
}

/** A usable id is a short string with no path separators. Anything else was supplied and is not kept. */
function classifyId(value: unknown): ClassifiedId {
    if (value === undefined || value === null || value === '') return { supplied: false }
    if (typeof value !== 'string') return { supplied: true }
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 200 || /[/\\\0]/.test(trimmed) || trimmed.includes('..')) return { supplied: true }
    return { supplied: true, id: trimmed }
}

function readOverride(body: Record<string, unknown>): Record<string, unknown> | undefined {
    const raw = body.overrideConfig
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        } catch {
            return undefined
        }
        return undefined
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    return undefined
}

function readClientToken(req: Request): unknown {
    const header = req.get?.(TOKEN_HEADER)
    if (typeof header === 'string' && header.trim()) return header.trim()
    const body = req.body as { sessionToken?: unknown } | undefined
    if (typeof body?.sessionToken === 'string' && body.sessionToken.trim()) return body.sessionToken.trim()
    return cookieTokenForBody(req, body as Record<string, unknown> | undefined)
}

const COOKIE_NAME = 'cuttlely_session'
const COOKIE_SESSIONS = 8

/** `id.token` pairs. Ids are uuids and tokens are base64url, so comma and dot stay separators. */
function parseSessionCookie(raw: string): Map<string, string> {
    const pairs = new Map<string, string>()
    for (const part of raw.split(',')) {
        const dot = part.indexOf('.')
        if (dot <= 0) continue
        const id = part.slice(0, dot)
        const token = part.slice(dot + 1)
        if (id && token) pairs.set(id, token)
    }
    return pairs
}

function readSessionCookie(req: Request): Map<string, string> {
    const raw = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[COOKIE_NAME]
    return typeof raw === 'string' ? parseSessionCookie(raw) : new Map()
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined
}

/** Same-site browsers keep the token in an httpOnly cookie and resend only the chat id. */
function cookieTokenForBody(req: Request, body: Record<string, unknown> | undefined): string | undefined {
    const pairs = readSessionCookie(req)
    if (!pairs.size) return undefined
    const override = readOverride(body ?? {})
    const named = [body?.chatId, override?.sessionId, body?.sessionId, req.params?.chatId, req.query?.chatId]
        .map(stringValue)
        .find((value): value is string => !!value)
    if (!named) return undefined
    return pairs.get(named)
}

function setSessionCookie(req: Request, chatflowId: string, owned: OwnedSession, isInternal: boolean): void {
    if (isInternal) return
    const res = req.res
    if (!res || typeof res.cookie !== 'function' || res.headersSent) return
    const pairs = readSessionCookie(req)
    pairs.set(owned.chatId, owned.sessionToken)
    const entries = [...pairs.entries()].slice(-COOKIE_SESSIONS)
    res.cookie(COOKIE_NAME, entries.map(([id, token]) => `${id}.${token}`).join(','), {
        httpOnly: true,
        sameSite: 'lax',
        // Prediction, attachments, and get-upload-file all need the pair. The token is still bound to one chatflow.
        path: '/api/v1',
        secure: process.env.NODE_ENV === 'production'
    })
}

export function resolveOwnedSession(input: ResolveInput): OwnedSession {
    const overrideSession = classifyId(input.clientSessionId)
    const chat = classifyId(input.clientChatId)
    const token = typeof input.clientToken === 'string' ? input.clientToken : ''
    const supplied = overrideSession.supplied || chat.supplied

    const owns = (id: string): boolean => {
        if (token && sessionTokenMatches(input.secret, input.caller.key, input.chatflowId, id, token)) return true
        if (input.caller.kind === 'user') return input.grants.get(input.chatflowId, id) === input.caller.key
        return false
    }

    // Prefer the memory id when both were sent and only one is owned.
    const accepted = [overrideSession.id, chat.id].find((id): id is string => !!id && owns(id))
    const fresh = !accepted
    const sessionId = accepted ?? randomUUID()
    const rebound = supplied && (fresh || overrideSession.id !== sessionId || (chat.id !== undefined && chat.id !== sessionId))

    // A resume or a file read must not continue on a new id. Do not grant that id either.
    // `rebound` is also set when an owned chat id had no matching override session id, so it is not the refusal signal.
    if (input.failClosed && supplied && fresh) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Forbidden')
    }

    if (input.caller.kind === 'user') input.grants.put(input.chatflowId, sessionId, input.caller.key)

    return {
        chatId: sessionId,
        sessionId,
        sessionToken: issueSessionToken(input.secret, input.caller.key, input.chatflowId, sessionId),
        rebound
    }
}

/**
 * Memory and agentflow runs are keyed by the caller-owned chat id (D55).
 * A client `overrideConfig.sessionId` is kept only when it is that id.
 * Any other string is replaced, so a later allowlisted node input cannot open the other session.
 * A non-string is rejected. An empty value leaves the override alone.
 */
export function pinOwnedMemorySession(overrideConfig: { sessionId?: unknown } | null | undefined, ownedChatId: string): string {
    if (!overrideConfig || typeof overrideConfig !== 'object') return ownedChatId
    const candidate = overrideConfig.sessionId
    if (candidate === undefined || candidate === null || candidate === '') return ownedChatId
    if (typeof candidate !== 'string') {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid sessionId: must be a string')
    }
    if (candidate !== ownedChatId) overrideConfig.sessionId = ownedChatId
    return ownedChatId
}

function applyOwnedSession(body: Record<string, unknown>, owned: OwnedSession, suppliedSession: boolean): void {
    body.chatId = owned.chatId
    if (suppliedSession || owned.rebound) {
        const override = readOverride(body) ?? {}
        override.sessionId = owned.sessionId
        body.overrideConfig = override
    }
    delete body.sessionToken
    delete body.sessionId
}

/**
 * Resolve once per request. A second call returns the same id so the SSE channel and the run match.
 * `failClosed` refuses a supplied id this caller does not own (webhook resume, file read).
 */
export function bindRequestSession(
    req: Request,
    options: { chatflow: ChatflowSessionRef; isInternal: boolean; failClosed?: boolean }
): OwnedSession {
    const cached = (req as unknown as Record<symbol, OwnedSession | undefined>)[CACHE]
    if (cached) return cached

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {}
    const body = req.body as Record<string, unknown>
    const override = readOverride(body)
    const suppliedSession = classifyId(override?.sessionId).supplied || classifyId(body.sessionId).supplied
    const caller = sessionCaller(req, options.chatflow, options.isInternal)
    const owned = resolveOwnedSession({
        chatflowId: options.chatflow.id,
        caller,
        secret: ownershipSecret(),
        clientChatId: body.chatId,
        clientSessionId: override?.sessionId ?? body.sessionId,
        clientToken: readClientToken(req),
        grants: grantStore(),
        failClosed: options.failClosed
    })
    applyOwnedSession(body, owned, suppliedSession)
    setSessionCookie(req, options.chatflow.id, owned, options.isInternal)
    ;(req as unknown as Record<symbol, OwnedSession>)[CACHE] = owned
    return owned
}

/** A route param or query chat id uses the same ownership as a prediction body. */
export function bindSuppliedChatId(
    req: Request,
    options: { chatflow: ChatflowSessionRef; isInternal: boolean; suppliedChatId: unknown; failClosed?: boolean }
): OwnedSession {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {}
    const body = req.body as Record<string, unknown>
    if (body.chatId === undefined && options.suppliedChatId !== undefined) body.chatId = options.suppliedChatId
    return bindRequestSession(req, {
        chatflow: options.chatflow,
        isInternal: options.isInternal,
        failClosed: options.failClosed
    })
}

export function callerIsSignedIn(req: Request): boolean {
    return Boolean(req.user?.id && req.user?.activeWorkspaceId)
}
