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

import { randomUUID, timingSafeEqual } from 'crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { DataSource, QueryRunner } from 'typeorm'
import { DEFAULT_WORKSPACE, LOGIN_FAILURE_WINDOW_MS, OPEN_SOURCE_FEATURES, OWNER_ROLE, PERSONAL_WORKSPACE } from './constants'
import { ACCOUNT_LOCK_CAP, LoginLimiter, accountLockKey } from './rateLimit'
import { runtimeNumber } from '../settings/runtime'
import { AuthKitSwitchApply, AuthKitSwitchState, nextAuthKitSwitch } from './authKitSwitch'
import { utcEpoch } from './dbTime'
import { addSessionSeenColumn } from './schemaMigration'
import { isBcryptHash } from './password'
import { IdentityStore } from './store'
import { SetupCodeRow, SetupCodeStore, SetupCodeWrite } from './setupCode'
import {
    CreateOwnerInput,
    CreateOwnerOptions,
    InviteSignIn,
    LocalSession,
    NotEmptyError,
    SessionUser,
    SetupCodeRejected,
    UserRow
} from './types'
import { acceptAuthKitInvite } from './actionLink'
import { sqlFromDataSource } from './directory'

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

function switchStateFrom(row: Record<string, unknown>): AuthKitSwitchState {
    const when = cell(row, 'switchedAt')
    const empty = when === null || when === undefined || when === ''
    return {
        configured: Number(cell(row, 'configured')) === 1,
        sessionsEnded: Number(cell(row, 'sessionsEnded') || 0),
        switchedAt: empty ? null : new Date(utcEpoch(when)).toISOString()
    }
}

