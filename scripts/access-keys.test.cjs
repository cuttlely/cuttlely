process.env.INBOUND_ACCESS_V2 = 'on'
// Execution-level migration, lifecycle, authorization and race coverage with the real SQLite driver.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
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
const { DataSource } = serverRequire('typeorm')
const { ApiKey } = serverRequire('./src/database/entities/ApiKey.ts')
const { ApiKeyCredential } = serverRequire('./src/database/entities/ApiKeyCredential.ts')
const { ApiKeyResource } = serverRequire('./src/database/entities/ApiKeyResource.ts')
const { ApiKeyUsage } = serverRequire('./src/database/entities/ApiKeyUsage.ts')
const { ApiKeyReport } = serverRequire('./src/database/entities/ApiKeyReport.ts')
const { addAccessKeys, removeAccessKeys } = serverRequire('./src/database/migrations/AccessKeys.ts')
const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
const { consume, clearMinuteBuckets } = serverRequire('./src/services/accessKeys/limiter.ts')
const { hasGrant } = serverRequire('./src/services/accessKeys/authorization.ts')
const { generateSecretHash, storedApiKeyLookup, compareKeys } = serverRequire('./src/utils/apiKey.ts')

async function database() {
    const data = new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: [ApiKey, ApiKeyCredential, ApiKeyResource, ApiKeyUsage, ApiKeyReport]
    })
    await data.initialize()
    await data.query(`CREATE TABLE apikey (id varchar PRIMARY KEY, apiKey text NOT NULL, apiSecret text NOT NULL, keyName text NOT NULL,
        permissions text NOT NULL DEFAULT '[]', updatedDate datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, workspaceId text NOT NULL,
        ownerUserId varchar, disabledAt datetime, harnesses text)`)
    await data.query('CREATE TABLE role (id varchar PRIMARY KEY, name varchar, organizationId varchar, permissions text)')
    await data.query('CREATE TABLE chat_flow (id varchar PRIMARY KEY, name text, type text, workspaceId text, apikeyid varchar)')
    return data
}
test('migration preserves bearer bytes and maps only exact workspace resources; rollback leaves legacy material', async () => {
    const data = await database()
    try {
        const secret = 'fixture-legacy-bearer'
        const verifier = generateSecretHash(secret)
        await data.query('INSERT INTO apikey (id, apiKey, apiSecret, keyName, workspaceId, harnesses) VALUES (?, ?, ?, ?, ?, ?)', [
            'legacy',
            storedApiKeyLookup(secret),
            verifier,
            'Fixture',
            'workspace-a',
            '["baker"]'
        ])
        for (const row of [
            ['flow-a', 'one', 'CHATFLOW', 'workspace-a', 'legacy'],
            ['flow-b', 'two', 'CHATFLOW', 'workspace-b', 'legacy'],
            ['h-a', 'baker', 'HARNESS', 'workspace-a', null],
            ['h-b', 'baker', 'HARNESS', 'workspace-b', null]
        ])
            await data.query('INSERT INTO chat_flow (id, name, type, workspaceId, apikeyid) VALUES (?, ?, ?, ?, ?)', row)
        await data.transaction(async (manager) => addAccessKeys(manager.queryRunner))
        const legacy = await data.getRepository(ApiKey).findOneByOrFail({ id: 'legacy' })
        assert.equal(legacy.apiSecret, verifier)
        assert.equal(compareKeys(legacy.apiSecret, secret), true)
        assert.equal(legacy.accessPolicy.legacy, true)
        assert.equal(legacy.accessPolicy.allResources, false)
        const grants = await data.getRepository(ApiKeyResource).findBy({ principalId: legacy.id })
        assert.deepEqual(grants.map((g) => g.resourceId).sort(), ['flow-a', 'h-a'])
        assert.equal(await hasGrant(data, legacy, { resourceType: 'CHATFLOW', resourceId: 'flow-b' }), false)
        await removeAccessKeys(data.createQueryRunner())
        const rows = await data.query('SELECT apiSecret FROM apikey WHERE id = ?', ['legacy'])
        assert.equal(rows[0].apiSecret, verifier)
    } finally {
        await data.destroy()
    }
})
test('new principal denies every resource until an exact grant; many keys share one resource', async () => {
    const data = await database()
    try {
        await addAccessKeys(data.createQueryRunner())
        const a = { id: 'a', accessPolicy: parsePolicy({ scopes: ['predict'] }) }
        const b = { id: 'b', accessPolicy: parsePolicy({ scopes: ['predict'] }) }
        const resource = { resourceType: 'CHATFLOW', resourceId: 'shared' }
        assert.equal(await hasGrant(data, a, resource), false)
        for (const principal of [a, b]) await data.getRepository(ApiKeyResource).save({ principalId: principal.id, ...resource })
        assert.equal(await hasGrant(data, a, resource), true)
        assert.equal(await hasGrant(data, b, resource), true)
        assert.equal(await hasGrant(data, a, { ...resource, resourceType: 'AGENTFLOW' }), false)
        assert.equal(await hasGrant(data, a, { ...resource, resourceId: 'other' }), false)
    } finally {
        await data.destroy()
    }
})
test('an already-migrated directory receives grant-all only on the canonical built-in Admin', async () => {
    const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
    const data = new DataSource({ type: 'sqlite', database: ':memory:', migrations: sqliteMigrations.slice(0, -1) })
    await data.initialize()
    try {
        await data.runMigrations()
        const adminId = '00000000-0000-4000-8000-000000000004'
        await data.query('UPDATE role SET permissions = ? WHERE id = ?', ['["apikeys:create"]', adminId])
        await data.query('INSERT INTO role (id, name, permissions, organizationId) VALUES (?, ?, ?, NULL)', [
            'custom-admin-fixture',
            'admin',
            '["apikeys:create"]'
        ])
        await addAccessKeys(data.createQueryRunner())
        const rows = await data.query('SELECT id, permissions FROM role WHERE id IN (?, ?)', [adminId, 'custom-admin-fixture'])
        assert.equal(JSON.parse(rows.find((r) => r.id === adminId).permissions).includes('apikeys:grant-all'), true)
        assert.equal(JSON.parse(rows.find((r) => r.id === 'custom-admin-fixture').permissions).includes('apikeys:grant-all'), false)
    } finally {
        await data.destroy()
    }
})
test('SQL quotas atomically admit only the allowed racing requests and rollback rejected counts', async () => {
    clearMinuteBuckets()
    const data = await database()
    try {
        await addAccessKeys(data.createQueryRunner())
        const key = { id: 'quota', accessPolicy: parsePolicy({ daily: 5, monthly: 20, rpm: 0 }) }
        const results = await Promise.allSettled(Array.from({ length: 30 }, () => consume(data, key, 'predict')))
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5)
        for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.statusCode, 429)
        const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
        assert.equal(usage.length, 4)
        for (const row of usage) assert.equal(row.accepted, 5)
    } finally {
        await data.destroy()
    }
})
test('a rolled-back monthly refusal does not advertise uncommitted daily usage headers', async () => {
    clearMinuteBuckets()
    const data = await database()
    try {
        await addAccessKeys(data.createQueryRunner())
        const key = { id: 'headers-quota', accessPolicy: parsePolicy({ daily: 5, monthly: 1, rpm: 0 }) }
        await consume(data, key, 'predict')
        const before = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
        const headers = new Map()
        await assert.rejects(consume(data, key, 'predict', { setHeader: (name, value) => headers.set(name, value) }), { statusCode: 429 })
        assert.ok(headers.has('Retry-After'))
        assert.equal(headers.has('X-RateLimit-Day-Remaining'), false)
        assert.equal(headers.has('X-RateLimit-Day-Reset'), false)
        assert.deepEqual(await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id }), before)
    } finally {
        await data.destroy()
    }
})
test('RPM is key-wide across operations and credentials; UTC quota rollovers retain bounded storage', async () => {
    clearMinuteBuckets()
    const data = await database()
    try {
        await addAccessKeys(data.createQueryRunner())
        const key = { id: 'rpm', accessPolicy: parsePolicy({ rpm: 2, daily: 4, monthly: 5 }) }
        const now = Date.parse('2026-11-30T23:59:00Z')
        await consume(data, key, 'predict', undefined, now)
        await consume(data, key, 'feedback:read', undefined, now)
        await assert.rejects(consume(data, key, 'predict', undefined, now), { statusCode: 429 })
        await consume(data, key, 'predict', undefined, Date.parse('2026-12-01T00:00:00Z'))
        const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
        assert.deepEqual([...new Set(usage.map((r) => r.period))].sort(), ['2026-12', '2026-12-01'])
    } finally {
        await data.destroy()
    }
})

