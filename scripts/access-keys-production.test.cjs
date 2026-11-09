// Production entry points with disposable SQLite databases and the real harness runtime.
process.env.INBOUND_ACCESS_V2 = 'on'
process.env.CUTTLELY_VERSIONS = 'false'
process.env.CUTTLELY_DASH_FLOWS = 'false'
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { createRequire } = require('node:module')
const { mkdtempSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const root = mkdtempSync(path.join(tmpdir(), 'cuttlely-access-production-'))
process.env.LOG_PATH = path.join(root, 'logs')
process.env.BLOB_STORAGE_PATH = path.join(root, 'blobs')
process.env.CUTTLELY_DATA_DIR = root
process.env.CUTTLELY_HERMES_HOME = path.join(root, 'profiles-home')
process.env.FLOWISE_SECRETKEY_OVERWRITE = 'fixture-access-production-pepper'
after(() => rmSync(root, { recursive: true, force: true }))
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
const { entities } = serverRequire('./src/database/entities/index.ts')
const { ChatFlow, ApiKey, ApiKeyResource, ApiKeyUsage, ApiKeyCredential, FlowVersionState } = entities
const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
const { hasGrant } = serverRequire('./src/services/accessKeys/authorization.ts')
const appModule = serverRequire('./src/utils/getRunningExpressApp.ts')
const dataModule = serverRequire('./src/services/accessKeys/data.ts')
const dataSourceModule = serverRequire('./src/DataSource.ts')
async function database(beforeAccessMigration = false) {
    const data = new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: Object.values(entities),
        synchronize: !beforeAccessMigration,
        migrations: beforeAccessMigration ? serverRequire('./src/database/migrations/sqlite/index.ts').sqliteMigrations.slice(0, -1) : []
    })
    await data.initialize()
    if (beforeAccessMigration) await data.runMigrations()
    appModule.getRunningExpressApp = () => ({
        AppDataSource: data,
        nodesPool: { componentNodes: {} },
        cachePool: {},
        usageCacheManager: {},
        telemetry: { sendTelemetry: async () => {} },
        identityManager: { getPlatformType: () => 'open_source' }
    })
    dataModule.accessData = async () => data
    dataSourceModule.getDataSource = () => data
    return data
}
async function legacyFlow(data, id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
    await data.getRepository(ApiKey).save({
        id: 'legacy-key',
        apiKey: '',
        apiSecret: '',
        keyName: 'Fixture',
        workspaceId: 'team-a',
        permissions: [],
        harnesses: ['named-independent'],
        accessPolicy: { ...parsePolicy({ scopes: ['predict'] }), legacy: true }
    })
    const flow = await data.getRepository(ChatFlow).save({
        id,
        name: 'Fixture',
        workspaceId: 'team-a',
        type: 'CHATFLOW',
        flowData: '{"nodes":[],"edges":[]}',
        apikeyid: 'legacy-key',
        apiAccessMode: 'private'
    })
    await data.getRepository(ApiKeyResource).save({ principalId: 'legacy-key', resourceType: 'CHATFLOW', resourceId: id })
    return flow
}
const chatflows = serverRequire('./src/services/chatflows/index.ts')
const update = (flow, patch, options) => chatflows.default.updateChatflow(flow, patch, 'org-a', 'team-a', '', options)

test('updateChatflow moves derived grants, unbinds, preserves independent grants, and enforces draft/CAS guards', async () => {
    const data = await database()
    try {
        const { User, Workspace, Organization } = entities
        await data.getRepository(User).save({
            id: 'fixture',
            name: 'Fixture',
            email: 'type-fixture@example.invalid',
            status: 'active',
            createdBy: 'fixture',
            updatedBy: 'fixture'
        })
        await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        let flow = await legacyFlow(data)
        const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
        const key = await data.getRepository(ApiKey).findOneByOrFail({ id: 'legacy-key' })
        const { secret } = await data.transaction((manager) => mintCredential(manager, key))
        const express = serverRequire('express'),
            request = serverRequire('supertest')
        const { authorizePrediction } = serverRequire('./src/utils/authorizeFlowAccess.ts')
        const prediction = express()
        prediction.post('/api/v1/prediction/:id', authorizePrediction, (_req, res) => res.json({ admitted: true }))
        prediction.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const predict = (id) =>
            request(prediction)
                .post('/api/v1/prediction/' + id)
                .set('Authorization', 'Bearer ' + secret)

        await data.getRepository(ApiKey).save({
            id: 'explicit-key',
            apiKey: '',
            apiSecret: '',
            keyName: 'Explicit',
            workspaceId: 'team-a',
            permissions: [],
            accessPolicy: parsePolicy({ scopes: ['predict'] })
        })
        for (const grant of [
            { principalId: 'explicit-key', resourceType: 'CHATFLOW', resourceId: flow.id },
            { principalId: 'legacy-key', resourceType: 'HARNESS', resourceId: 'independent-harness' }
        ])
            await data.getRepository(ApiKeyResource).save(grant)
        await update(flow, { type: 'AGENTFLOW' })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(flow.type, 'AGENTFLOW')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: flow.id }), true)
        assert.equal((await predict(flow.id)).status, 200, 'converted flow still admits K through the real prediction guard')
        await update(flow, { apikeyid: null })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        await update(flow, { type: 'CHATFLOW' })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(flow.apiAccessMode, 'private')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'explicit-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: 'independent-harness' }), true)
        const usage = await data.getRepository(ApiKeyUsage).find()
        assert.equal((await predict(flow.id)).status, 403, 'unbound, reconverted private flow denies K')
        assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), usage)
        // Exercise the conflict guards on a bound flow, so its existing derived grant must also survive.
        flow = await legacyFlow(data, 'bound-cas')
        // Insert a draft at the actual conditional-write seam, after the earlier draft check.
        chatflows.liveWriteHooks.beforeConditionalWrite = async () => {
            await data.getRepository(FlowVersionState).save({ chatflowId: flow.id, workspaceId: 'team-a', draftFlowData: '{"nodes":[]}' })
        }
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }), { statusCode: 409 })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type, 'CHATFLOW')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), true)
        await data.getRepository(FlowVersionState).delete({ chatflowId: flow.id })
        chatflows.liveWriteHooks.beforeConditionalWrite = null
        const grants = await data.getRepository(ApiKeyResource).find()
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }, { expectedFlowData: 'stale canvas' }), { statusCode: 409 })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type, 'CHATFLOW')
        assert.deepEqual(await data.getRepository(ApiKeyResource).find(), grants)
    } finally {
        chatflows.liveWriteHooks.beforeConditionalWrite = null
        await data.destroy()
    }
})

test('updateChatflow rolls back its conditional row write when derived-grant reconciliation fails', async () => {
    const data = await database()
    try {
        const flow = await legacyFlow(data)
        const before = await data.getRepository(ApiKeyResource).find()
        await data.query(`CREATE TRIGGER refuse_derived_grant BEFORE INSERT ON apikey_resource
            WHEN NEW.resourceType = 'AGENTFLOW' BEGIN SELECT RAISE(ABORT, 'fixture grant failure'); END`)
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }), /fixture grant failure/)
        assert.equal(
            (await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type,
            'CHATFLOW',
            'type and grants must commit together'
        )
        assert.deepEqual(await data.getRepository(ApiKeyResource).find(), before)
    } finally {
        await data.destroy()
    }
})

function latch() {
    let release
    const reached = new Promise((resolve) => (release = resolve))
    return { reached, release }
}
const esm = (file) => import(path.join(__dirname, '../packages/harness', file))

test('round11 draft denial precedes committed quota admission through production routes', async () => {
    const data = await database()
    try {
        await workspaceFixture(data)
        const id = '77777777-7777-4777-8777-777777777777'
        await data
            .getRepository(ChatFlow)
            .save({ id, name: 'Draft caller', workspaceId: 'team-a', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' })
        await data.getRepository(FlowVersionState).save({
            chatflowId: id,
            workspaceId: 'team-a',
            draftFlowData: '{"nodes":[{"data":{"inputs":{"harnessName":"ungranted"}}}],"edges":[]}'
        })
        const key = await data.getRepository(ApiKey).save({
            id: 'draft-denial',
            apiKey: '',
            apiSecret: '',
            keyName: 'Draft denial',
            workspaceId: 'team-a',
            permissions: ['chatflows:view'],
            accessPolicy: parsePolicy({ scopes: ['api:read'], rpm: 0, daily: 1 }),
            harnesses: []
        })
        await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'CHATFLOW', resourceId: id })
        const { secret } = await data.transaction((manager) =>
            serverRequire('./src/services/accessKeys/credentials.ts').mintCredential(manager, key)
        )
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
        http.use(express.json())
        http.use('/api/v1', serverRequire('./src/services/accessKeys/routes.ts').accessKeyRouteGuard)
        for (const route of ['flow-drafts', 'chatflows'])
            http.use('/api/v1/' + route, serverRequire('./src/routes/' + route + '/index.ts').default)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const denied = await request(http)
            .get('/api/v1/flow-drafts/' + id)
            .set('Authorization', 'Bearer ' + secret)
        const afterDenial = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
        const allowed = await request(http)
            .get('/api/v1/chatflows/' + id)
            .set('Authorization', 'Bearer ' + secret)
        console.log('round11 draft:', JSON.stringify({ denied: denied.status, afterDenial, nextAllowed: allowed.status }))
        assert.equal(denied.status, 403)
        assert.deepEqual(afterDenial, [], 'authorization refusal must not commit quota')
        assert.equal(allowed.status, 200)
    } finally {
        await data.destroy()
    }
})

for (const mode of ['off', 'shadow'])
    test('round11 assistant binding production control: ' + mode, async () => {
        const data = await database(true)
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        try {
            await workspaceFixture(data)
            const { generateSecretHash, storedApiKeyLookup } = serverRequire('./src/utils/apiKey.ts')
            for (const key of ['old', 'replacement'])
                await data.query(
                    'INSERT INTO apikey (id, apiKey, apiSecret, keyName, workspaceId, permissions, harnesses) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [
                        key,
                        storedApiKeyLookup('fixture-assistant-' + key),
                        generateSecretHash('fixture-assistant-' + key),
                        key,
                        'team-a',
                        '[]',
                        '[]'
                    ]
                )
            const ids = [
                '88888888-8888-4888-8888-888888888881',
                '88888888-8888-4888-8888-888888888882',
                '88888888-8888-4888-8888-888888888883'
            ]
            for (const [index, id] of ids.entries())
                await data.query('INSERT INTO chat_flow (id, name, type, workspaceId, apikeyid, flowData) VALUES (?, ?, ?, ?, ?, ?)', [
                    id,
                    'Binding fixture',
                    index === 2 ? 'CHATFLOW' : 'ASSISTANT',
                    'team-a',
                    index === 1 ? 'old' : null,
                    '{"nodes":[],"edges":[]}'
                ])
            await data.transaction((manager) => serverRequire('./src/database/migrations/AccessKeys.ts').addAccessKeys(manager.queryRunner))
            process.env.INBOUND_ACCESS_V2 = mode
            setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
            const express = serverRequire('express'),
                request = serverRequire('supertest'),
                http = express()
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use(express.json())
            http.post('/api/v1/prediction/:id', serverRequire('./src/utils/authorizeFlowAccess.ts').authorizePrediction, (_req, res) =>
                res.json({ admitted: true })
            )
            http.use((req, _res, next) => {
                req.user = { id: 'fixture', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-a', permissions: [], features: {} }
                next()
            })
            http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const retained = await request(http)
                .post('/api/v1/prediction/' + ids[1])
                .set('Authorization', 'Bearer fixture-assistant-old')
            assert.equal(retained.status, 200)
            for (const [index, id] of ids.entries()) {
                const response = await request(http)
                    .put('/api/v1/chatflows/' + id)
                    .set('x-request-from', 'internal')
                    .send({ apikeyid: 'replacement', apiAccessMode: 'private' })
                console.log(
                    'round11 binding:',
                    mode,
                    index === 0 ? 'first assistant' : index === 1 ? 'replace assistant' : 'CHATFLOW control',
                    response.status
                )
                assert.equal(response.status, index === 2 ? 200 : 403, response.body.message)
            }
            assert.equal(
                (
                    await request(http)
                        .post('/api/v1/prediction/' + ids[1])
                        .set('Authorization', 'Bearer fixture-assistant-old')
                ).status,
                200
            )
            assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: ids[2] })).apikeyid, 'replacement')
        } finally {
            process.env.INBOUND_ACCESS_V2 = 'on'
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })

