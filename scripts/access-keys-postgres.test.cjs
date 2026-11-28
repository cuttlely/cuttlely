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
                username: options.user,
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

test(
    'two PostgreSQL API pools share committed UTC quota windows across credentials and restart',
    {
        skip: !process.env.CUTTLELY_TEST_PG_REQUIRED && !process.env.CUTTLELY_TEST_PG_PASSWORD && !process.env.PGPASSWORD
    },
    async (t) => {
        const { Client } = serverRequire('pg')
        const { DataSource } = serverRequire('typeorm')
        const { ApiKey } = serverRequire('./src/database/entities/ApiKey.ts')
        const { ApiKeyUsage } = serverRequire('./src/database/entities/ApiKeyUsage.ts')
        const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
        const { consume, assertCapacity } = serverRequire('./src/services/accessKeys/limiter.ts')
        const pg = {
            host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
            port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
            user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
            password: process.env.CUTTLELY_TEST_PG_PASSWORD || process.env.PGPASSWORD
        }
        const admin = new Client({ ...pg, database: 'postgres' })
        await admin.connect()
        const db = 'cuttlely_shared_key_' + randomUUID().replaceAll('-', '')
        await admin.query(`CREATE DATABASE "${db}"`)
        const open = () =>
            new DataSource({ ...pg, type: 'postgres', username: pg.user, database: db, entities: [ApiKey, ApiKeyUsage] }).initialize()
        const original = process.env.CUTTLELY_API_KEY_INSTANCES
        process.env.CUTTLELY_API_KEY_INSTANCES = '2'
        const pools = []
        t.after(async () => {
            if (original === undefined) delete process.env.CUTTLELY_API_KEY_INSTANCES
            else process.env.CUTTLELY_API_KEY_INSTANCES = original
            try {
                for (const ds of pools) if (ds.isInitialized) await ds.destroy()
            } finally {
                await admin.query(`DROP DATABASE "${db}"`)
                await admin.end()
            }
        })
        const a = await open()
        pools.push(a)
        // Isolated unit of the public schema; the preceding route fixture separately runs released migrations.
        await a.synchronize()
        const b = await open()
        pools.push(b)
        const api = a.getRepository(ApiKey),
            usage = a.getRepository(ApiKeyUsage)
        const key = await api.save({
            id: randomUUID(),
            workspaceId: randomUUID(),
            apiKey: '',
            apiSecret: '',
            keyName: 'fixture',
            permissions: [],
            accessPolicy: parsePolicy({ rpm: 5, daily: 9, monthly: 11 })
        })
        const foreign = await api.save({ ...key, id: randomUUID(), workspaceId: randomUUID() })
        const hdr = () => ({
            values: new Map(),
            setHeader(name, value) {
                this.values.set(name, value)
            }
        })
        const submit = async (ds, operation) => {
            const headers = hdr()
            try {
                await consume(ds, key, operation, headers)
                return { status: 200, headers: headers.values }
            } catch (err) {
                return { status: err.statusCode, headers: headers.values }
            }
        }
        // Keep the race and process replacement inside one real database minute even when CI starts on a boundary.
        const [{ now }] = await a.query('SELECT clock_timestamp() AS now')
        if (now.getUTCSeconds() >= 50) await new Promise((r) => setTimeout(r, (61 - now.getUTCSeconds()) * 1000))
        const preflightHeaders = hdr()
        await Promise.all([assertCapacity(a, key, 'predict', preflightHeaders), assertCapacity(b, key, 'feedback:read', preflightHeaders)])
        assert.equal(preflightHeaders.values.size, 0)
        assert.equal(await usage.countBy({ principalId: key.id }), 0)
        const [{ beforeRace }] = await a.query('SELECT clock_timestamp() AS "beforeRace"')
        const out = await Promise.all(Array.from({ length: 16 }, (_, i) => submit(i % 2 ? a : b, i % 2 ? 'predict' : 'feedback:read')))
        const [{ afterRace }] = await a.query('SELECT clock_timestamp() AS "afterRace"')
        const yes = out.filter((x) => x.status === 200),
            denied = out.filter((x) => x.status === 429)
        assert.equal(yes.length, 5)
        assert.equal(denied.length, 11)
        for (const [name, expected] of [
            ['X-RateLimit-Remaining', [0, 1, 2, 3, 4]],
            ['X-RateLimit-Day-Remaining', [4, 5, 6, 7, 8]],
            ['X-RateLimit-Month-Remaining', [6, 7, 8, 9, 10]]
        ])
            assert.deepEqual(
                yes.map((r) => Number(r.headers.get(name))).sort((l, r) => l - r),
                expected
            )
        const minuteReset = (Math.floor(beforeRace.getTime() / 60000) + 1) * 60000
        const dayReset = Date.UTC(beforeRace.getUTCFullYear(), beforeRace.getUTCMonth(), beforeRace.getUTCDate() + 1)
        const monthReset = Date.UTC(beforeRace.getUTCFullYear(), beforeRace.getUTCMonth() + 1, 1)
        for (const r of yes) {
            assert.equal(r.headers.get('X-RateLimit-Reset'), String(minuteReset / 1000))
            assert.equal(r.headers.get('X-RateLimit-Day-Reset'), String(dayReset / 1000))
            assert.equal(r.headers.get('X-RateLimit-Month-Reset'), String(monthReset / 1000))
        }
        for (const r of denied) {
            assert.deepEqual([...r.headers.keys()], ['Retry-After'])
            const retry = Number(r.headers.get('Retry-After'))
            assert.ok(
                retry >= Math.max(1, Math.ceil((minuteReset - afterRace.getTime()) / 1000)) &&
                    retry <= Math.ceil((minuteReset - beforeRace.getTime()) / 1000)
            )
        }
        await b.destroy()
        const replacement = await open()
        pools.push(replacement)
        await assert.rejects(assertCapacity(replacement, key, 'predict'), { statusCode: 429 })
        assert.equal((await submit(replacement, 'predict')).status, 429)
        await consume(replacement, foreign, 'predict')
        await assert.rejects(assertCapacity(replacement, { ...key, workspaceId: foreign.workspaceId }, 'predict'), { statusCode: 401 })
        await assert.rejects(consume(replacement, { ...key, workspaceId: foreign.workspaceId }, 'predict'), { statusCode: 401 })
        const before = await usage.find({ where: { principalId: key.id }, order: { period: 'ASC', operation: 'ASC' } })
        for (const row of before.filter((r) => r.operation === '*')) assert.equal(row.accepted, 5)
        for (const period of new Set(before.map((r) => r.period)))
            assert.equal(
                before.filter((r) => r.period === period && r.operation !== '*').reduce((n, r) => n + r.accepted, 0),
                5
            )
        assert.equal(await usage.countBy({ principalId: foreign.id }), 6)
        // Simulate existing daily/monthly charges and expiry of an older minute. Local mode's historical counters are retained.
        const monthly = before.find((r) => r.operation === '*' && /^\d{4}-\d{2}$/.test(r.period))
        const day = before.find((r) => r.operation === '*' && /^\d{4}-\d{2}-\d{2}$/.test(r.period))
        await usage.update({ principalId: key.id, period: before.find((r) => r.period.startsWith('m')).period }, { period: 'm1' })
        await usage.update({ principalId: key.id, period: monthly.period, operation: '*' }, { accepted: 11 })
        let deniedHeaders = hdr()
        await assert.rejects(consume(a, key, 'upload', deniedHeaders), { statusCode: 429 })
        assert.deepEqual([...deniedHeaders.values.keys()], ['Retry-After'])
        assert.equal(await usage.countBy({ principalId: key.id, operation: 'upload' }), 0)
        assert.equal((await usage.findOneBy({ principalId: key.id, period: day.period, operation: '*' })).accepted, 5)
        await usage.update({ principalId: key.id, period: monthly.period, operation: '*' }, { accepted: 5 })
        await usage.update({ principalId: key.id, period: day.period, operation: '*' }, { accepted: 9 })
        await assert.rejects(consume(a, key, 'upload'), { statusCode: 429 })
        await usage.update({ principalId: key.id, period: day.period, operation: '*' }, { accepted: 5 })
        await usage.save({ principalId: key.id, period: '1999-01-01', operation: '*', accepted: 30 })
        await consume(replacement, key, 'upload')
        assert.equal(await usage.countBy({ principalId: key.id, period: 'm1' }), 0)
        assert.equal(await usage.countBy({ principalId: key.id, period: '1999-01-01' }), 0)
        // A failure inside SQL rolls back all six changes and never advertises accepted remaining/reset headers.
        await a.query(
            "CREATE FUNCTION refuse_key_charge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$"
        )
        await a.query('CREATE TRIGGER refuse_key_charge BEFORE UPDATE ON apikey_usage FOR EACH ROW EXECUTE FUNCTION refuse_key_charge()')
        const committed = await usage.find({ where: { principalId: key.id }, order: { period: 'ASC', operation: 'ASC' } })
        deniedHeaders = hdr()
        await assert.rejects(consume(replacement, key, 'predict', deniedHeaders), { statusCode: 503 })
        assert.equal(deniedHeaders.values.size, 0)
        assert.deepEqual(await usage.find({ where: { principalId: key.id }, order: { period: 'ASC', operation: 'ASC' } }), committed)
    }
)
