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
import { addAuthenticationState, addLocalDirectory, removeLocalDirectory } from './schemaMigration'

interface Call {
    sql: string
    params?: unknown[]
}

function postgresRunner(present: Set<string>, existingRoles: Set<string> = new Set()): { runner: QueryRunner; calls: Call[] } {
    const calls: Call[] = []
    const runner = {
        connection: { options: { type: 'postgres' } },
        async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params })
            if (sql.includes('information_schema.tables')) return present.has(String(params?.[0])) ? [{ name: params?.[0] }] : []
            if (sql.startsWith('CREATE TABLE "identity_authentication_state"')) present.add('identity_authentication_state')
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
        expect(creates[0].sql).toContain('"activeMethod" varchar(32) NULL')
    })
})
