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
import { DEFAULT_WORKSPACE, OWNER_ROLE, PERSONAL_WORKSPACE } from './constants'
import { isCatalogPermission } from './permissionsCatalog'
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
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export interface Sql {
    type: Dialect
    query: QueryFn
    transaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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
            await runner.startTransaction()
            try {
                const result = await fn(bind(runner))
                await runner.commitTransaction()
                return result
            } catch (error) {
                await runner.rollbackTransaction()
                throw error
            } finally {
                await runner.release()
            }
        }
    }
}

async function endLocalSessions(query: QueryFn, sql: Sql, userId: string): Promise<void> {
    await query(`DELETE FROM ${q(sql, 'identity_local_session')} WHERE ${q(sql, 'userId')} = ?`, [userId])
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
    if (!EMAIL_PATTERN.test(email)) throw new DirectoryError(400, 'Enter a valid email')
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

function assignable(row: Record<string, unknown>, organizationId: string): boolean {
    const name = text(cell(row, 'name')).toLowerCase()
    if (name === OWNER_ROLE || name === 'personal workspace') return false
    const org = text(cell(row, 'organizationId'))
    if (!org && name === 'member') return true
    return org === organizationId
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

/** Create an active user with no local password. A repeated email is refused and the stored credential is left alone. */
export async function createEmailUser(sql: Sql, actor: DirectoryActor, body: unknown): Promise<{ id: string }> {
    const invite = inviteBody(body)
    return sql.transaction(async (query) => {
        const workspace = await workspaceInOrg(query, sql, invite.workspaceId, actor.organizationId)
        if (text(cell(workspace, 'name')) === PERSONAL_WORKSPACE) throw new DirectoryError(400, 'Choose a team')
        const role = await roleRow(query, sql, invite.roleId)
        if (!role || !assignable(role, actor.organizationId)) throw new DirectoryError(400, 'Choose a role')
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
                [userId, invite.name, invite.email, 'active', actor.id, actor.id]
            )
        } catch (error) {
            if (isUnique(error)) throw new DirectoryError(409, 'A user with this email already exists')
            throw error
        }
        await query(
            `INSERT INTO ${q(sql, 'organization_user')} (${q(sql, 'organizationId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')},
                ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [actor.organizationId, userId, text(cell(role, 'id')), 'active', actor.id, actor.id]
        )
        await query(
            `INSERT INTO ${q(sql, 'workspace_user')} (${q(sql, 'workspaceId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')},
                ${q(sql, 'status')}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [invite.workspaceId, userId, text(cell(role, 'id')), 'active', actor.id, actor.id]
        )
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
    const people = await sql.query(
        `SELECT u.${q(sql, 'id')} AS userId, u.${q(sql, 'name')} AS userName, u.${q(sql, 'email')} AS email,
                u.${q(sql, 'status')} AS userStatus, ou.${q(sql, 'status')} AS orgStatus,
                r.${q(sql, 'id')} AS roleId, r.${q(sql, 'name')} AS roleName
         FROM ${q(sql, 'organization_user')} ou
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = ou.${q(sql, 'userId')}
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         WHERE ou.${q(sql, 'organizationId')} = ?`,
        [organizationId]
    )
    const ids = people.map((row) => text(cell(row, 'userId'))).filter(Boolean)
    const counts = new Map<string, { roleCount: number; lastLogin: string | null }>()
    if (ids.length) {
        const marks = ids.map(() => '?').join(', ')
        const aggregate = await sql.query(
            `SELECT wu.${q(sql, 'userId')} AS userId, COUNT(*) AS roleCount, MAX(wu.${q(sql, 'lastLogin')}) AS lastLogin
             FROM ${q(sql, 'workspace_user')} wu
             INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = wu.${q(sql, 'workspaceId')}
             WHERE w.${q(sql, 'organizationId')} = ? AND wu.${q(sql, 'userId')} IN (${marks})
             GROUP BY wu.${q(sql, 'userId')}`,
            [organizationId, ...ids]
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
        if (await ownerUser(query, sql, organizationId, userId)) throw new DirectoryError(403, 'The organization owner cannot be deleted')
        const membership = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        if (!membership.length) throw new DirectoryError(404, 'User not found')
        await query(
            `DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'userId')} = ? AND ${q(sql, 'workspaceId')} IN
                (SELECT ${q(sql, 'id')} FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'organizationId')} = ?)`,
            [userId, organizationId]
        )
        await query(`DELETE FROM ${q(sql, 'organization_user')} WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`, [
            organizationId,
            userId
        ])
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
    const status = requested === 'active' ? 'active' : requested === 'inactive' || requested === 'disable' ? 'disable' : ''
    if (!status) throw new DirectoryError(400, 'Status must be active or inactive')
    return sql.transaction(async (query) => {
        if (await ownerUser(query, sql, organizationId, userId)) {
            if (status !== 'active') throw new DirectoryError(403, 'The organization owner stays active')
        }
        const still = await query(
            `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')}
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [organizationId, userId]
        )
        if (!still.length) throw new DirectoryError(404, 'User not found')
        await query(
            `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
             WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
            [status, organizationId, userId]
        )
        if (status === 'active') {
            await query(
                `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'id')} = ? AND LOWER(${q(sql, 'status')}) = 'invited'`,
                ['active', userId]
            )
        }
        if (status === 'disable') await endLocalSessions(query, sql, userId)
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
        await workspaceInOrg(sql.query, sql, filter.workspaceId, actor.organizationId)
        return membershipRows(sql, `wu.${q(sql, 'workspaceId')} = ?`, [filter.workspaceId])
    }
    if (filter.roleId) {
        const role = await roleRow(sql.query, sql, filter.roleId)
        if (!role || (text(cell(role, 'organizationId')) && text(cell(role, 'organizationId')) !== actor.organizationId)) {
            throw new DirectoryError(404, 'Role not found')
        }
        return membershipRows(sql, `wu.${q(sql, 'roleId')} = ? AND w.${q(sql, 'organizationId')} = ?`, [
            filter.roleId,
            actor.organizationId
        ])
    }
    if (filter.userId) {
        return membershipRows(sql, `wu.${q(sql, 'userId')} = ? AND w.${q(sql, 'organizationId')} = ?`, [
            filter.userId,
            actor.organizationId
        ])
    }
    throw new DirectoryError(400, 'A team, role, or user is required')
}

export async function deleteWorkspaceUser(sql: Sql, actor: DirectoryActor, workspaceId: string, userId: string): Promise<{ id: string }> {
    await workspaceInOrg(sql.query, sql, workspaceId, actor.organizationId)
    if (await ownerUser(sql.query, sql, actor.organizationId, userId)) {
        throw new DirectoryError(403, 'The organization owner cannot be removed from a team')
    }
    const rows = await sql.query(
        `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')}
         WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
        [workspaceId, userId]
    )
    if (!rows.length) throw new DirectoryError(404, 'Workspace user not found')
    await sql.query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`, [
        workspaceId,
        userId
    ])
    return { id: userId }
}

export async function updateWorkspaceUserRole(sql: Sql, actor: DirectoryActor, body: unknown): Promise<{ id: string }> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const userId = text(record.userId).trim()
    const workspaceId = text(record.workspaceId).trim()
    const roleId = text(record.roleId).trim()
    if (!userId || !workspaceId || !roleId) throw new DirectoryError(400, 'User, team, and role are required')
    await workspaceInOrg(sql.query, sql, workspaceId, actor.organizationId)
    const role = await roleRow(sql.query, sql, roleId)
    if (!role || !assignable(role, actor.organizationId)) throw new DirectoryError(400, 'Choose a role')
    const rows = await sql.query(
        `SELECT ${q(sql, 'userId')} AS userId FROM ${q(sql, 'workspace_user')}
         WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
        [workspaceId, userId]
    )
    if (!rows.length) throw new DirectoryError(404, 'Workspace user not found')
    await sql.query(
        `UPDATE ${q(sql, 'workspace_user')} SET ${q(sql, 'roleId')} = ?, ${q(sql, 'updatedBy')} = ?, ${q(
            sql,
            'updatedDate'
        )} = CURRENT_TIMESTAMP
         WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
        [roleId, actor.id, workspaceId, userId]
    )
    return { id: userId }
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
    const rows = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'description')} AS description,
                ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'updatedDate')} AS updatedDate
         FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'organizationId')} = ?`,
        [organizationId]
    )
    const visible = []
    for (const row of rows) {
        if (text(cell(row, 'name')) === PERSONAL_WORKSPACE) continue
        visible.push(await workspaceJson(sql, row))
    }
    return visible
}

export async function getWorkspace(sql: Sql, actor: DirectoryActor, id: string): Promise<WorkspaceJson> {
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
    return getWorkspace(sql, actor, id)
}

export async function updateWorkspace(sql: Sql, actor: DirectoryActor, body: unknown): Promise<WorkspaceJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const id = text(record.id).trim()
    const name = text(record.name).trim()
    const description = text(record.description).trim()
    if (!name || name.length > 100) throw new DirectoryError(400, 'Name is required')
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

async function chatflowCount(sql: Sql, workspaceId: string): Promise<number> {
    try {
        const rows = await sql.query(`SELECT COUNT(*) AS count FROM ${q(sql, 'chat_flow')} WHERE ${q(sql, 'workspaceId')} = ?`, [
            workspaceId
        ])
        return num(cell(rows[0] || {}, 'count'))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/no such table|does not exist|doesn't exist/i.test(message)) return 0
        throw error
    }
}

export async function deleteWorkspace(sql: Sql, actor: DirectoryActor, id: string): Promise<{ id: string }> {
    const current = await workspaceInOrg(sql.query, sql, id, actor.organizationId)
    if (RESERVED_WORKSPACE.has(text(cell(current, 'name')))) throw new DirectoryError(400, 'That team cannot be deleted')
    const detail = await workspaceJson(sql, current)
    if (detail.userCount > 1) throw new DirectoryError(400, 'Remove the other people from this team first')
    if ((await chatflowCount(sql, id)) > 0) throw new DirectoryError(400, 'Delete this team chatflows first')
    await sql.transaction(async (query) => {
        await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ?`, [id])
        await query(`DELETE FROM ${q(sql, 'workspace')} WHERE ${q(sql, 'id')} = ?`, [id])
    })
    return { id }
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
    return {
        id: text(cell(row, 'id')),
        name: text(cell(row, 'name')),
        description: text(cell(row, 'description')),
        permissions: text(cell(row, 'permissions')) || '[]',
        organizationId: org || null,
        userCount
    }
}