for (const kind of [
    'missing top grant',
    'draft type RBAC',
    'has-changed RBAC',
    'Harness rename',
    'foreign run',
    'foreign result',
    'foreign chat sync',
    'foreign chat async',
    'diagnostics',
    'dashboard off',
    'foreign receipt',
    'expired receipt',
    'foreign file chat',
    'feedback parent mismatch',
    'public adapter',
    'draft granted read',
    'authorized controller 403',
    'own run',
    'own result',
    'run list',
    'streaming capability',
    'upload capability',
    'lead read',
    'message read',
    'policy replaced after preparation',
    'route RBAC removed after preparation',
    'legacy key management'
])
    test('round11 complete authorization before quota: ' + kind, async () => {
        const data = await database()
        const store = await esm('store.mjs'),
            history = await esm('history.mjs')
        const dashflows = serverRequire('./src/services/dashflows/index.ts'),
            oldRuntime = dashflows.runtime
        const drafts = serverRequire('./src/services/flow-drafts/index.ts').default,
            oldDraftStatus = drafts.getDraftStatus
        const F = '77777777-7777-4777-8777-777777777771',
            G = '77777777-7777-4777-8777-777777777772',
            H = '77777777-7777-4777-8777-777777777773'
        const name = 'quota-boundary'
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        try {
            await workspaceFixture(data)
            for (const id of [F, G, H])
                await data.getRepository(ChatFlow).save({
                    id,
                    name: id === H ? name : 'Quota control',
                    workspaceId: 'team-a',
                    type: id === H ? 'HARNESS' : kind === 'draft type RBAC' && id === F ? 'ASSISTANT' : 'CHATFLOW',
                    apiAccessMode: kind === 'public adapter' && id === F ? 'public' : 'private',
                    flowData: '{"nodes":[],"edges":[]}'
                })
            if (kind === 'streaming capability')
                await data.getRepository(ChatFlow).update({ id: F }, { chatbotConfig: '{"postProcessing":{"enabled":true}}' })
            store.saveHarness(
                {
                    name,
                    chatflowId: H,
                    workspaceId: 'team-a',
                    chief: { model: { nodeName: 'fixture' } },
                    specialists: [{ name: 'writer', instructions: 'Fixture' }]
                },
                { overwrite: true }
            )
            const foreign = history.beginHarnessRun({
                name,
                chatId: 'foreign-chat',
                source: 'api',
                input: 'Fixture',
                apiKeyId: 'another-key'
            })
            const key = await data.getRepository(ApiKey).save({
                id: 'boundary-' + kind,
                keyName: kind,
                apiKey: '',
                apiSecret: '',
                workspaceId: 'team-a',
                harnesses: [],
                permissions: kind.includes('RBAC') ? ['chatflows:view'] : ['chatflows:view', 'chatflows:update', 'chatflows:delete'],
                accessPolicy: parsePolicy({
                    scopes: [
                        'api:read',
                        'api:write',
                        'harness:read',
                        'harness:run',
                        'feedback:read',
                        'feedback:write',
                        'dashflow:read',
                        'dashflow:report',
                        'upload',
                        'predict'
                    ],
                    rpm: 1,
                    daily: 1
                })
            })
            if (kind === 'policy replaced after preparation' || kind === 'legacy key management') {
                key.accessPolicy.legacy = true
                await data.getRepository(ApiKey).save(key)
            }
            const own = history.beginHarnessRun({ name, chatId: 'owned-chat', source: 'api', input: 'Fixture', apiKeyId: key.id })
            for (const [resourceType, resourceId] of [
                ['CHATFLOW', G],
                ['CHATFLOW', F],
                ['HARNESS', H],
                ['DASHFLOW', 'quota-dashboard']
            ]) {
                if (['missing top grant', 'policy replaced after preparation'].includes(kind) && resourceId === F) continue
                await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType, resourceId })
            }
            const { secret } = await data.transaction((manager) =>
                serverRequire('./src/services/accessKeys/credentials.ts').mintCredential(manager, key)
            )
            process.env.CUTTLELY_DASH_FLOWS = kind === 'dashboard off' || kind.includes('after preparation') ? 'false' : 'true'
            dashflows.runtime = async () => ({
                DashFlowError: class extends Error {},
                dashStore: () => ({ published: () => ({ revision: 1, definition: { harness: name }, snapshot: { cards: [] } }) })
            })
            if (kind.includes('receipt'))
                await data.getRepository(entities.ApiKeyReport).save({
                    runId: foreign.id,
                    dashboardId: 'quota-dashboard',
                    principalId: kind === 'foreign receipt' ? 'another-key' : key.id,
                    createdAt: new Date(Date.now() - (kind === 'expired receipt' ? 8 * 86400000 : 0))
                })
            if (kind === 'draft granted read')
                await data.getRepository(FlowVersionState).save({
                    chatflowId: F,
                    workspaceId: 'team-a',
                    draftFlowData: JSON.stringify({ nodes: [{ data: { inputs: { harnessName: name } } }], edges: [] })
                })
            if (kind === 'feedback parent mismatch')
                await data.getRepository(entities.ChatMessage).save({
                    id: 'quota-message',
                    chatflowid: F,
                    chatId: 'quota-chat',
                    role: 'apiMessage',
                    chatType: 'EXTERNAL',
                    content: 'Fixture'
                })
            if (kind === 'authorized controller 403')
                drafts.getDraftStatus = async () => {
                    throw new (serverRequire('./src/errors/appError').AppError)(403, 'Fixture application failure after authorization')
                }
            const express = serverRequire('express'),
                request = serverRequire('supertest'),
                http = express()
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use(express.json())
            http.use('/api/v1', serverRequire('./src/services/accessKeys/routes.ts').accessKeyRouteGuard)
            if (kind.includes('after preparation')) {
                setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
                const management = express()
                management.use(express.json())
                management.use((req, _res, next) => {
                    req.user = {
                        id: 'fixture',
                        activeWorkspaceId: 'team-a',
                        permissions: ['chatflows:view', 'chatflows:update', 'chatflows:delete'],
                        isOrganizationAdmin: true
                    }
                    next()
                })
                management.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
                management.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
                let edited = false
                http.use(async (_req, _res, next) => {
                    try {
                        if (!edited) {
                            edited = true
                            const changed = await request(management)
                                .put('/api/v1/apikey/' + key.id)
                                .send({
                                    keyName: kind,
                                    permissions: ['chatflows:view'],
                                    accessPolicy: { scopes: ['api:read'], rpm: 1, daily: 1 },
                                    expiresAt: null,
                                    resources: (kind === 'policy replaced after preparation' ? [G] : [F, G]).map((resourceId) => ({
                                        resourceType: 'CHATFLOW',
                                        resourceId
                                    }))
                                })
                            assert.equal(changed.status, 200, changed.body.message)
                        }
                        next()
                    } catch (error) {
                        next(error)
                    }
                })
            }
            for (const [prefix, route] of [
                ['chatflows', 'chatflows'],
                ['flow-drafts', 'flow-drafts'],
                ['harnesses', 'harnesses'],
                ['dashflows', 'dashflows'],
                ['get-upload-file', 'get-upload-file'],
                ['feedback', 'feedback'],
                ['orchestrate', 'orchestrate'],
                ['chatmessage', 'chat-messages'],
                ['leads', 'leads'],
                ['chatflows-streaming', 'chatflows-streaming'],
                ['chatflows-uploads', 'chatflows-uploads'],
                ['apikey', 'apikey']
            ])
                http.use('/api/v1/' + prefix, serverRequire('./src/routes/' + route + '/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            let method = 'get',
                target = '/chatflows/' + F,
                body
            let expected = 403
            if (kind === 'draft type RBAC' || kind === 'draft granted read' || kind === 'authorized controller 403')
                target = '/flow-drafts/' + F
            if (kind === 'has-changed RBAC') target = '/chatflows/has-changed/' + F + '/1'
            if (kind === 'route RBAC removed after preparation') target = '/chatflows/has-changed/' + F + '/1'
            if (kind === 'Harness rename') {
                method = 'put'
                target = '/chatflows/' + H
                body = { name: 'Key rename' }
            }
            if (kind === 'foreign run' || kind === 'foreign result') {
                target = '/harnesses/' + name + '/runs/' + foreign.id + (kind === 'foreign result' ? '/result' : '')
                expected = 404
            }
            if (kind.startsWith('foreign chat')) {
                method = 'post'
                target = '/harnesses/' + name + '/runs' + (kind.endsWith('async') ? '/async' : '')
                body = { question: 'Fixture', chatId: 'foreign-chat' }
            }
            if (kind === 'diagnostics') target = '/harnesses/' + name + '/runs/' + foreign.id + '/diagnostics'
            if (kind === 'dashboard off') target = '/dashflows/quota-dashboard/published'
            if (kind.includes('receipt')) {
                target = '/dashflows/quota-dashboard/reports/' + foreign.id
                expected = 404
            }
            if (kind === 'foreign file chat') target = '/get-upload-file?chatflowId=' + F + '&chatId=foreign-chat&fileName=fixture.png'
            if (kind === 'feedback parent mismatch') {
                method = 'post'
                target = '/feedback'
                body = { messageId: 'quota-message', chatflowid: G }
                expected = 400
            }
            if (kind === 'public adapter') {
                method = 'post'
                target = '/orchestrate/' + F
                body = { messages: [{ role: 'user', content: 'Fixture' }] }
            }
            if (kind === 'legacy key management') target = '/apikey/options'
            if (kind === 'draft granted read') expected = 200
            if (kind === 'own run' || kind === 'own result') {
                target = '/harnesses/' + name + '/runs/' + own.id + (kind === 'own result' ? '/result' : '')
                expected = 200
            }
            if (kind === 'run list') {
                target = '/harnesses/' + name + '/runs'
                expected = 200
            }
            for (const [label, prefix] of [
                ['streaming capability', 'chatflows-streaming'],
                ['upload capability', 'chatflows-uploads'],
                ['lead read', 'leads'],
                ['message read', 'chatmessage']
            ])
                if (kind === label) {
                    target = '/' + prefix + '/' + F
                    expected = 200
                }
            const response = await request(http)
                [method]('/api/v1' + target)
                .set('Authorization', 'Bearer ' + secret)
                .send(body)
            const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
            const control = await request(http)
                .get('/api/v1/chatflows/' + G)
                .set('Authorization', 'Bearer ' + secret)
            const admitted = expected === 200 || kind === 'authorized controller 403'
            console.log(
                'round11 boundary:',
                kind,
                JSON.stringify({
                    status: response.status,
                    quota: usage.map(({ operation, accepted }) => ({ operation, accepted })),
                    next: control.status
                })
            )
            assert.equal(response.status, expected, response.body.message || response.body.error?.message)
            if (!admitted) {
                assert.deepEqual(usage, [])
                assert.equal(response.headers['x-ratelimit-day-remaining'], undefined)
            } else assert.ok(usage.every((row) => row.accepted === 1) && usage.length === 4)
            assert.equal(control.status, admitted ? 429 : 200, control.body.message)
            if (kind === 'foreign chat async')
                assert.equal(
                    serverRequire('./src/settings/runs.ts').runsInProgress(),
                    0,
                    'denied async admission releases lifecycle tracking'
                )
        } finally {
            drafts.getDraftStatus = oldDraftStatus
            dashflows.runtime = oldRuntime
            process.env.CUTTLELY_DASH_FLOWS = 'false'
            setTeamPermissionLookup(null)
            store.deleteHarness(name)
            await data.destroy()
        }
    })

