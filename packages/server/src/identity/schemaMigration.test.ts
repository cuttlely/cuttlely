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

    it('adds the nullable WorkOS session id to application sessions', async () => {
        const present = new Set(['identity_local_session'])
        const { runner, calls } = postgresRunner(present)
        await addWorkosSessionId(runner)
        expect(
            calls.some((call) => call.sql === 'ALTER TABLE "identity_local_session" ADD COLUMN "workosSessionId" varchar(255) NULL')
        ).toBe(true)
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

        await removeScimGroups(runner)
        await removeScimProvisioning(runner)
        expect([...tables].filter((table) => table.startsWith('identity_scim') || table === 'identity_personal_token')).toEqual([])
        expect(columns.get('apikey')?.has('disabledAt')).toBe(false)
    })
})
