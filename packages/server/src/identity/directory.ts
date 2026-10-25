/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * JSON fields are the ones the users, roles, and teams screens already read.
 */

import { randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { builtInPermissionJson, builtInPermissionKeys, builtInRoleName, isReservedRoleName, permissionsLowered } from './builtInRoles'
import { DEFAULT_WORKSPACE, OWNER_ROLE, PERSONAL_WORKSPACE } from './constants'
import { utcDbTime } from './dbTime'
import { likeEscapeClause } from './likeEscape'
import { isCatalogPermission } from './permissionsCatalog'
import { safeRecordAudit } from './auditLog'
import { IdentityStore } from './store'
import { SessionUser } from './types'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

export class DirectoryError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.name = 'DirectoryError'
        this.status = status
    }
}

export interface DirectoryActor {
    id: string
    organizationId: string
    workspaceId: string | null
    /** Organization owner. Skips the role-grant subset check. */
    owner?: boolean
    /** Present when the route loaded this caller's team grants. Undefined keeps older callers unchanged. */
    permissions?: string[] | null
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export interface Sql {
    type: Dialect
    query: QueryFn
    transaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>
}

/** Same shape as a single address with one @ and a dot in the domain. A linear scan, so a long input cannot stall the process. */
function isEmailAddress(value: string): boolean {
    if (value.length < 3) return false
    let at = -1
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index]
        if (char <= ' ' || char === '@') {
            if (char !== '@' || at !== -1) return false
            at = index
        }
    }
    if (at <= 0) return false
    const rest = value.slice(at + 1)
    const dot = rest.indexOf('.')
    return dot > 0 && dot < rest.length - 1 && !rest.includes('@')
}
const RESERVED_WORKSPACE = new Set([DEFAULT_WORKSPACE, PERSONAL_WORKSPACE])

function dialectOfRunner(runner: { connection: { options: { type?: string } } }): Dialect {
    return dialectFrom(runner.connection.options.type)
}

function dialectFrom(type: string | undefined): Dialect {
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb' || type === 'sqlite') return type
    return 'sqlite'
}

function quote(dialect: Dialect, name: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

function rowsOf(dialect: Dialect, result: unknown): Record<string, unknown>[] {
    if (!Array.isArray(result)) return []
    if (
        (dialect === 'mysql' || dialect === 'mariadb') &&
        result.length === 2 &&
        Array.isArray(result[0]) &&
        result[1] &&
        typeof result[1] === 'object' &&
        !Array.isArray(result[1])
    ) {
        return result[0] as Record<string, unknown>[]
    }
    return result as Record<string, unknown>[]
}

async function run(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const dialect = dialectOfRunner(runner)
    let index = 0
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    return rowsOf(dialect, await runner.query(text, params))
}

export function sqlFromDataSource(dataSource: DataSource): Sql {
    const type = dialectFrom(dataSource.options.type)
    const bind =
        (runner: QueryRunner): QueryFn =>
        (sql, params = []) =>
            run(runner, sql, params)
    return {
        type,
        query: async (sql, params = []) => {
            const runner = dataSource.createQueryRunner()
            await runner.connect()
            try {
                return await bind(runner)(sql, params)
            } finally {
                await runner.release()
            }
        },
        transaction: async (fn) => {
            const runner = dataSource.createQueryRunner()
            await runner.connect()
            const sqlite = type === 'sqlite'
            // Deferred BEGIN lets a second connection pass the same owner check.
            if (sqlite) await runner.query('BEGIN IMMEDIATE')
            else await runner.startTransaction()
            try {
                const result = await fn(bind(runner))
                if (sqlite) await runner.query('COMMIT')
                else await runner.commitTransaction()
                return result
            } catch (error) {
                try {
                    if (sqlite) await runner.query('ROLLBACK')
                    else await runner.rollbackTransaction()
                } catch {
                    // The original error is the one the caller needs.
                }
                throw error
            } finally {
                await runner.release()
            }
        }
    }
}

/** Bump the permission version, then delete every local session. An older cookie fails the version check. */
export async function endLocalSessions(query: QueryFn, sql: Sql, userId: string): Promise<void> {
    await query(
        `UPDATE ${q(sql, 'user')} SET ${q(sql, 'permissionVersion')} = COALESCE(${q(sql, 'permissionVersion')}, 0) + 1
         WHERE ${q(sql, 'id')} = ?`,
        [userId]
    )
    await query(`DELETE FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'userId')} = ?`, [userId])
}

/** Marks open invite links used, so adding the person back later does not bring an old link back to life. */
export async function revokeInviteLinks(
    query: QueryFn,
    sql: Sql,
    userId: string,
    scope: { workspaceId: string } | { organizationId: string },
    now = Date.now()
): Promise<void> {
    const where = 'workspaceId' in scope ? `${q(sql, 'workspaceId')} = ?` : `${q(sql, 'organizationId')} = ?`
    await query(
        `UPDATE ${q(sql, 'identity_action_link')} SET ${q(sql, 'usedAt')} = ?, ${q(sql, 'consumeId')} = ?
         WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'purpose')} = ? AND ${q(sql, 'usedAt')} IS NULL AND ${where}`,
        [utcDbTime(sql.type, now), 'revoked', userId, 'invite', 'workspaceId' in scope ? scope.workspaceId : scope.organizationId]
    )
}

function storedPermissions(value: unknown): string[] {
    const raw = text(value)
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is string => typeof item === 'string')
    } catch {
        return []
    }
}

function permissionsOn(row: Record<string, unknown>): string[] {
    return builtInPermissionKeys(text(cell(row, 'name'))) || storedPermissions(cell(row, 'permissions'))
}

/** An enabled owner is an active user whose organization role is owner. Team rows are not part of the count. */
function enabledOwnersSql(sql: Sql): string {
    return `SELECT ou.${q(sql, 'userId')} AS userId
        FROM ${q(sql, 'organization_user')} ou
        INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = ou.${q(sql, 'userId')}
        INNER JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
        WHERE ou.${q(sql, 'organizationId')} = ?
          AND LOWER(ou.${q(sql, 'status')}) = 'active'
          AND LOWER(u.${q(sql, 'status')}) = 'active'
          AND LOWER(r.${q(sql, 'name')}) = 'owner'`
}

async function enabledOwnerIds(query: QueryFn, sql: Sql, organizationId: string): Promise<string[]> {
    const rows = await query(enabledOwnersSql(sql), [organizationId])
    return rows.map((row) => text(cell(row, 'userId'))).filter((id) => id.length > 0)
}

/** True when this user is an enabled owner and no other enabled owner remains. */
function keepsLastOwner(ownerIds: string[], userId: string): boolean {
    return ownerIds.includes(userId) && ownerIds.length < 2
}

/** Hold the owner rows for this organization until the transaction commits. SQLite uses BEGIN IMMEDIATE instead. */
async function lockOrgOwners(query: QueryFn, sql: Sql, organizationId: string, userId: string): Promise<void> {
    if (sql.type === 'sqlite') return
    await query(
        `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')} WHERE ${q(sql, 'organizationId')} = ? FOR UPDATE`,
        [organizationId]
    )
    await query(
        `SELECT ${q(sql, 'workspaceId')} AS workspaceId FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'userId')} = ? FOR UPDATE`,
        [userId]
    )
}

/**
 * Read the enabled owners after the row lock, then a plain UPDATE. The same statement
 * cannot both read and write organization_user. Returns last when the row stays active.
 */
