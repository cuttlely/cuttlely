// Shared execution fixture: real server modules stay behind the scripts adapter.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

module.exports = async function workerNestedAuthorization(t, bootHarnessNodePool) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-worker-nested-'))
    const previous = {}
    const environment = {
        CUTTLELY_HARNESS_QUEUE: 'external',
        INBOUND_ACCESS_V2: 'on',
        CUTTLELY_VERSIONS: 'false',
        CUTTLELY_DATA_DIR: dir,
        CUTTLELY_HERMES_HOME: path.join(dir, 'runtime'),
        DATABASE_PATH: path.join(dir, 'unused-global-database'),
        LOG_PATH: path.join(dir, 'logs')
    }
    for (const [name, value] of Object.entries(environment)) {
        previous[name] = process.env[name]
        process.env[name] = value
    }
    t.after(() => {
        for (const name of Object.keys(environment)) {
            if (previous[name] === undefined) delete process.env[name]
            else process.env[name] = previous[name]
        }
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const require = createRequire(path.join(__dirname, '../../packages/server/package.json'))
    require('ts-node').register({
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
    const { DataSource } = require('typeorm')
    const { entities } = require('./src/database/entities/index.ts')
    const { ChatFlow, ApiKey, ApiKeyResource, User, Workspace, Organization, Role, OrganizationUser, WorkspaceUser, ChatMessage } = entities
    const { parsePolicy } = require('./src/services/accessKeys/policy.ts')
    const { nestedFlowNodeOptions } = require('./src/utils/nestedFlowCall.ts')
    const appModule = require('./src/utils/getRunningExpressApp.ts')
    const { getRunningExpressApp } = appModule
    const { getInstance } = require('./src/index.ts')
    const { getDataSource } = require('./src/DataSource.ts')
    const { executeModule } = await import('../../packages/harness/bridge.mjs')
    const { saveHarness } = await import('../../packages/harness/store.mjs')
    const { configureHarnessRuntime } = await import('../../packages/harness/run.mjs')
    const { setGatewayContext } = await import('../../packages/harness/gateway.mjs')
    const { closeQueueDb } = await import('../../packages/harness/lock.mjs')
    t.after(() => closeQueueDb())

    assert.equal(getInstance(), undefined)
    assert.throws(getRunningExpressApp, /getRunningExpressApp failed/)
    assert.equal(getDataSource().isInitialized, false)
    await assert.rejects(getDataSource().query('SELECT 1'))

    const data = new DataSource({ type: 'sqlite', database: ':memory:', entities: Object.values(entities), synchronize: true })
    await data.initialize()
    t.after(async () => data.destroy())
    const owner = 'worker-key-owner'
    const workspace = 'worker-workspace'
    const org = 'worker-org'
    const targetId = '33333333-3333-4333-8333-333333333333'
    const harnessId = '44444444-4444-4444-8444-444444444444'
    await data
        .getRepository(User)
        .save({ id: owner, name: 'Fixture', email: 'worker@example.invalid', status: 'active', createdBy: owner, updatedBy: owner })
    await data.getRepository(Organization).save({ id: org, name: 'Fixture', createdBy: owner, updatedBy: owner })
    await data.getRepository(Workspace).save({ id: workspace, organizationId: org, name: 'Fixture', createdBy: owner, updatedBy: owner })
    await data.getRepository(Role).save({ id: 'worker-role', name: 'Builder', permissions: JSON.stringify(['chatflows:view']) })
    await data
        .getRepository(OrganizationUser)
        .save({ organizationId: org, userId: owner, roleId: 'worker-role', status: 'active', createdBy: owner, updatedBy: owner })
    await data
        .getRepository(WorkspaceUser)
        .save({ workspaceId: workspace, userId: owner, roleId: 'worker-role', status: 'active', createdBy: owner, updatedBy: owner })
    await data.getRepository(ApiKey).save({
        id: 'worker-key',
        apiKey: '',
        apiSecret: '',
        keyName: 'Fixture',
        workspaceId: workspace,
        ownerUserId: owner,
        permissions: ['chatflows:view'],
        accessPolicy: parsePolicy({ scopes: ['predict', 'harness:run'] })
    })
    const filePath = path.join(dir, 'private-target.cjs')
    fs.writeFileSync(
        filePath,
        `exports.nodeClass = class {
        async init() { return {} }
        async run(_node, question, options) {
            if (!options.appDataSource.isInitialized) throw new Error('Worker database is unavailable')
            return { text: 'private target: ' + question }
        }
    }`
    )
    const target = await data.getRepository(ChatFlow).save({
        id: targetId,
        name: 'Private target',
        workspaceId: workspace,
        type: 'CHATFLOW',
        apiAccessMode: 'private',
        flowData: JSON.stringify({
            nodes: [
                {
                    id: 'target-node',
                    data: {
                        id: 'target-node',
                        name: 'workerFixture',
                        label: 'Fixture',
                        category: 'Chains',
                        inputs: {},
                        outputs: { output: 'EndingNode' }
                    }
                }
            ],
            edges: []
        })
    })
    await data.getRepository(ChatFlow).save({
        id: harnessId,
        name: 'worker-reference',
        workspaceId: workspace,
        type: 'HARNESS',
        apiAccessMode: 'private',
        flowData: '{"nodes":[],"edges":[]}'
    })
    saveHarness({
        name: 'worker-reference',
        chatflowId: harnessId,
        workspaceId: workspace,
        chief: { model: { nodeName: 'fixtureModel' } },
        specialists: [{ name: 'helper' }]
    })
    const resource = { principalId: 'worker-key', resourceType: 'CHATFLOW', resourceId: targetId }
    const harnessResource = { principalId: 'worker-key', resourceType: 'HARNESS', resourceId: harnessId }
    const policy = parsePolicy({ scopes: ['predict', 'harness:run'] })
    await data.getRepository(ApiKeyResource).save(resource)
    const harnessEndingPath = path.join(dir, 'harness-ending.cjs')
    fs.writeFileSync(
        harnessEndingPath,
        `const assert = require('node:assert/strict')
    exports.observed = []
    exports.nodeClass = class {
        async init() { return {} }
        async run(_node, question, options) {
            exports.observed.push(options)
            assert.equal(options.chatflowid, '${harnessId}')
            assert.equal(options.workspaceId, '${workspace}')
            assert.equal(options.orgId, '${org}')
            assert.equal(options.nestedFlowDepth, 2)
            assert.deepEqual(options.nestedFlowCaller, { via: 'api_key', apiKeyId: 'worker-key' })
            await assert.rejects(options.runNestedFlow({ targetFlowId: '${harnessId}', question }),
                { statusCode: 400, message: /cannot call itself/ })
            const result = await options.runNestedFlow({ targetFlowId: '${targetId}', question: question + ' from harness' })
            return result.text
        }
    }`
    )
    const harnessCanvas = {
        nodes: [
            { id: 'chief', data: { name: 'harnessChief', inputs: {} } },
            { id: 'helper', data: { name: 'harnessSpecialist', inputs: { specialistName: 'helper' } } },
            { id: 'model', data: { name: 'fixtureModel', category: 'Chat Models', inputs: {} } },
            { id: 'ending', data: { name: 'harnessEnding', category: 'Tools', inputs: {} } }
        ],
        edges: [
            { source: 'model', target: 'chief', targetHandle: 'chief-input-model' },
            { source: 'ending', target: 'helper', targetHandle: 'helper-input-tools' }
        ]
    }
    await data.getRepository(ChatFlow).update({ id: harnessId }, { flowData: JSON.stringify(harnessCanvas) })
    const componentNodes = { workerFixture: { filePath }, harnessEnding: { filePath: harnessEndingPath }, fixtureModel: {} }
    const cachePool = {}
    const telemetry = { sendTelemetry: async () => {} }
    const usageCacheManager = {}
    const sseStreamer = {}
    const pool = await bootHarnessNodePool({
        loadServer: async () => ({
            componentNodes,
            appDataSource: data,
            databaseEntities: entities,
            cachePool,
            workspaceEntity: Workspace,
            organizationEntity: Organization,
            nestedFlowNodeOptions,
            telemetry,
            usageCacheManager,
            sseStreamer,
            productId: ''
        })
    })
    assert.equal(pool.ready, true)
    const workerContextFor = pool.contextFor
    const previousContextFor = setGatewayContext(workerContextFor)
    configureHarnessRuntime({ contextFor: workerContextFor })
    t.after(() => configureHarnessRuntime({ contextFor: previousContextFor }))
    const context = await pool.contextFor(
        { chatflowId: '11111111-1111-4111-8111-111111111111', workspaceId: workspace },
        { nestedFlowCaller: { via: 'api_key', apiKeyId: 'worker-key' }, nestedFlowDepth: 1 }
    )
    const ChatflowTool = require('../components/nodes/tools/ChatflowTool/ChatflowTool.ts').nodeClass
    const invoke = (selectedChatflow = targetId) =>
        executeModule(
            {
                nodeName: 'chatflowTool',
                nodeId: 'pinned-private-tool',
                inputs: {
                    selectedChatflow,
                    baseURL: context.flowOptions.baseURL,
                    name: 'private_target',
                    description: 'Fixture private target'
                }
            },
            { input: 'hello' },
            { ...context, loadNode: () => ChatflowTool }
        )

    await t.test('a granted key runs the pinned private target without a 503', async () => {
        assert.equal(await invoke(), 'private target: hello')
        assert.equal(await data.getRepository(ChatMessage).countBy({ chatflowid: targetId, role: 'apiMessage' }), 1)
    })
    await t.test('a missing target grant is 403', async () => {
        await data.getRepository(ApiKeyResource).delete(resource)
        await assert.rejects(invoke(), { statusCode: 403 })
        await data.getRepository(ApiKeyResource).save(resource)
    })
    await t.test('a revoked key is refused without a 503', async () => {
        await data.getRepository(ApiKey).update({ id: 'worker-key' }, { disabledAt: new Date() })
        await assert.rejects(invoke(), { statusCode: 401 })
        await data.getRepository(ApiKey).update({ id: 'worker-key' }, { disabledAt: null })
    })
    await t.test('a missing key is refused without a 503', async () => {
        const key = await data.getRepository(ApiKey).findOneByOrFail({ id: 'worker-key' })
        await data.getRepository(ApiKey).delete({ id: key.id })
        await assert.rejects(invoke(), { statusCode: 401 })
        await data.getRepository(ApiKey).save(key)
    })
    await t.test('the owner must still be active', async () => {
        await data.getRepository(User).update({ id: owner }, { status: 'disabled' })
        try {
            await assert.rejects(invoke(), { statusCode: 401 })
        } finally {
            await data.getRepository(User).update({ id: owner }, { status: 'active' })
        }
    })
    for (const legacy of [false, true]) {
        await t.test(`current owner permissions constrain a ${legacy ? 'migrated legacy' : 'scoped'} key`, async () => {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: { ...policy, legacy } })
            await data.getRepository(Role).update({ id: 'worker-role' }, { permissions: '[]' })
            try {
                await assert.rejects(invoke(), { statusCode: 403, message: /key owner needs chatflows:view/ })
            } finally {
                await data.getRepository(Role).update({ id: 'worker-role' }, { permissions: JSON.stringify(['chatflows:view']) })
                await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: policy })
            }
        })
    }
    await t.test('prediction scope and key view permission are still required', async () => {
        try {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: parsePolicy({ scopes: [] }) })
            await assert.rejects(invoke(), { statusCode: 403, message: /predict API operation/ })
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: policy, permissions: [] })
            await assert.rejects(invoke(), { statusCode: 403, message: /chatflows:view permission/ })
        } finally {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: policy, permissions: ['chatflows:view'] })
        }
    })
    await t.test('a same-server nested call cannot cross the parent workspace', async () => {
        await data.getRepository(ChatFlow).update({ id: targetId }, { workspaceId: 'another-workspace' })
        try {
            await assert.rejects(invoke(), { statusCode: 403, message: /parent workspace/ })
        } finally {
            await data.getRepository(ChatFlow).update({ id: targetId }, { workspaceId: workspace })
        }
    })
    await t.test('a retained migration grant cannot override a replacement binding', async () => {
        await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: { ...policy, legacy: true } })
        await data.getRepository(ChatFlow).update({ id: targetId }, { apikeyid: 'replacement-key' })
        try {
            await assert.rejects(invoke(), { statusCode: 401 })
        } finally {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: policy })
            await data.getRepository(ChatFlow).update({ id: targetId }, { apikeyid: null })
        }
    })
    assert.equal(await data.getRepository(ChatMessage).countBy({ chatflowid: targetId, role: 'apiMessage' }), 1)

    await t.test('referenced Harness resolution uses the worker database for identity, scope and grant checks', async () => {
        const { authorizeNestedFlowKey } = require('./src/services/accessKeys/authorization.ts')
        const referenced = { ...target, flowData: JSON.stringify({ nodes: [{ data: { inputs: { harnessName: 'worker-reference' } } }] }) }
        const authorize = () => authorizeNestedFlowKey('worker-key', referenced, data)
        await assert.rejects(authorize(), { statusCode: 403, message: /HARNESS resource grant/ })
        await data.getRepository(ApiKeyResource).save(harnessResource)
        assert.deepEqual((await authorize()).harnessIds, { 'worker-reference': harnessId })
        await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: parsePolicy({ scopes: ['predict'] }) })
        try {
            await assert.rejects(authorize(), { statusCode: 403, message: /harness:run API operation/ })
        } finally {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { accessPolicy: policy })
        }
        const record = {
            name: 'worker-reference',
            chatflowId: harnessId,
            chief: { model: { nodeName: 'fixtureModel' } },
            specialists: [{ name: 'helper' }]
        }
        // An older record without a workspace must resolve its canvas using the same database.
        saveHarness(record, { overwrite: true })
        assert.deepEqual((await authorize()).harnessIds, { 'worker-reference': harnessId })
        // With no canvas either, default-workspace resolution must still stay on this database.
        saveHarness({ ...record, chatflowId: null }, { overwrite: true })
        await assert.rejects(authorize(), { statusCode: 403, message: /Referenced harness is unavailable/ })
        saveHarness({ ...record, workspaceId: workspace }, { overwrite: true })
        const stale = '55555555-5555-4555-8555-555555555555'
        await data.getRepository(ChatFlow).save({ ...target, id: stale, name: 'worker-reference', type: 'HARNESS' })
        await data.getRepository(ApiKeyResource).delete(harnessResource)
        await data.getRepository(ApiKeyResource).save({ ...harnessResource, resourceId: stale })
        await assert.rejects(authorize(), { statusCode: 403, message: /HARNESS resource grant/ })
        await data.getRepository(ApiKeyResource).save(harnessResource)
        assert.deepEqual((await authorize()).harnessIds, { 'worker-reference': harnessId })
    })
    await t.test('a granted key executes a pinned Private Harness canvas and its later nested call on the worker runtime', async () => {
        // Old saved records resolve their canvas ownership through the injected database too.
        saveHarness(
            {
                name: 'worker-reference',
                chatflowId: harnessId,
                chief: { model: { nodeName: 'fixtureModel' } },
                specialists: [{ name: 'helper' }]
            },
            { overwrite: true }
        )
        assert.equal(await invoke(harnessId), 'private target: hello from harness')
        const observed = require(harnessEndingPath).observed
        assert.equal(observed.length, 1)
        assert.equal(observed[0].appDataSource, data)
        assert.equal(observed[0].componentNodes, componentNodes)
        assert.equal(observed[0].cachePool, cachePool)
        assert.equal(observed[0].telemetry, telemetry)
        assert.equal(observed[0].usageCacheManager, usageCacheManager)
        assert.equal(observed[0].sseStreamer, sseStreamer)
        // Server runtime setup would replace this worker callback before booting its gateway.
        assert.equal(setGatewayContext(workerContextFor), workerContextFor)
        assert.equal(observed[0].baseURL, context.flowOptions.baseURL)
        assert.equal(await data.getRepository(ChatMessage).countBy({ chatflowid: targetId, role: 'apiMessage' }), 2)
        assert.equal(getInstance(), undefined)
        assert.throws(getRunningExpressApp, /getRunningExpressApp failed/)
        assert.equal(getDataSource().isInitialized, false)
    })
    await t.test('a Private Harness canvas still requires its current grant and active key', async () => {
        await data.getRepository(ApiKeyResource).delete(harnessResource)
        try {
            await assert.rejects(invoke(harnessId), { statusCode: 403 })
        } finally {
            await data.getRepository(ApiKeyResource).save(harnessResource)
        }
        await data.getRepository(ApiKey).update({ id: 'worker-key' }, { disabledAt: new Date() })
        try {
            await assert.rejects(invoke(harnessId), { statusCode: 401 })
        } finally {
            await data.getRepository(ApiKey).update({ id: 'worker-key' }, { disabledAt: null })
        }
    })
    await t.test('off and shadow retain binding checks while resolving Harness names on the worker database', async () => {
        await data.getRepository(ChatFlow).update({ id: targetId }, { apikeyid: 'worker-key' })
        try {
            for (const mode of ['off', 'shadow']) {
                process.env.INBOUND_ACCESS_V2 = mode
                assert.equal(await invoke(), 'private target: hello')
            }
        } finally {
            process.env.INBOUND_ACCESS_V2 = 'on'
            await data.getRepository(ChatFlow).update({ id: targetId }, { apikeyid: null })
        }
    })
    await t.test('web key lookup and accessData retain their no-argument database defaults', async () => {
        const apiKeys = require('./src/services/apikey/index.ts').default
        const { accessData } = require('./src/services/accessKeys/data.ts')
        appModule.getRunningExpressApp = () => ({ AppDataSource: data })
        try {
            assert.equal(await accessData(), data)
            assert.equal((await apiKeys.getApiKeyById('worker-key')).id, 'worker-key')
        } finally {
            appModule.getRunningExpressApp = getRunningExpressApp
        }
    })
    assert.equal(getInstance(), undefined)
    assert.throws(getRunningExpressApp, /getRunningExpressApp failed/)
    assert.equal(getDataSource().isInitialized, false)
}