test('round11 modern expiry management lifecycle preserves irreversible credential cutoff', async () => {
    const data = await database()
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
        await workspaceFixture(data)
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
        const id = '99999999-9999-4999-8999-999999999999'
        await data
            .getRepository(ChatFlow)
            .save({ id, name: 'Expiry', type: 'CHATFLOW', workspaceId: 'team-a', flowData: '{"nodes":[],"edges":[]}' })
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
        http.use(express.json())
        http.use((req, _res, next) => {
            if (!req.headers.authorization)
                req.user = { id: 'fixture', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'], features: {} }
            next()
        })
        http.use('/api/v1', serverRequire('./src/services/accessKeys/routes.ts').accessKeyRouteGuard)
        http.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
        http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const body = {
            keyName: 'Expiry',
            permissions: ['chatflows:view'],
            accessPolicy: { scopes: ['api:read'], rpm: 0 },
            resources: [{ resourceType: 'CHATFLOW', resourceId: id }],
            expiresAt: null
        }
        const read = (secret) =>
            request(http)
                .get('/api/v1/chatflows/' + id)
                .set('Authorization', 'Bearer ' + secret)
        const results = []
        for (const extendBefore of [false, true]) {
            const start = now
            const created = await request(http).post('/api/v1/apikey').send(body)
            assert.equal(created.status, 200, created.body.message)
            const key = created.body.find((row) => row.apiKey)
            assert.ok(key)
            assert.equal((await read(key.apiKey)).status, 200)
            const edit = (expiry) =>
                request(http)
                    .put('/api/v1/apikey/' + key.id)
                    .send({ ...body, expiresAt: new Date(expiry).toISOString() })
            assert.equal((await edit(start + 60000)).status, 200)
            now = start + (extendBefore ? 30000 : 60001)
            if (!extendBefore) assert.equal((await read(key.apiKey)).status, 401, 'principal lapse is refused')
            assert.equal((await edit(start + 3600000)).status, 200)
            now = start + 60001
            const retried = await read(key.apiKey)
            const rotated = await request(http)
                .post('/api/v1/apikey/' + key.id + '/rotate')
                .send({ graceSeconds: 0 })
            assert.equal(rotated.status, 200, rotated.body.message)
            assert.equal((await read(rotated.body.apiKey)).status, 200)
            assert.equal((await read(key.apiKey)).status, 401)
            results.push({ extendBefore, oldBearerAfterCutoff: retried.status })
            now = start + 120000
        }
        console.log('round11 modern expiry:', JSON.stringify(results))
        for (const control of ['own expiry', 'revoked', 'legacy']) {
            const start = now
            let key, secret
            if (control === 'legacy') {
                const { generateSecretHash, storedApiKeyLookup } = serverRequire('./src/utils/apiKey.ts')
                secret = 'fixture-round11-legacy-expiry'
                key = await data.getRepository(ApiKey).save({
                    id: 'expiry-legacy',
                    apiKey: storedApiKeyLookup(secret),
                    apiSecret: generateSecretHash(secret),
                    keyName: 'Legacy expiry',
                    workspaceId: 'team-a',
                    permissions: ['chatflows:view'],
                    harnesses: [],
                    accessPolicy: { ...parsePolicy(body.accessPolicy), legacy: true }
                })
            } else {
                const created = await request(http)
                    .post('/api/v1/apikey')
                    .send({ ...body, expiresAt: control === 'own expiry' ? new Date(start + 60000).toISOString() : null })
                assert.equal(created.status, 200)
                key = created.body.find((row) => row.apiKey)
                secret = key.apiKey
            }
            assert.equal((await read(secret)).status, 200)
            if (control === 'revoked')
                assert.equal(
                    (
                        await request(http)
                            .post('/api/v1/apikey/' + key.id + '/credentials/' + key.credentials[0].id + '/revoke')
                            .send({})
                    ).status,
                    200
                )
            if (control === 'legacy') {
                assert.equal(
                    (
                        await request(http)
                            .put('/api/v1/apikey/' + key.id)
                            .send({ ...body, expiresAt: new Date(start + 60000).toISOString() })
                    ).status,
                    200
                )
                now = start + 60001
                assert.equal((await read(secret)).status, 401)
            }
            assert.equal(
                (
                    await request(http)
                        .put('/api/v1/apikey/' + key.id)
                        .send({ ...body, expiresAt: new Date(start + 3600000).toISOString() })
                ).status,
                200
            )
            now = start + 60001
            const denied = await read(secret)
            console.log('round11 expiry control:', control, denied.status)
            assert.equal(denied.status, 401)
            now = start + 120000
        }
        assert.deepEqual(
            results.map((row) => row.oldBearerAfterCutoff),
            [401, 401],
            'principal extensions cannot extend an already-issued credential'
        )
    } finally {
        Date.now = originalNow
        setTeamPermissionLookup(null)
        await data.destroy()
    }
})

async function workspaceFixture(data) {
    const { User, Workspace, Organization } = entities
    await data.getRepository(User).save({
        id: 'fixture',
        name: 'Fixture',
        email: 'scope@example.invalid',
        status: 'active',
        createdBy: 'fixture',
        updatedBy: 'fixture'
    })
    await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
    await data.getRepository(Workspace).save({
        id: 'team-a',
        organizationId: 'org-a',
        name: 'Fixture',
        createdBy: 'fixture',
        updatedBy: 'fixture'
    })
}

async function round12Fixture(data) {
    await workspaceFixture(data)
    const actorPermissions = ['apikeys:view', 'apikeys:create', 'apikeys:update', 'apikeys:delete', 'chatflows:view', 'chatflows:delete']
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: actorPermissions }) })
    const express = serverRequire('express'),
        request = serverRequire('supertest'),
        http = express()
    http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
    http.use(express.json())
    http.use((req, _res, next) => {
        if (!req.headers.authorization)
            req.user = {
                id: 'fixture',
                activeWorkspaceId: 'team-a',
                activeOrganizationId: 'org-a',
                permissions: actorPermissions,
                features: {}
            }
        next()
    })
    http.use('/api/v1', serverRequire('./src/services/accessKeys/routes.ts').accessKeyRouteGuard)
    http.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
    http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
    http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
    for (const [id, name, workspaceId] of [
        ['12121212-1212-4121-8121-121212121201', 'Chatflow A', 'team-a'],
        ['12121212-1212-4121-8121-121212121202', 'Chatflow B', 'team-a'],
        ['12121212-1212-4121-8121-121212121203', 'Other workspace', 'team-b']
    ])
        await data
            .getRepository(ChatFlow)
            .save({ id, name, workspaceId, type: 'CHATFLOW', apiAccessMode: 'private', flowData: '{"nodes":[],"edges":[]}' })
    const body = {
        keyName: 'round12-deleted',
        permissions: ['chatflows:view'],
        accessPolicy: { scopes: ['api:read'], rpm: 0 },
        expiresAt: null,
        resources: ['12121212-1212-4121-8121-121212121201', '12121212-1212-4121-8121-121212121202'].map((resourceId) => ({
            resourceType: 'CHATFLOW',
            resourceId
        }))
    }
    const created = await request(http).post('/api/v1/apikey').send(body)
    assert.equal(created.status, 200, created.body.message)
    const key = created.body.find((row) => row.apiKey)
    assert.ok(key)
    const read = (id) =>
        request(http)
            .get('/api/v1/chatflows/' + id)
            .set('Authorization', 'Bearer ' + key.apiKey)
    const edit = (resources) =>
        request(http)
            .put('/api/v1/apikey/' + key.id)
            .send({ ...body, resources })
    return { http, request, key, read, edit, body }
}