async function refuseLastOwnerDisable(query: QueryFn, sql: Sql, organizationId: string, userId: string): Promise<'ok' | 'last'> {
    const owners = await enabledOwnerIds(query, sql, organizationId)
    if (keepsLastOwner(owners, userId)) return 'last'
    await query(
        `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = 'disable', ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
         WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
        [organizationId, userId]
    )
    const rows = await query(
        `SELECT ${q(sql, 'status')} AS status FROM ${q(sql, 'organization_user')}
         WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
        [organizationId, userId]
    )
    return text(cell(rows[0] || {}, 'status')).toLowerCase() === 'disable' ? 'ok' : 'last'
}

async function actorGrant(query: QueryFn, sql: Sql, actor: DirectoryActor): Promise<{ owner: boolean; permissions: string[] }> {
    const owner = await ownerUser(query, sql, actor.organizationId, actor.id)
    if (owner) return { owner: true, permissions: builtInPermissionKeys('owner') || [] }
    if (!actor.workspaceId) return { owner: false, permissions: [] }
    const rows = await query(
        `SELECT r.${q(sql, 'name')} AS name, r.${q(sql, 'permissions')} AS permissions
         FROM ${q(sql, 'workspace_user')} wu
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = wu.${q(sql, 'roleId')}
         WHERE wu.${q(sql, 'userId')} = ? AND wu.${q(sql, 'workspaceId')} = ?`,
        [actor.id, actor.workspaceId]
    )
    return { owner: false, permissions: permissionsOn(rows[0] || {}) }
}

function assertCovers(grant: { owner: boolean; permissions: string[] }, keys: string[]): void {
    if (grant.owner) return
    for (const key of keys) {
        if (!grant.permissions.includes(key)) throw new DirectoryError(403, 'You cannot grant a permission you do not have')
    }
}

async function assertSameWorkspace(query: QueryFn, sql: Sql, actor: DirectoryActor, workspaceId: string): Promise<void> {
    await workspaceInOrg(query, sql, workspaceId, actor.organizationId)
    if (await ownerUser(query, sql, actor.organizationId, actor.id)) return
    if (!actor.workspaceId || actor.workspaceId !== workspaceId) throw new DirectoryError(404, 'Team not found')
}

/** A non-owner may change a person only when that person is on the caller's active team. */
async function assertSharedActiveTeam(query: QueryFn, sql: Sql, actor: DirectoryActor, userId: string): Promise<void> {
    if (await ownerUser(query, sql, actor.organizationId, actor.id)) return
    if (!actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
    const rows = await query(
        `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')}
         WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
        [actor.workspaceId, userId]
    )
    if (!rows.length) throw new DirectoryError(404, 'User not found')
}

async function plainMemberRoleId(query: QueryFn, sql: Sql): Promise<string> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'role')}
         WHERE ${q(sql, 'organizationId')} IS NULL AND LOWER(${q(sql, 'name')}) = 'member'`,
        []
    )
    const id = text(cell(rows[0] || {}, 'id'))
    if (!id) throw new DirectoryError(400, 'Choose a role')
    return id
}

function q(sql: Sql, name: string): string {
    return quote(sql.type, name)
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

function num(value: unknown): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

function iso(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null
    // SQLite stores identity_local_session times as integer milliseconds. A digit
    // string is that same value. new Date("1790000000000") is not a valid instant.
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        const millis = Number(value)
        if (!Number.isFinite(millis)) return null
        const parsed = new Date(millis)
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
    const parsed = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function sameOrg(actor: DirectoryActor, organizationId: string): void {
    if (!organizationId || organizationId !== actor.organizationId) throw new DirectoryError(403, 'Wrong organization')
}

function isUnique(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /UNIQUE constraint failed|duplicate key|ER_DUP_ENTRY|23505/i.test(message)
}

interface InviteBody {
    name: string
    email: string
    workspaceId: string
    roleId: string
}

function inviteBody(body: unknown): InviteBody {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const user = record.user && typeof record.user === 'object' ? (record.user as Record<string, unknown>) : {}
    const workspace = record.workspace && typeof record.workspace === 'object' ? (record.workspace as Record<string, unknown>) : {}
    const role = record.role && typeof record.role === 'object' ? (record.role as Record<string, unknown>) : {}
    const name = text(user.name).trim()
    const email = text(user.email).trim()
    const workspaceId = text(workspace.id).trim()
    const roleId = text(role.id).trim()
    if (!name || name.length > 100) throw new DirectoryError(400, 'Name is required')
    if (!isEmailAddress(email)) throw new DirectoryError(400, 'Enter a valid email')
    if (!workspaceId) throw new DirectoryError(400, 'Choose a team')
    if (!roleId) throw new DirectoryError(400, 'Choose a role')
    return { name, email, workspaceId, roleId }
}

async function roleRow(query: QueryFn, sql: Sql, roleId: string): Promise<Record<string, unknown> | null> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'organizationId')} AS organizationId,
                ${q(sql, 'permissions')} AS permissions, ${q(sql, 'description')} AS description
         FROM ${q(sql, 'role')} WHERE ${q(sql, 'id')} = ?`,
        [roleId]
    )
    return rows[0] || null
}

function assignable(row: Record<string, unknown>, organizationId: string, actorIsOwner: boolean): boolean {
    const name = text(cell(row, 'name')).toLowerCase()
    if (name === 'personal workspace') return false
    if (name === OWNER_ROLE) return actorIsOwner
    if (!text(cell(row, 'organizationId')) && (name === 'member' || builtInRoleName(name))) return true
    if (isReservedRoleName(name)) return false
    return text(cell(row, 'organizationId')) === organizationId
}

async function workspaceInOrg(query: QueryFn, sql: Sql, workspaceId: string, organizationId: string): Promise<Record<string, unknown>> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'organizationId')} AS organizationId,
                ${q(sql, 'description')} AS description, ${q(sql, 'updatedDate')} AS updatedDate
         FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'id')} = ?`,
        [workspaceId]
    )
    const row = rows[0]
    if (!row || text(cell(row, 'organizationId')) !== organizationId) throw new DirectoryError(404, 'Team not found')
    return row
}

/**
 * Create a pending (`invited`) user with no local password. Only that person's invite link makes the user active.
 * A repeated email is refused and the stored credential is left alone.
 */
