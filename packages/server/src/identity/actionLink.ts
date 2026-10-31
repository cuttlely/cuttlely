/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * One-time invite and reset links. The raw token is returned once, in a URL
 * fragment, and only its SHA-256 is stored. A newer link for the same user,
 * purpose, and workspace invalidates the older one. Accepting a reset link
 * ends that user's local sessions in the same transaction as the password write.
 */

import { connect as netConnect, Socket } from 'net'
import { randomUUID } from 'crypto'
import { connect as tlsConnect } from 'tls'
import { accountLinkSnapshot, effectiveAccountEnv } from '../settings/accountLinks'
import { safeRecordAudit } from './auditLog'
import { workosConfigured } from './constants'
import { utcDbTime } from './dbTime'
import { DirectoryActor, DirectoryError, QueryFn, Sql, createEmailUser } from './directory'
import { hashPassword, hashSessionToken, passwordErrors, randomToken } from './password'
import { LoginRateLimit, LoginLimiter } from './rateLimit'
import { publicOrigin } from './setupCode'
import { HandlerResult, InviteSignIn } from './types'

export const LINK_INVALID = 'This link is not valid.'
export const MAIL_REQUIRED = 'Mail is not configured. Set link to true to receive a one-time link, or configure mail first.'
export const MAIL_FAILED = 'Mail could not be sent. Nothing was saved.'
export const TOO_MANY_LINKS = 'Too many attempts. Try again later.'
export const PASSWORD_SAVED = 'Password saved.'
export const INVITE_NEEDS_AUTHKIT =
    'This invite is accepted by signing in with WorkOS, not with a password. Open your invite link and select Accept invite with WorkOS.'

const INVITE_DEFAULT_HOURS = 72
const INVITE_MIN_HOURS = 1
const INVITE_MAX_HOURS = 168
const RESET_DEFAULT_MINUTES = 60
const RESET_MIN_MINUTES = 5
const RESET_MAX_MINUTES = 1440
const RETAIN_USED_MS = 24 * 60 * 60 * 1000

export type LinkPurpose = 'invite' | 'reset'

export interface OutboundMail {
    to: string
    subject: string
    text: string
}

export interface LinkDeps {
    now(): number
    env: NodeJS.ProcessEnv
    origin(): string
    mailReady(): boolean
    send(message: OutboundMail): Promise<void>
    rateLimit: LoginLimiter
}

interface AuditRow {
    action: string
    purpose: string
    organizationId: string
    workspaceId: string
    userId: string
    actorId: string
    result: 'success' | 'failed'
    reason: string
}

const metrics = { issued: 0, accepted: 0, expired: 0, resetFailed: 0 }
const acceptLimiter = new LoginRateLimit()

/** Counts only. No address, user, or token label. */
export function actionLinkMetrics(): { issued: number; accepted: number; expired: number; resetFailed: number } {
    return { ...metrics }
}

export function smtpReady(env: NodeJS.ProcessEnv = effectiveAccountEnv(process.env) as NodeJS.ProcessEnv): boolean {
    return Boolean((env.SMTP_HOST || '').trim() && (env.SENDER_EMAIL || '').trim())
}

function defaultDeps(): LinkDeps {
    const env = effectiveAccountEnv(process.env) as NodeJS.ProcessEnv
    return {
        now: () => Date.now(),
        env,
        origin: () => publicOrigin(process.env.PORT || '3000'),
        mailReady: () => smtpReady(env),
        send: (message) => sendSmtp(message, env),
        rateLimit: acceptLimiter
    }
}

/** Hours for an invite, minutes for a reset. A saved panel value overrides the environment. Blank, zero, negative, and non-integers use the next value. Values past the cap are clamped. */
export function actionTtlMs(purpose: LinkPurpose, env: NodeJS.ProcessEnv = process.env): number {
    const snap = accountLinkSnapshot(env)
    if (purpose === 'invite') {
        const hours = boundedInt(snap.get('INVITE_TOKEN_EXPIRY_IN_HOURS')?.value, INVITE_DEFAULT_HOURS, INVITE_MIN_HOURS, INVITE_MAX_HOURS)
        return hours * 60 * 60 * 1000
    }
    const minutes = boundedInt(
        snap.get('PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS')?.value,
        RESET_DEFAULT_MINUTES,
        RESET_MIN_MINUTES,
        RESET_MAX_MINUTES
    )
    return minutes * 60 * 1000
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback
    if (!/^[0-9]+$/.test(raw.trim())) return fallback
    const value = Number(raw.trim())
    if (!Number.isSafeInteger(value) || value <= 0) return fallback
    if (value < min) return min
    if (value > max) return max
    return value
}

export function linkMode(body: unknown): true | false | undefined {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    if (!Object.prototype.hasOwnProperty.call(record, 'link')) return undefined
    if (record.link === true) return true
    if (record.link === false) return false
    throw new DirectoryError(400, 'link must be true or false')
}

/**
 * An explicit link field wins. Otherwise the invite delivery setting fills in. Reset links are unchanged.
 * With AuthKit on, an invite always carries a link, because the invite link is the only way to join.
 */
function inviteMode(body: unknown, env: NodeJS.ProcessEnv): true | false | undefined {
    const explicit = linkMode(body)
    if (explicit !== undefined) return explicit
    const delivery = (env.INVITE_DELIVERY || accountLinkSnapshot(env).get('INVITE_DELIVERY')?.value || '').trim()
    if (delivery === 'link') return true
    if (delivery === 'email') return false
    return workosConfigured(env) ? true : undefined
}