test('round12 real delete and management routes with APIKeyDialog and AccessPolicyEditor submissions', async () => {
    const data = await database()
    let listener
    try {
        const { http, request, body } = await round12Fixture(data)
        const created = await request(http)
            .post('/api/v1/apikey')
            .send({ ...body, keyName: 'round12-retained', resources: body.resources.slice(1) })
        assert.equal(created.status, 200)
        const retained = created.body.find((row) => row.apiKey)
        // Existing-data control: an orphan left by a deletion before this fix.
        await data
            .getRepository(ApiKeyResource)
            .save({ principalId: retained.id, resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121204' })
        listener = await new Promise((resolve) => {
            const server = http.listen(0, '127.0.0.1', () => resolve(server))
        })
        const uiRequire = createRequire(path.join(__dirname, '../packages/ui/package.json'))
        const { spawn } = require('node:child_process')
        const child = spawn(
            process.execPath,
            [uiRequire.resolve('jest/bin/jest'), '--runInBand', '--testMatch', '**/APIKeyDialog.production.fixture.js'],
            {
                cwd: path.join(__dirname, '../packages/ui'),
                env: { ...process.env, CUTTLELY_ACCESS_UI_URL: 'http://127.0.0.1:' + listener.address().port },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        child.stdout.pipe(process.stdout)
        child.stderr.pipe(process.stderr)
        const code = await new Promise((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', resolve)
        })
        assert.equal(code, 0, 'actual policy dialog must save B while permitting explicit removal of unavailable A')
    } finally {
        if (listener) await new Promise((resolve) => listener.close(resolve))
        serverRequire('./src/identity/rbac.ts').setTeamPermissionLookup(null)
        await data.destroy()
    }
})

test('round12 deletion and removal cannot revive grants; workspace and ordinary lifecycle controls', async () => {
    const data = await database()
    try {
        const { http, request, key, read, edit, body } = await round12Fixture(data)
        assert.equal((await read('12121212-1212-4121-8121-121212121201')).status, 200)
        assert.equal((await read('12121212-1212-4121-8121-121212121202')).status, 200)
        const foreignKey = await data.getRepository(ApiKey).save({
            id: 'round12-foreign-key',
            workspaceId: 'team-b',
            keyName: 'Foreign',
            apiKey: '',
            apiSecret: '',
            permissions: [],
            harnesses: [],
            accessPolicy: parsePolicy({ scopes: ['api:read'] })
        })
        const foreignGrant = { principalId: foreignKey.id, resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121201' }
        await data.getRepository(ApiKeyResource).save(foreignGrant)
        assert.equal((await request(http).delete('/api/v1/chatflows/12121212-1212-4121-8121-121212121201')).status, 200)
        assert.equal((await read('12121212-1212-4121-8121-121212121201')).status, 404)
        assert.equal((await read('12121212-1212-4121-8121-121212121202')).status, 200)
        await data.getRepository(ChatFlow).save({
            id: '12121212-1212-4121-8121-121212121201',
            name: 'Foreign same ID',
            workspaceId: 'team-b',
            type: 'CHATFLOW',
            apiAccessMode: 'private',
            flowData: '{}'
        })
        assert.equal(
            (await read('12121212-1212-4121-8121-121212121201')).status,
            404,
            'same ID in another workspace is concealed and never authorized'
        )
        assert.ok(await data.getRepository(ApiKeyResource).findOneBy(foreignGrant), 'deletion cannot alter another workspace principal')
        await data.getRepository(ChatFlow).update({ id: '12121212-1212-4121-8121-121212121201' }, { workspaceId: 'team-a' })
        assert.equal(
            (await read('12121212-1212-4121-8121-121212121201')).status,
            403,
            'recreation with the same ID cannot revive a deleted grant before any policy edit'
        )
        await data.getRepository(ChatFlow).save({
            id: '12121212-1212-4121-8121-121212121205',
            name: 'New A',
            workspaceId: 'team-a',
            type: 'CHATFLOW',
            apiAccessMode: 'private',
            flowData: '{}'
        })
        assert.equal((await read('12121212-1212-4121-8121-121212121205')).status, 403, 'a replacement ID is not a grant')
        const onlyB = body.resources.slice(1)
        assert.equal((await edit(onlyB)).status, 200)
        const denied = await edit([...onlyB, { resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121203' }])
        assert.equal(denied.status, 403, 'unavailable new resources remain rejected')
        assert.equal((await read('12121212-1212-4121-8121-121212121202')).status, 200)
        assert.equal(
            (await edit([...onlyB, { resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121205' }])).status,
            200,
            'explicit authorized new grant works'
        )
        assert.equal((await read('12121212-1212-4121-8121-121212121205')).status, 200)
        assert.equal((await edit(onlyB)).status, 200)
        assert.equal((await read('12121212-1212-4121-8121-121212121205')).status, 403, 'explicit removal revokes A')
        await data.getRepository(ChatFlow).delete({ id: '12121212-1212-4121-8121-121212121205' })
        await data.getRepository(ChatFlow).save({
            id: '12121212-1212-4121-8121-121212121205',
            name: 'Recreated A',
            workspaceId: 'team-a',
            type: 'CHATFLOW',
            apiAccessMode: 'private',
            flowData: '{}'
        })
        assert.equal(
            (await read('12121212-1212-4121-8121-121212121205')).status,
            403,
            'recreation cannot revive an explicitly removed grant'
        )
        assert.equal((await edit(body.resources)).status, 200, 'explicit reauthorization of a recreated resource still works')
        assert.equal((await read('12121212-1212-4121-8121-121212121201')).status, 200)
        assert.equal((await request(http).delete('/api/v1/apikey/' + key.id)).status, 200)
        assert.equal((await read('12121212-1212-4121-8121-121212121201')).status, 401)
        assert.equal((await read('12121212-1212-4121-8121-121212121202')).status, 401)
        console.log(
            'round12 controls: deleted/recreated/revoked A denied, B preserved, foreign/new unauthorized grants refused, explicit grant lifecycle unchanged'
        )
    } finally {
        serverRequire('./src/identity/rbac.ts').setTeamPermissionLookup(null)
        await data.destroy()
    }
})

test('round12 a failed grant cleanup rolls back the real delete route with B untouched', async () => {
    const data = await database()
    try {
        const { http, request, read } = await round12Fixture(data)
        const grants = await data.getRepository(ApiKeyResource).find()
        await data.query(`CREATE TRIGGER refuse_flow_grant_delete BEFORE DELETE ON apikey_resource
            BEGIN SELECT RAISE(ABORT, 'fixture grant cleanup failure'); END`)
        const deleted = await request(http).delete('/api/v1/chatflows/12121212-1212-4121-8121-121212121201')
        assert.equal(deleted.status, 500)
        assert.ok(await data.getRepository(ChatFlow).findOneBy({ id: '12121212-1212-4121-8121-121212121201' }))
        assert.deepEqual(await data.getRepository(ApiKeyResource).find(), grants)
        assert.equal((await read('12121212-1212-4121-8121-121212121201')).status, 200)
        assert.equal((await read('12121212-1212-4121-8121-121212121202')).status, 200)
    } finally {
        serverRequire('./src/identity/rbac.ts').setTeamPermissionLookup(null)
        await data.destroy()
    }
})

for (const scopes of [['api:read'], ['api:read', 'harness:read', 'harness:run']]) {
    test('Harness api:read production routes retain granted canvas access: ' + scopes.join(','), async () => {
        const data = await database()
        const store = await esm('store.mjs')
        const versions = serverRequire('./src/services/flow-versions/index.ts')
        const id = '44444444-4444-4444-8444-444444444444'
        const name = 'read-canvas'
        try {
            await workspaceFixture(data)
            const flow = await data.getRepository(ChatFlow).save({
                id,
                name,
                workspaceId: 'team-a',
                type: 'HARNESS',
                flowData: '{"nodes":[],"edges":[]}'
            })
            await data.getRepository(FlowVersionState).save({ chatflowId: id, workspaceId: 'team-a', draftFlowData: flow.flowData })
            process.env.CUTTLELY_VERSIONS = 'on'
            process.env.CUTTLELY_VERSIONS_DIR = path.join(root, 'read-versions-' + scopes.length)
            versions.resetForTests()
            const sha = await versions.recordFlowVersion(flow)
            assert.ok(sha, 'fixture records a real version')
            store.saveHarness(
                {
                    name,
                    chatflowId: id,
                    workspaceId: 'team-a',
                    chief: { model: { nodeName: 'fixture' } },
                    specialists: [{ name: 'writer', instructions: 'Fixture' }]
                },
                { overwrite: true }
            )
            const key = await data.getRepository(ApiKey).save({
                id: 'read-key',
                apiKey: '',
                apiSecret: '',
                keyName: 'Read',
                workspaceId: 'team-a',
                permissions: ['chatflows:view'],
                accessPolicy: parsePolicy({ scopes, rpm: 0 }),
                harnesses: []
            })
            const grant = { principalId: key.id, resourceType: 'HARNESS', resourceId: id }
            await data.getRepository(ApiKeyResource).save(grant)
            const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
            const { secret } = await data.transaction((manager) => mintCredential(manager, key))
            const express = serverRequire('express'),
                request = serverRequire('supertest'),
                http = express()
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use(express.json())
            http.use('/api/v1', serverRequire('./src/services/accessKeys/routes.ts').accessKeyRouteGuard)
            for (const route of ['chatflows', 'flow-drafts', 'flow-versions'])
                http.use('/api/v1/' + route, serverRequire('./src/routes/' + route + '/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const paths = [
                'chatflows/' + id,
                'flow-drafts/' + id,
                'flow-versions/' + id,
                'flow-versions/' + id + '/' + sha,
                'flow-versions/' + id + '/' + sha + '/diff?against=current'
            ]
            const read = (route) =>
                request(http)
                    .get('/api/v1/' + route)
                    .set('Authorization', 'Bearer ' + secret)
            const results = []
            for (const route of paths) {
                const response = await read(route)
                console.log(
                    'Harness read scope evidence:',
                    scopes.join(','),
                    route,
                    response.status,
                    'quota rows',
                    JSON.stringify(await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id }))
                )
                results.push({ route, status: response.status, message: response.body.message })
                if (response.status === 200 && route.startsWith('flow-drafts/')) assert.ok(response.body.draft)
                if (response.status === 200 && route === 'flow-versions/' + id) assert.equal(response.body.versions.length, 1)
                if (response.status === 200 && route === 'flow-versions/' + id + '/' + sha)
                    assert.equal(response.body.flowData, flow.flowData)
            }
            assert.deepEqual(
                results.map(({ route, status }) => ({ route, status })),
                paths.map((route) => ({ route, status: 200 })),
                JSON.stringify(results)
            )
            const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id })
            assert.ok(usage.some((row) => row.operation === 'api:read' && row.accepted === paths.length))
            await data.getRepository(ApiKeyResource).delete(grant)
            for (const route of paths) assert.equal((await read(route)).status, 403)
            assert.deepEqual(await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id }), usage)
            // Read authority never implies draft writes/publication. Explicit harness:run adds execution.
            await data.getRepository(ApiKeyResource).save(grant)
            for (const [method, route] of [
                ['put', 'flow-drafts/' + id],
                ['post', 'flow-drafts/' + id + '/publish'],
                ...(!scopes.includes('harness:run') ? [['post', 'harnesses/' + name + '/runs']] : [])
            ]) {
                const response = await request(http)
                    [method]('/api/v1/' + route)
                    .set('Authorization', 'Bearer ' + secret)
                    .send({})
                assert.equal(response.status, 403)
            }
            assert.deepEqual(await data.getRepository(ApiKeyUsage).findBy({ principalId: key.id }), usage)
        } finally {
            process.env.CUTTLELY_VERSIONS = 'false'
            delete process.env.CUTTLELY_VERSIONS_DIR
            versions.resetForTests()
            store.deleteHarness(name)
            await data.destroy()
        }
    })
}

test('custom assistant unsupported scope: real migration, prediction and management routes', async () => {
    const data = await database(true)
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    const id = '55555555-5555-4555-8555-555555555555'
    try {
        await workspaceFixture(data)
        const { generateSecretHash, storedApiKeyLookup } = serverRequire('./src/utils/apiKey.ts')
        const secret = 'fixture-custom-assistant-legacy'
        await data.query(
            'INSERT INTO apikey (id, apiKey, apiSecret, keyName, workspaceId, permissions, harnesses) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['assistant-key', storedApiKeyLookup(secret), generateSecretHash(secret), 'Assistant', 'team-a', '[]', '[]']
        )
        await data.query('INSERT INTO chat_flow (id, name, type, workspaceId, apikeyid, flowData) VALUES (?, ?, ?, ?, ?, ?)', [
            id,
            'Assistant',
            'ASSISTANT',
            'team-a',
            'assistant-key',
            '{"nodes":[],"edges":[]}'
        ])
        await data.transaction((manager) => serverRequire('./src/database/migrations/AccessKeys.ts').addAccessKeys(manager.queryRunner))
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
        http.use(express.json())
        http.post('/api/v1/prediction/:id', serverRequire('./src/utils/authorizeFlowAccess.ts').authorizePrediction, (_req, res) =>
            res.json({ admitted: true })
        )
        http.use((req, _res, next) => {
            req.user = { id: 'fixture', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-a', permissions: [], features: {} }
            next()
        })
        http.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
        http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        process.env.INBOUND_ACCESS_V2 = 'off'
        assert.equal(
            (
                await request(http)
                    .post('/api/v1/prediction/' + id)
                    .set('Authorization', 'Bearer ' + secret)
            ).status,
            200
        )
        process.env.INBOUND_ACCESS_V2 = 'on'
        const predicted = await request(http)
            .post('/api/v1/prediction/' + id)
            .set('Authorization', 'Bearer ' + secret)
        assert.equal(predicted.status, 401)
        assert.equal(await data.getRepository(ApiKeyResource).count(), 0)
        assert.equal(await data.getRepository(ApiKeyUsage).count(), 0)
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
        // A new private custom assistant has the same resource-choice limitation as the migrated one.
        const created = await request(http).post('/api/v1/chatflows').send({
            name: 'New assistant',
            type: 'ASSISTANT',
            apiAccessMode: 'private',
            flowData: '{"nodes":[],"edges":[]}'
        })
        assert.equal(created.status, 200, created.body.message)
        const fresh = await data.getRepository(ChatFlow).findOneByOrFail({ id: created.body.id })
        assert.equal(fresh.type, 'ASSISTANT')
        assert.equal(fresh.apiAccessMode, 'private')
        const options = await request(http).get('/api/v1/apikey/options')
        assert.equal(options.status, 200)
        assert.equal(
            options.body.resources.some((r) => [id, fresh.id].includes(r.resourceId)),
            false
        )
        const granted = await request(http)
            .post('/api/v1/apikey')
            .send({
                keyName: 'Assistant replacement',
                permissions: ['chatflows:view'],
                accessPolicy: { scopes: ['predict'] },
                resources: [{ resourceType: 'CHATFLOW', resourceId: fresh.id }],
                expiresAt: null
            })
        assert.equal(granted.status, 403)
        console.log(
            'Custom assistant scope evidence: legacy off=200, enforced=' +
                predicted.status +
                ', options omit ASSISTANT, exact management grant=' +
                granted.status
        )
    } finally {
        process.env.INBOUND_ACCESS_V2 = 'on'
        setTeamPermissionLookup(null)
        await data.destroy()
    }
})

for (const entry of [
    'account report',
    'sync',
    'stream',
    'async',
    'prediction card',
    'prediction tool',
    'missing startRun pin',
    'missing background pin',
    'missing runtime pin',
    'missing enqueue pin'
])
    for (const stage of entry.startsWith('missing')
        ? ['missing pin']
        : [
              'unchanged',
              'unchanged queued',
              'after caller',
              'before dispatch',
              'after enqueue',
              'lost queue pin',
              'worker context replacement'
          ]) {
        test(entry + ' Guard → handler → runtime/worker retains authorized canvas: ' + stage, async () => {
            const data = await database()
            const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
            const harnesses = serverRequire('./src/services/harnesses/index.ts')
            const report = serverRequire('./src/services/accessKeys/dashflowReports.ts')
            const dashflows = serverRequire('./src/services/dashflows/index.ts')
            const oldRuntime = dashflows.runtime
            const store = await esm('store.mjs')
            const engine = await esm('run.mjs')
            const queue = await esm('queue.mjs')
            const history = await esm('history.mjs')
            const gateway = await esm('gateway.mjs')
            const fixture = require('./fixtures/access-key-report-node.cjs')
            const before = fixture.executions.length
            const A = '11111111-1111-4111-8111-111111111111'
            const B = '22222222-2222-4222-8222-222222222222'
            const name = entry.replaceAll(' ', '-') + '-' + stage.replaceAll(' ', '-')
            const backgroundEntry = ['account report', 'async'].includes(entry)
            const queued = ['after enqueue', 'unchanged queued', 'lost queue pin', 'worker context replacement'].includes(stage)
            const unchanged = stage.startsWith('unchanged')
            const accountId = '001000000000000000'
            const ready = latch(),
                resume = latch(),
                settled = latch(),
                background = latch()
            const runs = serverRequire('./src/settings/runs.ts')
            const originalTrack = runs.trackBackgroundRun
            runs.trackBackgroundRun = (promise) => originalTrack(promise).finally(() => background.release())
            let entered = false
            const replace = async () => {
                entered = true
                ready.release()
                await resume.reached
                store.deleteHarness(name)
                store.saveHarness(roster(B))
            }
            const roster = (id) => ({
                name,
                chatflowId: id,
                workspaceId: 'team-a',
                chief: { model: { nodeName: 'reportModel' } },
                specialists: [
                    {
                        name: 'writer',
                        instructions: 'Write report.',
                        modules: [{ nodeName: 'reportRetriever', category: 'Retrievers', inputs: { marker: id } }]
                    }
                ]
            })
            try {
                const { User, Workspace, Organization } = entities
                await data.getRepository(User).save({
                    id: 'fixture',
                    name: 'Fixture',
                    email: 'fixture@example.invalid',
                    status: 'active',
                    createdBy: 'fixture',
                    updatedBy: 'fixture'
                })
                await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
                await data
                    .getRepository(Workspace)
                    .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
                for (const id of [A, B])
                    await data.getRepository(ChatFlow).save({ id, name, workspaceId: 'team-a', type: 'HARNESS', flowData: '{}' })
                const key = await data.getRepository(ApiKey).save({
                    id: 'report-key',
                    apiKey: '',
                    apiSecret: '',
                    keyName: 'Report',
                    workspaceId: 'team-a',
                    permissions: ['chatflows:view', 'chatflows:update'],
                    accessPolicy: parsePolicy({ scopes: ['dashflow:report', 'harness:run', 'predict', 'stream'], rpm: 0 }),
                    harnesses: []
                })
                for (const grant of [
                    { resourceType: 'HARNESS', resourceId: A },
                    { resourceType: 'DASHFLOW', resourceId: 'dashboard' },
                    { resourceType: 'CHATFLOW', resourceId: '33333333-3333-4333-8333-333333333333' }
                ])
                    await data.getRepository(ApiKeyResource).save({ principalId: key.id, ...grant })
                const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
                const { secret } = await data.transaction((manager) => mintCredential(manager, key))
                assert.equal((await serverRequire('./src/services/apikey/index.ts').default.getApiKey(secret)).id, key.id)
                setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: ['chatflows:view'] }) })
                const app = appModule.getRunningExpressApp()
                // The production contextFor loads these node classes, including in the worker.
                const { writeFileSync } = require('node:fs')
                const retrieverPath = path.join(root, 'retriever.cjs')
                writeFileSync(
                    retrieverPath,
                    `module.exports.nodeClass = require(${JSON.stringify(
                        path.join(__dirname, 'fixtures/access-key-report-node.cjs')
                    )}).ReportRetriever`
                )
                app.nodesPool.componentNodes.reportModel = { filePath: path.join(__dirname, 'fixtures/access-key-report-node.cjs') }
                app.nodesPool.componentNodes.reportRetriever = { filePath: retrieverPath }
                appModule.getRunningExpressApp = () => app
                // Boot the real gateway on a disposable listener before installing any rosters.
                const listener = await gateway.startGateway({ port: 0 })
                process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(listener.port)
                store.saveHarness(roster(A), { overwrite: true })
                const outerId = '33333333-3333-4333-8333-333333333333'
                await data.getRepository(ChatFlow).save({
                    id: outerId,
                    name: 'Caller',
                    workspaceId: 'team-a',
                    type: 'CHATFLOW',
                    apiAccessMode: 'private',
                    flowData: JSON.stringify({ nodes: [{ data: { inputs: { harnessName: name } } }] })
                })
                dashflows.runtime = async () => ({
                    DashFlowError: class DashFlowError extends Error {},
                    dashStore: () => ({
                        published: () => ({
                            definition: { harness: name },
                            revision: 1,
                            snapshot: { cards: [{ rows: [{ account_id: accountId }] }] }
                        })
                    })
                })
                if (stage === 'after caller' && entry === 'account report') report.reportAdmissionHooks.afterCaller = replace
                if (stage === 'before dispatch' && !entry.startsWith('prediction ')) harnesses.runAdmissionHooks.beforeDispatch = replace
                if (queued)
                    queue.queueHooks.afterEnqueue = async () => {
                        if (!unchanged && stage !== 'lost queue pin' && stage !== 'worker context replacement') await replace()
                        if (stage === 'lost queue pin') {
                            entered = true
                            ready.release()
                        }
                        // Claim before localRuns is installed: exercise the serialized payload, as an external worker does.
                        const job = queue.claimJob()
                        assert.ok(job)
                        assert.equal(job.payload.workspaceId, 'team-a')
                        assert.equal(job.payload.expectedHarnessChatflowId, A)
                        assert.equal(job.payload.caller.harnessIds[name], A)
                        if (stage === 'lost queue pin') delete job.payload.expectedHarnessChatflowId
                        queue.setWorkerContext(
                            stage === 'worker context replacement'
                                ? async (record) => {
                                      await replace()
                                      return harnesses.contextFor(record)
                                  }
                                : harnesses.contextFor
                        )
                        await queue.executeJob(job)
                    }
                process.env.CUTTLELY_HARNESS_QUEUE = queued ? 'external' : 'off'
                // Track the same background lifecycle the handler uses, with no polling sleeps.
                const express = serverRequire('express'),
                    request = serverRequire('supertest')
                const { accessKeyRouteGuard } = serverRequire('./src/services/accessKeys/routes.ts')
                const http = express()
                http.use(serverRequire('express').json())
                http.use('/api/v1', accessKeyRouteGuard)
                if (entry !== 'account report' && !entry.startsWith('prediction ') && stage === 'after caller')
                    http.use(async (_req, _res, next) => {
                        await replace()
                        next()
                    })
                const controller = serverRequire('./src/controllers/harnesses/index.ts').default
                http.post('/api/v1/dashflows/:id/accounts/:accountId/report', report.bearerDashboardReport)
                http.post(
                    '/api/v1/harnesses/:name/runs',
                    entry.startsWith('missing')
                        ? async (req, res, next) => {
                              try {
                                  const caller = await serverRequire('./src/services/harnesses/apiAccess.ts').harnessCallerFor(req)
                                  assert.equal(caller.harnessIds[name], A)
                                  entered = true
                                  ready.release()
                                  const opts = { workspaceId: 'team-a', caller }
                                  if (entry === 'missing startRun pin') await harnesses.default.startRun(name, req.body, opts)
                                  else if (entry === 'missing background pin')
                                      await harnesses.default.startBackgroundRun(name, req.body, opts)
                                  else {
                                      const args = {
                                          name,
                                          chatId: name + '-chat',
                                          input: 'Report',
                                          componentNodes: app.nodesPool.componentNodes,
                                          flowOptions: { workspaceId: 'team-a', harnessCaller: caller }
                                      }
                                      if (entry === 'missing enqueue pin') queue.enqueueHarnessJob(args)
                                      else await engine.runHarness(args)
                                  }
                                  res.json({ erroneouslyAdmitted: true })
                              } catch (error) {
                                  next(error)
                              }
                          }
                        : controller.createRun
                )
                http.post('/api/v1/harnesses/:name/runs/async', controller.startBackgroundRun)
                if (entry.startsWith('prediction ')) {
                    const { authorizePrediction } = serverRequire('./src/utils/authorizeFlowAccess.ts')
                    http.post('/api/v1/prediction/:id', authorizePrediction, async (req, res, next) => {
                        try {
                            const caller = await serverRequire('./src/utils/flowHarnessCaller.ts').flowHarnessCaller(
                                serverRequire('./src/services/accessKeys/authorization.ts').accessContext(req)?.key.id,
                                'team-a',
                                serverRequire('./src/services/accessKeys/authorization.ts').accessContext(req)?.harnessIds
                            )
                            if (['after caller', 'before dispatch'].includes(stage)) await replace()
                            const Harness = serverRequire('../components/nodes/harness/Harness/Harness.ts').nodeClass
                            const node = new Harness()
                            const nodeData = { id: 'harness-card', inputs: { harnessName: name } }
                            const nodeOptions = {
                                ...(await harnesses.contextFor({ chatflowId: outerId, workspaceId: 'team-a' })).flowOptions,
                                chatId: name + '-chat',
                                harnessCaller: caller,
                                componentNodes: app.nodesPool.componentNodes
                            }
                            const outcome =
                                entry === 'prediction tool'
                                    ? await (await node.init(nodeData, 'Report', nodeOptions)).invoke('Report')
                                    : await node.run(nodeData, 'Report', nodeOptions)
                            res.json(outcome)
                        } catch (error) {
                            next(error)
                        }
                    })
                }
                http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
                const pending = request(http)
                    .post(
                        entry.startsWith('prediction ')
                            ? `/api/v1/prediction/${outerId}`
                            : entry === 'account report'
                            ? `/api/v1/dashflows/dashboard/accounts/${accountId}/report`
                            : `/api/v1/harnesses/${name}/runs${entry === 'async' ? '/async' : ''}`
                    )
                    .set('Authorization', 'Bearer ' + secret)
                    .set('Accept', entry === 'stream' ? 'text/event-stream' : 'application/json')
                    .send({ question: 'Report' })
                    .then((response) => {
                        settled.release(response)
                        return response
                    })
                const arrived = unchanged ? true : await Promise.race([ready.reached.then(() => true), settled.reached.then(() => false)])
                if (!arrived) {
                    const early = await settled.reached
                    assert.equal(early.status, 202, early.body.message)
                    assert.equal(
                        await Promise.race([ready.reached.then(() => true), background.reached.then(() => false)]),
                        true,
                        'runtime must reach race seam'
                    )
                }
                resume.release()
                const response = await pending
                if (backgroundEntry) await background.reached
                if (unchanged)
                    assert.ok(
                        fixture.executions.slice(before).some((call) => call.marker === A),
                        'authorized A executes'
                    )
                else assert.ok(entered)
                assert.ok(
                    [200, 202, 403, 409].includes(response.status) ||
                        ((entry.startsWith('prediction ') || entry.startsWith('missing')) &&
                            response.status === 500 &&
                            /changed after authorization|requires its authorized canvas id/.test(response.body.message)),
                    response.body.message
                )
                if (response.status === 409) assert.match(response.body.message, /changed after authorization/)
                const calls = fixture.executions.slice(before)
                if (stage === 'missing pin') {
                    assert.ok([403, 409, 500].includes(response.status))
                    assert.match(response.body.message, /authorized (Harness )?canvas id/)
                    assert.equal(calls.length, 0, 'missing pins refuse even unchanged A')
                }
                if (stage === 'lost queue pin')
                    assert.equal(calls.length, 0, 'a scoped job without an expected id refuses even unchanged A')
                assert.equal(calls.filter((call) => call.marker === B).length, 0, 'ungranted B tool must never execute')
                if (backgroundEntry && response.status === 202) {
                    const run = history.getRun(name, response.body.runId, { apiKeyId: key.id })
                    assert.ok(run, 'history belongs to the presenting principal')
                    assert.equal(history.getRun(name, response.body.runId, { apiKeyId: 'another-key' }), null)
                    assert.ok(calls.some((call) => call.marker === A) || ['failed', 'cancelled'].includes(run.status), JSON.stringify(run))
                }
            } finally {
                resume.release()
                report.reportAdmissionHooks.afterCaller = null
                harnesses.runAdmissionHooks.beforeDispatch = null
                queue.queueHooks.afterEnqueue = null
                queue.setWorkerContext(null)
                dashflows.runtime = oldRuntime
                setTeamPermissionLookup(null)
                runs.trackBackgroundRun = originalTrack
                gateway.stopGateway()
                await data.destroy()
            }
        })
    }

for (const writer of ['saveLegacyBoundFlow', 'saveFlowPreservingAccess']) {
    test(writer + ' cannot update another workspace through a primary-key collision', async () => {
        const data = await database()
        try {
            const other = await data.getRepository(ChatFlow).save({
                id: 'tenant-collision',
                workspaceId: 'team-b',
                name: 'Other team',
                type: 'CHATFLOW',
                flowData: '{}',
                apiAccessMode: 'private'
            })
            const before = await data.getRepository(ChatFlow).findOneByOrFail({ id: other.id })
            const attempted = { ...before, workspaceId: 'team-a', name: 'Overwritten' }
            const writers = serverRequire('./src/services/accessKeys/legacyBinding.ts')
            await assert.rejects(writers[writer](data, attempted, writer === 'saveFlowPreservingAccess' ? attempted : undefined), {
                statusCode: 409
            })
            assert.deepEqual(await data.getRepository(ChatFlow).findOneByOrFail({ id: other.id }), before)
        } finally {
            await data.destroy()
        }
    })
}

test('SQLite invitationOnly removal uses the production BEGIN IMMEDIATE adapter before any policy reads', async () => {
    const { sqlFromDataSource, deleteOrganizationUser } = serverRequire('./src/identity/directory.ts')
    const data = await database()
    const commands = []
    const original = data.createQueryRunner.bind(data)
    data.createQueryRunner = (...args) => {
        const runner = original(...args)
        const query = runner.query.bind(runner)
        runner.query = (sql, ...params) => {
            commands.push(sql)
            return query(sql, ...params)
        }
        return runner
    }
    try {
        await assert.rejects(
            deleteOrganizationUser(
                sqlFromDataSource(data),
                { id: 'owner', organizationId: 'org-a', workspaceId: 'team-a', permissions: [] },
                'org-a',
                'pending',
                { invitationOnly: true }
            )
        )
        assert.equal(commands[0], 'BEGIN IMMEDIATE')
        assert.ok(commands.at(-1).includes('ROLLBACK'))
        assert.equal(commands.filter((sql) => sql === 'BEGIN IMMEDIATE').length, 1)
    } finally {
        await data.destroy()
    }
})

for (const [operation, change] of [
    ...['rotate', 'update', 'revoke', 'credential revoke'].flatMap((operation) =>
        ['policy and grants', 'grants only'].map((change) => [operation, change])
    ),
    ['rotate', 'actor permission']
]) {
    test('management ' + operation + ' rechecks ' + change + ' between snapshot and writer lock', async () => {
        const data = await database()
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        const management = serverRequire('./src/services/accessKeys/management.ts')
        const ready = latch(),
            resume = latch()
        try {
            const flow = await data
                .getRepository(ChatFlow)
                .save({ id: 'manageable', workspaceId: 'team-a', name: 'Fixture', type: 'CHATFLOW', flowData: '{}' })
            const key = await data.getRepository(ApiKey).save({
                id: 'managed-key',
                apiKey: '',
                apiSecret: '',
                keyName: 'Manage',
                workspaceId: 'team-a',
                permissions: ['chatflows:view'],
                accessPolicy: parsePolicy({ scopes: ['predict'] }),
                harnesses: []
            })
            await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'CHATFLOW', resourceId: flow.id })
            const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
            const minted = await data.transaction((manager) => mintCredential(manager, key))
            let actorPermissions = ['chatflows:view', 'apikeys:update', 'apikeys:delete']
            setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: actorPermissions }) })
            management.lifecycleHooks.beforeLock = async () => {
                ready.release()
                await resume.reached
            }
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            http.use(express.json())
            http.use((req, _res, next) => {
                req.user = { id: 'actor', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'] }
                next()
            })
            http.post('/keys/:id/rotate', management.rotateAccessKey)
            http.put('/keys/:id', management.updateAccessKey)
            http.delete('/keys/:id', management.revokeAccessKey)
            http.post('/keys/:id/credentials/:credentialId/revoke', management.revokeAccessCredential)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const req =
                operation === 'rotate'
                    ? request(http).post('/keys/managed-key/rotate').send({ graceSeconds: 0 })
                    : operation === 'update'
                    ? request(http)
                          .put('/keys/managed-key')
                          .send({
                              keyName: 'Changed',
                              permissions: ['chatflows:view'],
                              accessPolicy: { scopes: ['predict'] },
                              resources: [{ resourceType: 'CHATFLOW', resourceId: flow.id }],
                              expiresAt: null
                          })
                    : operation === 'revoke'
                    ? request(http).delete('/keys/managed-key')
                    : request(http).post('/keys/managed-key/credentials/' + minted.credential.id + '/revoke')
            const pending = req.then((response) => response)
            await ready.reached
            // Commit the competing administrator change while the request waits at the actual mutation boundary.
            if (change === 'policy and grants')
                await data
                    .getRepository(ApiKey)
                    .update({ id: key.id }, { accessPolicy: parsePolicy({ scopes: ['predict'], allResources: true }) })
            if (change !== 'actor permission')
                await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'AGENTFLOW', resourceId: 'admin-added' })
            else actorPermissions = ['apikeys:update', 'apikeys:delete']
            const beforeKey = await data.getRepository(ApiKey).findOneByOrFail({ id: key.id })
            const beforeGrants = await data.getRepository(ApiKeyResource).findBy({ principalId: key.id })
            const beforeCredentials = await data.getRepository(ApiKeyCredential).findBy({ principalId: key.id })
            resume.release()
            const response = await pending
            assert.equal(response.status, change === 'actor permission' ? 403 : 409, response.body.message)
            assert.deepEqual(await data.getRepository(ApiKey).findOneByOrFail({ id: key.id }), beforeKey)
            assert.deepEqual(await data.getRepository(ApiKeyResource).findBy({ principalId: key.id }), beforeGrants)
            assert.deepEqual(await data.getRepository(ApiKeyCredential).findBy({ principalId: key.id }), beforeCredentials)
        } finally {
            resume.release()
            management.lifecycleHooks.beforeLock = null
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })
}