export async function createEmailUser(
    sql: Sql,
    actor: DirectoryActor,
    body: unknown,
    hook?: (query: QueryFn, userId: string) => Promise<void>
): Promise<{ id: string }> {
    const invite = inviteBody(body)
    return sql.transaction(async (query) => {
        await assertSameWorkspace(query, sql, actor, invite.workspaceId)
        const workspace = await workspaceInOrg(query, sql, invite.workspaceId, actor.organizationId)
        if (text(cell(workspace, 'name')) === PERSONAL_WORKSPACE) throw new DirectoryError(400, 'Choose a team')
        const grant = await actorGrant(query, sql, actor)
        const role = await roleRow(query, sql, invite.roleId)
        if (!role) throw new DirectoryError(400, 'Choose a role')
        const invitedName = text(cell(role, 'name')).toLowerCase()
        if (invitedName === OWNER_ROLE && !grant.owner) {
            throw new DirectoryError(403, 'Only an owner can assign the owner role')
        }
        if (!assignable(role, actor.organizationId, grant.owner)) throw new DirectoryError(400, 'Choose a role')
        if (!grant.owner && actor.permissions) {
            const held = new Set(actor.permissions)
            if (permissionsOn(role).some((permission) => !held.has(permission))) {
                throw new DirectoryError(403, 'You cannot grant this role')
            }
        } else {
            assertCovers(grant, permissionsOn(role))
        }
        const orgRoleId = invitedName === OWNER_ROLE ? text(cell(role, 'id')) : await plainMemberRoleId(query, sql)
        const existing = await query(`SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'user')} WHERE LOWER(${q(sql, 'email')}) = LOWER(?)`, [
            invite.email
        ])
        if (existing.length) throw new DirectoryError(409, 'A user with this email already exists')
        const userId = randomUUID()
        try {
            await query(
                `INSERT INTO ${q(sql, 'user')} (${q(sql, 'id')}, ${q(sql, 'name')}, ${q(sql, 'email')}, ${q(sql, 'credential')},
                    ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
                 VALUES (?, ?, ?, NULL, ?, ?, ?)`,
                [userId, invite.name, invite.email, 'invited', actor.id, actor.id]
            )
        } catch (error) {
            if (isUnique(error)) throw new DirectoryError(409, 'A user with this email already exists')
            throw error
        }
        await query(
            `INSERT INTO ${q(sql, 'organization_user')} (${q(sql, 'organizationId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')},
                ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [actor.organizationId, userId, orgRoleId, 'active', actor.id, actor.id]
        )
        await query(
            `INSERT INTO ${q(sql, 'workspace_user')} (${q(sql, 'workspaceId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')},
                ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [invite.workspaceId, userId, text(cell(role, 'id')), 'active', actor.id, actor.id]
        )
        if (hook) await hook(query, userId)
        return { id: userId }
    })
}

export interface OrganizationUserJson {
    organizationId: string
    userId: string
    status: string
    roleCount: number
    isOrgOwner: boolean
    lastLogin: string | null
    user: { id: string; name: string; email: string; status: string }
    role: { id: string; name: string }
}

export async function listOrganizationUsers(sql: Sql, actor: DirectoryActor, organizationId: string): Promise<OrganizationUserJson[]> {
    sameOrg(actor, organizationId)
    const owner = await ownerUser(sql.query, sql, organizationId, actor.id)
    if (!owner && !actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
    const people = await sql.query(
        `SELECT u.${q(sql, 'id')} AS userId, u.${q(sql, 'name')} AS userName, u.${q(sql, 'email')} AS email,
                u.${q(sql, 'status')} AS userStatus, ou.${q(sql, 'status')} AS orgStatus,
                r.${q(sql, 'id')} AS roleId, r.${q(sql, 'name')} AS roleName
         FROM ${q(sql, 'organization_user')} ou
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = ou.${q(sql, 'userId')}
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         WHERE ou.${q(sql, 'organizationId')} = ?
           AND (? = 1 OR EXISTS (
             SELECT 1 FROM ${q(sql, 'workspace_user')} wuScope
             WHERE wuScope.${q(sql, 'userId')} = u.${q(sql, 'id')} AND wuScope.${q(sql, 'workspaceId')} = ?
           ))`,
        [organizationId, owner ? 1 : 0, actor.workspaceId || '']
    )
    const ids = people.map((row) => text(cell(row, 'userId'))).filter(Boolean)
    const counts = new Map<string, { roleCount: number; lastLogin: string | null }>()
    if (ids.length) {
        const marks = ids.map(() => '?').join(', ')
        const aggregate = await sql.query(
            `SELECT wu.${q(sql, 'userId')} AS userId, COUNT(*) AS roleCount, MAX(wu.${q(sql, 'lastLogin')}) AS lastLogin
             FROM ${q(sql, 'workspace_user')} wu
             INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
             WHERE w.${q(sql, 'organizationId')} = ?
               AND w.${q(sql, 'name')} <> ?
               AND (
                 ? = 1
                 OR wu.${q(sql, 'workspaceId')} IN (
                   SELECT caller.${q(sql, 'workspaceId')} FROM ${q(sql, 'workspace_user')} caller
                   WHERE caller.${q(sql, 'userId')} = ?
                 )
               )
               AND wu.${q(sql, 'userId')} IN (${marks})
             GROUP BY wu.${q(sql, 'userId')}`,
            [organizationId, PERSONAL_WORKSPACE, owner ? 1 : 0, actor.id, ...ids]
        )
        for (const row of aggregate) {
            counts.set(text(cell(row, 'userId')), { roleCount: num(cell(row, 'roleCount')), lastLogin: iso(cell(row, 'lastLogin')) })
        }
    }
    return people.map((row) => {
        const userId = text(cell(row, 'userId'))
        const orgStatus = text(cell(row, 'orgStatus')).toLowerCase()
        const userStatus = text(cell(row, 'userStatus')).toLowerCase()
        const summary = counts.get(userId)
        return {
            organizationId,
            userId,
            status: orgStatus === 'disable' ? 'disable' : userStatus,
            roleCount: summary?.roleCount || 0,
            isOrgOwner: text(cell(row, 'roleName')).toLowerCase() === OWNER_ROLE,
            lastLogin: summary?.lastLogin || null,
            user: { id: userId, name: text(cell(row, 'userName')), email: text(cell(row, 'email')), status: userStatus },
            role: { id: text(cell(row, 'roleId')), name: text(cell(row, 'roleName')) }
        }
    })
}

async function ownerUser(query: QueryFn, sql: Sql, organizationId: string, userId: string): Promise<boolean> {
    const rows = await query(
        `SELECT r.${q(sql, 'name')} AS name
         FROM ${q(sql, 'organization_user')} ou
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         WHERE ou.${q(sql, 'organizationId')} = ? AND ou.${q(sql, 'userId')} = ?`,
        [organizationId, userId]
    )
    return text(cell(rows[0] || {}, 'name')).toLowerCase() === OWNER_ROLE
}

export async function deleteOrganizationUser(
    sql: Sql,
    actor: DirectoryActor,
    organizationId: string,
    userId: string
): Promise<{ id: string }> {
    sameOrg(actor, organizationId)
    if (!userId) throw new DirectoryError(400, 'User is required')
    return sql.transaction(async (query) => {
        await assertSharedActiveTeam(query, sql, actor, userId)
        if (!(await ownerUser(query, sql, organizationId, actor.id))) {
            throw new DirectoryError(403, 'Only an owner can remove someone from every team')
        }
        await lockOrgOwners(query, sql, organizationId, userId)
        const membership = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        if (!membership.length) throw new DirectoryError(404, 'User not found')
        const owners = await enabledOwnerIds(query, sql, organizationId)
        if (keepsLastOwner(owners, userId)) throw new DirectoryError(409, 'The last owner cannot be removed')
        await query(
            `DELETE FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        const kept = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        if (kept.length) throw new DirectoryError(409, 'The last owner cannot be removed')
        await query(
            `DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'workspaceId')} IN
                (SELECT ${q(sql, 'id')} FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'organizationId')} = ?)`,
            [userId, organizationId]
        )
        await revokeInviteLinks(query, sql, userId, { organizationId })
        const remaining = await query(`SELECT COUNT(*) AS count FROM ${q(sql, 'organization_user')} WHERE ${q(sql, 'userId')} = ?`, [
            userId
        ])
        if (num(cell(remaining[0] || {}, 'count')) === 0) {
            await query(
                `UPDATE ${q(sql, 'user')} SET ${q(sql, 'email')} = ?, ${q(sql, 'status')} = ?, ${q(sql, 'externalId')} = NULL,
                    ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'id')} = ?`,
                [`deleted.${userId}@users.invalid`, 'deleted', userId]
            )
            await endLocalSessions(query, sql, userId)
        }
        return { id: userId }
    })
}

export async function updateOrganizationUser(sql: Sql, actor: DirectoryActor, body: unknown): Promise<{ id: string }> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const userId = text(record.userId).trim()
    const organizationId = text(record.organizationId).trim()
    const requested = text(record.status).trim().toLowerCase()
    sameOrg(actor, organizationId)
    if (!userId) throw new DirectoryError(400, 'User is required')
    const status =
        requested === 'active'
            ? 'active'
            : requested === 'inactive' || requested === 'disable'
            ? 'disable'
            : requested === 'invited'
            ? 'invited'
            : ''
    if (!status) throw new DirectoryError(400, 'Status must be active or inactive')
    return sql.transaction(async (query) => {
        await assertSharedActiveTeam(query, sql, actor, userId)
        await lockOrgOwners(query, sql, organizationId, userId)
        const still = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        if (!still.length) throw new DirectoryError(404, 'User not found')
        if (status === 'invited') {
            // Keeps a pending user pending and enabled. It never sets anyone to invited and never activates the user.
            const current = await query(`SELECT ${q(sql, 'status')} AS status FROM ${q(sql, 'user')} WHERE ${q(sql, 'id')} = ?`, [userId])
            if (text(cell(current[0] || {}, 'status')).toLowerCase() !== 'invited') {
                throw new DirectoryError(400, 'Status must be active or inactive')
            }
            await query(
                `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                ['active', organizationId, userId]
            )
            return { id: userId }
        }
        if (status === 'disable') {
            const kept = await refuseLastOwnerDisable(query, sql, organizationId, userId)
            if (kept === 'last') throw new DirectoryError(409, 'The last owner cannot be removed')
            await query(
                `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'id')} = ? AND LOWER(${q(sql, 'status')}) = 'active'`,
                ['disable', userId]
            )
            // A pending invite stays pending. Disabling it closes the membership and its open invite links.
            await query(
                `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?
                   AND EXISTS (SELECT 1 FROM ${q(sql, 'user')} u WHERE u.${q(sql, 'id')} = ? AND LOWER(u.${q(sql, 'status')}) = 'invited')`,
                ['disable', organizationId, userId, userId]
            )
            await revokeInviteLinks(query, sql, userId, { organizationId })
            await endLocalSessions(query, sql, userId)
            return { id: userId }
        }
        await query(
            `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [status, organizationId, userId]
        )
        // Enabling never activates a pending invite. Only that person's invite link does.
        await query(
            `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
             WHERE ${q(sql, 'id')} = ? AND LOWER(${q(sql, 'status')}) = 'disable'`,
            ['active', userId]
        )
        return { id: userId }
    })
}

export interface WorkspaceMembershipJson {
    workspaceId: string
    userId: string
    status: string
    lastLogin: string | null
    isOrgOwner: boolean
    user: { id: string; name: string; email: string }
    role: { id: string; name: string }
    workspace: { id: string; name: string }
}

async function membershipRows(sql: Sql, where: string, params: unknown[]): Promise<WorkspaceMembershipJson[]> {
    const rows = await sql.query(
        `SELECT wu.${q(sql, 'workspaceId')} AS workspaceId, wu.${q(sql, 'userId')} AS userId, wu.${q(sql, 'status')} AS status,
                wu.${q(sql, 'lastLogin')} AS lastLogin, u.${q(sql, 'name')} AS userName, u.${q(sql, 'email')} AS email,
                r.${q(sql, 'id')} AS roleId, r.${q(sql, 'name')} AS roleName,
                w.${q(sql, 'id')} AS teamId, w.${q(sql, 'name')} AS teamName, w.${q(sql, 'organizationId')} AS organizationId,
                orgRole.${q(sql, 'name')} AS orgRoleName
         FROM ${q(sql, 'workspace_user')} wu
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = wu.${q(sql, 'userId')}
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = wu.${q(sql, 'roleId')}
         LEFT JOIN ${q(sql, 'organization_user')} ou
           ON ou.${q(sql, 'userId')} = wu.${q(sql, 'userId')} AND ou.${q(sql, 'organizationId')} = w.${q(sql, 'organizationId')}
         LEFT JOIN ${q(sql, 'role')} orgRole ON orgRole.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         WHERE ${where}`,
        params
    )
    return rows
        .filter((row) => text(cell(row, 'teamName')) !== PERSONAL_WORKSPACE)
        .map((row) => ({
            workspaceId: text(cell(row, 'workspaceId')),
            userId: text(cell(row, 'userId')),
            status: text(cell(row, 'status')),
            lastLogin: iso(cell(row, 'lastLogin')),
            isOrgOwner: text(cell(row, 'orgRoleName')).toLowerCase() === OWNER_ROLE,
            user: { id: text(cell(row, 'userId')), name: text(cell(row, 'userName')), email: text(cell(row, 'email')) },
            role: { id: text(cell(row, 'roleId')), name: text(cell(row, 'roleName')) },
            workspace: { id: text(cell(row, 'teamId')), name: text(cell(row, 'teamName')) }
        }))
}

export async function listWorkspaceMemberships(
    sql: Sql,
    actor: DirectoryActor,
    filter: { workspaceId?: string; roleId?: string; userId?: string; organizationId?: string }
): Promise<WorkspaceMembershipJson[]> {
    if (filter.organizationId) sameOrg(actor, filter.organizationId)
    if (filter.workspaceId) {
        await assertSameWorkspace(sql.query, sql, actor, filter.workspaceId)
        return membershipRows(sql, `wu.${q(sql, 'workspaceId')} = ?`, [filter.workspaceId])
    }
    if (filter.roleId) {
        const role = await roleRow(sql.query, sql, filter.roleId)
        if (!role || (text(cell(role, 'organizationId')) && text(cell(role, 'organizationId')) !== actor.organizationId)) {
            throw new DirectoryError(404, 'Role not found')
        }
        const owner = await ownerUser(sql.query, sql, actor.organizationId, actor.id)
        if (owner) {
            return membershipRows(sql, `wu.${q(sql, 'roleId')} = ? AND w.${q(sql, 'organizationId')} = ?`, [
                filter.roleId,
                actor.organizationId
            ])
        }
        if (!actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
        return membershipRows(sql, `wu.${q(sql, 'roleId')} = ? AND w.${q(sql, 'organizationId')} = ? AND wu.${q(sql, 'workspaceId')} = ?`, [
            filter.roleId,
            actor.organizationId,
            actor.workspaceId
        ])
    }
    if (filter.userId) {
        if (filter.userId === actor.id) {
            return membershipRows(sql, `wu.${q(sql, 'userId')} = ? AND w.${q(sql, 'organizationId')} = ?`, [
                filter.userId,
                actor.organizationId
            ])
        }
        const owner = await ownerUser(sql.query, sql, actor.organizationId, actor.id)
        if (!owner) {
            if (!actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
            return membershipRows(
                sql,
                `wu.${q(sql, 'userId')} = ? AND w.${q(sql, 'organizationId')} = ? AND wu.${q(sql, 'workspaceId')} = ?`,
                [filter.userId, actor.organizationId, actor.workspaceId]
            )
        }
        return membershipRows(sql, `wu.${q(sql, 'userId')} = ? AND w.${q(sql, 'organizationId')} = ?`, [
            filter.userId,
            actor.organizationId
        ])
    }
    throw new DirectoryError(400, 'A team, role, or user is required')
}

export async function deleteWorkspaceUser(sql: Sql, actor: DirectoryActor, workspaceId: string, userId: string): Promise<{ id: string }> {
    if (!workspaceId || !userId) throw new DirectoryError(400, 'User and team are required')
    return sql.transaction(async (query) => {
        await assertSameWorkspace(query, sql, actor, workspaceId)
        await lockOrgOwners(query, sql, actor.organizationId, userId)
        const rows = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')}
             WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
            [workspaceId, userId]
        )
        if (!rows.length) throw new DirectoryError(404, 'Workspace user not found')
        const owners = `(${enabledOwnersSql(sql)})`
        const blocked = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')} current
             WHERE current.${q(sql, 'workspaceId')} = ? AND current.${q(sql, 'userId')} = ?
               AND EXISTS (SELECT 1 FROM ${owners} owners WHERE owners.userId = current.${q(sql, 'userId')})
               AND (SELECT COUNT(*) FROM ${owners} owners) < 2
               AND NOT EXISTS (
                 SELECT 1 FROM ${q(sql, 'workspace_user')} other
                 INNER JOIN ${q(sql, 'workspace')} otherTeam ON otherTeam.${q(sql, 'id')} = other.${q(sql, 'workspaceId')}
                 WHERE other.${q(sql, 'userId')} = current.${q(sql, 'userId')}
                   AND other.${q(sql, 'workspaceId')} <> current.${q(sql, 'workspaceId')}
                   AND otherTeam.${q(sql, 'organizationId')} = ?
                   AND otherTeam.${q(sql, 'name')} <> ?
                   AND LOWER(other.${q(sql, 'status')}) IN ('active', 'invited')
               )`,
            [workspaceId, userId, actor.organizationId, actor.organizationId, actor.organizationId, PERSONAL_WORKSPACE]
        )
        if (blocked.length) throw new DirectoryError(409, 'The last owner cannot be removed')
        await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`, [
            workspaceId,
            userId
        ])
        await revokeInviteLinks(query, sql, userId, { workspaceId })
        await endLocalSessions(query, sql, userId)
        return { id: userId }
    })
}

export async function updateWorkspaceUserRole(sql: Sql, actor: DirectoryActor, body: unknown): Promise<{ id: string }> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const userId = text(record.userId).trim()
    const workspaceId = text(record.workspaceId).trim()
    const roleId = text(record.roleId).trim()
    if (!userId || !workspaceId || !roleId) throw new DirectoryError(400, 'User, team, and role are required')
    let fromRoleId = ''
    const result = await sql.transaction(async (query) => {
        await assertSameWorkspace(query, sql, actor, workspaceId)
        const grant = await actorGrant(query, sql, actor)
        const role = await roleRow(query, sql, roleId)
        if (!role) throw new DirectoryError(400, 'Choose a role')
        const roleName = text(cell(role, 'name')).toLowerCase()
        if (roleName === OWNER_ROLE && !grant.owner) throw new DirectoryError(403, 'Only an owner can assign the owner role')
        if (!assignable(role, actor.organizationId, grant.owner)) throw new DirectoryError(400, 'Choose a role')
        assertCovers(grant, permissionsOn(role))
        const current = await query(
            `SELECT wu.${q(sql, 'roleId')} AS roleId, r.${q(sql, 'name')} AS name, r.${q(sql, 'permissions')} AS permissions
             FROM ${q(sql, 'workspace_user')} wu
             LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = wu.${q(sql, 'roleId')}
             WHERE wu.${q(sql, 'workspaceId')} = ? AND wu.${q(sql, 'userId')} = ?`,
            [workspaceId, userId]
        )
        if (!current.length) throw new DirectoryError(404, 'Workspace user not found')
        fromRoleId = text(cell(current[0] || {}, 'roleId'))
        await lockOrgOwners(query, sql, actor.organizationId, userId)
        const wasOwner = await ownerUser(query, sql, actor.organizationId, userId)
        const willBeOwner = roleName === OWNER_ROLE
        // A team role change leaves the organization role alone. Owner is the exception:
        // gaining it sets the organization role to owner, and losing it sets that role back to member.
        if (!wasOwner && willBeOwner) {
            await query(
                `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'roleId')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                [roleId, actor.organizationId, userId]
            )
        } else if (wasOwner && !willBeOwner) {
            const memberId = await plainMemberRoleId(query, sql)
            const owners = await enabledOwnerIds(query, sql, actor.organizationId)
            if (keepsLastOwner(owners, userId)) throw new DirectoryError(409, 'The last owner cannot be removed')
            await query(
                `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'roleId')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                [memberId, actor.organizationId, userId]
            )
            const still = await query(
                `SELECT r.${q(sql, 'name')} AS name FROM ${q(sql, 'organization_user')} ou
                 LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
                 WHERE ou.${q(sql, 'organizationId')} = ? AND ou.${q(sql, 'userId')} = ?`,
                [actor.organizationId, userId]
            )
            if (text(cell(still[0] || {}, 'name')).toLowerCase() === OWNER_ROLE) {
                throw new DirectoryError(409, 'The last owner cannot be removed')
            }
        }
        await query(
            `UPDATE ${q(sql, 'workspace_user')} SET ${q(sql, 'roleId')} = ?, ${q(sql, 'updatedBy')} = ?, ${q(
                sql,
                'updatedDate'
            )} = CURRENT_TIMESTAMP
             WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
            [roleId, actor.id, workspaceId, userId]
        )
        if (permissionsLowered(permissionsOn(current[0] || {}), permissionsOn(role), wasOwner && !willBeOwner)) {
            await endLocalSessions(query, sql, userId)
        }
        return { id: userId }
    })
    if (fromRoleId && fromRoleId !== roleId) {
        await safeRecordAudit(sql, {
            type: 'role_change',
            organizationId: actor.organizationId,
            workspaceId,
            userId,
            actorId: actor.id,
            summary: 'Role changed',
            detail: { fromRoleId, toRoleId: roleId }
        })
    }
    return result
}