test('credentials rotate with bounded grace, never extend old grace, and revoke without changing principal or policy', async () => {
    const data = await database()
    const oldPepper = process.env.FLOWISE_SECRETKEY_OVERWRITE
    process.env.FLOWISE_SECRETKEY_OVERWRITE = 'fixture-installation-pepper-for-access-key-tests'
    try {
        await addAccessKeys(data.createQueryRunner())
        const { mintCredential, rotateCredential, findCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
        const key = data.getRepository(ApiKey).create({
            id: 'lifecycle',
            apiKey: '',
            apiSecret: '',
            keyName: 'Fixture',
            workspaceId: 'workspace-a',
            permissions: ['chatflows:view'],
            accessPolicy: parsePolicy({ scopes: ['predict'] }),
            expiresAt: null
        })
        await data.getRepository(ApiKey).save(key)
        const first = await data.transaction((m) => mintCredential(m, key))
        assert.match(first.secret, /^ctu_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/)
        assert.equal((await findCredential(data, first.secret)).key.id, key.id)
        assert.equal(await findCredential(data, first.credential.digest), undefined)
        const second = await data.transaction((m) => rotateCredential(m, key, 60))
        assert.equal((await findCredential(data, first.secret)).key.id, key.id)
        assert.equal((await findCredential(data, second.secret)).key.id, key.id)
        const before = await data.getRepository(ApiKeyCredential).findOneByOrFail({ id: first.credential.id })
        await data.transaction((m) => rotateCredential(m, key, 3600))
        const after = await data.getRepository(ApiKeyCredential).findOneByOrFail({ id: first.credential.id })
        assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime())
        await data.getRepository(ApiKeyCredential).update({ id: first.credential.id }, { expiresAt: new Date(Date.now() - 1) })
        assert.equal(await findCredential(data, first.secret), undefined)
        await data.getRepository(ApiKeyCredential).update({ id: second.credential.id }, { revokedAt: new Date() })
        assert.equal(await findCredential(data, second.secret), undefined)
        const retiredLegacy = new Date(Date.now() - 1000)
        await data.getRepository(ApiKey).update({ id: key.id }, { legacyRevokedAt: retiredLegacy })
        const final = await data.transaction((m) => rotateCredential(m, key, 0))
        assert.equal((await data.getRepository(ApiKey).findOneByOrFail({ id: key.id })).legacyRevokedAt.getTime(), retiredLegacy.getTime())
        assert.ok((await data.getRepository(ApiKeyCredential).findOneByOrFail({ id: second.credential.id })).revokedAt)
        assert.equal((await findCredential(data, final.secret)).key.id, key.id)
        await data.getRepository(ApiKey).update({ id: key.id }, { disabledAt: new Date() })
        assert.equal(await findCredential(data, final.secret), undefined)
        const stored = await data.getRepository(ApiKey).findOneByOrFail({ id: key.id })
        await assert.rejects(
            data.transaction((m) => rotateCredential(m, stored, 60)),
            { statusCode: 409 }
        )
        const serialized = JSON.stringify(await data.getRepository(ApiKeyCredential).find())
        for (const value of [first.secret, second.secret, final.secret]) assert.equal(serialized.includes(value), false)
        assert.deepEqual(stored.accessPolicy, key.accessPolicy)
    } finally {
        if (oldPepper === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        else process.env.FLOWISE_SECRETKEY_OVERWRITE = oldPepper
        await data.destroy()
    }
})

test('management API creates deny-by-default principals, validates grants and privilege, rotates once, and soft-revokes', async () => {
    const { entities } = serverRequire('./src/database/entities/index.ts')
    const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
    const data = new DataSource({ type: 'sqlite', database: ':memory:', entities: Object.values(entities), migrations: sqliteMigrations })
    const oldPepper = process.env.FLOWISE_SECRETKEY_OVERWRITE
    process.env.FLOWISE_SECRETKEY_OVERWRITE = 'fixture-installation-pepper-for-access-key-tests'
    process.env.CUTTLELY_DASH_FLOWS = 'false'
    process.env.CUTTLELY_VERSIONS = 'false'
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    let owner = true
    let actorPermissions = ['apikeys:view', 'apikeys:create', 'apikeys:update', 'apikeys:delete', 'chatflows:view']
    setTeamPermissionLookup({
        accessFor: async () => ({
            owner,
            permissions: actorPermissions
        })
    })
    const appModule = serverRequire('./src/utils/getRunningExpressApp.ts')
    const oldApp = appModule.getRunningExpressApp
    appModule.getRunningExpressApp = () => ({ AppDataSource: data, identityManager: { getPlatformType: () => 'open_source' } })
    const { accessData } = serverRequire('./src/services/accessKeys/data.ts')
    const dataModule = serverRequire('./src/services/accessKeys/data.ts')
    dataModule.accessData = async () => data
    try {
        await data.initialize()
        await data.runMigrations()
        const { ChatFlow } = serverRequire('./src/database/entities/ChatFlow.ts')
        const { User, Workspace, Organization } = serverRequire('./src/database/entities/identity/index.ts')
        await data.getRepository(User).save({
            id: 'fixture-person',
            name: 'Fixture user',
            email: 'access-key-fixture@example.invalid',
            status: 'active',
            createdBy: 'fixture-person',
            updatedBy: 'fixture-person'
        })
        await data
            .getRepository(Organization)
            .save({ id: 'fixture-org', name: 'Fixture org', createdBy: 'fixture-person', updatedBy: 'fixture-person' })
        await data.getRepository(Workspace).save({
            id: 'workspace-a',
            name: 'Fixture workspace',
            organizationId: 'fixture-org',
            createdBy: 'fixture-person',
            updatedBy: 'fixture-person'
        })
        const flow = await data
            .getRepository(ChatFlow)
            .save(data.getRepository(ChatFlow).create({ name: 'Fixture', flowData: '{}', workspaceId: 'workspace-a', type: 'CHATFLOW' }))
        const express = serverRequire('express')
        const request = serverRequire('supertest')
        const router = serverRequire('./src/routes/apikey/index.ts').default
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => {
            req.user = {
                id: 'fixture-person',
                activeWorkspaceId: 'workspace-a',
                permissions: actorPermissions,
                features: {}
            }
            next()
        })
        app.use('/apikey', router)
        app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const created = await request(app)
            .post('/apikey')
            .send({ keyName: 'Fixture key', permissions: ['chatflows:view'] })
        assert.equal(created.status, 200, JSON.stringify(created.body))
        const row = created.body[0]
        assert.match(row.apiKey, /^ctu_live_/)
        assert.deepEqual(row.accessPolicy.scopes, [])
        assert.deepEqual(row.resources, [])
        assert.equal(row.accessPolicy.allResources, false)
        assert.ok(row.expiresAt)
        assert.equal(row.apiSecret, undefined)
        assert.equal(row.credentials[0].digest, undefined)
        const listed = await request(app).get('/apikey')
        assert.equal(listed.body[0].apiKey, undefined)
        const scoped = {
            keyName: 'Fixture key',
            permissions: ['chatflows:view'],
            accessPolicy: { scopes: ['predict'] },
            resources: [{ resourceType: 'CHATFLOW', resourceId: flow.id }],
            expiresAt: null
        }
        assert.equal(
            (
                await request(app)
                    .put('/apikey/' + row.id)
                    .send(scoped)
            ).status,
            200
        )
        // Real bearer verification + shared authorization against the migrated database, without model calls.
        const { accessKeyPreflight } = serverRequire('./src/services/accessKeys/preflight.ts')
        const { authorizePrediction } = serverRequire('./src/utils/authorizeFlowAccess.ts')
        const runtimeApp = express()
        runtimeApp.use(accessKeyPreflight)
        runtimeApp.use(express.json())
        runtimeApp.post('/api/v1/prediction/:id', authorizePrediction, (_req, res) => res.json({ ok: true }))
        runtimeApp.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const bearer = () =>
            request(runtimeApp)
                .post('/api/v1/prediction/' + flow.id)
                .set('Authorization', 'Bearer ' + row.apiKey)
        assert.equal((await bearer().send({ question: 'Fixture' })).status, 200)
        const countBefore = await data.getRepository(ApiKeyUsage).findBy({ principalId: row.id })
        assert.equal((await bearer().send({ streaming: true })).status, 403)
        assert.deepEqual(await data.getRepository(ApiKeyUsage).findBy({ principalId: row.id }), countBefore)
        const publicFlow = { ...flow, id: undefined, name: 'Public fixture', apiAccessMode: 'public' }
        const publishedPublic = await data.getRepository(ChatFlow).save(data.getRepository(ChatFlow).create(publicFlow))
        assert.equal(
            (
                await request(runtimeApp)
                    .post('/api/v1/prediction/' + publishedPublic.id)
                    .send({})
            ).status,
            200
        )
        assert.equal(
            (
                await request(runtimeApp)
                    .post('/api/v1/prediction/' + publishedPublic.id)
                    .set('Authorization', 'Bearer wrong-fixture')
                    .send({})
            ).status,
            401
        )
        const cross = await request(app)
            .put('/apikey/' + row.id)
            .send({ ...scoped, resources: [{ resourceType: 'CHATFLOW', resourceId: 'does-not-exist' }] })
        assert.equal(cross.status, 403)
        const unconfirmed = await request(app)
            .put('/apikey/' + row.id)
            .send({ ...scoped, accessPolicy: { scopes: ['predict'], allResources: true } })
        assert.equal(unconfirmed.status, 403)
        owner = false
        assert.equal(
            (
                await request(app)
                    .put('/apikey/' + row.id)
                    .send({ ...scoped, accessPolicy: { scopes: ['predict'], allResources: true }, confirmAllResources: true })
            ).status,
            403
        )
        owner = true
        const rotated = await request(app)
            .post('/apikey/' + row.id + '/rotate')
            .send({ graceSeconds: 3600 })
        assert.equal(rotated.status, 200, JSON.stringify(rotated.body))
        assert.match(rotated.body.apiKey, /^ctu_live_/)
        assert.equal(rotated.body.credential.digest, undefined)
        assert.equal((await request(app).post('/apikey/' + row.id + '/credentials/' + rotated.body.credential.id + '/revoke')).status, 200)
        assert.equal((await request(app).delete('/apikey/' + row.id)).status, 200)
        assert.ok((await data.getRepository(ApiKey).findOneByOrFail({ id: row.id })).disabledAt)
        assert.equal(
            (
                await request(app)
                    .post('/apikey/' + row.id + '/rotate')
                    .send({ graceSeconds: 0 })
            ).status,
            409
        )
        const stored = await data.getRepository(ApiKey).findOneByOrFail({ id: row.id })
        assert.equal(stored.apiSecret, '')
        assert.equal(stored.apiKey, '')
        const audits = await data.query("SELECT detail FROM audit_event WHERE type = 'api_key_change'")
        assert.ok(audits.length >= 4)
        assert.ok(audits.some((event) => String(event.detail).includes(row.id)))
        assert.equal(JSON.stringify(audits).includes(row.apiKey), false)
        assert.equal(JSON.stringify(audits).includes(rotated.body.apiKey), false)
        const compatibility = { ...parsePolicy({ scopes: ['predict', 'harness:run', 'api:read', 'api:write'] }), legacy: true }
        for (const id of ['legacy-a', 'legacy-b', 'explicit-key'])
            await data.getRepository(ApiKey).save({
                id,
                apiKey: '',
                apiSecret: '',
                keyName: id,
                workspaceId: 'workspace-a',
                permissions: [],
                accessPolicy: id === 'explicit-key' ? parsePolicy({ scopes: ['predict'] }) : compatibility
            })
        const { saveLegacyBoundFlow, saveFlowPreservingAccess } = serverRequire('./src/services/accessKeys/legacyBinding.ts')
        const bindingFlow = await saveLegacyBoundFlow(data, {
            ...flow,
            id: undefined,
            name: 'Binding fixture',
            apikeyid: 'legacy-a',
            apiAccessMode: 'private'
        })
        await data.getRepository(ApiKeyResource).save({ principalId: 'explicit-key', resourceType: 'CHATFLOW', resourceId: bindingFlow.id })
        const rebound = await saveLegacyBoundFlow(data, { ...bindingFlow, apikeyid: 'legacy-b' }, bindingFlow)
        assert.equal(await hasGrant(data, { id: 'legacy-a' }, { resourceType: 'CHATFLOW', resourceId: bindingFlow.id }), false)
        assert.equal(await hasGrant(data, { id: 'legacy-b' }, { resourceType: 'CHATFLOW', resourceId: bindingFlow.id }), true)
        const staleCanvas = {
            ...bindingFlow,
            apikeyid: null,
            apiAccessMode: 'public',
            name: 'Stale canvas fixture',
            mcpServerConfig: '{"enabled":true,"token":"retired-fixture"}',
            webhookSecret: 'retired-fixture'
        }
        await data
            .getRepository(ChatFlow)
            .update(
                { id: rebound.id },
                { mcpServerConfig: '{"enabled":false,"token":"successor-fixture"}', webhookSecret: 'successor-fixture' }
            )
        const privateBinding = await data.getRepository(ChatFlow).findOneByOrFail({ id: rebound.id })
        const afterOrdinarySave = await saveFlowPreservingAccess(data, staleCanvas, staleCanvas)
        assert.equal(afterOrdinarySave.apikeyid, privateBinding.apikeyid)
        assert.equal(afterOrdinarySave.apiAccessMode, privateBinding.apiAccessMode)
        assert.equal(afterOrdinarySave.name, staleCanvas.name)
        assert.equal(JSON.parse(afterOrdinarySave.mcpServerConfig).enabled, false)
        assert.equal(JSON.parse(afterOrdinarySave.mcpServerConfig).token, 'successor-fixture')
        assert.equal(
            (await data.query('SELECT webhookSecret FROM chat_flow WHERE id = ?', [rebound.id]))[0].webhookSecret,
            'successor-fixture'
        )
        await assert.rejects(saveFlowPreservingAccess(data, staleCanvas, staleCanvas, 'public'), { statusCode: 409 })
        assert.equal(await hasGrant(data, { id: 'explicit-key' }, { resourceType: 'CHATFLOW', resourceId: bindingFlow.id }), true)
        await assert.rejects(saveLegacyBoundFlow(data, { ...bindingFlow, apikeyid: 'legacy-a' }, bindingFlow), { statusCode: 409 })
        // A missing target rolls back both the row change and retirement of B's grant.
        await assert.rejects(saveLegacyBoundFlow(data, { ...rebound, apikeyid: 'missing-fixture' }, rebound), { statusCode: 403 })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: rebound.id })).apikeyid, 'legacy-b')
        assert.equal(await hasGrant(data, { id: 'legacy-b' }, { resourceType: 'CHATFLOW', resourceId: bindingFlow.id }), true)
        const movedAgain = await saveLegacyBoundFlow(
            data,
            {
                ...rebound,
                apikeyid: 'legacy-a',
                mcpServerConfig: staleCanvas.mcpServerConfig,
                webhookSecret: staleCanvas.webhookSecret
            },
            rebound
        )
        assert.equal(JSON.parse(movedAgain.mcpServerConfig).enabled, false)
        assert.equal(JSON.parse(movedAgain.mcpServerConfig).token, 'successor-fixture')
        await data.getRepository(ApiKey).save({
            id: 'narrow-legacy',
            apiKey: '',
            apiSecret: '',
            keyName: 'Narrow fixture',
            workspaceId: 'workspace-a',
            permissions: ['credentials:view'],
            accessPolicy: compatibility
        })
        // A retained bearer has its own monotonic cutoff, independent of later principal expiry edits.
        const keyService = serverRequire('./src/services/apikey/index.ts').default
        const legacySecret = 'fixture-legacy-expiry-bearer'
        const pastExpiry = new Date(Date.now() - 10000)
        await data.getRepository(ApiKey).save({
            id: 'legacy-expiry',
            apiKey: storedApiKeyLookup(legacySecret),
            apiSecret: generateSecretHash(legacySecret),
            keyName: 'Legacy expiry',
            workspaceId: 'workspace-a',
            permissions: ['chatflows:view'],
            accessPolicy: compatibility,
            expiresAt: pastExpiry
        })
        assert.equal(await keyService.getApiKey(legacySecret), undefined)
        assert.equal((await request(app).put('/apikey/legacy-expiry').send(scoped)).status, 200)
        assert.equal(await keyService.getApiKey(legacySecret), undefined, 'principal expiry edit must not revive a retained expired bearer')
        const futureSecret = 'fixture-legacy-future-expiry-bearer'
        const futureExpiry = new Date(Date.now() + 600000)
        await data.getRepository(ApiKey).save({
            id: 'legacy-future-expiry',
            apiKey: storedApiKeyLookup(futureSecret),
            apiSecret: generateSecretHash(futureSecret),
            keyName: 'Legacy future expiry',
            workspaceId: 'workspace-a',
            permissions: ['chatflows:view'],
            accessPolicy: compatibility,
            expiresAt: futureExpiry
        })
        assert.equal((await request(app).put('/apikey/legacy-future-expiry').send(scoped)).status, 200)
        assert.equal(
            (await data.getRepository(ApiKey).findOneByOrFail({ id: 'legacy-future-expiry' })).legacyRevokedAt.getTime(),
            futureExpiry.getTime()
        )
        const earlierExpiry = new Date(Date.now() + 300000)
        assert.equal(
            (
                await request(app)
                    .put('/apikey/legacy-future-expiry')
                    .send({ ...scoped, expiresAt: earlierExpiry.toISOString() })
            ).status,
            200
        )
        assert.equal((await request(app).put('/apikey/legacy-future-expiry').send(scoped)).status, 200)
        assert.equal(
            (await data.getRepository(ApiKey).findOneByOrFail({ id: 'legacy-future-expiry' })).legacyRevokedAt.getTime(),
            earlierExpiry.getTime()
        )
        assert.equal((await keyService.getApiKey(futureSecret)).id, 'legacy-future-expiry')
        owner = false
        actorPermissions = ['apikeys:update', 'apikeys:delete', 'credentials:view']
        assert.equal((await request(app).post('/apikey/narrow-legacy/rotate').send({ graceSeconds: 0 })).status, 200)
        assert.equal((await request(app).delete('/apikey/narrow-legacy')).status, 200)
        assert.equal((await request(app).delete('/apikey/' + row.id)).status, 403)
    } finally {
        dataModule.accessData = accessData
        appModule.getRunningExpressApp = oldApp
        setTeamPermissionLookup(null)
        if (oldPepper === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        else process.env.FLOWISE_SECRETKEY_OVERWRITE = oldPepper
        if (data.isInitialized) await data.destroy()
    }
})