async function roleUserCount(sql: Sql, roleId: string): Promise<number> {
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
        )}) IN ('member', 'owner'))`,
        [organizationId]
    )
    const listed = []
    let owner: RoleJson | null = null
    for (const row of rows) {
        const name = text(cell(row, 'name')).toLowerCase()
        if (name === OWNER_ROLE) {
            const listedOwner = { ...roleJson(row, await roleUserCount(sql, text(cell(row, 'id')))), readOnly: true }
            if (!owner || listedOwner.organizationId) owner = listedOwner
            continue
        }
        if (!assignable(row, organizationId) && name !== 'member') continue
        listed.push(roleJson(row, await roleUserCount(sql, text(cell(row, 'id')))))
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
    const lower = name.toLowerCase()
    if (lower === OWNER_ROLE || lower === 'member' || lower === 'personal workspace')
        throw new DirectoryError(400, 'That role name is reserved')
    return name
}

export async function createRole(sql: Sql, actor: DirectoryActor, body: unknown): Promise<RoleJson> {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const organizationId = text(record.organizationId).trim() || actor.organizationId
    sameOrg(actor, organizationId)
    const name = roleName(record.name)
    const description = text(record.description).trim()
    const permissions = JSON.stringify(permissionList(record.permissions))
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
    if (!role || text(cell(role, 'organizationId')) !== actor.organizationId) throw new DirectoryError(404, 'Role not found')
    if (text(cell(role, 'name')).toLowerCase() === OWNER_ROLE) throw new DirectoryError(403, 'Super User is read-only')
    const name = roleName(record.name)
    const description = text(record.description).trim()
    const permissions = JSON.stringify(permissionList(record.permissions))
    await sql.query(
        `UPDATE ${q(sql, 'role')} SET ${q(sql, 'name')} = ?, ${q(sql, 'description')} = ?, ${q(sql, 'permissions')} = ?,
            ${q(sql, 'updatedBy')} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
         WHERE ${q(sql, 'id')} = ?`,
        [name, description, permissions, actor.id, id]
    )
    return { id, name, description, permissions, organizationId: actor.organizationId, userCount: await roleUserCount(sql, id) }
}

export async function deleteRole(sql: Sql, actor: DirectoryActor, id: string, organizationId: string): Promise<{ id: string }> {
    sameOrg(actor, organizationId)
    const role = await roleRow(sql.query, sql, id)
    if (!role || text(cell(role, 'organizationId')) !== organizationId) throw new DirectoryError(404, 'Role not found')
    if (text(cell(role, 'name')).toLowerCase() === OWNER_ROLE) throw new DirectoryError(403, 'Super User is read-only')
    const count = await roleUserCount(sql, id)
    if (count > 0) throw new DirectoryError(400, 'Remove users with this role first')
    await sql.query(`DELETE FROM ${q(sql, 'role')} WHERE ${q(sql, 'id')} = ?`, [id])
    return { id }
}