export interface WorkspaceJson {
    id: string
    name: string
    description: string
    organizationId: string
    userCount: number
    updatedDate: string | null
    isOrgDefault: boolean
}

async function workspaceJson(sql: Sql, row: Record<string, unknown>): Promise<WorkspaceJson> {
    const id = text(cell(row, 'id'))
    const counts = await sql.query(`SELECT COUNT(*) AS count FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ?`, [id])
    const name = text(cell(row, 'name'))
    return {
        id,
        name,
        description: text(cell(row, 'description')),
        organizationId: text(cell(row, 'organizationId')),
        userCount: num(cell(counts[0] || {}, 'count')),
        updatedDate: iso(cell(row, 'updatedDate')),
        isOrgDefault: name === DEFAULT_WORKSPACE
    }
}

export async function listWorkspaces(sql: Sql, actor: DirectoryActor, organizationId: string): Promise<WorkspaceJson[]> {
    sameOrg(actor, organizationId)
    const owner = await ownerUser(sql.query, sql, organizationId, actor.id)
    if (!owner && !actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
    const rows = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'description')} AS description,
                ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'updatedDate')} AS updatedDate
         FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'organizationId')} = ?
           AND (? = 1 OR ${q(sql, 'id')} = ?)`,
        [organizationId, owner ? 1 : 0, actor.workspaceId || '']
    )
    const visible = []
    for (const row of rows) {
        if (text(cell(row, 'name')) === PERSONAL_WORKSPACE) continue
        visible.push(await workspaceJson(sql, row))
    }
    return visible
}

export async function getWorkspace(sql: Sql, actor: DirectoryActor, id: string): Promise<WorkspaceJson> {
    await assertSameWorkspace(sql.query, sql, actor, id)
    const row = await workspaceInOrg(sql.query, sql, id, actor.organizationId)
    return workspaceJson(sql, row)
}

export async function createWorkspace(sql: Sql, actor: DirectoryActor, body: unknown): Promise<WorkspaceJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const name = text(record.name).trim()
    const description = text(record.description).trim()
    const organizationId = text(record.organizationId).trim() || actor.organizationId
    sameOrg(actor, organizationId)
    if (!name || name.length > 100) throw new DirectoryError(400, 'Name is required')
    if (RESERVED_WORKSPACE.has(name)) throw new DirectoryError(400, 'That team name is reserved')
    const id = randomUUID()
    await sql.transaction(async (query) => {
        await query(
            `INSERT INTO ${q(sql, 'workspace')} (${q(sql, 'id')}, ${q(sql, 'name')}, ${q(sql, 'description')},
                ${q(sql, 'organizationId')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, name, description, organizationId, actor.id, actor.id]
        )
        const current = actor.workspaceId
            ? await query(
                  `SELECT ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'workspace_user')}
                   WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'workspaceId')} = ?`,
                  [actor.id, actor.workspaceId]
              )
            : []
        const orgRole = await query(
            `SELECT ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'organizationId')} = ?`,
            [actor.id, organizationId]
        )
        const roleId = text(cell(current[0] || orgRole[0] || {}, 'roleId'))
        if (!roleId) throw new DirectoryError(400, 'Choose a role')
        await query(
            `INSERT INTO ${q(sql, 'workspace_user')} (${q(sql, 'workspaceId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')},
                ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, actor.id, roleId, 'active', actor.id, actor.id]
        )
    })
    const created = await workspaceInOrg(sql.query, sql, id, organizationId)
    return workspaceJson(sql, created)
}

export async function updateWorkspace(sql: Sql, actor: DirectoryActor, body: unknown): Promise<WorkspaceJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const id = text(record.id).trim()
    const name = text(record.name).trim()
    const description = text(record.description).trim()
    if (!name || name.length > 100) throw new DirectoryError(400, 'Name is required')
    await assertSameWorkspace(sql.query, sql, actor, id)
    const current = await workspaceInOrg(sql.query, sql, id, actor.organizationId)
    if (RESERVED_WORKSPACE.has(text(cell(current, 'name')))) throw new DirectoryError(400, 'That team cannot be renamed')
    if (RESERVED_WORKSPACE.has(name)) throw new DirectoryError(400, 'That team name is reserved')
    await sql.query(
        `UPDATE ${q(sql, 'workspace')} SET ${q(sql, 'name')} = ?, ${q(sql, 'description')} = ?, ${q(sql, 'updatedBy')} = ?,
            ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
         WHERE ${q(sql, 'id')} = ?`,
        [name, description, actor.id, id]
    )
    return getWorkspace(sql, actor, id)
}

async function workspaceRowCount(query: QueryFn, sql: Sql, table: string, workspaceId: string): Promise<number> {
    try {
        const rows = await query(`SELECT COUNT(*) AS count FROM ${q(sql, table)} WHERE ${q(sql, 'workspaceId')} = ?`, [workspaceId])
        return num(cell(rows[0] || {}, 'count'))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/no such table|does not exist|doesn't exist/i.test(message)) return 0
        throw error
    }
}

async function chatflowCount(query: QueryFn, sql: Sql, workspaceId: string): Promise<number> {
    return workspaceRowCount(query, sql, 'chat_flow', workspaceId)
}

/** Tables with a workspace foreign key, besides chat_flow, that block deleting the team. */
const TEAM_OWNED_ROWS: { table: string; label: string }[] = [
    { table: 'credential', label: 'credentials' },
    { table: 'variable', label: 'variables' },
    { table: 'apikey', label: 'API keys' },
    { table: 'document_store', label: 'document stores' },
    { table: 'workspace_shared', label: 'shared items' },
    { table: 'assistant', label: 'assistants' },
    { table: 'custom_template', label: 'custom templates' },
    { table: 'dataset', label: 'datasets' },
    { table: 'evaluation', label: 'evaluations' },
    { table: 'evaluator', label: 'evaluators' },
    { table: 'tool', label: 'tools' },
    { table: 'execution', label: 'executions' }
]

function teamOwnedMessage(labels: string[]): string {
    if (labels.length === 1) return `Delete this team's ${labels[0]} first`
    const head = labels.slice(0, -1).join(', ')
    return `Delete this team's ${head} and ${labels[labels.length - 1]} first`
}

