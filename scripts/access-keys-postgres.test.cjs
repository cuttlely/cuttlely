// Execute the actual migrated Postgres delete route; never use deployment connection settings.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
    }
})

test(
    'Postgres migrated private-flow delete removes exact grants and binding atomically; SQLite contract unchanged',
    {
        skip: !process.env.CUTTLELY_TEST_PG_REQUIRED && !process.env.CUTTLELY_TEST_PG_PASSWORD && !process.env.PGPASSWORD
    },
    async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'cuttlely-key-delete-'))
        process.env.LOG_PATH = path.join(root, 'logs')
        process.env.CUTTLELY_DATA_DIR = root
        process.env.BLOB_STORAGE_PATH = path.join(root, 'blobs')
        process.env.CUTTLELY_VERSIONS = 'false'
        process.env.CUTTLELY_DASH_FLOWS = 'false'
        process.env.INBOUND_ACCESS_V2 = 'on'
        const { Client } = serverRequire('pg')
        const options = {
            host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
            port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
            user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
            password: process.env.CUTTLELY_TEST_PG_PASSWORD || process.env.PGPASSWORD,
            database: 'postgres'
        }
        const admin = new Client(options)
        await admin.connect()
        const database = 'cuttlely_key_delete_' + randomUUID().replaceAll('-', '')
        let data
        try {
            await admin.query(`CREATE DATABASE "${database}"`)
            const { DataSource } = serverRequire('typeorm')
            const { entities } = serverRequire('./src/database/entities/index.ts')
            const { ChatFlow, ApiKey, ApiKeyResource, Organization, Workspace, User } = entities
            data = new DataSource({
                ...options,
                database,
                type: 'postgres',
                entities: Object.values(entities),
                migrations: serverRequire('./src/database/migrations/postgres/index.ts').postgresMigrations
            })
            await data.initialize()
            await data.runMigrations()
            const userId = randomUUID(),
                orgId = randomUUID(),
                workspaceId = randomUUID()
            await data.getRepository(User).save({
                id: userId,
                name: 'Local fixture',
                email: 'delete@example.invalid',
                status: 'active',
                createdBy: userId,
                updatedBy: userId
            })
            await data.getRepository(Organization).save({ id: orgId, name: 'Local fixture', createdBy: userId, updatedBy: userId })
            await data
                .getRepository(Workspace)
                .save({ id: workspaceId, organizationId: orgId, name: 'Local fixture', createdBy: userId, updatedBy: userId })
            const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
            const keyId = randomUUID(),
                foreignId = randomUUID(),
                foreignWorkspaceId = randomUUID()
            await data
                .getRepository(Workspace)
                .save({ id: foreignWorkspaceId, organizationId: orgId, name: 'Other fixture', createdBy: userId, updatedBy: userId })
            for (const id of [keyId, foreignId])
                await data.getRepository(ApiKey).save({
                    id,
                    keyName: 'Local fixture',
                    workspaceId: id === keyId ? workspaceId : foreignWorkspaceId,
                    apiKey: '',
                    apiSecret: '',
                    permissions: ['chatflows:view'],
                    harnesses: [],
                    accessPolicy: parsePolicy({ scopes: ['predict'] })
                })
            const flow = await data.getRepository(ChatFlow).save({
                name: 'Private fixture',
                workspaceId,
                type: 'CHATFLOW',
                flowData: '{"nodes":[],"edges":[]}',
                apikeyid: keyId,
                apiAccessMode: 'private'
            })
            for (const principalId of [keyId, foreignId])
                await data.getRepository(ApiKeyResource).save({ principalId, resourceType: 'CHATFLOW', resourceId: flow.id })
            // Prove the historical varchar/uuid comparison fails on the actual shipped migration schema.
            await assert.rejects(
                data.query('DELETE FROM apikey_resource WHERE "principalId" IN (SELECT id FROM apikey WHERE "workspaceId" = $1)', [
                    workspaceId
                ]),
                { code: '42883' }
            )
            serverRequire('./src/utils/getRunningExpressApp.ts').getRunningExpressApp = () => ({
                AppDataSource: data,
                usageCacheManager: {},
                cachePool: {},
                nodesPool: { componentNodes: {} },
                telemetry: { sendTelemetry: async () => {} },
                identityManager: { getPlatformType: () => 'open_source' }
            })
            serverRequire('./src/DataSource.ts').getDataSource = () => data
            serverRequire('./src/services/accessKeys/data.ts').accessData = async () => data
            const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
            setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
            const express = serverRequire('express'),
                request = serverRequire('supertest'),
                http = express()
            http.use(express.json())
            http.use((req, _res, next) => {
                req.user = {
                    id: userId,
                    activeWorkspaceId: workspaceId,
                    activeOrganizationId: orgId,
                    permissions: ['chatflows:delete'],
                    features: {}
                }
                next()
            })
            http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            await data.query(
                `CREATE FUNCTION refuse_grant_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cleanup refused'; END $$`
            )
            await data.query(
                'CREATE TRIGGER refuse_grant_delete BEFORE DELETE ON apikey_resource FOR EACH ROW EXECUTE FUNCTION refuse_grant_delete()'
            )
            assert.equal((await request(http).delete('/api/v1/chatflows/' + flow.id)).status, 500)
            assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).apikeyid, keyId)
            assert.equal(await data.getRepository(ApiKeyResource).countBy({ resourceId: flow.id }), 2)
            await data.query('DROP TRIGGER refuse_grant_delete ON apikey_resource')
            const deleted = await request(http).delete('/api/v1/chatflows/' + flow.id)
            assert.equal(deleted.status, 200, deleted.body.message)
            assert.equal(await data.getRepository(ChatFlow).countBy({ id: flow.id }), 0)
            assert.equal(await data.getRepository(ChatFlow).countBy({ apikeyid: keyId }), 0, 'private binding removed with its flow row')
            assert.equal(await data.getRepository(ApiKeyResource).countBy({ principalId: keyId, resourceId: flow.id }), 0)
            assert.equal(
                await data.getRepository(ApiKeyResource).countBy({ principalId: foreignId, resourceId: flow.id }),
                1,
                'another workspace remains isolated'
            )
            assert.equal(await data.getRepository(ApiKey).countBy({ id: keyId }), 1, 'deleting a flow does not revoke its key')
            setTeamPermissionLookup(null)
        } finally {
            if (data?.isInitialized) await data.destroy()
            await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
            await admin.end()
            rmSync(root, { recursive: true, force: true })
        }
    }
)