async function readSwitchRow(runner: QueryRunner): Promise<AuthKitSwitchState | null> {
    const d = dialectOf(runner)
    const rows = await query(
        runner,
        `SELECT ${quote(d, 'configured')} AS ${quote(d, 'configured')}, ${quote(d, 'sessionsEnded')} AS ${quote(
            d,
            'sessionsEnded'
        )}, ${quote(d, 'switchedAt')} AS ${quote(d, 'switchedAt')} FROM ${quote(d, 'identity_authkit_switch')} WHERE ${quote(d, 'id')} = 1`
    )
    return rows[0] ? switchStateFrom(rows[0]) : null
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
                `SELECT ${selectUser(d)} FROM ${quote(d, 'user')} WHERE LOWER(TRIM(${quote(d, 'email')})) = LOWER(TRIM(?))`,
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

    async replaceCredential(userId: string, expected: string, next: string): Promise<boolean> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            // TypeORM UPDATE result shape differs by dialect (Postgres rowCount, SQLite often undefined).
            // UPDATE ... WHERE the old hash, then SELECT to confirm, so both drivers agree.
            await query(
                runner,
                `UPDATE ${quote(d, 'user')} SET ${quote(d, 'credential')} = ?, ${quote(d, 'updatedDate')} = CURRENT_TIMESTAMP WHERE ${quote(
                    d,
                    'id'
                )} = ? AND ${quote(d, 'credential')} = ?`,
                [next, userId, expected]
            )
            const rows = await query(
                runner,
                `SELECT ${quote(d, 'credential')} AS ${quote(d, 'credential')} FROM ${quote(d, 'user')} WHERE ${quote(d, 'id')} = ?`,
                [userId]
            )
            return Boolean(rows[0] && text(cell(rows[0], 'credential')) === next)
        })
    }

    async hasBcryptCredential(): Promise<boolean> {
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            // LIKE $2x$% also matches cost-31 and other rejected shapes. Keyset by id
            // (no OFFSET) until isBcryptHash hits so a later accepted hash is not hidden.
            const page = 32
            let after: string | null = null
            for (;;) {
                const keyset = after ? ` AND ${quote(d, 'id')} > ?` : ''
                const rows = await query(
                    runner,
                    `SELECT ${quote(d, 'id')} AS ${quote(d, 'id')}, ${quote(d, 'credential')} AS ${quote(d, 'credential')}
                     FROM ${quote(d, 'user')}
                     WHERE (${quote(d, 'credential')} LIKE '$2a$%'
                        OR ${quote(d, 'credential')} LIKE '$2b$%'
                        OR ${quote(d, 'credential')} LIKE '$2y$%')${keyset}
                     ORDER BY ${quote(d, 'id')}
                     LIMIT ?`,
                    after ? [after, page] : [page]
                )
                if (!rows.length) return false
                if (rows.some((row) => isBcryptHash(text(cell(row, 'credential'))))) return true
                if (rows.length < page) return false
                after = text(cell(rows[rows.length - 1], 'id'))
            }
        })
    }

    async acceptInvite(input: InviteSignIn): Promise<'accepted' | 'invalid'> {
        return acceptAuthKitInvite(sqlFromDataSource(this.dataSource), input)
    }

    async createOwner(input: CreateOwnerInput, options?: CreateOwnerOptions): Promise<UserRow> {
        return this.transaction(async (runner) => {
            const d = dialectOf(runner)
            await lockBootstrap(runner, d)
            if ((await count(runner)) !== 0) throw new NotEmptyError()
            // An open first-run code is retired in this same createOwner transaction.
            if (options?.consumeSetupHmac) await consumeSetupCodeRow(runner, d, options.consumeSetupHmac, options.now ?? Date.now())
            else await retireOpenSetupCodeRow(runner, d, options?.now ?? Date.now())
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
            const memberships = await query(
                runner,
                `SELECT w.${quote(d, 'id')} AS ${quote(d, 'workspaceId')}, w.${quote(d, 'name')} AS ${quote(d, 'workspaceName')},
                        w.${quote(d, 'organizationId')} AS ${quote(d, 'organizationId')},
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
            // The first organization row is not the active one. Owner follows the team that this request is in.
            const activeOrgId = active ? text(cell(active, 'organizationId')) : ''
            const org = orgs.find((row) => text(cell(row, 'organizationId')) === activeOrgId)
            let orgStatus = text(cell(org || {}, 'orgStatus'))
                .trim()
                .toLowerCase()
            // Re-invited existing users are stored as invited. Open only the active team's organization. disable stays disable.
            if (activeOrgId && org && orgStatus === 'invited') {
                await query(
                    runner,
                    `UPDATE ${quote(d, 'organization_user')} SET ${quote(d, 'status')} = ?
                     WHERE ${quote(d, 'userId')} = ? AND ${quote(d, 'organizationId')} = ? AND LOWER(${quote(d, 'status')}) = 'invited'`,
                    ['active', userId, activeOrgId]
                )
                orgStatus = 'active'
            }
            const owner = isActive(user.status) && orgStatus === 'active' && text(cell(org || {}, 'roleName')).toLowerCase() === OWNER_ROLE
            return {
                id: user.id,
                email: user.email,
                name: user.name,
                status: user.status,
                role: owner ? OWNER_ROLE : text(cell(active || {}, 'roleName')),
                isSSO: false,
                activeOrganizationId: activeOrgId || null,
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
            const columns = `${quote(d, 'id')}, ${quote(d, 'userId')}, ${quote(d, 'token')}, ${quote(d, 'expiresAt')}, ${quote(
                d,
                'absoluteExpiresAt'
            )}, ${quote(d, 'lastSeenAt')}, ${quote(d, 'permissionVersion')}`
            const select = `SELECT ?, ?, ?, ?, ?, ?, COALESCE(u.${quote(d, 'permissionVersion')}, 0) FROM ${quote(
                d,
                'user'
            )} u WHERE u.${quote(d, 'id')} = ?`
            const insert =
                d === 'sqlite'
                    ? `INSERT OR IGNORE INTO ${quote(d, 'identity_local_session')} (${columns}) ${select}`
                    : d === 'postgres'
                    ? `INSERT INTO ${quote(d, 'identity_local_session')} (${columns}) ${select} ON CONFLICT (${quote(
                          d,
                          'token'
                      )}) DO NOTHING`
                    : `INSERT IGNORE INTO ${quote(d, 'identity_local_session')} (${columns}) ${select}`
            try {
                await query(runner, insert, [row.id, row.userId, row.token, row.idleExpires, row.absoluteExpires, seen, row.userId])
            } catch (error) {
                if (!isUniqueViolation(error)) throw error
            }
        })
    }

    async findLocalSession(token: string): Promise<LocalSession | null> {
        await this.ensureSeenColumn()
        return this.withRunner(async (runner) => {
            const d = dialectOf(runner)
            const rows = await query(
                runner,
                `SELECT s.${quote(d, 'id')} AS ${quote(d, 'id')}, s.${quote(d, 'userId')} AS ${quote(d, 'userId')}, s.${quote(
                    d,
                    'token'
                )} AS ${quote(d, 'token')}, s.${quote(d, 'expiresAt')} AS ${quote(d, 'expiresAt')}, s.${quote(
                    d,
                    'absoluteExpiresAt'
                )} AS ${quote(d, 'absoluteExpiresAt')}, s.${quote(d, 'createdDate')} AS ${quote(d, 'createdDate')}, s.${quote(
                    d,
                    'lastSeenAt'
                )} AS ${quote(d, 'lastSeenAt')}, s.${quote(d, 'permissionVersion')} AS ${quote(d, 'permissionVersion')},
                u.${quote(d, 'permissionVersion')} AS ${quote(d, 'currentPermissionVersion')}
                FROM ${quote(d, 'identity_local_session')} s
                INNER JOIN ${quote(d, 'user')} u ON u.${quote(d, 'id')}${d === 'postgres' ? '::text' : ''} = s.${quote(d, 'userId')}
                WHERE s.${quote(d, 'token')} = ?`,
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
                lastSeenAt: seen > 0 ? new Date(seen) : undefined,
                permissionVersion: Number(cell(row, 'permissionVersion') || 0),
                currentPermissionVersion: Number(cell(row, 'currentPermissionVersion') || 0)
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

    async readAuthKitSwitch(): Promise<AuthKitSwitchState | null> {
        return this.withRunner(async (runner) => readSwitchRow(runner))
    }

    async applyAuthKitSwitch(configured: boolean, at: Date, options: AuthKitSwitchApply = {}): Promise<AuthKitSwitchState> {
        return this.transaction(async (runner) => {
            const d = dialectOf(runner)
            const table = quote(d, 'identity_authkit_switch')
            const id = quote(d, 'id')
            const insert =
                d === 'sqlite'
                    ? `INSERT OR IGNORE INTO ${table} (${id}, ${quote(d, 'configured')}, ${quote(d, 'sessionsEnded')}, ${quote(
                          d,
                          'switchedAt'
                      )}) VALUES (1, 0, 0, NULL)`
                    : d === 'postgres'
                    ? `INSERT INTO ${table} (${id}, ${quote(d, 'configured')}, ${quote(d, 'sessionsEnded')}, ${quote(
                          d,
                          'switchedAt'
                      )}) VALUES (1, 0, 0, NULL) ON CONFLICT (${id}) DO NOTHING`
                    : `INSERT IGNORE INTO ${table} (${id}, ${quote(d, 'configured')}, ${quote(d, 'sessionsEnded')}, ${quote(
                          d,
                          'switchedAt'
                      )}) VALUES (1, 0, 0, NULL)`
            await query(runner, insert)
            const locked = d === 'sqlite' ? '' : ' FOR UPDATE'
            const rows = await query(
                runner,
                `SELECT ${quote(d, 'configured')} AS ${quote(d, 'configured')}, ${quote(d, 'sessionsEnded')} AS ${quote(
                    d,
                    'sessionsEnded'
                )}, ${quote(d, 'switchedAt')} AS ${quote(d, 'switchedAt')} FROM ${table} WHERE ${id} = 1${locked}`
            )
            const previous = rows[0] ? switchStateFrom(rows[0]) : null
            const counted = await query(runner, `SELECT COUNT(*) AS ${quote(d, 'count')} FROM ${quote(d, 'identity_local_session')}`)
            const live = Number(cell(counted[0] || {}, 'count') || 0)
            const next = nextAuthKitSwitch(previous, configured, at, live, options)
            if (next.endSessions) await query(runner, `DELETE FROM ${quote(d, 'identity_local_session')}`)
            await query(
                runner,
                `UPDATE ${table} SET ${quote(d, 'configured')} = ?, ${quote(d, 'sessionsEnded')} = ?, ${quote(
                    d,
                    'switchedAt'
                )} = ? WHERE ${id} = 1`,
                [next.state.configured ? 1 : 0, next.state.sessionsEnded, next.state.switchedAt ? new Date(next.state.switchedAt) : null]
            )
            return next.state
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

function sameHmac(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** True when the setup-code table is already there. Older incremental schemas do not have it yet. */
async function setupCodeTablePresent(runner: QueryRunner, dialect: Dialect): Promise<boolean> {
    if (dialect === 'sqlite') {
        const rows = await query(runner, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_setup_code'`)
        return rows.length > 0
    }
    if (dialect === 'postgres') {
        const rows = await query(runner, `SELECT to_regclass('identity_setup_code') AS ${quote(dialect, 'name')}`)
        const name = cell(rows[0] || {}, 'name')
        return name != null && String(name) !== ''
    }
    const rows = await query(
        runner,
        `SELECT TABLE_NAME AS ${quote(
            dialect,
            'name'
        )} FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'identity_setup_code'`
    )
    return rows.length > 0
}

/** Marks any unconsumed setup row used. Operator commands do this inside createOwner. */
async function retireOpenSetupCodeRow(runner: QueryRunner, dialect: Dialect, now: number): Promise<void> {
    if (!(await setupCodeTablePresent(runner, dialect))) return
    await query(
        runner,
        `UPDATE ${quote(dialect, 'identity_setup_code')}
         SET ${quote(dialect, 'consumedAt')} = ?
         WHERE ${quote(dialect, 'id')} = 1 AND ${quote(dialect, 'consumedAt')} IS NULL`,
        [now]
    )
}

/** Marks the setup row used in the same transaction that inserts the owner. */
async function consumeSetupCodeRow(runner: QueryRunner, dialect: Dialect, hmac: string, now: number): Promise<void> {
    const rows = await query(
        runner,
        `SELECT ${quote(dialect, 'codeHmac')} AS ${quote(dialect, 'codeHmac')},
                ${quote(dialect, 'expiresAt')} AS ${quote(dialect, 'expiresAt')},
                ${quote(dialect, 'consumedAt')} AS ${quote(dialect, 'consumedAt')}
         FROM ${quote(dialect, 'identity_setup_code')} WHERE ${quote(dialect, 'id')} = 1`
    )
    const row = rows[0]
    const stored = text(cell(row || {}, 'codeHmac'))
    const expires = Number(cell(row || {}, 'expiresAt'))
    const consumed = cell(row || {}, 'consumedAt')
    const unused = consumed === null || consumed === undefined || consumed === ''
    if (!row || !unused || !(expires > now) || !sameHmac(stored, hmac)) throw new SetupCodeRejected()
    await query(
        runner,
        `UPDATE ${quote(dialect, 'identity_setup_code')}
         SET ${quote(dialect, 'consumedAt')} = ?
         WHERE ${quote(dialect, 'id')} = 1
           AND ${quote(dialect, 'consumedAt')} IS NULL
           AND ${quote(dialect, 'expiresAt')} > ?
           AND ${quote(dialect, 'codeHmac')} = ?`,
        [now, now, hmac]
    )
    const after = await query(
        runner,
        `SELECT ${quote(dialect, 'consumedAt')} AS ${quote(dialect, 'consumedAt')}
         FROM ${quote(dialect, 'identity_setup_code')} WHERE ${quote(dialect, 'id')} = 1`
    )
    if (Number(cell(after[0] || {}, 'consumedAt')) !== now) throw new SetupCodeRejected()
}

function optionalEpoch(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function setupCodeRowFrom(row: Record<string, unknown>): SetupCodeRow {
    const consumed = cell(row, 'consumedAt')
    const previousHmac = text(cell(row, 'previousCodeHmac'))
    return {
        codeHmac: text(cell(row, 'codeHmac')),
        issuedAt: Number(cell(row, 'issuedAt')),
        expiresAt: Number(cell(row, 'expiresAt')),
        consumedAt: consumed === null || consumed === undefined || consumed === '' ? null : Number(consumed),
        previousCodeHmac: previousHmac ? previousHmac : null,
        previousExpiresAt: optionalEpoch(cell(row, 'previousExpiresAt'))
    }
}

function sameOptional(left: string | number | null | undefined, right: string | number | null | undefined): boolean {
    return (left ?? null) === (right ?? null)
}

function sameSetupRow(left: SetupCodeRow | null, right: SetupCodeRow): boolean {
    if (!left) return false
    return (
        left.codeHmac === right.codeHmac &&
        left.issuedAt === right.issuedAt &&
        left.expiresAt === right.expiresAt &&
        left.consumedAt === right.consumedAt &&
        sameOptional(left.previousCodeHmac, right.previousCodeHmac) &&
        sameOptional(left.previousExpiresAt, right.previousExpiresAt)
    )
}

function setupCodeSelect(dialect: Dialect): string {
    return `SELECT ${quote(dialect, 'codeHmac')} AS ${quote(dialect, 'codeHmac')},
                    ${quote(dialect, 'issuedAt')} AS ${quote(dialect, 'issuedAt')},
                    ${quote(dialect, 'expiresAt')} AS ${quote(dialect, 'expiresAt')},
                    ${quote(dialect, 'consumedAt')} AS ${quote(dialect, 'consumedAt')},
                    ${quote(dialect, 'previousCodeHmac')} AS ${quote(dialect, 'previousCodeHmac')},
                    ${quote(dialect, 'previousExpiresAt')} AS ${quote(dialect, 'previousExpiresAt')}
             FROM ${quote(dialect, 'identity_setup_code')} WHERE ${quote(dialect, 'id')} = 1`
}

/**
 * One statement for sqlite and postgres. Inserts the singleton row when it is absent.
 * Updates it only when it is consumed, expired at this write's issued time, or still this process's HMAC.
 * MySQL and MariaDB use a transaction in SqlSetupCodeStore instead of a user variable.
 */
function conditionalSetupUpsert(dialect: Dialect): string {
    const table = quote(dialect, 'identity_setup_code')
    const id = quote(dialect, 'id')
    const codeHmac = quote(dialect, 'codeHmac')
    const issuedAt = quote(dialect, 'issuedAt')
    const expiresAt = quote(dialect, 'expiresAt')
    const consumedAt = quote(dialect, 'consumedAt')
    const previousCodeHmac = quote(dialect, 'previousCodeHmac')
    const previousExpiresAt = quote(dialect, 'previousExpiresAt')
    const insert = `INSERT INTO ${table} (${id}, ${codeHmac}, ${issuedAt}, ${expiresAt}, ${consumedAt}, ${previousCodeHmac}, ${previousExpiresAt}) VALUES (1, ?, ?, ?, ?, ?, ?)`
    if (dialect === 'sqlite' || dialect === 'postgres') {
        const excluded = dialect === 'postgres' ? 'EXCLUDED' : 'excluded'
        return `${insert}
            ON CONFLICT (${id}) DO UPDATE SET
                ${codeHmac} = ${excluded}.${codeHmac},
                ${issuedAt} = ${excluded}.${issuedAt},
                ${expiresAt} = ${excluded}.${expiresAt},
                ${consumedAt} = ${excluded}.${consumedAt},
                ${previousCodeHmac} = ${excluded}.${previousCodeHmac},
                ${previousExpiresAt} = ${excluded}.${previousExpiresAt}
            WHERE ${table}.${consumedAt} IS NOT NULL
               OR ${table}.${expiresAt} <= ?
               OR ${table}.${codeHmac} = ?`
    }
    throw new Error('MySQL and MariaDB setup writes use a transaction')
}

function affectedCount(result: unknown): number {
    if (result && typeof result === 'object' && 'affectedRows' in result) {
        return Number((result as { affectedRows: unknown }).affectedRows) || 0
    }
    if (Array.isArray(result) && result[0] && typeof result[0] === 'object' && 'affectedRows' in result[0]) {
        return Number((result[0] as { affectedRows: unknown }).affectedRows) || 0
    }
    return 0
}

/** InnoDB can abort one of two setup writes. The caller waits, then tries that write again. */
function isLockConflict(error: unknown): boolean {
    const record = error as { code?: string; errno?: number; driverError?: { code?: string; errno?: number } }
    const code = record.driverError?.code || record.code
    const errno = record.driverError?.errno || record.errno
    return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1213 || errno === 1205
}

/** How many times a MySQL or MariaDB setup write may run when the engine reports a lock conflict. */
export const SETUP_LOCK_RETRY_ATTEMPTS = 6
/** Full-jitter ceiling for the first wait. Later waits double this until the cap. */
export const SETUP_LOCK_RETRY_BASE_MS = 20
export const SETUP_LOCK_RETRY_CAP_MS = 250

export interface SetupLockRetryOptions {
    sleep?: (ms: number) => Promise<void>
    random?: () => number
}

/** Uniform draw from 0 through the attempt ceiling. The ceiling doubles, then stays at the cap. */
export function setupLockDelayMs(
    failed: number,
    random: () => number,
    baseMs = SETUP_LOCK_RETRY_BASE_MS,
    capMs = SETUP_LOCK_RETRY_CAP_MS
): number {
    const ceiling = Math.min(capMs, baseMs * 2 ** failed)
    const sample = random()
    const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0
    return Math.round(unit * ceiling)
}

export async function retryOnSetupLockConflict<T>(run: () => Promise<T>, options: SetupLockRetryOptions = {}): Promise<T> {
    const sleep = options.sleep ?? ((ms: number) => delay(ms))
    const random = options.random ?? Math.random
    let last: unknown
    for (let attempt = 0; attempt < SETUP_LOCK_RETRY_ATTEMPTS; attempt++) {
        try {
            return await run()
        } catch (error) {
            last = error
            if (!isLockConflict(error) || attempt === SETUP_LOCK_RETRY_ATTEMPTS - 1) throw error
            await sleep(setupLockDelayMs(attempt, random))
        }
    }
    throw last
}

/** Reads and writes the single setup-code row. Owner creation consumes it inside its own transaction. */
export class SqlSetupCodeStore implements SetupCodeStore {
    constructor(private readonly dataSource: DataSource, private readonly lockRetry: SetupLockRetryOptions = {}) {}

    async read(): Promise<SetupCodeRow | null> {
        const d = dialectOfSource(this.dataSource)
        const rows = await querySource(this.dataSource, setupCodeSelect(d), [])
        return rows[0] ? setupCodeRowFrom(rows[0]) : null
    }

    async save(row: SetupCodeRow, previousHmac?: string | null): Promise<SetupCodeWrite> {
        const d = dialectOfSource(this.dataSource)
        if (d === 'mysql' || d === 'mariadb') return this.saveOnMysql(row, previousHmac ?? '')
        const before = await this.read()
        const previous = previousHmac ?? ''
        await querySource(this.dataSource, conditionalSetupUpsert(d), [
            row.codeHmac,
            row.issuedAt,
            row.expiresAt,
            row.consumedAt,
            row.previousCodeHmac ?? null,
            row.previousExpiresAt ?? null,
            row.issuedAt,
            previous
        ])
        const after = await this.read()
        if (!sameSetupRow(after, row)) return 'kept'
        if (!before) return 'inserted'
        if (!sameSetupRow(before, row)) return 'replaced'
        return 'inserted'
    }

    /**
     * Insert if absent, lock the singleton row, then update it only when it is consumed,
     * expired at this write's issued time, or still this process's HMAC.
     * A second copy that finds a fresh live row leaves that row in place.
     */
    private async saveOnMysql(row: SetupCodeRow, previous: string): Promise<SetupCodeWrite> {
        return retryOnSetupLockConflict(() => this.saveOnMysqlOnce(row, previous), this.lockRetry)
    }

    private async saveOnMysqlOnce(row: SetupCodeRow, previous: string): Promise<SetupCodeWrite> {
        const d = dialectOfSource(this.dataSource)
        const runner = this.dataSource.createQueryRunner()
        await runner.connect()
        await runner.startTransaction()
        try {
            const table = quote(d, 'identity_setup_code')
            const insertResult: unknown = await runner.query(
                `INSERT IGNORE INTO ${table} (${quote(d, 'id')}, ${quote(d, 'codeHmac')}, ${quote(d, 'issuedAt')}, ${quote(
                    d,
                    'expiresAt'
                )}, ${quote(d, 'consumedAt')}, ${quote(d, 'previousCodeHmac')}, ${quote(
                    d,
                    'previousExpiresAt'
                )}) VALUES (1, ?, ?, ?, ?, ?, ?)`,
                [row.codeHmac, row.issuedAt, row.expiresAt, row.consumedAt, row.previousCodeHmac ?? null, row.previousExpiresAt ?? null]
            )
            const insertedRows = affectedCount(insertResult)
            const locked = await query(runner, `${setupCodeSelect(d)} FOR UPDATE`)
            const prior = locked[0] ? setupCodeRowFrom(locked[0]) : null
            const updateResult: unknown = await runner.query(
                `UPDATE ${table}
                 SET ${quote(d, 'codeHmac')} = ?, ${quote(d, 'issuedAt')} = ?, ${quote(d, 'expiresAt')} = ?, ${quote(d, 'consumedAt')} = ?,
                     ${quote(d, 'previousCodeHmac')} = ?, ${quote(d, 'previousExpiresAt')} = ?
                 WHERE ${quote(d, 'id')} = 1
                   AND (${quote(d, 'consumedAt')} IS NOT NULL OR ${quote(d, 'expiresAt')} <= ? OR ${quote(d, 'codeHmac')} = ?)`,
                [
                    row.codeHmac,
                    row.issuedAt,
                    row.expiresAt,
                    row.consumedAt,
                    row.previousCodeHmac ?? null,
                    row.previousExpiresAt ?? null,
                    row.issuedAt,
                    previous
                ]
            )
            const updatedRows = affectedCount(updateResult)
            const afterRows = await query(runner, setupCodeSelect(d))
            const after = afterRows[0] ? setupCodeRowFrom(afterRows[0]) : null
            await runner.commitTransaction()
            if (!sameSetupRow(after, row)) return 'kept'
            if (insertedRows > 0 && sameSetupRow(prior, row) && updatedRows === 0) return 'inserted'
            if (!prior) return 'inserted'
            if (!sameSetupRow(prior, row)) return 'replaced'
            return 'inserted'
        } catch (error) {
            try {
                await runner.rollbackTransaction()
            } catch {
                // The engine already ended the transaction.
            }
            throw error
        } finally {
            await runner.release()
        }
    }

    async consume(hmac: string, now: number): Promise<boolean> {
        const row = await this.read()
        if (!row || row.consumedAt != null || row.expiresAt <= now || !sameHmac(row.codeHmac, hmac)) return false
        const outcome = await this.save({ ...row, consumedAt: now }, row.codeHmac)
        return outcome !== 'kept'
    }
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
 * owner is true only when the active membership in the active workspace's organization has the owner role.
 * An owner role in another organization does not count.
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
         LEFT JOIN ${quote(d, 'workspace')} w ON w.${quote(d, 'id')} = ?
         LEFT JOIN ${quote(d, 'organization_user')} ou
           ON ou.${quote(d, 'userId')} = u.${quote(d, 'id')}
          AND ou.${quote(d, 'organizationId')} = w.${quote(d, 'organizationId')}
         LEFT JOIN ${quote(d, 'role')} orgRole ON orgRole.${quote(d, 'id')} = ou.${quote(d, 'roleId')}
         LEFT JOIN ${quote(d, 'workspace_user')} wu
           ON wu.${quote(d, 'userId')} = u.${quote(d, 'id')} AND wu.${quote(d, 'workspaceId')} = w.${quote(d, 'id')}
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