for (const dialect of ['sqlite', 'postgres', 'mysql', 'mariadb'])
    test('migration/rollback fixture uses portable schema and exact grants: ' + dialect, async () => {
        const tables = new Map()
        const columns = []
        const statements = []
        const grants = []
        const keys = [{ id: 'key', workspaceId: 'a', harnesses: '["baker", "orphan"]' }]
        const flows = [
            { id: 'flow', name: 'Fixture', type: 'AGENTFLOW', workspaceId: 'a', apikeyid: 'key' },
            { id: 'harness', name: 'baker', type: 'HARNESS', workspaceId: 'a' },
            { id: 'other', name: 'Fixture', type: 'CHATFLOW', workspaceId: 'b', apikeyid: 'key' },
            { id: 'public', name: 'Public', type: 'CHATFLOW', workspaceId: 'a', apikeyid: null }
        ]
        const qb = () => {
            let from
            let value
            const q = {
                select: () => q,
                from: (name) => {
                    from = name
                    return q
                },
                getRawMany: async () => (from === 'apikey' ? keys : flows),
                insert: () => q,
                into: () => q,
                values: (row) => {
                    value = row
                    return q
                },
                orIgnore: () => q,
                execute: async () => {
                    grants.push(value)
                }
            }
            return q
        }
        const runner = {
            connection: { options: { type: dialect } },
            manager: { createQueryBuilder: qb },
            addColumn: async (table, column) => columns.push([table, column]),
            addColumns: async (table, list) => list.forEach((column) => columns.push([table, column])),
            createTable: async (table) => tables.set(table.name, table),
            query: async (sql, params) => {
                statements.push({ sql, params })
                return []
            },
            dropColumn: async (table, name) => {
                const i = columns.findIndex(([t, c]) => t === table && c.name === name)
                if (i >= 0) columns.splice(i, 1)
            },
            dropTable: async (name) => tables.delete(name)
        }
        await addAccessKeys(runner)
        assert.deepEqual(grants.map((g) => g.resourceId).sort(), ['flow', 'harness'])
        assert.equal(
            tables.get('apikey_credential').columns.find((c) => c.name === 'createdAt').type,
            dialect === 'sqlite' ? 'datetime' : 'timestamp'
        )
        const update = statements.find((s) => s.params)
        assert.equal(JSON.parse(update.params[0]).legacy, true)
        assert.equal(JSON.parse(update.params[0]).allResources, false)
        assert.ok(update.sql.includes(dialect === 'postgres' ? '$1' : '?'))
        assert.ok(statements.some((s) => s.sql.includes("THEN 'public' ELSE 'private'")))
        await removeAccessKeys(runner)
        assert.equal(tables.size, 0)
        assert.equal(columns.length, 0)
    })

