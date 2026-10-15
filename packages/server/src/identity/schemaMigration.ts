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
 *
 * Additive schema from docs/identity/phase0-spec.md section 12.
 * The `user` table has no externalId column before this migration.
 * Break-glass rows use identity_local_session. login_sessions is left alone:
 * creating it made the unset-WorkOS smoke login fail. Unique indexes allow
 * multiple NULLs on these dialects, which is the "unique where not null" rule.
 * identity_bootstrap and identity_login_failure are a later migration so a
 * database that already applied the sign-in migration still receives them.
 */

import type { QueryRunner } from 'typeorm'
import { SEEDED_BUILT_IN_ROLES, builtInPermissionJson } from './builtInRoles'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

function dialectOf(runner: QueryRunner): Dialect {
    const type = runner.connection.options.type
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb') return type
    return 'sqlite'
}

function q(dialect: Dialect, name: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

async function rows(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const dialect = dialectOf(runner)
    let index = 0
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    const result = await runner.query(text, params)
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : []
}

function hasName(list: Record<string, unknown>[], name: string): boolean {
    return list.some((row) => {
        const value = row.name ?? row.NAME ?? row.column_name ?? row.COLUMN_NAME
        return String(value || '') === name
    })
}

async function userHasExternalId(runner: QueryRunner, dialect: Dialect): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `PRAGMA table_info(${q(dialect, 'user')})`)
        return hasName(list, 'externalId')
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'user' AND column_name = 'externalId'`
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'externalId'`
    )
    return list.length > 0
}

async function sessionsExist(runner: QueryRunner, dialect: Dialect): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_local_session'`)
        return list.length > 0
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'identity_local_session'`
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'identity_local_session'`
    )
    return list.length > 0
}

export async function addIdentitySignIn(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    const user = q(dialect, 'user')
    const externalId = q(dialect, 'externalId')
    if (!(await userHasExternalId(runner, dialect))) {
        const type = dialect === 'postgres' ? 'character varying(255)' : 'varchar(255)'
        await runner.query(`ALTER TABLE ${user} ADD COLUMN ${externalId} ${type}`)
    }
    if (dialect === 'sqlite' || dialect === 'postgres') {
        await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(dialect, 'IDX_user_externalId')} ON ${user} (${externalId})`)
    } else if (!(await indexExists(runner, dialect, 'user', 'IDX_user_externalId'))) {
        await runner.query(`CREATE UNIQUE INDEX ${q(dialect, 'IDX_user_externalId')} ON ${user} (${externalId})`)
    }

    if (!(await sessionsExist(runner, dialect))) {
        if (dialect === 'mysql' || dialect === 'mariadb') {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'identity_local_session')} (
                    ${q(dialect, 'id')} varchar(255) NOT NULL PRIMARY KEY,
                    ${q(dialect, 'userId')} varchar(255) NOT NULL,
                    ${q(dialect, 'token')} varchar(255) NOT NULL,
                    ${q(dialect, 'expiresAt')} datetime NOT NULL,
                    ${q(dialect, 'absoluteExpiresAt')} datetime NOT NULL,
                    ${q(dialect, 'createdDate')} datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY ${q(dialect, 'IDX_identity_local_session_token')} (${q(dialect, 'token')})
                )`
            )
        } else {
            const time = dialect === 'postgres' ? 'TIMESTAMP' : 'datetime'
            await runner.query(
                `CREATE TABLE ${q(dialect, 'identity_local_session')} (
                    ${q(dialect, 'id')} varchar(255) NOT NULL PRIMARY KEY,
                    ${q(dialect, 'userId')} varchar(255) NOT NULL,
                    ${q(dialect, 'token')} varchar(255) NOT NULL,
                    ${q(dialect, 'expiresAt')} ${time} NOT NULL,
                    ${q(dialect, 'absoluteExpiresAt')} ${time} NOT NULL,
                    ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT CURRENT_TIMESTAMP
                )`
            )
            await runner.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${q(dialect, 'IDX_identity_local_session_token')} ON ${q(
                    dialect,
                    'identity_local_session'
                )} (${q(dialect, 'token')})`
            )
        }
    }
}

export async function addIdentityLoginGuards(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await ensureLocalTables(runner, dialect)
}

export async function removeIdentityLoginGuards(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'identity_login_failure')}`)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'identity_bootstrap')}`)
}

async function ensureLocalTables(runner: QueryRunner, dialect: Dialect): Promise<void> {
    if (!(await tableExists(runner, dialect, 'identity_bootstrap'))) {
        await runner.query(`CREATE TABLE ${q(dialect, 'identity_bootstrap')} (${q(dialect, 'id')} integer NOT NULL PRIMARY KEY)`)
    }
    if (!(await tableExists(runner, dialect, 'identity_login_failure'))) {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'identity_login_failure')} (
                ${q(dialect, 'id')} varchar(255) NOT NULL PRIMARY KEY,
                ${q(dialect, 'scope')} varchar(32) NOT NULL,
                ${q(dialect, 'subject')} varchar(255) NOT NULL,
                ${q(dialect, 'attemptedAt')} bigint NOT NULL
            )`
        )
        if (dialect === 'sqlite' || dialect === 'postgres') {
            await runner.query(
                `CREATE INDEX IF NOT EXISTS ${q(dialect, 'IDX_identity_login_failure_lookup')} ON ${q(
                    dialect,
                    'identity_login_failure'
                )} (${q(dialect, 'scope')}, ${q(dialect, 'subject')}, ${q(dialect, 'attemptedAt')})`
            )
        }
    }
}