/** Fragment only. The browser posts the token. The server path and query do not carry it. */
export function oneTimeLink(origin: string, token: string): string {
    const base = origin.replace(/\/$/, '')
    return `${base}/local-accept#token=${encodeURIComponent(token)}`
}

function q(sql: Sql, name: string): string {
    if (sql.type === 'mysql' || sql.type === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

function cell(row: Record<string, unknown>, name: string): unknown {
    if (name in row) return row[name]
    const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase())
    return found ? row[found] : undefined
}

function text(value: unknown): string {
    if (value === null || value === undefined) return ''
    return String(value)
}

function emailOf(body: unknown): string {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const user = record.user && typeof record.user === 'object' ? (record.user as Record<string, unknown>) : {}
    return text(user.email).trim()
}

function workspaceOf(body: unknown): string {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const workspace = record.workspace && typeof record.workspace === 'object' ? (record.workspace as Record<string, unknown>) : {}
    return text(workspace.id).trim()
}

function canIssueLinks(actor: DirectoryActor): boolean {
    if (actor.owner) return true
    return Boolean(actor.permissions?.includes('users:manage'))
}

/**
 * `workspace:add-user` may send the invite link for an invite into the caller's own active team. createEmailUser
 * still refuses another team and a role with a permission the caller does not hold.
 */
function canIssueInviteLink(actor: DirectoryActor, workspaceId: string): boolean {
    if (canIssueLinks(actor)) return true
    return Boolean(actor.permissions?.includes('workspace:add-user') && actor.workspaceId && actor.workspaceId === workspaceId)
}

/**
 * Milliseconds from a driver value. Postgres returns a real Date. MySQL and MariaDB store UTC wall
 * time with no zone: a Date from the driver was built in local time, and a `YYYY-MM-DD HH:MM:SS`
 * string is the same wall time. Both are read as UTC. The SQL compare binds that same wall string.
 */
export function linkClock(value: unknown, dialect?: Sql['type']): number {
    if (value instanceof Date) {
        if (dialect === 'mysql' || dialect === 'mariadb') {
            return Date.UTC(
                value.getFullYear(),
                value.getMonth(),
                value.getDate(),
                value.getHours(),
                value.getMinutes(),
                value.getSeconds(),
                value.getMilliseconds()
            )
        }
        return value.getTime()
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    const text = String(value).trim()
    const zoneLess = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text)
    if (zoneLess) {
        const fraction = (zoneLess[7] || '').slice(0, 3).padEnd(3, '0')
        return Date.UTC(+zoneLess[1], +zoneLess[2] - 1, +zoneLess[3], +zoneLess[4], +zoneLess[5], +zoneLess[6], +fraction || 0)
    }
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? 0 : parsed
}

export function linkDbTime(dialect: Sql['type'], ms: number): Date | string {
    return utcDbTime(dialect, ms)
}

function dbTime(sql: Sql, ms: number): Date | string {
    return linkDbTime(sql.type, ms)
}

async function writeAudit(query: QueryFn, sql: Sql, row: AuditRow, at: number): Promise<void> {
    await query(
        `INSERT INTO ${q(sql, 'identity_action_audit')} (
            ${q(sql, 'id')}, ${q(sql, 'action')}, ${q(sql, 'purpose')}, ${q(sql, 'organizationId')}, ${q(sql, 'workspaceId')},
            ${q(sql, 'userId')}, ${q(sql, 'actorId')}, ${q(sql, 'result')}, ${q(sql, 'reason')}, ${q(sql, 'createdDate')}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            randomUUID(),
            row.action,
            row.purpose,
            row.organizationId,
            row.workspaceId,
            row.userId,
            row.actorId,
            row.result,
            row.reason,
            dbTime(sql, at)
        ]
    )
}

async function cleanup(query: QueryFn, sql: Sql, now: number): Promise<void> {
    await query(
        `DELETE FROM ${q(sql, 'identity_action_link')} WHERE ${q(sql, 'expiresAt')} < ? OR (${q(sql, 'usedAt')} IS NOT NULL AND ${q(
            sql,
            'usedAt'
        )} < ?)`,
        [dbTime(sql, now), dbTime(sql, now - RETAIN_USED_MS)]
    )
}

async function supersedeOpenLinks(
    query: QueryFn,
    sql: Sql,
    input: { purpose: LinkPurpose; actor: DirectoryActor; userId: string; workspaceId: string; now: number; keepId?: string }
): Promise<void> {
    const params: unknown[] = [input.userId, input.purpose, input.workspaceId]
    let except = ''
    if (input.keepId) {
        except = ` AND ${q(sql, 'id')} <> ?`
        params.push(input.keepId)
    }
    const older = await query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'identity_action_link')}
         WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'purpose')} = ? AND ${q(sql, 'workspaceId')} = ? AND ${q(
            sql,
            'usedAt'
        )} IS NULL${except}`,
        params
    )
    if (!older.length) return
    await query(
        `UPDATE ${q(sql, 'identity_action_link')} SET ${q(sql, 'usedAt')} = ?, ${q(sql, 'consumeId')} = ?
         WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'purpose')} = ? AND ${q(sql, 'workspaceId')} = ? AND ${q(
            sql,
            'usedAt'
        )} IS NULL${except}`,
        [dbTime(sql, input.now), 'superseded', ...params]
    )
    for (let index = 0; index < older.length; index += 1) {
        await writeAudit(
            query,
            sql,
            {
                action: 'token_rejected',
                purpose: input.purpose,
                organizationId: input.actor.organizationId,
                workspaceId: input.workspaceId,
                userId: input.userId,
                actorId: input.actor.id,
                result: 'success',
                reason: 'superseded'
            },
            input.now
        )
    }
}

async function issueToken(
    query: QueryFn,
    sql: Sql,
    input: {
        purpose: LinkPurpose
        actor: DirectoryActor
        userId: string
        workspaceId: string
        now: number
        env: NodeJS.ProcessEnv
        /** Email-only reset keeps older links until the message is sent. */
        holdPrevious?: boolean
    }
): Promise<{ raw: string; id: string }> {
    const raw = randomToken()
    const id = randomUUID()
    const hash = hashSessionToken(raw)
    await cleanup(query, sql, input.now)
    if (!input.holdPrevious) await supersedeOpenLinks(query, sql, input)
    await query(
        `INSERT INTO ${q(sql, 'identity_action_link')} (
            ${q(sql, 'id')}, ${q(sql, 'tokenHash')}, ${q(sql, 'purpose')}, ${q(sql, 'organizationId')}, ${q(sql, 'workspaceId')},
            ${q(sql, 'userId')}, ${q(sql, 'expiresAt')}, ${q(sql, 'usedAt')}, ${q(sql, 'consumeId')}, ${q(sql, 'createdBy')}, ${q(
            sql,
            'createdDate'
        )}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
            id,
            hash,
            input.purpose,
            input.actor.organizationId,
            input.workspaceId,
            input.userId,
            dbTime(sql, input.now + actionTtlMs(input.purpose, input.env)),
            input.actor.id,
            dbTime(sql, input.now)
        ]
    )
    await writeAudit(
        query,
        sql,
        {
            action: 'link_issued',
            purpose: input.purpose,
            organizationId: input.actor.organizationId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            actorId: input.actor.id,
            result: 'success',
            reason: 'issued'
        },
        input.now
    )
    metrics.issued += 1
    return { raw, id }
}

async function removeFreshUser(sql: Sql, userId: string): Promise<void> {
    await sql.query(`DELETE FROM ${q(sql, 'identity_action_link')} WHERE ${q(sql, 'userId')} = ?`, [userId])
    await sql.query(`DELETE FROM ${q(sql, 'identity_action_audit')} WHERE ${q(sql, 'userId')} = ?`, [userId])
    await sql.query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'userId')} = ?`, [userId])
    await sql.query(`DELETE FROM ${q(sql, 'organization_user')} WHERE ${q(sql, 'userId')} = ?`, [userId])
    await sql.query(`DELETE FROM ${q(sql, 'user')} WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'credential')} IS NULL`, [userId])
}

async function deliver(deps: LinkDeps, to: string, purpose: LinkPurpose, link: string): Promise<boolean> {
    if (!deps.mailReady()) return false
    const join = purpose === 'invite' && workosConfigured(deps.env)
    const subject = join ? 'Join Cuttlely' : purpose === 'invite' ? 'Set your Cuttlely password' : 'Reset your Cuttlely password'
    const action = join ? 'accept your invite and sign in' : 'set a password'
    const text = `Open this one-time link to ${action}. It works once. Do not share it.\n\n${link}\n`
    await deps.send({ to, subject, text })
    return true
}

export async function inviteAccount(
    sql: Sql,
    actor: DirectoryActor,
    body: unknown,
    deps: LinkDeps = defaultDeps()
): Promise<{ id: string; link?: string; mailed?: boolean }> {
    const mode = inviteMode(body, deps.env)
    const workspaceId = workspaceOf(body)
    if (mode !== undefined && !canIssueInviteLink(actor, workspaceId)) throw new DirectoryError(403, 'Forbidden')
    if (mode === false && !deps.mailReady()) throw new DirectoryError(400, MAIL_REQUIRED)
    let raw = ''
    const created = await createEmailUser(sql, actor, body, async (query, userId) => {
        if (mode === undefined) return
        raw = (await issueToken(query, sql, { purpose: 'invite', actor, userId, workspaceId, now: deps.now(), env: deps.env })).raw
    })
    const noteInvite = (mailed: boolean) =>
        safeRecordAudit(sql, {
            type: 'invite',
            organizationId: actor.organizationId,
            workspaceId,
            userId: created.id,
            actorId: actor.id,
            summary: 'Invite issued',
            detail: { mailed }
        })
    if (mode === undefined) {
        await noteInvite(false)
        return { id: created.id }
    }
    const link = oneTimeLink(deps.origin(), raw)
    if (mode === true) {
        let mailed = false
        if (deps.mailReady()) {
            try {
                mailed = await deliver(deps, emailOf(body), 'invite', link)
            } catch {
                mailed = false
            }
        }
        await noteInvite(mailed)
        return deps.mailReady() ? { id: created.id, link, mailed } : { id: created.id, link }
    }
    try {
        await deliver(deps, emailOf(body), 'invite', link)
    } catch {
        await removeFreshUser(sql, created.id)
        throw new DirectoryError(502, MAIL_FAILED)
    }
    await noteInvite(true)
    return { id: created.id, mailed: true }
}

interface TargetRow {
    id: string
    email: string
    status: string
    externalId: string
    ssoProvider: string
    ssoSubjectId: string
    orgStatus: string
    orgRoleName: string
    teamStatus: string
    teamRoleName: string
    permissions: string
    orgPermissions: string
}

async function loadTarget(
    query: QueryFn,
    sql: Sql,
    organizationId: string,
    workspaceId: string,
    userId: string
): Promise<TargetRow | null> {
    const rows = await query(
        `SELECT u.${q(sql, 'id')} AS id, u.${q(sql, 'email')} AS email, u.${q(sql, 'status')} AS status,
                u.${q(sql, 'externalId')} AS externalId,
                u.${q(sql, 'ssoProvider')} AS ssoProvider, u.${q(sql, 'ssoSubjectId')} AS ssoSubjectId,
                ou.${q(sql, 'status')} AS orgStatus, orgRole.${q(sql, 'name')} AS orgRoleName,
                orgRole.${q(sql, 'permissions')} AS orgPermissions,
                wu.${q(sql, 'status')} AS teamStatus, teamRole.${q(sql, 'name')} AS teamRoleName,
                teamRole.${q(sql, 'permissions')} AS permissions
         FROM ${q(sql, 'user')} u
         LEFT JOIN ${q(sql, 'organization_user')} ou
           ON ou.${q(sql, 'userId')} = u.${q(sql, 'id')} AND ou.${q(sql, 'organizationId')} = ?
         LEFT JOIN ${q(sql, 'role')} orgRole ON orgRole.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         LEFT JOIN ${q(sql, 'workspace_user')} wu
           ON wu.${q(sql, 'userId')} = u.${q(sql, 'id')} AND wu.${q(sql, 'workspaceId')} = ?
         LEFT JOIN ${q(sql, 'role')} teamRole ON teamRole.${q(sql, 'id')} = wu.${q(sql, 'roleId')}
         WHERE u.${q(sql, 'id')} = ?`,
        [organizationId, workspaceId, userId]
    )
    const row = rows[0]
    if (!row) return null
    return {
        id: text(cell(row, 'id')),
        email: text(cell(row, 'email')),
        status: text(cell(row, 'status')).toLowerCase(),
        externalId: text(cell(row, 'externalId')),
        ssoProvider: text(cell(row, 'ssoProvider')),
        ssoSubjectId: text(cell(row, 'ssoSubjectId')),
        orgStatus: text(cell(row, 'orgStatus')).toLowerCase(),
        orgRoleName: text(cell(row, 'orgRoleName')).toLowerCase(),
        teamStatus: text(cell(row, 'teamStatus')).toLowerCase(),
        teamRoleName: text(cell(row, 'teamRoleName')).toLowerCase(),
        permissions: text(cell(row, 'permissions')),
        orgPermissions: text(cell(row, 'orgPermissions'))
    }
}

function permissionList(value: string): string[] {
    if (!value) return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}

type Block = 'missing' | 'disabled' | 'owner' | 'sso' | 'service' | 'workspace' | 'higher'

/** A pending (`invited`) user passes only for an invite. An AuthKit invite may carry the owner role the inviter granted. */
function blockReason(target: TargetRow | null, purpose: LinkPurpose = 'reset', allowOwner = false): Block | null {
    if (!target || target.status === 'deleted' || !target.orgStatus) return 'missing'
    if (target.orgRoleName === 'owner' && !allowOwner) return 'owner'
    if (target.status === 'service' || target.ssoProvider.toLowerCase() === 'service' || target.teamRoleName === 'service account') {
        return 'service'
    }
    if (target.externalId || target.ssoProvider || target.ssoSubjectId) return 'sso'
    const pending = purpose === 'invite' && target.status === 'invited'
    if ((target.status !== 'active' && !pending) || target.orgStatus === 'disable') return 'disabled'
    if (!target.teamStatus) return 'workspace'
    if (target.teamStatus === 'disable') return 'disabled'
    if (target.teamStatus !== 'active' && target.teamStatus !== 'invited') return 'disabled'
    return null
}

function resetBlock(actor: DirectoryActor, target: TargetRow, purpose: LinkPurpose = 'reset'): Block | null {
    // Only an owner can grant the owner role, so only an owner may send a new link for a pending owner invite.
    const blocked = blockReason(target, purpose, purpose === 'invite' && Boolean(actor.owner))
    if (blocked) return blocked
    if (actor.owner) return null
    const held = new Set(actor.permissions || [])
    const grants = [...permissionList(target.permissions), ...permissionList(target.orgPermissions)]
    if (grants.some((permission) => !held.has(permission))) return 'higher'
    return null
}

function resetError(reason: Block): DirectoryError {
    if (reason === 'missing' || reason === 'workspace') return new DirectoryError(404, 'User not found')
    if (reason === 'owner') return new DirectoryError(403, 'The organization owner cannot be reset from a link.')
    if (reason === 'sso') return new DirectoryError(403, 'This account signs in with an outside identity and has no local password.')
    if (reason === 'service') return new DirectoryError(403, 'A service account cannot be reset from a link.')
    if (reason === 'higher') return new DirectoryError(403, 'You cannot reset this account.')
    return new DirectoryError(403, 'This account is disabled.')
}

export async function resetLocalLink(
    sql: Sql,
    actor: DirectoryActor,
    userId: string,
    body: unknown,
    deps: LinkDeps = defaultDeps()
): Promise<{ link?: string; mailed?: boolean }> {
    try {
        return await resetLocalLinkInner(sql, actor, userId, body, deps)
    } catch (error) {
        metrics.resetFailed += 1
        throw error
    }
}

async function resetLocalLinkInner(
    sql: Sql,
    actor: DirectoryActor,
    userId: string,
    body: unknown,
    deps: LinkDeps
): Promise<{ link?: string; mailed?: boolean }> {
    const mode = linkMode(body)
    const wantsLink = mode !== false
    if (!wantsLink && !deps.mailReady()) throw new DirectoryError(400, MAIL_REQUIRED)
    if (!actor.workspaceId) throw new DirectoryError(400, 'Choose a team')
    const target = await loadTarget(sql.query, sql, actor.organizationId, actor.workspaceId, userId.trim())
    // A pending invite gets a fresh invite link. It replaces the older invite link and still needs the invite flow.
    const purposeFor = (row: TargetRow | null): LinkPurpose => (row?.status === 'invited' ? 'invite' : 'reset')
    let purpose = purposeFor(target)
    const blocked = target ? resetBlock(actor, target, purpose) : 'missing'
    if (blocked) throw resetError(blocked)
    let issued = { raw: '', id: '' }
    const workspaceId = actor.workspaceId || ''
    await sql.transaction(async (query) => {
        const again = await loadTarget(query, sql, actor.organizationId, workspaceId, userId.trim())
        purpose = purposeFor(again)
        const still = again ? resetBlock(actor, again, purpose) : 'missing'
        if (still) throw resetError(still)
        issued = await issueToken(query, sql, {
            purpose,
            actor,
            userId: userId.trim(),
            workspaceId,
            now: deps.now(),
            env: deps.env,
            holdPrevious: !wantsLink
        })
    })
    const link = oneTimeLink(deps.origin(), issued.raw)
    const address = await userEmail(sql, userId.trim())
    if (!wantsLink) {
        try {
            await deliver(deps, address, purpose, link)
        } catch {
            await sql.query(
                `UPDATE ${q(sql, 'identity_action_link')} SET ${q(sql, 'usedAt')} = ?, ${q(sql, 'consumeId')} = ?
                 WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'usedAt')} IS NULL`,
                [dbTime(sql, deps.now()), 'unsent', issued.id, workspaceId]
            )
            throw new DirectoryError(502, MAIL_FAILED)
        }
        await supersedeOpenLinks(sql.query, sql, {
            purpose,
            actor,
            userId: userId.trim(),
            workspaceId,
            now: deps.now(),
            keepId: issued.id
        })
        await safeRecordAudit(sql, {
            type: purpose,
            organizationId: actor.organizationId,
            workspaceId,
            userId: userId.trim(),
            actorId: actor.id,
            summary: purpose === 'invite' ? 'Invite issued' : 'Password reset link issued',
            detail: { action: 'issued', mailed: true }
        })
        return { mailed: true }
    }
    let mailed = false
    if (deps.mailReady()) {
        try {
            mailed = await deliver(deps, address, purpose, link)
        } catch {
            mailed = false
        }
    }
    await safeRecordAudit(sql, {
        type: purpose,
        organizationId: actor.organizationId,
        workspaceId,
        userId: userId.trim(),
        actorId: actor.id,
        summary: purpose === 'invite' ? 'Invite issued' : 'Password reset link issued',
        detail: { action: 'issued', mailed }
    })
    return deps.mailReady() ? { link, mailed } : { link }
}

async function userEmail(sql: Sql, userId: string): Promise<string> {
    const rows = await sql.query(`SELECT ${q(sql, 'email')} AS email FROM ${q(sql, 'user')} WHERE ${q(sql, 'id')} = ?`, [userId])
    return text(cell(rows[0] || {}, 'email'))
}

interface StoredLink {
    tokenHash: string
    purpose: string
    organizationId: string
    workspaceId: string
    userId: string
    /** Milliseconds. 0 when the driver value cannot be read. */
    expiresAt: number
    usedAt: string
}

async function findLink(query: QueryFn, sql: Sql, hash: string): Promise<StoredLink | null> {
    const rows = await query(
        `SELECT ${q(sql, 'tokenHash')} AS tokenHash, ${q(sql, 'purpose')} AS purpose,
                ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'workspaceId')} AS workspaceId,
                ${q(sql, 'userId')} AS userId, ${q(sql, 'expiresAt')} AS expiresAt, ${q(sql, 'usedAt')} AS usedAt
         FROM ${q(sql, 'identity_action_link')} WHERE ${q(sql, 'tokenHash')} = ?`,
        [hash]
    )
    const row = rows[0]
    if (!row) return null
    return {
        tokenHash: text(cell(row, 'tokenHash')),
        purpose: text(cell(row, 'purpose')),
        organizationId: text(cell(row, 'organizationId')),
        workspaceId: text(cell(row, 'workspaceId')),
        userId: text(cell(row, 'userId')),
        expiresAt: linkClock(cell(row, 'expiresAt'), sql.type),
        usedAt: text(cell(row, 'usedAt'))
    }
}

export interface AcceptInput {
    body: Record<string, unknown>
    /** Ignored. A token in the query is not a credential. */
    query: Record<string, unknown>
    ip: string
    now: number
}

export async function acceptLocalPassword(sql: Sql, input: AcceptInput, deps: LinkDeps = defaultDeps()): Promise<HandlerResult> {
    if (await deps.rateLimit.blocked(input.ip, '', input.now)) return json(429, { message: TOO_MANY_LINKS })
    const token = typeof input.body.token === 'string' ? input.body.token : ''
    const password = typeof input.body.password === 'string' ? input.body.password : ''
    if (!token) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        return json(400, { message: LINK_INVALID })
    }
    // Strength is checked before the token is read, so a weak password does not show that the token is live.
    const problems = passwordErrors(password)
    if (problems.length) return json(400, { message: problems[0] })
    const hash = hashSessionToken(token)
    const found = await findLink(sql.query, sql, hash)
    if (!found || (found.purpose !== 'invite' && found.purpose !== 'reset')) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, 'unknown', input.now)
        return json(400, { message: LINK_INVALID })
    }
    if (found.usedAt) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, 'reused', input.now)
        return json(400, { message: LINK_INVALID })
    }
    if (!found.expiresAt || found.expiresAt <= input.now) {
        metrics.expired += 1
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, 'expired', input.now)
        return json(400, { message: LINK_INVALID })
    }
    const target = await loadTarget(sql.query, sql, found.organizationId, found.workspaceId, found.userId)
    // With AuthKit on, a live owner invite reaches the AuthKit refusal below, which never sets a password.
    const authKitInvite = found.purpose === 'invite' && workosConfigured(deps.env)
    const blocked = blockReason(target, found.purpose as LinkPurpose, authKitInvite)
    if (blocked) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, blocked, input.now)
        return json(400, { message: LINK_INVALID })
    }
    // With AuthKit on, only the AuthKit callback may use an invite: it checks the verified email and binds the sign-in.
    // Checked last, so a used, expired, or revoked token gets the same answer as any other invalid link.
    if (authKitInvite) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, 'authkit-only', input.now)
        return json(400, { message: INVITE_NEEDS_AUTHKIT })
    }
    const credential = await hashPassword(password)
    const consumeId = randomUUID()
    let won = false
    try {
        await sql.transaction(async (query) => {
            await query(
                `UPDATE ${q(sql, 'identity_action_link')} SET ${q(sql, 'usedAt')} = ?, ${q(sql, 'consumeId')} = ?
                 WHERE ${q(sql, 'tokenHash')} = ? AND ${q(sql, 'usedAt')} IS NULL AND ${q(sql, 'expiresAt')} > ?`,
                [dbTime(sql, input.now), consumeId, hash, dbTime(sql, input.now)]
            )
            const marked = await query(
                `SELECT ${q(sql, 'userId')} AS userId, ${q(sql, 'purpose')} AS purpose, ${q(sql, 'organizationId')} AS organizationId,
                        ${q(sql, 'workspaceId')} AS workspaceId
                 FROM ${q(sql, 'identity_action_link')} WHERE ${q(sql, 'consumeId')} = ?`,
                [consumeId]
            )
            if (!marked.length) throw new Error('lost')
            const userId = text(cell(marked[0], 'userId'))
            const purpose = text(cell(marked[0], 'purpose'))
            const organizationId = text(cell(marked[0], 'organizationId'))
            const workspaceId = text(cell(marked[0], 'workspaceId'))
            if (purpose === 'invite' && workosConfigured(deps.env)) throw new Error('authkit-only')
            const again = await loadTarget(query, sql, organizationId, workspaceId, userId)
            if (blockReason(again, purpose as LinkPurpose)) throw new Error('ineligible')
            await query(
                `UPDATE ${q(sql, 'user')} SET ${q(sql, 'credential')} = ?, ${q(sql, 'updatedDate')} = ? WHERE ${q(sql, 'id')} = ?`,
                [credential, dbTime(sql, input.now), userId]
            )
            if (purpose === 'invite') await activatePending(query, sql, userId, input.now)
            await writeAudit(
                query,
                sql,
                {
                    action: 'token_consumed',
                    purpose,
                    organizationId,
                    workspaceId,
                    userId,
                    actorId: userId,
                    result: 'success',
                    reason: 'consumed'
                },
                input.now
            )
            await writeAudit(
                query,
                sql,
                {
                    action: 'password_set',
                    purpose,
                    organizationId,
                    workspaceId,
                    userId,
                    actorId: userId,
                    result: 'success',
                    reason: 'set'
                },
                input.now
            )
            if (purpose === 'reset') {
                await query(`DELETE FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'userId')} = ?`, [userId])
                await writeAudit(
                    query,
                    sql,
                    {
                        action: 'sessions_revoked',
                        purpose,
                        organizationId,
                        workspaceId,
                        userId,
                        actorId: userId,
                        result: 'success',
                        reason: 'reset'
                    },
                    input.now
                )
            }
            won = true
        })
    } catch {
        won = false
    }
    if (!won) {
        await deps.rateLimit.recordFailure(input.ip, '', input.now)
        await rejectAudit(sql, found, 'reused', input.now)
        return json(400, { message: LINK_INVALID })
    }
    metrics.accepted += 1
    await safeRecordAudit(sql, {
        type: found.purpose === 'invite' ? 'invite' : 'reset',
        organizationId: found.organizationId,
        workspaceId: found.workspaceId,
        userId: found.userId,
        actorId: found.userId,
        summary: found.purpose === 'invite' ? 'Invite accepted' : 'Password reset',
        detail: { action: 'completed' }
    })
    return json(200, { message: PASSWORD_SAVED })
}

