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

import type { QueryRunner } from 'typeorm'
import {
    addAuthenticationState,
    addAuthenticationSwitchStage,
    addLocalDirectory,
    addOidcProvider,
    addScimGroups,
    addScimProvisioning,
    addWorkosSessionId,
    removeLocalDirectory,
    removeScimGroups,
    removeScimProvisioning
} from './schemaMigration'

interface Call {
    sql: string
    params?: unknown[]
}

function postgresRunner(present: Set<string>, existingRoles: Set<string> = new Set()): { runner: QueryRunner; calls: Call[] } {
    const calls: Call[] = []
    const runner = {
        connection: { options: { type: 'postgres' } },
        async hasColumn() {
            return false
        },
        async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params })
            if (sql.includes('information_schema.tables')) return present.has(String(params?.[0])) ? [{ name: params?.[0] }] : []
            if (sql.startsWith('CREATE TABLE "identity_authentication_state"')) present.add('identity_authentication_state')
            if (sql.startsWith('CREATE TABLE "identity_authentication_switch_stage"')) present.add('identity_authentication_switch_stage')
            if (sql.includes('information_schema.columns')) return []
            if (sql.includes('FROM "role"') && sql.includes('SELECT')) {
                return existingRoles.has(String(params?.[0] || '').toLowerCase()) ? [{ id: 'existing' }] : []
            }
            return []
        }
    }
    return { runner: runner as unknown as QueryRunner, calls }
}

function mysqlFamilyRunner(type: 'mysql' | 'mariadb'): { runner: QueryRunner; calls: Call[] } {
    const calls: Call[] = []
    const runner = {
        connection: { options: { type } },
        async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params })
            return []
        }
    }
    return { runner: runner as unknown as QueryRunner, calls }
}