test('SQLite quota refuses open primary transactions, retains committed charges, and copies sibling lock settings', async () => {
    const { consume, clearMinuteBuckets } = serverRequire('./src/services/accessKeys/limiter.ts')
    clearMinuteBuckets()
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'quota.sqlite'),
        entities: [ApiKeyUsage],
        synchronize: true,
        busyTimeout: 2345,
        enableWAL: true
    })
    await data.initialize()
    const key = { id: 'quota-fixture', accessPolicy: parsePolicy({ daily: 2, monthly: 2, rpm: 0 }) }
    const initialized = []
    const originalInitialize = DataSource.prototype.initialize
    DataSource.prototype.initialize = function () {
        initialized.push(this.options)
        return originalInitialize.call(this)
    }
    try {
        // Both a read transaction and one holding SQLite's writer reservation fail immediately at the guard.
        for (const write of [false, true]) {
            await assert.rejects(
                data.transaction(async (manager) => {
                    await manager.query('SELECT * FROM apikey_usage')
                    if (write) await manager.query('DELETE FROM apikey_usage')
                    await assert.rejects(consume(data, key, 'predict'), {
                        statusCode: 503,
                        message: 'Access key quota admission cannot run inside a primary SQLite transaction.'
                    })
                    throw new Error('fixture rollback')
                }),
                /fixture rollback/
            )
            assert.equal(await data.getRepository(ApiKeyUsage).count(), 0)
        }
        await consume(data, key, 'predict')
        const sibling = initialized.find((options) => options.database === data.options.database)
        assert.equal(sibling.busyTimeout, 2345)
        assert.equal(sibling.enableWAL, true)
        await assert.rejects(
            data.transaction(async (manager) => {
                await manager.query('DELETE FROM apikey_usage')
                throw new Error('fixture rollback')
            }),
            /fixture rollback/
        )
        assert.ok((await data.getRepository(ApiKeyUsage).find()).every((row) => row.accepted === 1))
        await consume(data, key, 'predict')
        await assert.rejects(consume(data, key, 'predict'), { statusCode: 429 })
    } finally {
        DataSource.prototype.initialize = originalInitialize
        await data.destroy()
    }
})