export async function deleteWorkspace(sql: Sql, actor: DirectoryActor, id: string): Promise<{ id: string }> {
    return sql.transaction(async (query) => {
        await assertSameWorkspace(query, sql, actor, id)
        await lockOrgOwners(query, sql, actor.organizationId, actor.id)
        const current = await workspaceInOrg(query, sql, id, actor.organizationId)
        if (RESERVED_WORKSPACE.has(text(cell(current, 'name')))) throw new DirectoryError(400, 'That team cannot be deleted')
        const members = await query(`SELECT COUNT(*) AS count FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ?`, [id])
        if (num(cell(members[0] || {}, 'count')) > 1) throw new DirectoryError(400, 'Remove the other people from this team first')
        if ((await chatflowCount(query, sql, id)) > 0) throw new DirectoryError(400, 'Delete this team chatflows first')
        const owned: string[] = []
        for (const item of TEAM_OWNED_ROWS) {
            if ((await workspaceRowCount(query, sql, item.table, id)) > 0) owned.push(item.label)
        }
        if (owned.length) throw new DirectoryError(400, teamOwnedMessage(owned))
        const owners = `(${enabledOwnersSql(sql)})`
        const stranded = await query(
            `SELECT owners.userId AS userId FROM ${owners} owners
             WHERE EXISTS (
               SELECT 1 FROM ${q(sql, 'workspace_user')} here
               WHERE here.${q(sql, 'userId')} = owners.userId AND here.${q(sql, 'workspaceId')} = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM ${q(sql, 'workspace_user')} other
               INNER JOIN ${q(sql, 'workspace')} otherTeam ON otherTeam.${q(sql, 'id')} = other.${q(sql, 'workspaceId')}
               WHERE other.${q(sql, 'userId')} = owners.userId
                 AND other.${q(sql, 'workspaceId')} <> ?
                 AND otherTeam.${q(sql, 'organizationId')} = ?
                 AND otherTeam.${q(sql, 'name')} <> ?
                 AND LOWER(other.${q(sql, 'status')}) IN ('active', 'invited')
             )
             AND (SELECT COUNT(*) FROM ${owners} allOwners) < 2`,
            [actor.organizationId, id, id, actor.organizationId, PERSONAL_WORKSPACE, actor.organizationId]
        )
        if (!stranded.length) {
            const counted = await query(`SELECT COUNT(*) AS count FROM ${owners} owners`, [actor.organizationId])
            if (num(cell(counted[0] || {}, 'count')) < 1) throw new DirectoryError(409, 'The last owner cannot be removed')
        } else {
            throw new DirectoryError(409, 'The last owner cannot be removed')
        }
        await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ?`, [id])
        await query(`DELETE FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'id')} = ?`, [id])
        return { id }
    })
}

export async function switchWorkspace(sql: Sql, store: IdentityStore, actor: DirectoryActor, workspaceId: string): Promise<SessionUser> {
    const workspace = await workspaceInOrg(sql.query, sql, workspaceId, actor.organizationId)
    if (text(cell(workspace, 'name')) === PERSONAL_WORKSPACE) throw new DirectoryError(404, 'Team not found')
    const membership = await sql.query(
        `SELECT ${q(sql, 'status')} AS status FROM ${q(sql, 'workspace_user')}
         WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
        [workspaceId, actor.id]
    )
    const status = text(cell(membership[0] || {}, 'status')).toLowerCase()
    if (status !== 'active' && status !== 'invited') throw new DirectoryError(404, 'Team not found')
    if (status === 'invited') {
        await sql.query(
            `UPDATE ${q(sql, 'workspace_user')} SET ${q(sql, 'status')} = ?
             WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ? AND LOWER(${q(sql, 'status')}) = 'invited'`,
            ['active', workspaceId, actor.id]
        )
    }
    await store.touchLastLogin(actor.id, workspaceId, new Date())
    const session = await store.sessionFor(actor.id, workspaceId)
    if (!session || session.activeWorkspaceId !== workspaceId) throw new DirectoryError(404, 'Team not found')
    return session
}