async function rejectAudit(sql: Sql, found: StoredLink | null, reason: string, now: number): Promise<void> {
    await writeAudit(
        sql.query,
        sql,
        {
            action: 'token_rejected',
            purpose: found?.purpose || 'reset',
            organizationId: found?.organizationId || '',
            workspaceId: found?.workspaceId || '',
            userId: found?.userId || '',
            actorId: found?.userId || '',
            result: 'failed',
            reason
        },
        now
    )
}

async function activatePending(query: QueryFn, sql: Sql, userId: string, now: number): Promise<void> {
    await query(
        `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = ?
         WHERE ${q(sql, 'id')} = ? AND LOWER(${q(sql, 'status')}) = 'invited'`,
        ['active', dbTime(sql, now), userId]
    )
}

function tokenRefusal(found: StoredLink | null, input: InviteSignIn): string | null {
    if (!found || found.purpose !== 'invite') return 'unknown'
    if (found.usedAt) return 'reused'
    if (!found.expiresAt || found.expiresAt <= input.now) return 'expired'
    if (found.userId !== input.userId) return 'other-user'
    return null
}

/** The invite still stands: same team and organization, not removed or disabled, and the mailbox is the one invited. */
async function inviteTargetRefusal(query: QueryFn, sql: Sql, found: StoredLink, input: InviteSignIn): Promise<string | null> {
    const target = await loadTarget(query, sql, found.organizationId, found.workspaceId, found.userId)
    const blocked = blockReason(target, 'invite', true)
    if (blocked) return blocked
    if (!target || target.status !== 'invited') return 'not-pending'
    if (target.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) return 'other-email'
    return null
}

