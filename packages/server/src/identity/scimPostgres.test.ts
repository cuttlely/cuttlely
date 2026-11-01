/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { randomBytes, randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import type { QueryRunner } from 'typeorm'
import { resetAuthSecretsForTests } from './authSecrets'
import { Sql } from './directory'

let activeSql: Sql
jest.mock('./production', () => ({ applicationSql: () => activeSql }))

import {
    authenticateScimToken,
    createScimToken,
    createUser,
    deleteUser,
    identityScimRouter,
    mutateUser,
    readScimTokenState,
    usersForOrganization
} from './scim'
import {
    createGroup,
    createMapping,
    groupsForOrganization,
    mappingOptions,
    previewMappingCreation,
    previewMappingRemoval
} from './scimGroups'
import { addScimGroups, addScimProvisioning } from './schemaMigration'

interface PgResult {
    rows: Record<string, unknown>[]
}

interface PgClient {
    connect(): Promise<void>
    query(text: string, params?: unknown[]): Promise<PgResult>
    end(): Promise<void>
    release(): void
}

interface PgPool {
    connect(): Promise<PgClient>
    query(text: string, params?: unknown[]): Promise<PgResult>
    end(): Promise<void>
}

const password = process.env.CUTTLELY_TEST_PG_PASSWORD || process.env.PGPASSWORD
const required = process.env.CUTTLELY_TEST_PG_REQUIRED === '1'
const configured = Boolean(password)

if (required && !configured) {
    test('PostgreSQL SCIM execution is required for this run', () => {
        throw new Error('CUTTLELY_TEST_PG_REQUIRED=1 needs PGPASSWORD or CUTTLELY_TEST_PG_PASSWORD')
    })
}

const describePostgres = configured ? describe : describe.skip

describePostgres('SCIM on PostgreSQL uuid core ids', () => {
    jest.setTimeout(60_000)

    const organizationId = '10000000-0000-4000-8000-000000000001'
    const ownerId = '10000000-0000-4000-8000-000000000002'
    const secondOwnerId = '10000000-0000-4000-8000-000000000003'
    const ownerRoleId = '10000000-0000-4000-8000-000000000004'
    const memberRoleId = '10000000-0000-4000-8000-000000000005'
    const workspaceId = '10000000-0000-4000-8000-000000000006'
    const base = {
        host: process.env.CUTTLELY_TEST_PG_HOST || process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || process.env.PGPORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || process.env.PGUSER || 'postgres',
        password,
        connectionTimeoutMillis: 5000
    }
    const databaseName = `cuttlely_scim_${process.pid}_${randomUUID().slice(0, 8)}`
    let pool: PgPool | undefined
    let databaseCreated = false

    function bind(statement: string): string {
        let index = 0
        return statement.replace(/\?/g, () => `$${++index}`)
    }

    function postgresSql(value: PgPool): Sql {
        return {
            type: 'postgres',
            query: async (statement, params = []) => (await value.query(bind(statement), params)).rows,
            transaction: async (fn) => {
                const client = await value.connect()
                const query = async (statement: string, params: unknown[] = []) => (await client.query(bind(statement), params)).rows
                await client.query('BEGIN')
                try {
                    const result = await fn(query)
                    await client.query('COMMIT')
                    return result
                } catch (error) {
                    await client.query('ROLLBACK')
                    throw error
                } finally {
                    client.release()
                }
            }
        }
    }

    async function migrationRunner(value: PgPool): Promise<QueryRunner> {
        return {
            connection: { options: { type: 'postgres' } },
            hasColumn: async (table: string, column: string) => {
                const result = await value.query(
                    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
                    [table, column]
                )
                return result.rows.length > 0
            },
            query: async (statement: string, params: unknown[] = []) => (await value.query(statement, params)).rows
        } as unknown as QueryRunner
    }

    async function seedCore(value: PgPool): Promise<void> {
        await value.query(`
            CREATE TABLE "user" (
                "id" uuid PRIMARY KEY, "name" varchar(255) NOT NULL, "email" varchar(255) NOT NULL UNIQUE,
                "credential" text NULL, "status" varchar(20) NOT NULL, "externalId" varchar(255) NULL,
                "createdBy" uuid NULL, "updatedBy" uuid NULL, "createdDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, "permissionVersion" integer NOT NULL DEFAULT 0
            );
            CREATE TABLE "role" (
                "id" uuid PRIMARY KEY, "organizationId" uuid NULL, "name" varchar(100) NOT NULL,
                "description" text NULL, "permissions" text NULL, "createdDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE "organization_user" (
                "organizationId" uuid NOT NULL, "userId" uuid NOT NULL, "roleId" uuid NOT NULL, "status" varchar(20) NOT NULL,
                "createdBy" uuid NULL, "updatedBy" uuid NULL, "createdDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("organizationId", "userId")
            );
            CREATE TABLE "workspace" (
                "id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL, "name" varchar(255) NOT NULL,
                "description" text NULL, "updatedDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE "workspace_user" (
                "workspaceId" uuid NOT NULL, "userId" uuid NOT NULL, "roleId" uuid NOT NULL, "status" varchar(20) NOT NULL,
                "createdBy" uuid NULL, "updatedBy" uuid NULL, PRIMARY KEY ("workspaceId", "userId")
            );
            CREATE TABLE "identity_action_link" (
                "id" uuid PRIMARY KEY, "tokenHash" varchar(64) NULL, "purpose" varchar(16) NOT NULL,
                "organizationId" uuid NULL, "workspaceId" uuid NULL, "userId" uuid NOT NULL,
                "expiresAt" timestamp NULL, "usedAt" timestamp NULL, "consumeId" varchar(255) NULL,
                "createdBy" uuid NULL, "createdDate" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE "identity_local_session" ("id" varchar(255) PRIMARY KEY, "userId" uuid NOT NULL);
            CREATE TABLE "apikey" ("id" uuid PRIMARY KEY, "ownerUserId" uuid NULL);
            CREATE TABLE "audit_event" (
                "id" uuid PRIMARY KEY, "type" varchar(64) NOT NULL, "organizationId" uuid NULL, "workspaceId" uuid NULL,
                "userId" uuid NULL, "actorId" varchar(36) NULL, "summary" varchar(255) NOT NULL,
                "detail" text NULL, "createdAt" bigint NOT NULL
            );
        `)
        await value.query(
            `INSERT INTO "role" ("id", "organizationId", "name", "permissions") VALUES
             ($1, NULL, 'owner', '["authentication:manage"]'), ($2, NULL, 'member', '[]')`,
            [ownerRoleId, memberRoleId]
        )
        await value.query(
            `INSERT INTO "user" ("id", "name", "email", "status", "createdBy", "updatedBy") VALUES
             ($1, 'Made Up Owner', 'owner@example.test', 'active', $1, $1),
             ($2, 'Made Up Backup Owner', 'backup-owner@example.test', 'active', $1, $1)`,
            [ownerId, secondOwnerId]
        )
        await value.query(
            `INSERT INTO "organization_user" ("organizationId", "userId", "roleId", "status", "createdBy", "updatedBy") VALUES
             ($1, $2, $4, 'active', $2, $2), ($1, $3, $4, 'active', $2, $2)`,
            [organizationId, ownerId, secondOwnerId, ownerRoleId]
        )
        await value.query(`INSERT INTO "workspace" ("id", "organizationId", "name") VALUES ($1, $2, 'Made Up Team')`, [
            workspaceId,
            organizationId
        ])
    }

    beforeAll(async () => {
        const pg = require('pg') as {
            Client: new (config: Record<string, unknown>) => PgClient
            Pool: new (config: Record<string, unknown>) => PgPool
        }
        const admin = new pg.Client({ ...base, database: 'postgres' })
        await admin.connect()
        try {
            await admin.query(`CREATE DATABASE "${databaseName}"`)
            databaseCreated = true
        } finally {
            await admin.end()
        }
        pool = new pg.Pool({ ...base, database: databaseName, max: 4 })
        await seedCore(pool)
        const runner = await migrationRunner(pool)
        await addScimProvisioning(runner)
        await addScimGroups(runner)
        activeSql = postgresSql(pool)
        process.env.TOKEN_HASH_SECRET = randomBytes(32).toString('hex')
        resetAuthSecretsForTests()
    })

    afterAll(async () => {
        delete process.env.TOKEN_HASH_SECRET
        resetAuthSecretsForTests()
        await pool?.end()
        if (!databaseCreated) return
        const pg = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient }
        const admin = new pg.Client({ ...base, database: 'postgres' })
        await admin.connect()
        try {
            await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        } finally {
            await admin.end()
        }
    })

    it('runs provisioning, groups, mappings, settings reads, deactivation, and deletion against uuid columns', async () => {
        if (!pool) throw new Error('PostgreSQL pool was not created')
        const types = await pool.query(
            `SELECT table_name, column_name, data_type FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name LIKE 'identity_scim_%'
               AND column_name IN
                   ('id', 'organizationId', 'userId', 'workspaceId', 'roleId', 'groupId', 'scimUserId', 'mappingId', 'createdBy',
                    'activeTokenId', 'previousTokenId')
               AND NOT (table_name = 'identity_scim_configuration' AND column_name = 'id')`
        )
        expect(types.rows.filter((row) => row.data_type !== 'uuid')).toEqual([])

        const token = await createScimToken(activeSql, { id: ownerId, organizationId })
        const actor = await authenticateScimToken(activeSql, token.clear)
        if (!actor) throw new Error('The created SCIM credential did not authenticate')
        const user = await createUser(activeSql, actor, {
            userName: 'made-up-person@example.test',
            externalId: 'made-up-provider-user',
            displayName: 'Made Up Person'
        })
        expect((await usersForOrganization(activeSql.query, activeSql, organizationId)).map((item) => item.id)).toEqual([user.id])

        const app = express()
        app.use('/api/v1/scim/v2', identityScimRouter)
        const listed = await request(app).get('/api/v1/scim/v2/Users').set('Authorization', `Bearer ${token.clear}`)
        expect(listed.status).toBe(200)
        expect(listed.body).toMatchObject({ totalResults: 1, Resources: [expect.objectContaining({ id: user.id })] })
        const invalid = await request(app).get('/api/v1/scim/v2/Users/not-a-uuid').set('Authorization', `Bearer ${token.clear}`)
        expect(invalid.status).toBe(404)
        expect(invalid.body).toMatchObject({ status: '404', scimType: 'noTarget' })

        const failedUpdate = await request(app)
            .put(`/api/v1/scim/v2/Users/${randomUUID()}`)
            .set('Authorization', `Bearer ${token.clear}`)
            .send({ userName: 'missing-update@example.test', displayName: 'Missing Update' })
        expect(failedUpdate.status).toBe(404)
        const failedDeactivation = await request(app)
            .patch(`/api/v1/scim/v2/Users/${randomUUID()}`)
            .set('Authorization', `Bearer ${token.clear}`)
            .send({ Operations: [{ op: 'Replace', path: 'active', value: false }] })
        expect(failedDeactivation.status).toBe(404)
        const diagnosticIds = [failedUpdate.headers['x-correlation-id'], failedDeactivation.headers['x-correlation-id']]
        let diagnosticRows: Record<string, unknown>[] = []
        for (let attempt = 0; attempt < 50; attempt += 1) {
            diagnosticRows = (
                await pool.query(
                    `SELECT "correlationId", "category" FROM "identity_scim_diagnostic" WHERE "correlationId" = ANY($1::text[])`,
                    [diagnosticIds]
                )
            ).rows
            if (diagnosticRows.length === 2) break
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(Object.fromEntries(diagnosticRows.map((row) => [row.correlationId, row.category]))).toEqual({
            [String(failedUpdate.headers['x-correlation-id'])]: 'usersUpdated',
            [String(failedDeactivation.headers['x-correlation-id'])]: 'usersDisabled'
        })

        const group = await createGroup(activeSql, actor, {
            displayName: 'Made Up Group',
            externalId: 'made-up-provider-group',
            members: [{ value: user.id }]
        })
        expect((await groupsForOrganization(activeSql.query, activeSql, organizationId))[0].members).toEqual([
            { value: user.id, display: 'Made Up Person' }
        ])

        const adminActor = { id: ownerId, organizationId }
        const preview = await previewMappingCreation(activeSql, adminActor, { groupId: group.id, workspaceId, roleId: memberRoleId })
        const mapping = await createMapping(
            activeSql,
            adminActor,
            { groupId: group.id, workspaceId, roleId: memberRoleId },
            preview.fingerprint
        )
        const settings = {
            token: await readScimTokenState(activeSql),
            mapping: await mappingOptions(activeSql, adminActor)
        }
        expect(settings.token.status).toBe('active')
        expect(settings.mapping).toMatchObject({
            mappings: [expect.objectContaining({ id: mapping.id, groupId: group.id, workspaceId })],
            groups: [{ id: group.id, displayName: 'Made Up Group' }],
            workspaces: [{ id: workspaceId, name: 'Made Up Team' }]
        })
        await expect(previewMappingRemoval(activeSql, adminActor, 'not-a-uuid')).rejects.toMatchObject({
            status: 404,
            scimType: 'noTarget'
        })

        const inactive = await mutateUser(activeSql, actor, user.id, { active: false }, 'updated')
        expect(inactive.userStatus).toBe('disable')
        await deleteUser(activeSql, actor, user.id)
        expect(await usersForOrganization(activeSql.query, activeSql, organizationId)).toEqual([])
    })

    it.each([
        ['the same email', 'used-exact@example.test', 'exact'],
        ['a case variant', 'Used-Case@example.test', 'case']
    ])('refuses recreation with %s owned by another PostgreSQL account without changing stored state', async (_label, userName, suffix) => {
        if (!pool) throw new Error('PostgreSQL pool was not created')
        const activePool = pool
        const actor = {
            organizationId,
            tokenId: randomUUID(),
            displayPrefix: 'cuttlely_scim_test…',
            creatorId: ownerId
        }
        const created = await createUser(activeSql, actor, {
            userName: `deleted-${suffix}@example.test`,
            externalId: `made-up-deleted-${suffix}`,
            displayName: `Deleted ${suffix}`
        })
        await deleteUser(activeSql, actor, created.id)
        const emailOwnerId = randomUUID()
        await activePool.query(
            `INSERT INTO "user" ("id", "name", "email", "status", "createdBy", "updatedBy") VALUES ($1, $2, $3, 'active', $4, $4)`,
            [emailOwnerId, `Email Owner ${suffix}`, userName.toLowerCase(), ownerId]
        )
        const state = async () =>
            (
                await activePool.query(
                    `SELECT 'account' AS kind, "id"::text AS id, "name" AS value1, "email" AS value2, "status" AS value3
                     FROM "user" WHERE "id" IN ($1, $2)
                     UNION ALL
                     SELECT 'membership', "userId"::text, "roleId"::text, "status", COALESCE("updatedBy"::text, '')
                     FROM "organization_user" WHERE "organizationId" = $3 AND "userId" = $1
                     UNION ALL
                     SELECT 'resource', "userId"::text, COALESCE("externalId", ''), "userName", COALESCE("deletedAt"::text, '')
                     FROM "identity_scim_user" WHERE "id" = $4
                     ORDER BY kind, id`,
                    [created.userId, emailOwnerId, organizationId, created.id]
                )
            ).rows
        const before = await state()

        await expect(
            createUser(activeSql, actor, {
                userName,
                externalId: `made-up-deleted-${suffix}`,
                displayName: `Changed ${suffix}`
            })
        ).rejects.toMatchObject({ status: 409, scimType: 'uniqueness', message: 'A matching value already exists.' })

        expect(await state()).toEqual(before)
    })
})