export interface RoleJson {
    id: string
    name: string
    description: string
    permissions: string
    organizationId: string | null
    userCount: number
    readOnly?: boolean
}

function roleJson(row: Record<string, unknown>, userCount: number): RoleJson {
    const org = text(cell(row, 'organizationId'))
    const name = text(cell(row, 'name'))
    const canonical = builtInPermissionJson(name)
    const readOnly = isReservedRoleName(name) || !org
    return {
        id: text(cell(row, 'id')),
        name,
        description: text(cell(row, 'description')),
        permissions: canonical || text(cell(row, 'permissions')) || '[]',
        organizationId: org || null,
        userCount,
        ...(readOnly ? { readOnly: true } : {})
    }
}

/** People with this role on one team. The role list uses the caller's active team. */
async function roleUserCount(sql: Sql, roleId: string, workspaceId: string): Promise<number> {
    if (!workspaceId) return 0
    const rows = await sql.query(
        `SELECT COUNT(*) AS count FROM ${q(sql, 'workspace_user')}
         WHERE ${q(sql, 'roleId')} = ? AND ${q(sql, 'workspaceId')} = ?`,
        [roleId, workspaceId]
    )
    return num(cell(rows[0] || {}, 'count'))
}

/** Every team assignment of this role. Deleting a role still looks at all of them. */
async function roleAssignmentCount(sql: Sql, roleId: string): Promise<number> {
    const rows = await sql.query(`SELECT COUNT(*) AS count FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'roleId')} = ?`, [roleId])
    return num(cell(rows[0] || {}, 'count'))
}