test('updateChatflow preserves a legacy Harness name grant using the pre-write name across type change and rename', async () => {
    const data = await database()
    try {
        const initial = await legacyFlow(data)
        await data.getRepository(ChatFlow).update({ id: initial.id }, { type: 'HARNESS', name: 'named-independent' })
        await data.getRepository(ApiKeyResource).delete({ principalId: 'legacy-key', resourceId: initial.id })
        await data.getRepository(ApiKeyResource).save({ principalId: 'legacy-key', resourceType: 'HARNESS', resourceId: initial.id })
        let flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        await update(flow, { type: 'CHATFLOW', name: 'renamed' })
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: initial.id }), true)
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        await update(flow, { apikeyid: null })
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: initial.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: initial.id }), false)
    } finally {
        await data.destroy()
    }
})

test('a compensating flow save restores the legacy grant type with the row after a real updateChatflow', async () => {
    const data = await database()
    try {
        const initial = await legacyFlow(data)
        await update({ ...initial }, { type: 'AGENTFLOW' })
        const current = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        const { saveFlowPreservingAccess } = serverRequire('./src/services/accessKeys/legacyBinding.ts')
        await saveFlowPreservingAccess(data, initial, current)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: initial.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: initial.id }), false)
    } finally {
        await data.destroy()
    }
})