/**
 * AuthKit sign-in with an invite link. The token is used, the user activated, and the AuthKit id bound in one
 * transaction, so a second sign-in with the same link finds the token used.
 */
export async function acceptAuthKitInvite(sql: Sql, input: InviteSignIn): Promise<'accepted' | 'invalid'> {
    const hash = hashSessionToken(input.token)
    const found = await findLink(sql.query, sql, hash)
    const refused = tokenRefusal(found, input) || (found ? await inviteTargetRefusal(sql.query, sql, found, input) : null)
    if (refused || !found) {
        if (refused === 'expired') metrics.expired += 1
        await rejectAudit(sql, found, refused || 'unknown', input.now)
        return 'invalid'
    }
    const consumeId = randomUUID()
    let won = false
    try {
        await sql.transaction(async (query) => {
            await query(
                `UPDATE ${q(sql, 'identity_action_link')} SET ${q(sql, 'usedAt')} = ?, ${q(sql, 'consumeId')} = ?
                 WHERE ${q(sql, 'tokenHash')} = ? AND ${q(sql, 'purpose')} = ? AND ${q(sql, 'userId')} = ?
                   AND ${q(sql, 'usedAt')} IS NULL AND ${q(sql, 'expiresAt')} > ?`,
                [dbTime(sql, input.now), consumeId, hash, 'invite', input.userId, dbTime(sql, input.now)]
            )
            const marked = await query(
                `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'identity_action_link')} WHERE ${q(sql, 'consumeId')} = ?`,
                [consumeId]
            )
            if (!marked.length) throw new Error('lost')
            if (await inviteTargetRefusal(query, sql, found, input)) throw new Error('ineligible')
            await activatePending(query, sql, input.userId, input.now)
            if (input.providerKey && input.subject && input.assuranceBasis) {
                await query(
                    `INSERT INTO ${q(sql, 'identity_provider_link')} (${q(sql, 'providerKey')}, ${q(sql, 'subject')}, ${q(
                        sql,
                        'userId'
                    )}, ${q(sql, 'emailAtLink')}, ${q(sql, 'assuranceBasis')}, ${q(sql, 'createdAt')}) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        input.providerKey,
                        input.subject,
                        input.userId,
                        input.email.trim().toLowerCase(),
                        input.assuranceBasis,
                        dbTime(sql, input.now)
                    ]
                )
            }
            if (!input.providerKey || input.retainExternalId) {
                await query(
                    `UPDATE ${q(sql, 'user')} SET ${q(sql, 'externalId')} = ?, ${q(sql, 'updatedDate')} = ?
                     WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'externalId')} IS NULL`,
                    [input.externalId, dbTime(sql, input.now), input.userId]
                )
            }
            const after = await query(
                `SELECT ${q(sql, 'status')} AS status, ${q(sql, 'externalId')} AS externalId FROM ${q(sql, 'user')} WHERE ${q(
                    sql,
                    'id'
                )} = ?`,
                [input.userId]
            )
            const row = after[0] || {}
            const providerLinked = input.providerKey
                ? (
                      await query(
                          `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'identity_provider_link')} WHERE ${q(
                              sql,
                              'providerKey'
                          )} = ? AND ${q(sql, 'subject')} = ?`,
                          [input.providerKey, input.subject]
                      )
                  ).some((linked) => text(cell(linked, 'userId')) === input.userId)
                : text(cell(row, 'externalId')) === input.externalId
            const compatibilityLinked = !input.retainExternalId || text(cell(row, 'externalId')) === input.externalId
            if (text(cell(row, 'status')).toLowerCase() !== 'active' || !providerLinked || !compatibilityLinked) {
                throw new Error('lost')
            }
            await writeAudit(
                query,
                sql,
                {
                    action: 'token_consumed',
                    purpose: 'invite',
                    organizationId: found.organizationId,
                    workspaceId: found.workspaceId,
                    userId: input.userId,
                    actorId: input.userId,
                    result: 'success',
                    reason: input.providerKey ? 'oidc' : 'authkit'
                },
                input.now
            )
            won = true
        })
    } catch {
        won = false
    }
    if (!won) {
        await rejectAudit(sql, found, 'reused', input.now)
        return 'invalid'
    }
    metrics.accepted += 1
    await safeRecordAudit(sql, {
        type: 'invite',
        organizationId: found.organizationId,
        workspaceId: found.workspaceId,
        userId: input.userId,
        actorId: input.userId,
        summary: 'Invite accepted',
        detail: { action: 'completed', method: input.providerKey ? 'oidc' : 'authkit' }
    })
    return 'accepted'
}

function json(status: number, body: unknown): HandlerResult {
    return { type: 'json', status, body }
}

const SMTP_TIMEOUT_MS = 10000

export async function sendSmtp(
    message: OutboundMail,
    env: NodeJS.ProcessEnv = effectiveAccountEnv(process.env) as NodeJS.ProcessEnv,
    timeoutMs = SMTP_TIMEOUT_MS
): Promise<void> {
    const host = (env.SMTP_HOST || '').trim()
    const from = (env.SENDER_EMAIL || '').trim()
    const port = Number((env.SMTP_PORT || '587').trim())
    if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('mail send failed')
    const implicitTls = env.SMTP_SECURE === 'true' || port === 465
    let socket: Socket = await openSocket(host, port, implicitTls, timeoutMs)
    try {
        await expectCode(socket, 220, timeoutMs)
        await command(socket, 'EHLO cuttlely', 250, timeoutMs)
        if (!implicitTls && env.SMTP_STARTTLS === 'true') {
            await command(socket, 'STARTTLS', 220, timeoutMs)
            socket = await upgrade(socket, host, timeoutMs)
            await command(socket, 'EHLO cuttlely', 250, timeoutMs)
        }
        const user = (env.SMTP_USER || '').trim()
        if (user) {
            await command(socket, 'AUTH LOGIN', 334, timeoutMs)
            await command(socket, Buffer.from(user).toString('base64'), 334, timeoutMs)
            await command(socket, Buffer.from(env.SMTP_PASSWORD || '').toString('base64'), 235, timeoutMs)
        }
        await command(socket, `MAIL FROM:<${from}>`, 250, timeoutMs)
        await command(socket, `RCPT TO:<${message.to}>`, 250, timeoutMs)
        await command(socket, 'DATA', 354, timeoutMs)
        const payload = [
            `From: ${from}`,
            `To: ${message.to}`,
            `Subject: ${message.subject.replace(/[\r\n]/g, ' ')}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            message.text
        ].join('\r\n')
        const stuffed = payload
            .split('\r\n')
            .map((line) => (line.startsWith('.') ? `.${line}` : line))
            .join('\r\n')
        await command(socket, `${stuffed}\r\n.`, 250, timeoutMs)
        await command(socket, 'QUIT', 221, timeoutMs).catch(() => '')
    } catch {
        throw new Error('mail send failed')
    } finally {
        releaseSocket(socket)
    }
}