export async function listRoles(sql: Sql, actor: DirectoryActor, organizationId: string): Promise<RoleJson[]> {
    sameOrg(actor, organizationId)
    const rows = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'description')} AS description,
                ${q(sql, 'permissions')} AS permissions, ${q(sql, 'organizationId')} AS organizationId
         FROM ${q(sql, 'role')}
         WHERE ${q(sql, 'organizationId')} = ? OR (${q(sql, 'organizationId')} IS NULL AND LOWER(${q(
            sql,
            'name'
        )}) IN ('member', 'owner', 'admin', 'builder', 'viewer'))`,
        [organizationId]
    )
    const listed = []
    let owner: RoleJson | null = null
    for (const row of rows) {
        const name = text(cell(row, 'name')).toLowerCase()
        if (name === OWNER_ROLE) {
            const listedOwner = {
                ...roleJson(row, await roleUserCount(sql, text(cell(row, 'id')), actor.workspaceId || '')),
                readOnly: true
            }
            if (!owner || listedOwner.organizationId) owner = listedOwner
            continue
        }
        if (!assignable(row, organizationId, true) && name !== 'member') continue
        listed.push(roleJson(row, await roleUserCount(sql, text(cell(row, 'id')), actor.workspaceId || '')))
    }
    return owner ? [owner, ...listed] : listed
}

function permissionList(value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) throw new DirectoryError(400, 'Choose at least one permission')
    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new DirectoryError(400, 'Permissions are not valid JSON')
    }
    if (!Array.isArray(parsed)) throw new DirectoryError(400, 'Permissions are not valid JSON')
    const keys = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    if (!keys.length) throw new DirectoryError(400, 'Choose at least one permission')
    const unique = [...new Set(keys)]
    for (const key of unique) {
        if (!isCatalogPermission(key)) throw new DirectoryError(400, 'Unknown permission')
    }
    return unique
}

function roleName(value: unknown): string {
    const name = text(value).trim()
    if (!name || name.length > 100) throw new DirectoryError(400, 'Name is required')
    if (name.includes(' ')) throw new DirectoryError(400, 'Role name cannot contain spaces')
    if (isReservedRoleName(name)) throw new DirectoryError(400, 'That role name is reserved')
    return name
}

export async function createRole(sql: Sql, actor: DirectoryActor, body: unknown): Promise<RoleJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const organizationId = actor.organizationId
    sameOrg(actor, organizationId)
    const name = roleName(record.name)
    const description = text(record.description).trim()
    const keys = permissionList(record.permissions)
    assertCovers(await actorGrant(sql.query, sql, actor), keys)
    const permissions = JSON.stringify(keys)
    const id = randomUUID()
    await sql.query(
        `INSERT INTO ${q(sql, 'role')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'name')}, ${q(sql, 'description')},
            ${q(sql, 'permissions')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, organizationId, name, description, permissions, actor.id, actor.id]
    )
    return { id, name, description, permissions, organizationId, userCount: 0 }
}

export async function updateRole(sql: Sql, actor: DirectoryActor, body: unknown): Promise<RoleJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const id = text(record.id).trim()
    const role = await roleRow(sql.query, sql, id)
    if (!role) throw new DirectoryError(404, 'Role not found')
    if (isReservedRoleName(text(cell(role, 'name'))) || !text(cell(role, 'organizationId'))) {
        throw new DirectoryError(403, 'Built-in roles cannot be changed')
    }
    if (text(cell(role, 'organizationId')) !== actor.organizationId) throw new DirectoryError(404, 'Role not found')
    const name = roleName(record.name)
    const description = text(record.description).trim()
    const keys = permissionList(record.permissions)
    assertCovers(await actorGrant(sql.query, sql, actor), keys)
    const permissions = JSON.stringify(keys)
    const before = permissionsOn(role)
    await sql.query(
        `UPDATE ${q(sql, 'role')} SET ${q(sql, 'name')} = ?, ${q(sql, 'description')} = ?, ${q(sql, 'permissions')} = ?,
            ${q(sql, 'updatedBy')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
         WHERE ${q(sql, 'id')} = ?`,
        [name, description, permissions, actor.id, id]
    )
    if (permissionsLowered(before, keys, false)) {
        const holders = await sql.query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'roleId')} = ?
             UNION SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')} WHERE ${q(sql, 'roleId')} = ?`,
            [id, id]
        )
        for (const holder of holders) {
            const holderId = text(cell(holder, 'userId'))
            if (holderId) await endLocalSessions(sql.query, sql, holderId)
        }
    }
    return {
        id,
        name,
        description,
        permissions,
        organizationId: actor.organizationId,
        userCount: await roleUserCount(sql, id, actor.workspaceId || '')
    }
}

export async function deleteRole(sql: Sql, actor: DirectoryActor, id: string, organizationId: string): Promise<{ id: string }> {
    sameOrg(actor, organizationId)
    const role = await roleRow(sql.query, sql, id)
    if (!role) throw new DirectoryError(404, 'Role not found')
    if (isReservedRoleName(text(cell(role, 'name'))) || !text(cell(role, 'organizationId'))) {
        throw new DirectoryError(403, 'Built-in roles cannot be changed')
    }
    if (text(cell(role, 'organizationId')) !== organizationId) throw new DirectoryError(404, 'Role not found')
    const count = await roleAssignmentCount(sql, id)
    if (count > 0) throw new DirectoryError(400, 'Remove users with this role first')
    await sql.query(`DELETE FROM ${q(sql, 'role')} WHERE ${q(sql, 'id')} = ?`, [id])
    return { id }
}

export interface Page {
    limit: number
    offset: number
    q: string
    sort: string
    descending: boolean
    status: '' | 'active' | 'disable'
}

const USER_SORT = new Set(['name', 'email', 'status'])

export function pageFrom(query: Record<string, unknown>): Page {
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit)
    const offset = query.offset === undefined || query.offset === '' ? 0 : Number(query.offset)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DirectoryError(400, 'limit must be from 1 to 100')
    if (!Number.isInteger(offset) || offset < 0) throw new DirectoryError(400, 'offset must be 0 or greater')
    const q = text(query.q).trim().toLowerCase()
    if (q.length > 100) throw new DirectoryError(400, 'Search is too long')
    const rawSort = text(query.sort).trim()
    const descending = rawSort.startsWith('-')
    const sort = (descending ? rawSort.slice(1) : rawSort) || 'name'
    if (!USER_SORT.has(sort)) throw new DirectoryError(400, 'sort must be name, email, or status')
    const statusRaw = text(query.status).trim().toLowerCase()
    if (statusRaw && statusRaw !== 'active' && statusRaw !== 'disable') throw new DirectoryError(400, 'status must be active or disable')
    return { limit, offset, q, sort, descending, status: statusRaw as Page['status'] }
}