async function tableExists(runner: QueryRunner, dialect: Dialect, table: string): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
        return list.length > 0
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`,
            [table]
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    )
    return list.length > 0
}

async function indexExists(runner: QueryRunner, dialect: Dialect, table: string, index: string): Promise<boolean> {
    const list = await rows(
        runner,
        `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index]
    )
    return list.length > 0 && dialect !== 'postgres' && dialect !== 'sqlite'
}

async function columnExists(runner: QueryRunner, dialect: Dialect, table: string, column: string): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `PRAGMA table_info(${q(dialect, table)})`)
        return hasName(list, column)
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
            [table, column]
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    )
    return list.length > 0
}

/**
 * permissionVersion on the user and on each local session.
 * A role drop or a disable bumps the user value and deletes session rows.
 * A session issued at an older value is rejected, so an old cookie cannot keep the previous permissions.
 * Admin, Builder, and Viewer are seeded with stable ids. Owner already has one.
 */
export async function addLocalDirectory(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if ((await tableExists(runner, dialect, 'user')) && !(await columnExists(runner, dialect, 'user', 'permissionVersion'))) {
        await runner.query(`ALTER TABLE ${q(dialect, 'user')} ADD COLUMN ${q(dialect, 'permissionVersion')} integer NOT NULL DEFAULT 0`)
    }
    if ((await sessionsExist(runner, dialect)) && !(await columnExists(runner, dialect, 'identity_local_session', 'permissionVersion'))) {
        await runner.query(
            `ALTER TABLE ${q(dialect, 'identity_local_session')} ADD COLUMN ${q(dialect, 'permissionVersion')} integer NOT NULL DEFAULT 0`
        )
    }
    if (!(await tableExists(runner, dialect, 'role'))) return
    const now = dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP'
    for (const role of SEEDED_BUILT_IN_ROLES) {
        const permissions = builtInPermissionJson(role.name) || '[]'
        const existing = await rows(
            runner,
            `SELECT ${q(dialect, 'id')} AS id FROM ${q(dialect, 'role')} WHERE ${q(dialect, 'organizationId')} IS NULL AND LOWER(${q(
                dialect,
                'name'
            )}) = LOWER(?)`,
            [role.name]
        )
        if (!existing.length) {
            await runner.query(
                `INSERT INTO ${q(dialect, 'role')} (${q(dialect, 'id')}, ${q(dialect, 'name')}, ${q(dialect, 'description')}, ${q(
                    dialect,
                    'permissions'
                )}, ${q(dialect, 'createdDate')}, ${q(dialect, 'updatedDate')}) VALUES (?, ?, ?, ?, ${now}, ${now})`,
                [role.id, role.name, role.description, permissions]
            )
            continue
        }
        await runner.query(
            `UPDATE ${q(dialect, 'role')} SET ${q(dialect, 'description')} = ?, ${q(dialect, 'permissions')} = ?, ${q(
                dialect,
                'updatedDate'
            )} = ${now} WHERE ${q(dialect, 'organizationId')} IS NULL AND LOWER(${q(dialect, 'name')}) = LOWER(?)`,
            [role.description, permissions, role.name]
        )
    }
}

export async function removeLocalDirectory(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await tableExists(runner, dialect, 'role')) {
        for (const role of SEEDED_BUILT_IN_ROLES) {
            await runner.query(
                `DELETE FROM ${q(dialect, 'role')} WHERE ${q(dialect, 'id')} = ? AND ${q(dialect, 'organizationId')} IS NULL`,
                [role.id]
            )
        }
    }
    if ((await tableExists(runner, dialect, 'user')) && (await columnExists(runner, dialect, 'user', 'permissionVersion'))) {
        await runner.query(`ALTER TABLE ${q(dialect, 'user')} DROP COLUMN ${q(dialect, 'permissionVersion')}`)
    }
    if ((await sessionsExist(runner, dialect)) && (await columnExists(runner, dialect, 'identity_local_session', 'permissionVersion'))) {
        await runner.query(`ALTER TABLE ${q(dialect, 'identity_local_session')} DROP COLUMN ${q(dialect, 'permissionVersion')}`)
    }
}

export async function removeIdentitySignIn(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    const user = q(dialect, 'user')
    if (dialect === 'mysql' || dialect === 'mariadb') {
        if (await indexExists(runner, dialect, 'user', 'IDX_user_externalId')) {
            await runner.query(`DROP INDEX ${q(dialect, 'IDX_user_externalId')} ON ${user}`)
        }
        if (await userHasExternalId(runner, dialect)) await runner.query(`ALTER TABLE ${user} DROP COLUMN ${q(dialect, 'externalId')}`)
        if (await sessionsExist(runner, dialect)) await runner.query(`DROP TABLE ${q(dialect, 'identity_local_session')}`)
        return
    }
    await runner.query(`DROP INDEX IF EXISTS ${q(dialect, 'IDX_user_externalId')}`)
    if (await userHasExternalId(runner, dialect)) await runner.query(`ALTER TABLE ${user} DROP COLUMN ${q(dialect, 'externalId')}`)
    if (await sessionsExist(runner, dialect)) await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'identity_local_session')}`)
}
