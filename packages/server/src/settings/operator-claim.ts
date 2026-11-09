// Explicit operator designation. Bootstrap/setup capabilities never enter this module.
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import path from 'path'
import { Request } from 'express'
import { getDataSource } from '../DataSource'
import { INSTANCE_OPERATOR_KEY, isInstanceOperator, operatorDatabaseFingerprint } from '../identity/instanceOperator'
import {
    OPERATOR_BINDING_LOCK,
    logOperatorClaimCode,
    operatorBindingSnapshot,
    publishOperator,
    managedOperator,
    operatorInstallation,
    writeOperatorProofState,
    readPrivateOperatorFile
} from '../identity/operatorBinding'
import { recentlyAuthenticated } from '../identity/authenticationRoutes'
import { attachIdentitySession } from '../identity/middleware'
import { resolveTeamAccess } from '../identity/rbac'
import { LOCAL_SESSION_COOKIE } from '../identity/constants'
import { hashSessionToken } from '../identity/password'
import { SqlIdentityStore } from '../identity/sqlStore'
import { sessionHashOf } from './authkit'
import { withNamedLock } from './lock'
import { SettingsError } from './service'
import { settingsDir } from './store'

type Env = Record<string, string | undefined>
type Purpose = 'claim' | 'rebind' | 'recover'
const STATE_FILE = 'operator-claim.json'
const HOUR = 60 * 60 * 1000
const TTL = 5 * 60 * 1000
interface Challenge {
    hash: string
    user: string
    session: string
    database: string
    snapshot: string
    installation: string
    epoch: number
    purpose: Purpose
    expires: number
}
interface Budget {
    requests: number
    attempts: number
}
interface State {
    window: number
    lastRequest: number
    global: Budget
    users: Record<string, Budget>
    challenge?: Challenge
}
function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}
function denied(): never {
    throw new SettingsError(403, 'OPERATOR_ACTION_DENIED', 'Operator action unavailable. Sign in again or use host recovery.')
}
function limited(): never {
    throw new SettingsError(429, 'OPERATOR_RATE_LIMIT', 'Too many operator proof requests or attempts. Try again later.')
}
function confirmation(body: Record<string, unknown>, word: string): void {
    if (body.confirm !== word) throw new SettingsError(400, 'CONFIRM_REQUIRED', `Type ${word} to confirm this operator action.`)
}
function readState(env: Env): State {
    try {
        const value = JSON.parse(readPrivateOperatorFile(path.join(settingsDir(env), STATE_FILE))) as State
        const validBudget = (b: Budget) =>
            b && Number.isSafeInteger(b.requests) && b.requests >= 0 && Number.isSafeInteger(b.attempts) && b.attempts >= 0
        if (
            !Number.isFinite(value.window) ||
            !Number.isFinite(value.lastRequest) ||
            !validBudget(value.global) ||
            !value.users ||
            Array.isArray(value.users) ||
            Object.keys(value.users).length > 16 ||
            Object.entries(value.users).some(([key, budget]) => !/^[a-f0-9]{64}$/.test(key) || !validBudget(budget))
        )
            denied()
        const c = value.challenge
        if (
            c &&
            (!/^[a-f0-9]{64}$/.test(c.hash) ||
                !Number.isFinite(c.expires) ||
                typeof c.user !== 'string' ||
                typeof c.session !== 'string' ||
                typeof c.database !== 'string' ||
                typeof c.snapshot !== 'string' ||
                typeof c.installation !== 'string' ||
                !Number.isSafeInteger(c.epoch) ||
                !['claim', 'recover', 'rebind'].includes(c.purpose))
        )
            denied()
        if (Date.now() < value.window + HOUR) return value
        return {
            window: Date.now(),
            lastRequest: value.lastRequest,
            global: { requests: 0, attempts: 0 },
            users: {},
            challenge: value.challenge
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { window: Date.now(), lastRequest: 0, global: { requests: 0, attempts: 0 }, users: {} }
}
function saveState(env: Env, state: State): void {
    writeOperatorProofState(env, JSON.stringify(state))
}

/** Revalidate the real session, not just the middleware's earlier principal, after acquiring the lock. */
async function principal(
    req: Request,
    recent: boolean
): Promise<{ user: string; session: string; database: string; epoch: number; reauthenticateUrl: string }> {
    if (!(req as Request & { cuttlelyIdentity?: boolean }).cuttlelyIdentity || req.user?.apiKeyId) denied()
    // The session attacher validates status, epoch, expiry and authentication method. A no-op response avoids cookie side effects.
    const response = { clearCookie: () => undefined, cookie: () => undefined } as unknown as Parameters<typeof attachIdentitySession>[1]
    const current = await attachIdentitySession(req, response)
    if (!current || current.id !== req.user?.id || current.activeWorkspaceId !== req.user?.activeWorkspaceId) denied()
    if (!(await resolveTeamAccess(current.id, current.activeWorkspaceId ?? '')).owner) denied()
    if (recent && !(await recentlyAuthenticated(req)))
        throw new SettingsError(403, 'RECENT_AUTH_REQUIRED', 'Sign in again before changing the instance operator.')
    const session = sessionHashOf(req)
    if (!session) denied()
    const token = req.cookies?.[LOCAL_SESSION_COOKIE]
    const row = token ? await new SqlIdentityStore(getDataSource()).findLocalSession(hashSessionToken(token)) : null
    if (!row || row.userId !== current.id) denied()
    return {
        user: current.id,
        session,
        epoch: row.authenticationEpoch ?? 0,
        reauthenticateUrl:
            row.authenticationMethod === 'workos'
                ? '/api/v1/auth/reauthenticate'
                : row.authenticationMethod === 'oidc'
                ? '/api/v1/auth/oidc/reauthenticate'
                : '/signin?reauth=1',
        database: operatorDatabaseFingerprint(getDataSource().options)
    }
}

async function eligibility(req: Request, env: Env): Promise<{ state: string; purpose: Purpose | null }> {
    if (env[INSTANCE_OPERATOR_KEY] !== undefined) return { state: 'HostOverride', purpose: null }
    operatorBindingSnapshot(env) // unsafe files require host recovery
    const managed = managedOperator(env)
    if (managed.state === 'Unclaimed') return { state: 'Unclaimed', purpose: 'claim' }
    if (managed.state === 'Disabled' || managed.state === 'RecoveryRequired')
        return { state: managed.state === 'Disabled' ? 'Disabled' : 'RecoveryRequired', purpose: 'recover' }
    if (managed.state !== 'Active') denied()
    const active = await new SqlIdentityStore(getDataSource()).isActiveOwner(managed.identity.userId)
    if (managed.identity.database !== operatorDatabaseFingerprint(getDataSource().options))
        return { state: 'RecoveryRequired', purpose: active && managed.identity.userId === req.user?.id ? 'rebind' : null }
    if (!active) return { state: 'RecoveryRequired', purpose: 'recover' }
    return { state: 'Active', purpose: null }
}

/** Nonoperators receive only eligibility for the narrow proof flow, never the bound identity or settings. */
export async function operatorPanelStatus(req: Request, env: Env): Promise<unknown> {
    const who = await principal(req, false)
    if (await isInstanceOperator(req, env)) {
        const {
            entities: { User, OrganizationUser, Role }
        } = await import('../database/entities')
        const owners = await getDataSource()
            .getRepository(User)
            .createQueryBuilder('u')
            .innerJoin(OrganizationUser, 'ou', 'ou.userId = u.id')
            .innerJoin(Role, 'r', 'r.id = ou.roleId')
            .where('ou.organizationId = :org', { org: req.user?.activeOrganizationId })
            .andWhere('LOWER(u.status) = :active AND LOWER(ou.status) = :active AND LOWER(r.name) = :owner', {
                active: 'active',
                owner: 'owner'
            })
            .select(['u.id', 'u.email'])
            .getMany()
        return {
            reauthenticateUrl: who.reauthenticateUrl,
            operator: {
                userId: req.user?.id,
                source: env[INSTANCE_OPERATOR_KEY] === undefined ? (managedOperator(env) as { source: string }).source : 'host environment'
            },
            mutable: env[INSTANCE_OPERATOR_KEY] === undefined,
            owners: owners.map((u) => ({ id: u.id, email: u.email }))
        }
    }
    try {
        const allowed = await eligibility(req, env)
        const challenge = readState(env).challenge
        return {
            state: allowed.state,
            proofPurpose: allowed.purpose,
            reauthenticateUrl: who.reauthenticateUrl,
            proofPending: Boolean(
                challenge &&
                    challenge.user === who.user &&
                    challenge.session === who.session &&
                    challenge.purpose === allowed.purpose &&
                    challenge.expires > Date.now()
            )
        }
    } catch {
        return { state: 'RecoveryRequired', proofPurpose: null }
    }
}

/** Shared lock serializes proof issuance, attempts, publication and the host recovery writer across processes. */
export async function operatorPanelAction(req: Request, env: Env, action: string): Promise<unknown> {
    const origin = req.get('origin')
    if (origin) {
        try {
            const expected = new URL(env.APP_URL || `${req.protocol}://${req.get('host')}`).origin
            if (new URL(origin).origin !== expected) denied()
        } catch {
            denied()
        }
    }
    return withNamedLock(settingsDir(env), OPERATOR_BINDING_LOCK, async () => {
        const who = await principal(req, true)
        if (env[INSTANCE_OPERATOR_KEY] !== undefined) denied()
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
        const previous = operatorBindingSnapshot(env)
        if (action === 'request' || action === 'claim' || action === 'rebind' || action === 'recover') {
            const purpose = action === 'request' ? body.purpose : action
            if (purpose !== 'claim' && purpose !== 'rebind' && purpose !== 'recover') denied()
            const allowed = await eligibility(req, env)
            if (purpose !== allowed.purpose) denied()
            confirmation(body, purpose.toUpperCase())
            const state = readState(env)
            const installation = operatorInstallation(env)
            const userKey = digest(who.user)
            const budget = state.users[userKey] ?? { requests: 0, attempts: 0 }
            const now = Date.now()
            if (action === 'request') {
                if (
                    (state.challenge && state.challenge.expires > now) ||
                    now - state.lastRequest < TTL ||
                    state.global.requests >= 4 ||
                    budget.requests >= 2 ||
                    (Object.keys(state.users).length >= 16 && !state.users[userKey])
                )
                    limited()
                const code = randomBytes(32).toString('base64url')
                state.challenge = {
                    hash: digest('operator-' + purpose + '\n' + code),
                    user: who.user,
                    session: who.session,
                    database: who.database,
                    snapshot: digest(previous ?? 'missing'),
                    installation,
                    epoch: who.epoch,
                    purpose,
                    expires: now + TTL
                }
                state.lastRequest = now
                state.global.requests++
                budget.requests++
                state.users[userKey] = budget
                saveState(env, state)
                logOperatorClaimCode(code)
                return {
                    requested: true,
                    message: 'Read the one-time code from the host log and submit it in this session within 5 minutes.'
                }
            }
            const code = typeof body.code === 'string' && body.code.length <= 128 ? body.code : ''
            const c = state.challenge
            const valid =
                c &&
                c.expires > now &&
                c.user === who.user &&
                c.session === who.session &&
                c.database === who.database &&
                c.snapshot === digest(previous ?? 'missing') &&
                c.installation === installation &&
                c.epoch === who.epoch &&
                c.purpose === purpose &&
                timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(digest('operator-' + purpose + '\n' + code), 'hex'))
            if (valid) delete state.challenge
            else {
                // Wrong guesses cannot consume the rightful requester's proof or deny its correct redemption.
                if (state.global.attempts >= 20 || budget.attempts >= 5 || (Object.keys(state.users).length >= 16 && !state.users[userKey]))
                    limited()
                state.global.attempts++
                budget.attempts++
                state.users[userKey] = budget
            }
            saveState(env, state)
            if (!valid)
                throw new SettingsError(
                    403,
                    'OPERATOR_CODE_REJECTED',
                    'The operator proof code is invalid, expired or belongs to another session.'
                )
            // SQL and session checks have completed under the lock. Recheck host precedence and actual fingerprint at publication.
            if (env[INSTANCE_OPERATOR_KEY] !== undefined || who.database !== operatorDatabaseFingerprint(getDataSource().options)) denied()
            publishOperator({ userId: who.user, database: who.database }, previous, env, who.user, purpose)
            return { changed: true }
        }
        if (!(await isInstanceOperator(req, env))) denied()
        if (action !== 'transfer' && action !== 'revoke') denied()
        confirmation(body, action === 'transfer' ? 'TRANSFER' : 'REVOKE')
        let target: string | null = null
        if (action === 'transfer') {
            if (typeof body.userId !== 'string' || body.userId === who.user) denied()
            const {
                entities: { User, OrganizationUser, Role }
            } = await import('../database/entities')
            const owner = await getDataSource()
                .getRepository(OrganizationUser)
                .createQueryBuilder('ou')
                .innerJoin(User, 'u', 'u.id = ou.userId')
                .innerJoin(Role, 'r', 'r.id = ou.roleId')
                .where('ou.userId = :id AND ou.organizationId = :org', { id: body.userId, org: req.user?.activeOrganizationId })
                .andWhere('LOWER(u.status) = :active AND LOWER(ou.status) = :active AND LOWER(r.name) = :owner', {
                    active: 'active',
                    owner: 'owner'
                })
                .getOne()
            if (!owner) denied()
            target = body.userId
        }
        if (env[INSTANCE_OPERATOR_KEY] !== undefined || who.database !== operatorDatabaseFingerprint(getDataSource().options)) denied()
        // Invalidate old proofs before publishing; failed publication requires a fresh proof.
        const state = readState(env)
        delete state.challenge
        saveState(env, state)
        publishOperator(target ? { userId: target, database: who.database } : null, previous, env, who.user, action)
        return { changed: true }
    })
}