// A request may hold an ordinary-save snapshot while a second request commits a type change.
test('updateChatflow stale ordinary save cannot strand a derived grant after conversion and unbind', async () => {
    const data = await database()
    try {
        const stale = await legacyFlow(data)
        await update({ ...stale }, { type: 'AGENTFLOW' })
        let conflict
        try {
            await update({ ...stale }, { category: 'Saved from stale tab' })
        } catch (error) {
            conflict = error
        }
        if (conflict) assert.equal(conflict.statusCode, 409)
        let current = await data.getRepository(ChatFlow).findOneByOrFail({ id: stale.id })
        const family = current.type === 'AGENTFLOW' ? 'AGENTFLOW' : 'CHATFLOW'
        assert.equal(
            await hasGrant(data, { id: 'legacy-key' }, { resourceType: family, resourceId: stale.id }),
            true,
            'committed row and derived grant agree even after an ordinary stale save'
        )
        await update({ ...current }, { apikeyid: null })
        current = await data.getRepository(ChatFlow).findOneByOrFail({ id: stale.id })
        if (current.type !== 'AGENTFLOW') await update({ ...current }, { type: 'AGENTFLOW' })
        assert.equal(
            await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: stale.id }),
            false,
            'unbind and reconversion cannot reuse a stranded grant'
        )
    } finally {
        await data.destroy()
    }
})

for (const method of ['put', 'delete']) {
    test('real apikey router refuses missing management id before any principal mutation: ' + method, async () => {
        const data = await database()
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        try {
            await legacyFlow(data)
            const before = await data.getRepository(ApiKey).find()
            const grants = await data.getRepository(ApiKeyResource).find()
            setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            http.use(express.json())
            http.use((req, _res, next) => {
                req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
                next()
            })
            http.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const response = await request(http)
                [method]('/api/v1/apikey')
                .set('x-request-from', 'internal')
                .send({
                    keyName: 'Unintended replacement',
                    permissions: [],
                    accessPolicy: { scopes: [] },
                    resources: [],
                    expiresAt: null
                })
            assert.equal(response.status, 412, response.body.message)
            assert.deepEqual(await data.getRepository(ApiKey).find(), before)
            assert.deepEqual(await data.getRepository(ApiKeyResource).find(), grants)
        } finally {
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })
}

for (const entry of ['anonymous private', 'uppercase uuid', 'anonymous public']) {
    test('real preflight refuses unauthorized flow before parser: ' + entry, async () => {
        const data = await database()
        try {
            const { User, Workspace, Organization } = entities
            await data.getRepository(User).save({
                id: 'fixture',
                name: 'Fixture',
                email: 'preflight@example.invalid',
                status: 'active',
                createdBy: 'fixture',
                updatedBy: 'fixture'
            })
            await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
            await data
                .getRepository(Workspace)
                .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
            const flow = await data.getRepository(ChatFlow).save({
                id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                name: 'Private',
                workspaceId: 'team-a',
                type: 'CHATFLOW',
                flowData: '{}',
                apiAccessMode: entry === 'anonymous public' ? 'public' : 'private'
            })
            const key = await data.getRepository(ApiKey).save({
                id: 'preflight-key',
                apiKey: '',
                apiSecret: '',
                keyName: 'Fixture',
                workspaceId: 'team-a',
                permissions: ['chatflows:view'],
                accessPolicy: parsePolicy({ scopes: ['predict', 'upload'], rpm: 0 }),
                harnesses: []
            })
            const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
            const { secret } = await data.transaction((manager) => mintCredential(manager, key))
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            let parsed = 0
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use((_req, _res, next) => {
                parsed++
                next()
            })
            http.use(express.json())
            http.post('/api/v1/prediction/:id', (_req, res) => res.json({ parsed: true }))
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            let req = request(http).post('/api/v1/prediction/' + (entry === 'uppercase uuid' ? flow.id.toUpperCase() : flow.id))
            if (entry === 'uppercase uuid') req = req.set('Authorization', 'Bearer ' + secret)
            const response = await req.send({ question: 'Fixture' })
            assert.equal(
                response.status,
                entry === 'anonymous public' ? 200 : entry === 'anonymous private' ? 401 : 403,
                response.body.message
            )
            assert.equal(parsed, entry === 'anonymous public' ? 1 : 0, 'admission precedes body parser')
        } finally {
            await data.destroy()
        }
    })
}

test('real scoped metadata writer cannot rename a canvas converted to Harness after its read', async () => {
    const data = await database()
    try {
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        await data.getRepository(ChatFlow).save({ id, name: 'Original', workspaceId: 'team-a', type: 'CHATFLOW', flowData: '{}' })
        const key = await data.getRepository(ApiKey).save({
            id: 'metadata-key',
            keyName: 'Fixture',
            apiKey: '',
            apiSecret: '',
            workspaceId: 'team-a',
            permissions: ['chatflows:update'],
            accessPolicy: parsePolicy({ scopes: ['api:write'] }),
            harnesses: []
        })
        const repo = data.getRepository(ChatFlow),
            read = repo.findOneBy.bind(repo)
        let crossed = false
        repo.findOneBy = async (...args) => {
            const row = await read(...args)
            if (!crossed && row) {
                crossed = true
                await repo.update({ id }, { type: 'HARNESS' })
            }
            return row
        }
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            serverRequire('./src/services/accessKeys/authorization.ts').setAccessContext(req, key)
            next()
        })
        http.put('/api/v1/chatflows/:id', serverRequire('./src/services/accessKeys/managementBoundary.ts').scopedFlowMetadataUpdate)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const response = await request(http)
            .put('/api/v1/chatflows/' + id)
            .send({ name: 'Key rename' })
        assert.equal(response.status, 409, response.body.message)
        assert.equal((await read({ id })).name, 'Original')
    } finally {
        await data.destroy()
    }
})

test('real create handler rechecks resource authority after waiting for writer mutex', async () => {
    const data = await database()
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    const ready = latch(),
        resume = latch()
    try {
        const { Workspace, Organization, User } = entities
        await data.getRepository(User).save({
            id: 'fixture',
            name: 'Fixture',
            email: 'create@example.invalid',
            status: 'active',
            createdBy: 'fixture',
            updatedBy: 'fixture'
        })
        await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(ChatFlow)
            .save({ id: 'grant-target', name: 'Original', workspaceId: 'team-a', type: 'CHATFLOW', flowData: '{}' })
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
        // Pause the final pre-lock workspace read, after policyInput has accepted the resource.
        const repo = data.getRepository(Workspace),
            read = repo.findOneBy.bind(repo)
        repo.findOneBy = async (...args) => {
            const row = await read(...args)
            ready.release()
            await resume.reached
            return row
        }
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
            next()
        })
        http.post('/api/v1/apikey', serverRequire('./src/services/accessKeys/management.ts').createAccessKey)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const pending = request(http)
            .post('/api/v1/apikey')
            .send({
                keyName: 'New',
                permissions: ['chatflows:view'],
                accessPolicy: { scopes: ['predict'] },
                resources: [{ resourceType: 'CHATFLOW', resourceId: 'grant-target' }],
                expiresAt: null
            })
            .then((r) => r)
        await ready.reached
        await data.getRepository(ChatFlow).update({ id: 'grant-target' }, { workspaceId: 'team-b' })
        resume.release()
        const response = await pending
        assert.equal(response.status, 403, response.body.message)
        assert.equal(await data.getRepository(ApiKey).count(), 0)
        assert.equal(await data.getRepository(ApiKeyCredential).count(), 0)
        assert.equal(await data.getRepository(ApiKeyResource).count(), 0)
    } finally {
        resume.release()
        setTeamPermissionLookup(null)
        await data.destroy()
    }
})

test('real management create rejects an invalid environment before minting or retiring credentials', async () => {
    const data = await database()
    try {
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
            next()
        })
        http.post('/api/v1/apikey', serverRequire('./src/services/accessKeys/management.ts').createAccessKey)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const response = await request(http)
            .post('/api/v1/apikey')
            .send({ keyName: 'Invalid', permissions: [], resources: [], accessPolicy: { scopes: [], environment: 'prod' } })
        assert.equal(response.status, 400)
        assert.equal(await data.getRepository(ApiKey).count(), 0)
        assert.equal(await data.getRepository(ApiKeyCredential).count(), 0)
    } finally {
        await data.destroy()
    }
})

test('real updateChatflow commits a mode-only change and permits an unchanged ordinary save', async () => {
    const data = await database()
    try {
        const flow = await data.getRepository(ChatFlow).save({
            id: 'mode-control',
            name: 'Mode',
            workspaceId: 'team-a',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}',
            apiAccessMode: 'public'
        })
        await update({ ...flow }, { apiAccessMode: 'private' })
        const saved = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(saved.apiAccessMode, 'private')
        await update({ ...saved }, { apiAccessMode: 'private' })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).apiAccessMode, 'private')
    } finally {
        await data.destroy()
    }
})

