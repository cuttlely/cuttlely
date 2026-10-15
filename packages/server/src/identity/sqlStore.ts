/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { DEFAULT_WORKSPACE, LOGIN_FAILURE_WINDOW_MS, OPEN_SOURCE_FEATURES, OWNER_ROLE, PERSONAL_WORKSPACE } from './constants'
import { ACCOUNT_LOCK_CAP, LoginLimiter, accountLockKey } from './rateLimit'
import { runtimeNumber } from '../settings/runtime'
import { utcEpoch } from './dbTime'
import { addSessionSeenColumn } from './schemaMigration'
import { IdentityStore } from './store'
import { CreateOwnerInput, LocalSession, NotEmptyError, SessionUser, UserRow } from './types'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

function dialectOf(runner: QueryRunner): Dialect {
    const type = runner.connection.options.type
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb' || type === 'sqlite') return type
    return 'sqlite'
}

function quote(dialect: Dialect, name: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

async function query(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const dialect = dialectOf(runner)
    let index = 0
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    const rows = await runner.query(text, params)
    if (Array.isArray(rows)) return rows as Record<string, unknown>[]
    return []
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

function nullable(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null
    return String(value)
}

function epoch(value: unknown): number {
    return utcEpoch(value)
}

function userFrom(row: Record<string, unknown>): UserRow {
    return {
        id: text(cell(row, 'id')),
        email: text(cell(row, 'email')),
        name: text(cell(row, 'name')),
        status: text(cell(row, 'status')),
        externalId: nullable(cell(row, 'externalId')),
        credential: nullable(cell(row, 'credential'))
    }
}

function permissionsOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
    if (typeof value !== 'string' || !value) return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
    } catch {
        return []
    }
}

export class SqlIdentityStore implements IdentityStore {
    private gate: Promise<void> = Promise.resolve()

    constructor(private readonly dataSource: DataSource) {}

    async countUsers(): Promise<number> {
        return this.withRunner(async (runner) => count(runner))
    }