test('usage examples distinguish legacy usage bearers from owner-session model-price commands', () => {
    const { readFileSync } = require('node:fs')
    const doc = readFileSync(path.join(__dirname, '../docs/reference/usage-api.md'), 'utf8')
    const [usage, ownerSession] = doc.split('`CUTTLELY_LOCAL_ADMIN=true`')
    assert.match(usage, /This bearer example requires a retained legacy key/)
    assert.doesNotMatch(ownerSession, /This bearer example requires a retained legacy key/)
    const commands = [...ownerSession.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1])
    assert.equal(commands.length, 3)
    assert.match(commands[0], /-c "\$COOKIE_JAR".*POST.*\/api\/v1\/auth\/login/)
    assert.match(commands[1], /-b "\$COOKIE_JAR".*PUT.*\/api\/v1\/model-prices/)
    assert.match(commands[2], /-b "\$COOKIE_JAR".*DELETE.*\/api\/v1\/model-prices/)
    for (const command of commands) {
        assert.match(command, /x-request-from: internal/)
        assert.doesNotMatch(command, /Authorization|Bearer/)
    }
})

test('an outer TypeORM transaction cannot erase an admitted SQLite quota charge', async () => {
    clearMinuteBuckets()
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const file = path.join(os.tmpdir(), `api-keys-quota-nested-${process.pid}.sqlite`)
    try {
        try {
            fs.unlinkSync(file)
        } catch {}
        const data = new DataSource({
            type: 'sqlite',
            database: file,
            entities: [ApiKey, ApiKeyCredential, ApiKeyResource, ApiKeyUsage, ApiKeyReport]
        })
        await data.initialize()
        await data.query(`CREATE TABLE apikey (id varchar PRIMARY KEY, apiKey text NOT NULL, apiSecret text NOT NULL, keyName text NOT NULL,
            permissions text NOT NULL DEFAULT '[]', updatedDate datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, workspaceId text NOT NULL,
            ownerUserId varchar, disabledAt datetime, harnesses text)`)
        await data.query('CREATE TABLE role (id varchar PRIMARY KEY, name varchar, organizationId varchar, permissions text)')
        await data.query('CREATE TABLE chat_flow (id varchar PRIMARY KEY, name text, type text, workspaceId text, apikeyid varchar)')
        await addAccessKeys(data.createQueryRunner())
        const key = { id: 'nested-outer', accessPolicy: parsePolicy({ daily: 1, monthly: 1, rpm: 0 }) }
        let consumeResult
        let releaseOuter
        const hold = new Promise((resolve) => {
            releaseOuter = resolve
        })
        let done
        const finished = new Promise((resolve) => {
            done = resolve
        })
        const outer = data
            .transaction(async (manager) => {
                await manager.query('SELECT 1')
                consume(data, key, 'predict').then(
                    () => {
                        consumeResult = 'admitted'
                        done()
                    },
                    (error) => {
                        consumeResult = `rejected:${error.statusCode || error.message}`
                        done()
                    }
                )
                await hold
                throw new Error('force-outer-rollback')
            })
            .catch((error) => {
                if (error.message !== 'force-outer-rollback') throw error
            })
        await new Promise((resolve) => setTimeout(resolve, 200))
        releaseOuter()
        await outer
        await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2000))])
        assert.equal(consumeResult, 'admitted')
        const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
        assert.equal(usage.length, 4)
        for (const row of usage) assert.equal(row.accepted, 1)
        await assert.rejects(consume(data, key, 'predict'), { statusCode: 429 })
        await data.destroy()
    } finally {
        try {
            fs.unlinkSync(file)
        } catch {}
    }
})