function releaseSocket(socket: Socket): void {
    socket.setTimeout(0)
    socket.removeAllListeners()
    socket.on('error', () => undefined)
    socket.destroy()
}

function openSocket(host: string, port: number, tls: boolean, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
        let settled = false
        const fail = () => {
            if (settled) return
            settled = true
            releaseSocket(socket)
            reject(new Error('mail send failed'))
        }
        socket.setTimeout(timeoutMs)
        socket.on('timeout', fail)
        socket.on('error', fail)
        socket.on('close', fail)
        socket.once(tls ? 'secureConnect' : 'connect', () => {
            if (settled) return
            settled = true
            socket.setTimeout(0)
            socket.removeAllListeners()
            resolve(socket)
        })
    })
}

function upgrade(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: host })
        let settled = false
        const fail = () => {
            if (settled) return
            settled = true
            releaseSocket(secure)
            reject(new Error('mail send failed'))
        }
        secure.setTimeout(timeoutMs)
        secure.on('timeout', fail)
        secure.on('error', fail)
        secure.on('close', fail)
        secure.once('secureConnect', () => {
            if (settled) return
            settled = true
            secure.setTimeout(0)
            secure.removeAllListeners()
            resolve(secure)
        })
    })
}

/** One SMTP reply. Error, close, and timeout all reject and destroy the socket. Listeners come off when it settles. */
function readReply(socket: Socket, code: number, timeoutMs: number, loose: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error: Error | null, text = '') => {
            if (settled) return
            settled = true
            socket.setTimeout(0)
            socket.off('data', onData)
            socket.off('error', onFail)
            socket.off('close', onFail)
            socket.off('timeout', onFail)
            if (error) {
                socket.on('error', () => undefined)
                socket.destroy()
                reject(error)
                return
            }
            resolve(text)
        }
        const onFail = () => finish(new Error('mail send failed'))
        const onData = (buf: Buffer) => {
            const text = buf.toString('utf8')
            if (loose) {
                if (!text.startsWith(String(code))) onFail()
                else finish(null, text)
                return
            }
            const match = text.match(/^(\d{3})([\s-])/m)
            if (!match || Number(match[1]) !== code) onFail()
            else finish(null, text)
        }
        socket.on('data', onData)
        socket.on('error', onFail)
        socket.on('close', onFail)
        socket.on('timeout', onFail)
        socket.setTimeout(timeoutMs)
    })
}

function command(socket: Socket, line: string, code: number, timeoutMs: number): Promise<string> {
    const pending = readReply(socket, code, timeoutMs, false)
    socket.write(`${line}\r\n`)
    return pending
}

function expectCode(socket: Socket, code: number, timeoutMs: number): Promise<string> {
    return readReply(socket, code, timeoutMs, true)
}