async function requireActiveMember(sql: Sql, actor: DirectoryActor, userId: string): Promise<void> {
    if (!userId) throw new DirectoryError(400, 'User is required')
    if (!actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
    await assertSameWorkspace(sql.query, sql, actor, actor.workspaceId)
    const rows = await sql.query(
        `SELECT wu.${q(sql, 'userId')} AS userId
         FROM ${q(sql, 'workspace_user')} wu
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
         WHERE wu.${q(sql, 'workspaceId')} = ? AND wu.${q(sql, 'userId')} = ? AND w.${q(sql, 'organizationId')} = ?`,
        [actor.workspaceId, userId, actor.organizationId]
    )
    if (!rows.length) throw new DirectoryError(404, 'User not found')
}

export interface LocalUserJson {
    id: string
    name: string
    email: string
    disabled: boolean
    status: string
    workspaceId: string
    role: { id: string; name: string; builtIn: boolean }
}

export async function listLocalUsers(
    sql: Sql,
    actor: DirectoryActor,
    page: Page
): Promise<{ users: LocalUserJson[]; limit: number; offset: number; total: number }> {
    if (!actor.workspaceId) throw new DirectoryError(400, 'Active workspace is required')
    await assertSameWorkspace(sql.query, sql, actor, actor.workspaceId)
    const needle = `%${page.q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    const statusSql = page.status ? `AND LOWER(ou.${q(sql, 'status')}) = ?` : ''
    const escape = likeEscapeClause(sql.type)
    const searchSql = page.q ? `AND (LOWER(u.${q(sql, 'name')}) LIKE ? ${escape} OR LOWER(u.${q(sql, 'email')}) LIKE ? ${escape})` : ''
    const params: unknown[] = [actor.workspaceId, actor.organizationId]
    if (page.status) params.push(page.status)
    if (page.q) params.push(needle, needle)
    const where = `wu.${q(sql, 'workspaceId')} = ? AND w.${q(sql, 'organizationId')} = ? ${statusSql} ${searchSql}`
    const totals = await sql.query(
        `SELECT COUNT(*) AS count
         FROM ${q(sql, 'workspace_user')} wu
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = wu.${q(sql, 'userId')}
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
         LEFT JOIN ${q(sql, 'organization_user')} ou
           ON ou.${q(sql, 'userId')} = wu.${q(sql, 'userId')} AND ou.${q(sql, 'organizationId')} = w.${q(sql, 'organizationId')}
         WHERE ${where}`,
        params
    )
    const sortColumn =
        page.sort === 'email' ? `u.${q(sql, 'email')}` : page.sort === 'status' ? `ou.${q(sql, 'status')}` : `u.${q(sql, 'name')}`
    const direction = page.descending ? 'DESC' : 'ASC'
    const rows = await sql.query(
        `SELECT u.${q(sql, 'id')} AS id, u.${q(sql, 'name')} AS name, u.${q(sql, 'email')} AS email,
                u.${q(sql, 'status')} AS userStatus, ou.${q(sql, 'status')} AS orgStatus,
                r.${q(sql, 'id')} AS roleId, r.${q(sql, 'name')} AS roleName
         FROM ${q(sql, 'workspace_user')} wu
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = wu.${q(sql, 'userId')}
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
         LEFT JOIN ${q(sql, 'organization_user')} ou
           ON ou.${q(sql, 'userId')} = wu.${q(sql, 'userId')} AND ou.${q(sql, 'organizationId')} = w.${q(sql, 'organizationId')}
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = wu.${q(sql, 'roleId')}
         WHERE ${where}
         ORDER BY ${sortColumn} ${direction}
         LIMIT ? OFFSET ?`,
        [...params, page.limit, page.offset]
    )
    return {
        users: rows.map((row) => {
            const orgStatus = text(cell(row, 'orgStatus')).toLowerCase()
            const userStatus = text(cell(row, 'userStatus')).toLowerCase()
            const disabled = orgStatus === 'disable' || userStatus === 'disable'
            const roleName = text(cell(row, 'roleName'))
            return {
                id: text(cell(row, 'id')),
                name: text(cell(row, 'name')),
                email: text(cell(row, 'email')),
                disabled,
                status: disabled ? 'disable' : userStatus || orgStatus,
                workspaceId: actor.workspaceId || '',
                role: { id: text(cell(row, 'roleId')), name: roleName, builtIn: isReservedRoleName(roleName) }
            }
        }),
        limit: page.limit,
        offset: page.offset,
        total: num(cell(totals[0] || {}, 'count'))
    }
}

export async function setUserDisabled(
    sql: Sql,
    actor: DirectoryActor,
    userId: string,
    disabled: boolean
): Promise<{ id: string; disabled: boolean }> {
    await requireActiveMember(sql, actor, userId)
    await updateOrganizationUser(sql, actor, {
        userId,
        organizationId: actor.organizationId,
        status: disabled ? 'disable' : 'active'
    })
    await safeRecordAudit(sql, {
        type: 'user_disable',
        organizationId: actor.organizationId,
        workspaceId: null,
        userId,
        actorId: actor.id,
        summary: disabled ? 'User disabled' : 'User enabled',
        detail: { disabled }
    })
    return { id: userId, disabled }
}

export interface SessionPublic {
    id: string
    createdAt: string | null
    idleExpiresAt: string | null
    absoluteExpiresAt: string | null
}

export async function listUserSessions(
    sql: Sql,
    actor: DirectoryActor,
    userId: string,
    page: Page
): Promise<{ sessions: SessionPublic[]; limit: number; offset: number; total: number }> {
    await requireActiveMember(sql, actor, userId)
    const totals = await sql.query(`SELECT COUNT(*) AS count FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'userId')} = ?`, [
        userId
    ])
    const rows = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'createdDate')} AS createdAt, ${q(sql, 'expiresAt')} AS idleExpiresAt,
                ${q(sql, 'absoluteExpiresAt')} AS absoluteExpiresAt
         FROM ${q(sql, 'identity_local_session')}
         WHERE ${q(sql, 'userId')} = ?
         ORDER BY ${q(sql, 'createdDate')} DESC
         LIMIT ? OFFSET ?`,
        [userId, page.limit, page.offset]
    )
    return {
        sessions: rows.map((row) => ({
            id: text(cell(row, 'id')),
            createdAt: iso(cell(row, 'createdAt')),
            idleExpiresAt: iso(cell(row, 'idleExpiresAt')),
            absoluteExpiresAt: iso(cell(row, 'absoluteExpiresAt'))
        })),
        limit: page.limit,
        offset: page.offset,
        total: num(cell(totals[0] || {}, 'count'))
    }
}

export async function endUserSessions(sql: Sql, actor: DirectoryActor, userId: string): Promise<{ ended: number }> {
    await requireActiveMember(sql, actor, userId)
    const totals = await sql.query(`SELECT COUNT(*) AS count FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'userId')} = ?`, [
        userId
    ])
    const ended = num(cell(totals[0] || {}, 'count'))
    await endLocalSessions(sql.query, sql, userId)
    return { ended }
}

export async function endUserSession(sql: Sql, actor: DirectoryActor, userId: string, sessionId: string): Promise<{ id: string }> {
    await requireActiveMember(sql, actor, userId)
    if (!sessionId) throw new DirectoryError(400, 'Session is required')
    const rows = await sql.query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'userId')} = ?`,
        [sessionId, userId]
    )
    if (!rows.length) throw new DirectoryError(404, 'Session not found')
    await sql.query(`DELETE FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'userId')} = ?`, [
        sessionId,
        userId
    ])
    return { id: sessionId }
}