describe('local directory schema on postgres', () => {
    it('rewrites placeholders before the driver sees them', async () => {
        const present = new Set(['user', 'role', 'identity_local_session'])
        const { runner, calls } = postgresRunner(present)
        await addLocalDirectory(runner)
        const parameterized = calls.filter((call) => call.params && call.params.length > 0)
        expect(parameterized.length).toBeGreaterThan(0)
        for (const call of parameterized) {
            expect(call.sql).not.toContain('?')
            call.params?.forEach((_, index) => expect(call.sql).toContain(`$${index + 1}`))
        }
        expect(calls.some((call) => call.sql.includes('table_name = $1') && call.sql.includes('column_name = $2'))).toBe(true)
        const insert = calls.find((call) => call.sql.startsWith('INSERT INTO "role"'))
        expect(insert?.sql).toContain('VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
        expect(insert?.params?.slice(0, 2)).toEqual(['00000000-0000-4000-8000-000000000004', 'admin'])

        const again = postgresRunner(present, new Set(['admin', 'builder', 'viewer']))
        await addLocalDirectory(again.runner)
        const update = again.calls.find((call) => call.sql.startsWith('UPDATE "role"'))
        expect(update?.sql).toContain('SET "description" = $1, "permissions" = $2')
        expect(update?.sql).toContain('LOWER($3)')
        expect(update?.sql).not.toContain('?')

        const removed = postgresRunner(present)
        await removeLocalDirectory(removed.runner)
        const deleted = removed.calls.find((call) => call.sql.startsWith('DELETE FROM "role"'))
        expect(deleted?.sql).toContain('WHERE "id" = $1')
        expect(deleted?.sql).not.toContain('?')
    })

    it('adds the authentication state once with installation and epoch fields', async () => {
        const present = new Set<string>()
        const { runner, calls } = postgresRunner(present)
        await addAuthenticationState(runner)
        await addAuthenticationState(runner)
        const creates = calls.filter((call) => call.sql.startsWith('CREATE TABLE "identity_authentication_state"'))
        expect(creates).toHaveLength(1)
        expect(creates[0].sql).toContain('"installationId" varchar(64) NOT NULL')
        expect(creates[0].sql).toContain('"authenticationEpoch" integer NOT NULL')
        expect(creates[0].sql).toContain('"authenticationBaselineEpoch" integer NOT NULL')
        expect(creates[0].sql).toContain('"activeMethod" varchar(32) NULL')
    })

    it('adds the durable switch stage with version, expiry, and single-use fields', async () => {
        const present = new Set<string>()
        const { runner, calls } = postgresRunner(present)
        await addAuthenticationSwitchStage(runner)
        await addAuthenticationSwitchStage(runner)
        const creates = calls.filter((call) => call.sql.startsWith('CREATE TABLE "identity_authentication_switch_stage"'))
        expect(creates).toHaveLength(1)
        expect(creates[0].sql).toContain('"stateVersion" integer NOT NULL')
        expect(creates[0].sql).toContain('"expiresAt" TIMESTAMP NOT NULL')
        expect(creates[0].sql).toContain('"consumedAt" TIMESTAMP NULL')
        expect(creates[0].sql).toContain('"version" integer NOT NULL')
    })

    it('adds provider links, OIDC configuration, and cross-process transactions', async () => {
        const present = new Set(['identity_authentication_switch_stage', 'identity_local_session'])
        const { runner, calls } = postgresRunner(present)
        await addOidcProvider(runner)
        expect(calls.some((call) => call.sql.startsWith('CREATE TABLE "identity_provider_link"'))).toBe(true)
        expect(calls.some((call) => call.sql.includes('UNIQUE ("providerKey", "subject")'))).toBe(true)
        expect(calls.some((call) => call.sql.startsWith('CREATE TABLE "identity_oidc_configuration"'))).toBe(true)
        expect(calls.some((call) => call.sql.startsWith('CREATE TABLE "identity_oidc_transaction"'))).toBe(true)
        expect(calls.some((call) => call.sql.startsWith('CREATE TABLE "identity_provider_link_migration"'))).toBe(true)
        expect(calls.some((call) => call.sql.includes('identity_recent_authentication'))).toBe(false)
        expect(calls.some((call) => call.sql.includes('ADD COLUMN "recentAuthenticationAt" TIMESTAMP NULL'))).toBe(true)
        expect(calls.some((call) => call.sql.includes('"inertCount" integer NOT NULL DEFAULT 0'))).toBe(true)
        expect(calls.some((call) => call.sql.includes('ADD COLUMN "configurationFingerprint"'))).toBe(true)
    })

    it('adds the inert legacy-link count to an existing OIDC schema', async () => {
        const present = new Set([
            'identity_authentication_switch_stage',
            'identity_provider_link',
            'identity_oidc_configuration',
            'identity_oidc_transaction',
            'identity_provider_link_migration'
        ])
        const { runner, calls } = postgresRunner(present)
        await addOidcProvider(runner)
        expect(calls.some((call) => call.sql.includes('ADD COLUMN "inertCount" integer NOT NULL DEFAULT 0'))).toBe(true)
    })

    it('adds the nullable WorkOS session id to application sessions', async () => {
        const present = new Set(['identity_local_session'])
        const { runner, calls } = postgresRunner(present)
        await addWorkosSessionId(runner)
        expect(
            calls.some((call) => call.sql === 'ALTER TABLE "identity_local_session" ADD COLUMN "workosSessionId" varchar(255) NULL')
        ).toBe(true)
    })
})

describe.each([
    ['mysql', 'COLLATE=utf8mb4_0900_ai_ci'],
    ['mariadb', 'COLLATE=utf8mb4_unicode_520_ci']
] as const)('OIDC schema on %s', (dialect, collation) => {
    it('generates the provider, configuration, transaction, and migration tables', async () => {
        const { runner, calls } = mysqlFamilyRunner(dialect)
        await addOidcProvider(runner)

        const create = (table: string) => calls.find((call) => call.sql.startsWith(`CREATE TABLE \`${table}\``))?.sql || ''
        const provider = create('identity_provider_link')
        expect(provider).toContain('`userId` varchar(36) NOT NULL')
        expect(provider).toContain('`providerKey` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL')
        expect(provider).toContain('`subject` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL')
        expect(provider).toContain('UNIQUE (`providerKey`, `subject`)')
        expect(provider).toContain(`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ${collation}`)

        const configuration = create('identity_oidc_configuration')
        expect(configuration).toContain('`trustMissingEmailVerification` tinyint(1) NOT NULL')
        expect(configuration).toContain('`privateIssuerHosts` text NOT NULL')
        expect(configuration).toContain(`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ${collation}`)

        const transaction = create('identity_oidc_transaction')
        expect(transaction).toContain('`stateHash` varchar(64) PRIMARY KEY')
        expect(transaction).toContain('`consumedAt` datetime NULL')
        expect(transaction).toContain(`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ${collation}`)

        const migration = create('identity_provider_link_migration')
        expect(migration).toContain('`inertCount` integer NOT NULL DEFAULT 0')
        expect(migration).toContain(`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ${collation}`)
        expect(calls.some((call) => call.sql.includes('information_schema.TABLES') && call.sql.includes('TABLE_NAME = ?'))).toBe(true)
        expect(calls.some((call) => call.sql.includes('$1'))).toBe(false)
    })
})

describe('SCIM schema on sqlite', () => {
    it('is idempotent and its down path removes every added object', async () => {
        const tables = new Set(['apikey'])
        const columns = new Map([['apikey', new Set(['id'])]])
        const indexes = new Map<string, Set<string>>()
        const calls: string[] = []
        const runner = {
            connection: { options: { type: 'sqlite' } },
            async hasColumn(table: string, column: string) {
                return columns.get(table)?.has(column) || false
            },
            async dropColumn(table: string, column: string) {
                columns.get(table)?.delete(column)
            },
            async query(sql: string, params: unknown[] = []) {
                calls.push(sql)
                if (sql.includes('sqlite_master')) return tables.has(String(params[0])) ? [{ name: params[0] }] : []
                if (sql.startsWith('PRAGMA index_list')) {
                    const table = /\("([^"]+)"\)/.exec(sql)?.[1] || ''
                    return [...(indexes.get(table) || [])].map((name) => ({ name }))
                }
                const createTable = /^CREATE TABLE "([^"]+)"/.exec(sql)
                if (createTable) {
                    tables.add(createTable[1])
                    columns.set(createTable[1], new Set([...sql.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1])))
                }
                const addColumn = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/.exec(sql)
                if (addColumn) columns.get(addColumn[1])?.add(addColumn[2])
                const createIndex = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"/.exec(sql)
                if (createIndex) {
                    if (!indexes.has(createIndex[2])) indexes.set(createIndex[2], new Set())
                    indexes.get(createIndex[2])?.add(createIndex[1])
                }
                const dropTable = /^DROP TABLE IF EXISTS "([^"]+)"/.exec(sql)
                if (dropTable) tables.delete(dropTable[1])
                return []
            }
        } as unknown as QueryRunner

        await addScimProvisioning(runner)
        await addScimProvisioning(runner)
        await addScimGroups(runner)
        await addScimGroups(runner)
        for (const table of ['identity_scim_configuration', 'identity_scim_token', 'identity_scim_user', 'identity_personal_token']) {
            expect(tables.has(table)).toBe(true)
            expect(calls.filter((sql) => sql.startsWith(`CREATE TABLE "${table}"`))).toHaveLength(1)
        }
        for (const table of [
            'identity_scim_group',
            'identity_scim_group_member',
            'identity_scim_mapping',
            'identity_scim_assignment',
            'identity_scim_diagnostic'
        ]) {
            expect(tables.has(table)).toBe(true)
            expect(calls.filter((sql) => sql.startsWith(`CREATE TABLE "${table}"`))).toHaveLength(1)
        }
        expect(columns.get('apikey')?.has('disabledAt')).toBe(true)
        expect(columns.get('identity_scim_group')?.has('normalizedDisplayName')).toBe(true)
        expect(calls).toContain(
            'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_identity_scim_group_name" ON "identity_scim_group" ("organizationId", "normalizedDisplayName")'
        )
        expect(calls).toContain(
            'CREATE INDEX IF NOT EXISTS "IDX_identity_scim_diagnostic_org_completed" ON "identity_scim_diagnostic" ("organizationId", "completedAt")'
        )

        await removeScimGroups(runner)
        await removeScimProvisioning(runner)
        expect([...tables].filter((table) => table.startsWith('identity_scim') || table === 'identity_personal_token')).toEqual([])
        expect(columns.get('apikey')?.has('disabledAt')).toBe(false)
    })
})