    async listEmails(): Promise<string[]> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(
                runner,
                `SELECT ${quote(d, 'email')} AS ${quote(d, 'email')} FROM ${quote(d, 'user')} ORDER BY ${quote(d, 'email')}`
            )
            return rows.map((row) => text(cell(row, 'email'))).filter(Boolean)
        })
    }

    async findUserByExternalId(externalId: string): Promise<UserRow | null> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(runner, `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE ${quote(d, 'externalId')} = ?`, [
                externalId
            ])
            return rows[0] ? userFrom(rows[0]) : null
        })
    }

    async findUsersByEmail(email: string): Promise<UserRow[]> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(
                runner,
                `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE LOWER(${quote(d, 'email')}) = LOWER(?)`,
                [email]
            )
            return rows.map(userFrom)
        })
    }

    async setExternalId(userId: string, externalId: string): Promise<'linked' | 'rebind' | 'missing'> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(runner, `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`, [userId])
            const current = rows[0] ? userFrom(rows[0]) : null
            if (!current) return 'missing'
            if (current.externalId === externalId) return 'linked'
            if (current.externalId) return 'rebind'
            await query(
                runner,
                `UPDATE ${quote(d, 'user')} SET ${quote(d, 'externalId')} = ?, ${quote(d, 'updatedDate')} = CURRENT_TIMESTAMP WHERE ${quote(
                    d,
                    'id'
                )} = ? AND ${quote(d, 'externalId')} IS NULL`,
                [externalId, userId]
            )
            const after = await query(runner, `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`, [userId])
            const next = after[0] ? userFrom(after[0]) : null
            if (next?.externalId === externalId) return 'linked'
            return 'rebind'
        })
    }

    async findSuperUser(): Promise<UserRow | null> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(
                runner,
                `SELECT ${selectUser(d, 'u')} FROM ${quote(d, 'user')} u
                 INNER JOIN ${quote(d, 'organization_user')} ou ON ou.${quote(d, 'userId')} = u.${quote(d, 'id')}
                 INNER JOIN ${quote(d, 'role')} r ON r.${quote(d, 'id')} = ou.${quote(d, 'roleId')}
                 WHERE LOWER(r.${quote(d, 'name')}) = LOWER(?)
                   AND LOWER(u.${quote(d, 'status')}) = 'active'
                 ORDER BY u.${quote(d, 'createdDate')} ASC
                 LIMIT 1`,
                [OWNER_ROLE]
            )
            return rows[0] ? userFrom(rows[0]) : null
        })
    }

    async setCredential(userId: string, credential: string): Promise<void> {
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            await query(
                runner,
                `UPDATE ${quote(d, 'user')} SET ${quote(d, 'credential')} = ?, ${quote(d, 'updatedDate')} = CURRENT_TIMESTAMP WHERE ${quote(
                    d,
                    'id'
                )} = ?`,
                [credential, userId]
            )
        })
    }

    async activateUser(userId: string): Promise<UserRow | null> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            await query(
                runner,
                `UPDATE ${quote(d, 'user')} SET ${quote(d, 'status')} = ?, ${quote(d, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${quote(d, 'id')} = ? AND LOWER(${quote(d, 'status')}) = 'invited'`,
                ['active', userId]
            )
            const rows = await query(runner, `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`, [userId])
            const user = rows[0] ? userFrom(rows[0]) : null
            if (!user || !isActive(user.status)) return null
            return user
        })
    }

    async createOwner(input: CreateOwnerInput): Promise<UserRow> {
        return this.transaction(async (runner) => {
            const d = dialectOf(runner)
            await lockBootstrap(runner, d)
            if ((await count(runner)) !== 0) throw new NotEmptyError()
            // An empty user table with a leftover bootstrap row is not bootstrapped.
            await query(runner, `DELETE FROM ${quote(d, 'identity_bootstrap')}`)
            try {
                await query(runner, `INSERT INTO ${quote(d, 'identity_bootstrap')} (${quote(d, 'id')}) VALUES (1)`)
            } catch (error) {
                if (isUniqueViolation(error)) throw new NotEmptyError()
                throw error
            }
            const userId = randomUUID()
            const organizationId = randomUUID()
            const roleId = randomUUID()
            const workspaceId = randomUUID()
            await query(
                runner,
                `INSERT INTO ${quote(d, 'user')} (${quote(d, 'id')}, ${quote(d, 'name')}, ${quote(d, 'email')}, ${quote(
                    d,
                    'credential'
                )}, ${quote(d, 'status')}, ${quote(d, 'externalId')}, ${quote(d, 'createdBy')}, ${quote(
                    d,
                    'updatedBy'
                )}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, input.name, input.email, input.credential, 'active', input.externalId, userId, userId]
            )
            await query(
                runner,
                `INSERT INTO ${quote(d, 'organization')} (${quote(d, 'id')}, ${quote(d, 'name')}, ${quote(d, 'createdBy')}, ${quote(
                    d,
                    'updatedBy'
                )}) VALUES (?, ?, ?, ?)`,
                [organizationId, 'Cuttlely', userId, userId]
            )
            await query(
                runner,
                `INSERT INTO ${quote(d, 'role')} (${quote(d, 'id')}, ${quote(d, 'organizationId')}, ${quote(d, 'name')}, ${quote(
                    d,
                    'permissions'
                )}, ${quote(d, 'createdBy')}, ${quote(d, 'updatedBy')}) VALUES (?, ?, ?, ?, ?, ?)`,
                [roleId, organizationId, OWNER_ROLE, '[]', userId, userId]
            )
            await query(
                runner,
                `INSERT INTO ${quote(d, 'workspace')} (${quote(d, 'id')}, ${quote(d, 'name')}, ${quote(d, 'organizationId')}, ${quote(
                    d,
                    'createdBy'
                )}, ${quote(d, 'updatedBy')}) VALUES (?, ?, ?, ?, ?)`,
                [workspaceId, DEFAULT_WORKSPACE, organizationId, userId, userId]
            )
            await query(
                runner,
                `INSERT INTO ${quote(d, 'organization_user')} (${quote(d, 'organizationId')}, ${quote(d, 'userId')}, ${quote(
                    d,
                    'roleId'
                )}, ${quote(d, 'status')}, ${quote(d, 'createdBy')}, ${quote(d, 'updatedBy')}) VALUES (?, ?, ?, ?, ?, ?)`,
                [organizationId, userId, roleId, 'active', userId, userId]
            )
            await query(
                runner,
                `INSERT INTO ${quote(d, 'workspace_user')} (${quote(d, 'workspaceId')}, ${quote(d, 'userId')}, ${quote(
                    d,
                    'roleId'
                )}, ${quote(d, 'status')}, ${quote(d, 'createdBy')}, ${quote(d, 'updatedBy')}) VALUES (?, ?, ?, ?, ?, ?)`,
                [workspaceId, userId, roleId, 'active', userId, userId]
            )
            return {
                id: userId,
                email: input.email,
                name: input.name,
                status: 'active',
                externalId: input.externalId,
                credential: input.credential
            }
        })
    }

    async sessionFor(userId: string, preferredWorkspaceId?: string | null): Promise<SessionUser | null> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const users = await query(runner, `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`, [userId])
            const user = users[0] ? userFrom(users[0]) : null
            if (!user) return null
            const orgs = await query(
                runner,
                `SELECT ou.${quote(d, 'organizationId')} AS ${quote(d, 'organizationId')},
                        ou.${quote(d, 'status')} AS ${quote(d, 'orgStatus')},
                        r.${quote(d, 'name')} AS ${quote(d, 'roleName')}
                 FROM ${quote(d, 'organization_user')} ou
                 LEFT JOIN ${quote(d, 'role')} r ON r.${quote(d, 'id')} = ou.${quote(d, 'roleId')}
                 WHERE ou.${quote(d, 'userId')} = ?`,
                [userId]
            )
            const org = orgs[0]
            const owner = text(cell(org || {}, 'roleName')).toLowerCase() === OWNER_ROLE
            const organizationId = org ? text(cell(org, 'organizationId')) : ''
            // Re-invited existing users are stored as invited. Open only that row. disable stays disable.
            if (organizationId && text(cell(org, 'orgStatus')).trim().toLowerCase() === 'invited') {
                await query(
                    runner,
                    `UPDATE ${quote(d, 'organization_user')} SET ${quote(d, 'status')} = ?
                     WHERE ${quote(d, 'userId')} = ? AND ${quote(d, 'organizationId')} = ? AND LOWER(${quote(d, 'status')}) = 'invited'`,
                    ['active', userId, organizationId]
                )
            }
            const memberships = await query(
                runner,
                `SELECT w.${quote(d, 'id')} AS ${quote(d, 'workspaceId')}, w.${quote(d, 'name')} AS ${quote(d, 'workspaceName')},
                        r.${quote(d, 'name')} AS ${quote(d, 'roleName')}, r.${quote(d, 'permissions')} AS ${quote(d, 'permissions')},
                        wu.${quote(d, 'status')} AS ${quote(d, 'membershipStatus')},
                        wu.${quote(d, 'lastLogin')} AS ${quote(d, 'lastLogin')}
                 FROM ${quote(d, 'workspace_user')} wu
                 INNER JOIN ${quote(d, 'workspace')} w ON w.${quote(d, 'id')} = wu.${quote(d, 'workspaceId')}
                 LEFT JOIN ${quote(d, 'role')} r ON r.${quote(d, 'id')} = wu.${quote(d, 'roleId')}
                 WHERE wu.${quote(d, 'userId')} = ?`,
                [userId]
            )
            const visible = memberships.filter((row) => text(cell(row, 'workspaceName')) !== PERSONAL_WORKSPACE)
            const granting = visible.filter((row) => teamGrants(cell(row, 'membershipStatus')))
            const preferred = preferredWorkspaceId
                ? granting.find((row) => text(cell(row, 'workspaceId')) === preferredWorkspaceId)
                : undefined
            const stamped = granting
                .filter((row) => cell(row, 'lastLogin'))
                .sort((a, b) => epoch(cell(b, 'lastLogin')) - epoch(cell(a, 'lastLogin')))
            const active =
                preferred || stamped[0] || granting.find((row) => text(cell(row, 'workspaceName')) === DEFAULT_WORKSPACE) || granting[0]
            // Only an unopened team is flipped. `disable` and every other status stay as stored.
            if (active && text(cell(active, 'membershipStatus')).trim().toLowerCase() === 'invited') {
                const workspaceId = text(cell(active, 'workspaceId'))
                await query(
                    runner,
                    `UPDATE ${quote(d, 'workspace_user')} SET ${quote(d, 'status')} = ?
                     WHERE ${quote(d, 'userId')} = ? AND ${quote(d, 'workspaceId')} = ? AND LOWER(${quote(d, 'status')}) = 'invited'`,
                    ['active', userId, workspaceId]
                )
            }
            const last = active ? cell(active, 'lastLogin') : null
            return {
                id: user.id,
                email: user.email,
                name: user.name,
                status: user.status,
                role: owner ? OWNER_ROLE : text(cell(active || {}, 'roleName')),
                isSSO: false,
                activeOrganizationId: org ? text(cell(org, 'organizationId')) || null : null,
                activeOrganizationSubscriptionId: null,
                activeOrganizationCustomerId: null,
                activeOrganizationProductId: null,
                activeWorkspaceId: active ? text(cell(active, 'workspaceId')) || null : null,
                activeWorkspace: active ? text(cell(active, 'workspaceName')) || null : null,
                lastLogin: last ? new Date(epoch(last)).toISOString() : null,
                isOrganizationAdmin: owner,
                assignedWorkspaces: granting.map((row) => ({
                    id: text(cell(row, 'workspaceId')),
                    name: text(cell(row, 'workspaceName'))
                })),
                permissions: permissionsOf(active ? cell(active, 'permissions') : null),
                features: OPEN_SOURCE_FEATURES
            }
        })
    }

    async touchLastLogin(userId: string, workspaceId: string | null, at: Date): Promise<void> {
        if (!workspaceId) return
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            await query(
                runner,
                `UPDATE ${quote(d, 'workspace_user')} SET ${quote(d, 'lastLogin')} = ? WHERE ${quote(d, 'userId')} = ? AND ${quote(
                    d,
                    'workspaceId'
                )} = ?`,
                [at, userId, workspaceId]
            )
        })
    }

    private seenColumn: Promise<void> | null = null

    private ensureSeenColumn(): Promise<void> {
        if (!this.seenColumn) {
            this.seenColumn = this.withRunner((runner) => addSessionSeenColumn(runner)).catch((error) => {
                this.seenColumn = null
                throw error
            })
        }
        return this.seenColumn
    }

    async insertLocalSession(row: LocalSession): Promise<void> {
        await this.ensureSeenColumn()
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const seen = row.lastSeenAt || row.issuedAt || new Date()
            await query(
                runner,
                `INSERT INTO ${quote(d, 'identity_local_session')} (${quote(d, 'id')}, ${quote(d, 'userId')}, ${quote(d, 'token')}, ${quote(
                    d,
                    'expiresAt'
                )}, ${quote(d, 'absoluteExpiresAt')}, ${quote(d, 'lastSeenAt')}) VALUES (?, ?, ?, ?, ?, ?)`,
                [row.id, row.userId, row.token, row.idleExpires, row.absoluteExpires, seen]
            )
        })
    }

    async findLocalSession(token: string): Promise<LocalSession | null> {
        await this.ensureSeenColumn()
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(
                runner,
                `SELECT ${quote(d, 'id')} AS ${quote(d, 'id')}, ${quote(d, 'userId')} AS ${quote(d, 'userId')}, ${quote(
                    d,
                    'token'
                )} AS ${quote(d, 'token')}, ${quote(d, 'expiresAt')} AS ${quote(d, 'expiresAt')}, ${quote(
                    d,
                    'absoluteExpiresAt'
                )} AS ${quote(d, 'absoluteExpiresAt')}, ${quote(d, 'createdDate')} AS ${quote(d, 'createdDate')}, ${quote(
                    d,
                    'lastSeenAt'
                )} AS ${quote(d, 'lastSeenAt')} FROM ${quote(d, 'identity_local_session')} WHERE ${quote(d, 'token')} = ?`,
                [token]
            )
            const row = rows[0]
            if (!row) return null
            const created = epoch(cell(row, 'createdDate'))
            const seen = epoch(cell(row, 'lastSeenAt'))
            return {
                id: text(cell(row, 'id')),
                userId: text(cell(row, 'userId')),
                token: text(cell(row, 'token')),
                idleExpires: new Date(epoch(cell(row, 'expiresAt'))),
                absoluteExpires: new Date(epoch(cell(row, 'absoluteExpiresAt'))),
                issuedAt: created > 0 ? new Date(created) : undefined,
                lastSeenAt: seen > 0 ? new Date(seen) : undefined
            }
        })
    }

    async slideLocalSession(token: string, idleExpires: Date, lastSeenAt?: Date): Promise<void> {
        await this.ensureSeenColumn()
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            if (lastSeenAt) {
                await query(
                    runner,
                    `UPDATE ${quote(d, 'identity_local_session')} SET ${quote(d, 'expiresAt')} = ?, ${quote(
                        d,
                        'lastSeenAt'
                    )} = ? WHERE ${quote(d, 'token')} = ?`,
                    [idleExpires, lastSeenAt, token]
                )
                return
            }
            await query(
                runner,
                `UPDATE ${quote(d, 'identity_local_session')} SET ${quote(d, 'expiresAt')} = ? WHERE ${quote(d, 'token')} = ?`,
                [idleExpires, token]
            )
        })
    }

    async deleteLocalSession(token: string): Promise<void> {
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            await query(runner, `DELETE FROM ${quote(d, 'identity_local_session')} WHERE ${quote(d, 'token')} = ?`, [token])
        })
    }

    async deleteLocalSessionsForUser(userId: string): Promise<void> {
        await this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            await query(runner, `DELETE FROM ${quote(d, 'identity_local_session')} WHERE ${quote(d, 'userId')} = ?`, [userId])
        })
    }

    async localAccountOpen(userId: string): Promise<boolean> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const users = await query(
                runner,
                `SELECT ${quote(d, 'status')} AS ${quote(d, 'status')} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`,
                [userId]
            )
            if (!users.length || text(cell(users[0], 'status')).trim().toLowerCase() !== 'active') return false
            const disabled = await query(
                runner,
                `SELECT COUNT(*) AS ${quote(d, 'count')} FROM ${quote(d, 'organization_user')} WHERE ${quote(
                    d,
                    'userId'
                )} = ? AND LOWER(${quote(d, 'status')}) = 'disable'`,
                [userId]
            )
            return Number(cell(disabled[0] || {}, 'count') || 0) === 0
        })
    }

    private async withRunner<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
        const runner = this.dataSource.createQueryRunner()
        await runner.connect()
        try {
            return await fn(runner)
        } finally {
            await runner.release()
        }
    }

    private async transaction<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
        let release: () => void = () => undefined
        const next = new Promise<void>((resolve) => {
            release = resolve
        })
        const previous = this.gate
        this.gate = next
        await previous
        try {
            return await this.withRunner(async (runner) => {
                const sqlite = dialectOf(runner) === 'sqlite'
                // Deferred BEGIN lets a second connection delete the winner's bootstrap row.
                if (sqlite) await runner.query('BEGIN IMMEDIATE')
                else await runner.startTransaction()
                try {
                    const value = await fn(runner)
                    if (sqlite) await runner.query('COMMIT')
                    else await runner.commitTransaction()
                    return value
                } catch (error) {
                    if (sqlite) await runner.query('ROLLBACK')
                    else await runner.rollbackTransaction()
                    throw error
                } finally {
                    const dialect = dialectOf(runner)
                    if (dialect === 'mysql' || dialect === 'mariadb') await query(runner, `SELECT RELEASE_LOCK('identity_bootstrap')`)
                }
            })
        } finally {
            release()
        }
    }
}

async function lockBootstrap(runner: QueryRunner, dialect: Dialect): Promise<void> {
    if (dialect === 'postgres') {
        await runner.query(`LOCK TABLE ${quote(dialect, 'identity_bootstrap')} IN EXCLUSIVE MODE`)
        return
    }
    if (dialect === 'mysql' || dialect === 'mariadb') {
        const rows = await query(runner, `SELECT GET_LOCK('identity_bootstrap', 10) AS ${quote(dialect, 'locked')}`)
        if (Number(cell(rows[0] || {}, 'locked')) !== 1) throw new Error('bootstrap lock')
    }
}

function selectUser(dialect: Dialect, alias?: string): string {
    const prefix = alias ? `${alias}.` : ''
    return ['id', 'email', 'name', 'status', 'externalId', 'credential'].map((name) => `${prefix}${quote(dialect, name)}`).join(', ')
}

async function count(runner: QueryRunner): Promise<number> {
    const d = dialectOf(runner)
    const rows = await query(runner, `SELECT COUNT(*) AS ${quote(d, 'count')} FROM ${quote(d, 'user')}`)
    return Number(cell(rows[0] || {}, 'count') || 0)
}

/** Active user, active org membership, and the active team's role. Owner is the org role, not the session flag. */
export interface TeamAccess {
    owner: boolean
    permissions: string[] | null
}

const DENIED_ACCESS: TeamAccess = { owner: false, permissions: null }

function isActive(value: unknown): boolean {
    return text(value).trim().toLowerCase() === 'active'
}

function dialectOfSource(dataSource: DataSource): Dialect {
    const type = dataSource.options.type
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb' || type === 'sqlite') return type
    return 'sqlite'
}

/** One statement on the pool. Does not take a query runner. */
async function querySource(dataSource: DataSource, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const dialect = dialectOfSource(dataSource)
    let index = 0
    const textSql = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    const result: unknown = await dataSource.query(textSql, params)
    if (!Array.isArray(result)) return []
    // mysql2 hands back [rows, fields]. A row list's first element is an object.
    if (result.length === 2 && Array.isArray(result[0]) && result[1] && typeof result[1] === 'object' && !Array.isArray(result[1])) {
        return result[0] as Record<string, unknown>[]
    }
    return result as Record<string, unknown>[]
}

/**
 * Stored team statuses are `active`, `disable`, and `invited`.
 * Only `active` and `invited` grant. `disable` and any unknown value do not.
 */
function teamGrants(status: unknown): boolean {
    const value = text(status).trim().toLowerCase()
    return value === 'active' || value === 'invited'
}

/**
 * One query. User status and organization-membership status grant only for `active`
 * (the user values are `active`, `invited`, `unverified`, `deleted`; the organization
 * values are `active`, `disable`, `invited`).
 * A team row grants only for `active` or `invited`.
 * owner is true only for an active user whose active org membership has the owner role.
 */
export async function teamAccess(dataSource: DataSource, userId: string, workspaceId: string): Promise<TeamAccess> {
    const d = dialectOfSource(dataSource)
    const rows = await querySource(
        dataSource,
        `SELECT u.${quote(d, 'status')} AS ${quote(d, 'userStatus')},
                ou.${quote(d, 'status')} AS ${quote(d, 'orgStatus')},
                orgRole.${quote(d, 'name')} AS ${quote(d, 'orgRoleName')},
                wu.${quote(d, 'workspaceId')} AS ${quote(d, 'teamId')},
                wu.${quote(d, 'status')} AS ${quote(d, 'teamStatus')},
                teamRole.${quote(d, 'permissions')} AS ${quote(d, 'permissions')}
         FROM ${quote(d, 'user')} u
         LEFT JOIN ${quote(d, 'organization_user')} ou ON ou.${quote(d, 'userId')} = u.${quote(d, 'id')}
         LEFT JOIN ${quote(d, 'role')} orgRole ON orgRole.${quote(d, 'id')} = ou.${quote(d, 'roleId')}
         LEFT JOIN ${quote(d, 'workspace_user')} wu
           ON wu.${quote(d, 'userId')} = u.${quote(d, 'id')} AND wu.${quote(d, 'workspaceId')} = ?
         LEFT JOIN ${quote(d, 'role')} teamRole ON teamRole.${quote(d, 'id')} = wu.${quote(d, 'roleId')}
         WHERE u.${quote(d, 'id')} = ?`,
        [workspaceId, userId]
    )
    if (!rows.length || !isActive(cell(rows[0], 'userStatus'))) return DENIED_ACCESS
    const orgRows = rows.filter((row) => isActive(cell(row, 'orgStatus')))
    if (!orgRows.length) return DENIED_ACCESS
    const owner = orgRows.some((row) => text(cell(row, 'orgRoleName')).toLowerCase() === OWNER_ROLE)
    const teamRows = rows.filter((row) => text(cell(row, 'teamId')) && teamGrants(cell(row, 'teamStatus')))
    if (!teamRows.length) return { owner, permissions: null }
    const grants = new Set<string>()
    for (const row of teamRows) {
        for (const permission of permissionsOf(cell(row, 'permissions'))) {
            const trimmed = permission.trim()
            if (trimmed) grants.add(trimmed)
        }
    }
    return { owner, permissions: [...grants] }
}

function isUniqueViolation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /UNIQUE constraint failed|duplicate key|ER_DUP_ENTRY|23505/i.test(message)
}

/** Failed sign-ins. Old rows are deleted on each check. The email is stored as an HMAC. */
export class SqlLoginRateLimit implements LoginLimiter {
    constructor(
        private readonly dataSource: DataSource,
        private readonly limit: number | (() => number) = () => runtimeNumber('CUTTLELY_LOGIN_FAILURE_LIMIT'),
        private readonly windowMs = LOGIN_FAILURE_WINDOW_MS,
        private readonly accountCap = ACCOUNT_LOCK_CAP
    ) {}

    private cap(): number {
        return typeof this.limit === 'function' ? this.limit() : this.limit
    }

    async blocked(ip: string, account: string, now: number): Promise<boolean> {
        return this.with(async (runner) => {
            await this.prune(runner, now)
            if ((await this.countScope(runner, 'ip', ip, now)) >= this.cap()) return true
            const key = accountLockKey(account)
            return key !== '' && (await this.countScope(runner, 'account', key, now)) >= this.cap()
        })
    }

    async recordFailure(ip: string, account: string, now: number): Promise<void> {
        await this.with(async (runner) => {
            await this.prune(runner, now)
            await this.insert(runner, 'ip', ip, now)
            const key = accountLockKey(account)
            if (key) await this.insert(runner, 'account', key, now)
            await this.evictAccounts(runner)
        })
    }

    private async with<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
        const runner = this.dataSource.createQueryRunner()
        await runner.connect()
        try {
            return await fn(runner)
        } finally {
            await runner.release()
        }
    }

    private async prune(runner: QueryRunner, now: number): Promise<void> {
        const d = dialectOf(runner)
        await query(runner, `DELETE FROM ${quote(d, 'identity_login_failure')} WHERE ${quote(d, 'attemptedAt')} < ?`, [now - this.windowMs])
        await this.evictAccounts(runner)
    }

    /** Drop the least recently used email keys when too many distinct addresses have failed. */
    private async evictAccounts(runner: QueryRunner): Promise<void> {
        const d = dialectOf(runner)
        const subjects = await query(
            runner,
            `SELECT ${quote(d, 'subject')} AS ${quote(d, 'subject')}, MAX(${quote(d, 'attemptedAt')}) AS ${quote(d, 'latest')} FROM ${quote(
                d,
                'identity_login_failure'
            )} WHERE ${quote(d, 'scope')} = 'account' GROUP BY ${quote(d, 'subject')} ORDER BY ${quote(d, 'latest')} ASC`
        )
        const extra = subjects.length - this.accountCap
        if (extra <= 0) return
        for (const row of subjects.slice(0, extra)) {
            await query(
                runner,
                `DELETE FROM ${quote(d, 'identity_login_failure')} WHERE ${quote(d, 'scope')} = 'account' AND ${quote(d, 'subject')} = ?`,
                [text(cell(row, 'subject'))]
            )
        }
    }

    private async countScope(runner: QueryRunner, scope: string, key: string, now: number): Promise<number> {
        const d = dialectOf(runner)
        const rows = await query(
            runner,
            `SELECT COUNT(*) AS ${quote(d, 'count')} FROM ${quote(d, 'identity_login_failure')} WHERE ${quote(d, 'scope')} = ? AND ${quote(
                d,
                'subject'
            )} = ? AND ${quote(d, 'attemptedAt')} >= ?`,
            [scope, key, now - this.windowMs]
        )
        return Number(cell(rows[0] || {}, 'count') || 0)
    }

    private async insert(runner: QueryRunner, scope: string, key: string, now: number): Promise<void> {
        const d = dialectOf(runner)
        await query(
            runner,
            `INSERT INTO ${quote(d, 'identity_login_failure')} (${quote(d, 'id')}, ${quote(d, 'scope')}, ${quote(d, 'subject')}, ${quote(
                d,
                'attemptedAt'
            )}) VALUES (?, ?, ?, ?)`,
            [randomUUID(), scope, key, now]
        )
    }
}