// Use App.config itself: global preflight, parsers, API gate, real prediction router/controller,
// and RateLimiterManager. Fixture DataSource/running-app accessors and platform identity wire
// disposable SQLite into the app; buildChatflow is replaced after authorization has completed.
async function round14App() {
    const { App } = serverRequire('./src/index.ts')
    const { RateLimiterManager } = serverRequire('./src/utils/rateLimit.ts')
    const previousManager = RateLimiterManager.instance
    RateLimiterManager.instance = new RateLimiterManager()
    const app = new App()
    app.identityManager = { getPlatformType: () => 'open_source' }
    app.sseStreamer = new (serverRequire('./src/utils/SSEStreamer.ts').SSEStreamer)()
    appModule.getRunningExpressApp = () => app
    await app.config()
    const predictions = serverRequire('./src/services/predictions/index.ts').default
    const build = predictions.buildChatflow
    let executions = 0
    predictions.buildChatflow = async () => {
        executions++
        return { text: 'fixture result' }
    }
    return {
        app,
        manager: RateLimiterManager.instance,
        executions: () => executions,
        restore: () => {
            predictions.buildChatflow = build
            RateLimiterManager.instance = previousManager
        }
    }
}
async function round14Key(data, flow) {
    const key = await data.getRepository(ApiKey).save({
        id: 'round14-key',
        apiKey: '',
        apiSecret: '',
        keyName: 'Round 14',
        workspaceId: 'team-a',
        permissions: ['chatflows:view'],
        accessPolicy: parsePolicy({ scopes: ['predict', 'stream', 'upload'], rpm: 0, daily: 10 }),
        harnesses: []
    })
    await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'CHATFLOW', resourceId: flow.id })
    return (await data.transaction((m) => serverRequire('./src/services/accessKeys/credentials.ts').mintCredential(m, key))).secret
}

test('round14 actual app counts preflight-refused prediction attempts without charging refused key quota', async () => {
    const data = await database()
    let fixture
    try {
        await workspaceFixture(data)
        const flow = await data.getRepository(ChatFlow).save({
            id: '14141414-1414-4141-8141-141414141401',
            name: 'Attempt contract',
            chatbotConfig: JSON.stringify({ postProcessing: { enabled: true } }),
            type: 'CHATFLOW',
            workspaceId: 'team-a',
            apiAccessMode: 'private',
            flowData: '{"nodes":[],"edges":[]}',
            apiConfig: JSON.stringify({ rateLimit: { limitMax: 2, limitDuration: 60, limitMsg: 'Attempt limit' } })
        })
        const secret = await round14Key(data, flow)
        fixture = await round14App()
        await fixture.manager.initializeRateLimiters(await data.getRepository(ChatFlow).find())
        const request = serverRequire('supertest')
        const predict = (token) =>
            request(fixture.app.app)
                .post('/api/v1/prediction/' + flow.id)
                .set('Authorization', 'Bearer ' + token)
                .send({ question: 'fixture' })
        const responses = [await predict('invalid-fixture-bearer'), await predict(secret), await predict(secret)]
        process.stdout.write('round14 actual App.config invalid/valid/valid statuses=' + responses.map((r) => r.status).join('/') + '\n')
        assert.equal(responses[0].status, 401)
        assert.equal(responses[1].status, 200, responses[1].text)
        assert.equal(responses[2].status, 429, 'third prediction attempt must hit the configured IP/flow limit')
        assert.equal(responses[2].text, 'Attempt limit')
        assert.ok(Number(responses[2].headers['retry-after']) > 0)
        assert.equal(fixture.executions(), 1)
        const usage = await data.getRepository(ApiKeyUsage).find()
        assert.ok(usage.length > 0)
        assert.ok(
            usage.every((row) => row.accepted === 1),
            'only the fully authorized prediction charges key quota'
        )
        const before = await data.getRepository(ApiKeyUsage).find()
        assert.equal((await predict('invalid-fixture-bearer')).status, 429)
        assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), before)
        // A different flow has its own bucket for this same socket IP.
        const other = await data.getRepository(ChatFlow).save({ ...flow, id: '14141414-1414-4141-8141-141414141403' })
        await data.getRepository(ApiKeyResource).save({ principalId: 'round14-key', resourceType: 'CHATFLOW', resourceId: other.id })
        await fixture.manager.updateRateLimiter(other)
        const independent = await request(fixture.app.app)
            .post('/api/v1/prediction/' + other.id)
            .set('Authorization', 'Bearer ' + secret)
            .send({ question: 'fixture' })
        assert.equal(independent.status, 200, independent.text)
        // Repeated preflight refusals exhaust the real bucket without touching key quotas.
        await fixture.manager.updateRateLimiter(flow)
        const afterOther = await data.getRepository(ApiKeyUsage).find()
        const refused = []
        for (let i = 0; i < 3; i++) refused.push((await predict('invalid-fixture-bearer')).status)
        assert.deepEqual(refused, [401, 401, 429])
        assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), afterOther)
        // Successful preflight and the route limiter together still count each attempt once.
        await fixture.manager.updateRateLimiter(flow)
        const accepted = []
        for (let i = 0; i < 3; i++) accepted.push((await predict(secret)).status)
        assert.deepEqual(accepted, [200, 200, 429])
        assert.equal(fixture.executions(), 4)
        assert.ok((await data.getRepository(ApiKeyUsage).find()).every((row) => row.accepted === 4))
        process.stdout.write('round14 controls: separate flow=200; invalid burst=401/401/429; valid burst=200/200/429; accepted quota=4\n')
    } finally {
        fixture?.restore()
        await data.destroy()
    }
})

test('round14 actual app pre-parser streaming origin refusals are JSON for JSON, Accept and multipart callers', async () => {
    const data = await database()
    let fixture
    try {
        await workspaceFixture(data)
        const message = '<script>literal refusal</script>'
        const flow = await data.getRepository(ChatFlow).save({
            id: '14141414-1414-4141-8141-141414141402',
            name: 'Origin contract',
            type: 'CHATFLOW',
            workspaceId: 'team-a',
            apiAccessMode: 'private',
            flowData: '{"nodes":[],"edges":[]}',
            chatbotConfig: JSON.stringify({ allowedOrigins: ['https://allowed.example'], allowedOriginsError: message })
        })
        const secret = await round14Key(data, flow)
        fixture = await round14App()
        const request = serverRequire('supertest')
        const filesBefore = readdirSync(root, { recursive: true }).filter((name) => name.startsWith('blobs'))
        for (const kind of ['json', 'accept', 'multipart']) {
            let req = request(fixture.app.app)
                .post('/api/v1/prediction/' + flow.id)
                .set('Authorization', 'Bearer ' + secret)
                .set('Origin', 'https://refused.example')
            if (kind === 'multipart') req = req.field('streaming', 'true').attach('files', Buffer.from('refused'), 'fixture.txt')
            else if (kind === 'accept')
                req = req.set('Accept', 'text/event-stream').set('Content-Type', 'application/json').send('{invalid')
            else req = req.send({ question: 'fixture', streaming: true })
            const response = await req
            process.stdout.write(
                `round14 actual App.config ${kind} streaming refusal=${response.status} ${response.headers['content-type']}\n`
            )
            assert.equal(response.status, 403)
            assert.match(response.headers['content-type'], /^application\/json/)
            assert.equal(response.body.message, message)
            assert.equal(response.headers['x-accel-buffering'], undefined)
            assert.equal(fixture.app.sseStreamer.clients.size, 0)
            assert.equal(fixture.executions(), 0)
            assert.deepEqual(
                readdirSync(root, { recursive: true }).filter((name) => name.startsWith('blobs')),
                filesBefore
            )
            assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), [])
        }
    } finally {
        fixture?.restore()
        await data.destroy()
    }
})

test('private flow duplication starts private, explicitly omits grants, and refuses anonymous prediction', async () => {
    const data = await database()
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    try {
        await workspaceFixture(data)
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
        const source = await legacyFlow(data)
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            req.user = { id: 'fixture', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-a', permissions: [], features: {} }
            next()
        })
        http.use('/api/v1/chatflows', serverRequire('./src/routes/chatflows/index.ts').default)
        http.post('/api/v1/prediction/:id', serverRequire('./src/utils/authorizeFlowAccess.ts').authorizePrediction, (_req, res) =>
            res.json({ admitted: true })
        )
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const copied = await request(http).post('/api/v1/chatflows').send({
            duplicateSourceId: source.id,
            name: 'Private copy',
            type: 'CHATFLOW',
            flowData: source.flowData,
            apiAccessMode: 'public',
            apikeyid: 'legacy-key'
        })
        assert.equal(copied.status, 200, copied.body.message)
        assert.equal(copied.body.apiAccessMode, 'private')
        assert.equal(copied.body.apikeyid || '', '')
        assert.match(copied.body.accessNotice, /grants were not copied/)
        assert.equal(await data.getRepository(ApiKeyResource).countBy({ resourceId: copied.body.id }), 0)
        assert.equal(await data.getRepository(ApiKeyResource).countBy({ resourceId: source.id }), 1)
        assert.equal(
            (
                await request(http)
                    .post('/api/v1/prediction/' + copied.body.id)
                    .send({ question: 'local fixture' })
            ).status,
            401
        )
        await data.getRepository(ChatFlow).update({ id: source.id }, { workspaceId: 'team-b' })
        assert.equal(
            (await request(http).post('/api/v1/chatflows').send({ duplicateSourceId: source.id, name: 'Forbidden', flowData: '{}' }))
                .status,
            404
        )
    } finally {
        setTeamPermissionLookup(null)
        await data.destroy()
    }
})

for (const limit of ['rpm', 'daily'])
    test('HTTP prediction isolation and ' + limit + ' quota retain 401/403/429 and Retry-After', async () => {
        const data = await database()
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        try {
            const { http: management, request, key } = await round12Fixture(data)
            const { clearMinuteBuckets } = serverRequire('./src/services/accessKeys/limiter.ts')
            clearMinuteBuckets()
            await data
                .getRepository(ApiKey)
                .update(
                    { id: key.id },
                    { accessPolicy: parsePolicy({ scopes: ['predict'], rpm: limit === 'rpm' ? 1 : 0, daily: limit === 'daily' ? 1 : 0 }) }
                )
            const allowedId = '12121212-1212-4121-8121-121212121201',
                deniedId = '12121212-1212-4121-8121-121212121203'
            await data.getRepository(ChatFlow).update({ id: deniedId }, { workspaceId: 'team-a' })
            const express = serverRequire('express'),
                http = express()
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use(express.json())
            http.post('/api/v1/prediction/:id', serverRequire('./src/utils/authorizeFlowAccess.ts').authorizePrediction, (_req, res) =>
                res.json({ admitted: true })
            )
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const predict = (id, bearer = key.apiKey) =>
                request(http)
                    .post('/api/v1/prediction/' + id)
                    .set('Authorization', 'Bearer ' + bearer)
                    .send({ question: 'local fixture' })
            assert.equal((await predict(allowedId, 'invalid-local-fixture')).status, 401)
            assert.equal((await predict(deniedId)).status, 403)
            for (const [method, target] of [
                ['get', ''],
                ['get', '/' + allowedId],
                ['put', '/' + allowedId],
                ['delete', '/' + allowedId]
            ]) {
                assert.equal(
                    (
                        await request(management)
                            [method]('/api/v1/chatflows' + target)
                            .set('Authorization', 'Bearer ' + key.apiKey)
                            .send({ name: 'Denied' })
                    ).status,
                    403
                )
            }
            assert.equal(await data.getRepository(ApiKeyUsage).countBy({ principalId: key.id }), 0, 'denials consume no quota')
            assert.equal((await predict(allowedId)).status, 200)
            const limited = await predict(allowedId)
            assert.equal(limited.status, 429)
            assert.ok(Number(limited.headers['retry-after']) > 0)
            assert.match(limited.body.message, /https:\/\/cuttlely.com\/docs\/how-to\/access-keys\//)
        } finally {
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })
