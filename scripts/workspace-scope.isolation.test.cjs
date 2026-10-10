// Cross-workspace isolation for the Apache services. Jest replaces typeorm with a stub,
// so this file uses node:test and the real driver. It refuses to load anything under enterprise/.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { after, before, describe, it } = require('node:test')

const componentStub = path.join(tmpdir(), 'cuttlely-flowise-components-stub.cjs')
fs.writeFileSync(
    componentStub,
    `function stub() {
  const fn = function () { return stub() }
  return new Proxy(fn, {
    get(_target, key) {
      if (key === '__esModule') return true
      if (key === 'then') return undefined
      if (key === 'getLoggerTransports') return () => []
      if (typeof key === 'symbol') return undefined
      return stub()
    },
    apply() { return stub() }
  })
}
module.exports = stub()
`
)

const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
    const segments = typeof request === 'string' ? request.split(/[/\\]/) : []
    // Apache constants import SSO classes. Substitute a stub so those files are not loaded.
    if (segments.includes('enterprise')) {
        return componentStub
    }
    if (request === 'flowise-components' || (typeof request === 'string' && request.startsWith('flowise-components/'))) {
        return componentStub
    }
    return resolveFilename.call(this, request, ...rest)
}

serverRequire('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const { DataSource } = serverRequire('typeorm')
const { ApiKey } = serverRequire('./src/database/entities/ApiKey.ts')
const { Assistant } = serverRequire('./src/database/entities/Assistant.ts')
const { ChatFlow, EnumChatflowType } = serverRequire('./src/database/entities/ChatFlow.ts')
const { ChatMessage } = serverRequire('./src/database/entities/ChatMessage.ts')
const { Credential } = serverRequire('./src/database/entities/Credential.ts')
const { Dataset } = serverRequire('./src/database/entities/Dataset.ts')
const { DatasetRow } = serverRequire('./src/database/entities/DatasetRow.ts')
const { DocumentStore } = serverRequire('./src/database/entities/DocumentStore.ts')
const { Evaluation } = serverRequire('./src/database/entities/Evaluation.ts')
const { EvaluationRun } = serverRequire('./src/database/entities/EvaluationRun.ts')
const { Execution } = serverRequire('./src/database/entities/Execution.ts')
const { Tool } = serverRequire('./src/database/entities/Tool.ts')
const { Variable } = serverRequire('./src/database/entities/Variable.ts')
const { Organization } = serverRequire('./src/database/entities/identity/Organization.ts')
const { Role } = serverRequire('./src/database/entities/identity/Role.ts')
const { User } = serverRequire('./src/database/entities/identity/User.ts')
const { Workspace } = serverRequire('./src/database/entities/identity/Workspace.ts')
const { WorkspaceShared } = serverRequire('./src/database/entities/identity/WorkspaceShared.ts')
const { WorkspaceUser } = serverRequire('./src/database/entities/identity/WorkspaceUser.ts')
const scope = serverRequire('./src/identity/workspaceScope.ts')

const WS1 = '11111111-1111-4111-8111-111111111111'
const WS2 = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const CLOSED_USER = '55555555-5555-4555-8555-555555555555'

const app = {
    AppDataSource: null,
    identityManager: { getPlatformType: () => 'open source' },
    telemetry: { sendTelemetry: async () => undefined },
    metricsProvider: { incrementCounter: () => undefined },
    usageCacheManager: {},
    nodesPool: { componentNodes: {}, componentCredentials: {} }
}

const appPath = serverRequire.resolve('./src/utils/getRunningExpressApp.ts')
require.cache[appPath] = {
    id: appPath,
    filename: appPath,
    loaded: true,
    exports: { getRunningExpressApp: () => app }
}

function loadService(rel) {
    const mod = serverRequire(rel)
    return mod.default || mod
}

const chatflows = loadService('./src/services/chatflows/index.ts')
const credentials = loadService('./src/services/credentials/index.ts')
const variables = loadService('./src/services/variables/index.ts')
const tools = loadService('./src/services/tools/index.ts')
const assistants = loadService('./src/services/assistants/index.ts')
const documentStores = loadService('./src/services/documentstore/index.ts')
const datasets = loadService('./src/services/dataset/index.ts')
const evaluations = loadService('./src/services/evaluations/index.ts')
const executions = loadService('./src/services/executions/index.ts')
const apiKeys = loadService('./src/services/apikey/index.ts')

function idsOf(value) {
    const rows = Array.isArray(value) ? value : value.data || []
    return rows.map((row) => row.id)
}

async function denied(run) {
    await assert.rejects(run, /not found|unauthorized/i)
}

function actor(workspaceId, owner, permissions) {
    return {
        id: owner ? USER : undefined,
        email: owner ? 'ada@example.com' : undefined,
        permissions,
        isOrganizationAdmin: owner,
        activeOrganizationId: ORG,
        activeWorkspaceId: workspaceId
    }
}

describe('workspace isolation', () => {
    /** @type {import('typeorm').DataSource} */
    let ds
    const own = {}
    const other = {}

    before(async () => {
        ds = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            synchronize: true,
            entities: [
                ChatFlow,
                ChatMessage,
                Credential,
                Variable,
                Tool,
                Assistant,
                DocumentStore,
                Dataset,
                DatasetRow,
                Evaluation,
                EvaluationRun,
                Execution,
                ApiKey,
                User,
                Organization,
                Role,
                Workspace,
                WorkspaceUser,
                WorkspaceShared
            ]
        })
        await ds.initialize()
        await ds.query('PRAGMA foreign_keys = OFF')
        app.AppDataSource = ds

        await ds
            .getRepository(User)
            .insert({ id: USER, name: 'Ada', email: 'ada@example.com', status: 'active', createdBy: USER, updatedBy: USER })
        await ds.getRepository(Organization).insert({ id: ORG, name: 'Org', createdBy: USER, updatedBy: USER })
        await ds.getRepository(Workspace).insert([
            { id: WS1, name: 'Team One', organizationId: ORG, createdBy: USER, updatedBy: USER },
            { id: WS2, name: 'Team Two', organizationId: ORG, createdBy: USER, updatedBy: USER }
        ])
        await ds.getRepository(WorkspaceUser).insert([
            { workspaceId: WS1, userId: USER, roleId: USER, status: 'active', createdBy: USER, updatedBy: USER },
            { workspaceId: WS2, userId: USER, roleId: USER, status: 'invited', createdBy: USER, updatedBy: USER },
            { workspaceId: WS2, userId: CLOSED_USER, roleId: USER, status: 'disable', createdBy: USER, updatedBy: USER }
        ])

        own.chatflow = (await ds.getRepository(ChatFlow).save({ name: 'own flow', flowData: '{}', type: 'CHATFLOW', workspaceId: WS1 })).id
        other.chatflow = (
            await ds.getRepository(ChatFlow).save({ name: 'other flow', flowData: '{}', type: 'CHATFLOW', workspaceId: WS2 })
        ).id
        own.credential = await saveCredential(ds, WS1, 'own cred')
        other.credential = await saveCredential(ds, WS2, 'other cred')
        own.sharedCredential = await saveCredential(ds, WS2, 'shared cred')
        await ds.getRepository(WorkspaceShared).insert({ workspaceId: WS1, sharedItemId: own.sharedCredential, itemType: 'credential' })
        own.variable = (await ds.getRepository(Variable).save({ name: 'own var', value: 'x', type: 'string', workspaceId: WS1 })).id
        other.variable = (await ds.getRepository(Variable).save({ name: 'other var', value: 'y', type: 'string', workspaceId: WS2 })).id
        own.tool = (await ds.getRepository(Tool).save({ name: 'own tool', description: 'd', color: '#fff', workspaceId: WS1 })).id
        other.tool = (await ds.getRepository(Tool).save({ name: 'other tool', description: 'd', color: '#fff', workspaceId: WS2 })).id
        own.assistant = (
            await ds.getRepository(Assistant).save({
                details: JSON.stringify({ name: 'own' }),
                credential: '66666666-6666-4666-8666-666666666666',
                type: 'CUSTOM',
                workspaceId: WS1
            })
        ).id
        other.assistant = (
            await ds.getRepository(Assistant).save({
                details: JSON.stringify({ name: 'other' }),
                credential: '66666666-6666-4666-8666-666666666666',
                type: 'CUSTOM',
                workspaceId: WS2
            })
        ).id
        own.store = (
            await ds.getRepository(DocumentStore).save({ name: 'own store', description: '', status: 'EMPTY', workspaceId: WS1 })
        ).id
        other.store = (
            await ds.getRepository(DocumentStore).save({ name: 'other store', description: '', status: 'EMPTY', workspaceId: WS2 })
        ).id
        own.dataset = (await ds.getRepository(Dataset).save({ name: 'own dataset', description: 'd', workspaceId: WS1 })).id
        other.dataset = (await ds.getRepository(Dataset).save({ name: 'other dataset', description: 'd', workspaceId: WS2 })).id
        own.evaluation = await saveEvaluation(ds, WS1, 'own eval', own.chatflow)
        other.evaluation = await saveEvaluation(ds, WS2, 'other eval', other.chatflow)
        own.execution = await saveExecution(ds, WS1, own.chatflow)
        other.execution = await saveExecution(ds, WS2, other.chatflow)
        own.apiKey = await saveApiKey(ds, WS1, 'ownkey00000000000001', 'own key')
        other.apiKey = await saveApiKey(ds, WS2, 'othkey00000000000001', 'other key')
    })

    after(async () => {
        if (ds?.isInitialized) await ds.destroy()
    })

    it('rejects a missing workspace id instead of listing rows', async () => {
        for (const missing of [undefined, '', null]) {
            assert.throws(
                () => scope.getWorkspaceSearchOptions(missing),
                (error) => {
                    assert.equal(error.statusCode, 400)
                    assert.equal(error.message, 'Workspace ID is required')
                    return true
                }
            )
        }
        assert.throws(
            () => scope.getWorkspaceSearchOptionsFromReq({ user: {} }),
            (error) => {
                assert.equal(error.statusCode, 400)
                assert.equal(error.message, 'Workspace ID is required')
                return true
            }
        )
        const scoped = await ds.getRepository(Variable).findBy(scope.getWorkspaceSearchOptions(WS1))
        assert.deepEqual(
            scoped.map((row) => row.id),
            [own.variable]
        )
        assert.equal(scope.getWorkspaceSearchOptions(WS1).workspaceId._value, WS1)
    })

    it('never lists a blank or null workspace id', async () => {
        const blankId = 'blank-var-000000000001'
        await ds.query(
            `INSERT INTO "variable" ("id", "name", "value", "type", "workspaceId", "createdDate", "updatedDate") VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
            [blankId, 'blank', 'b', 'string', '']
        )
        let nullInserted = false
        try {
            await ds.query(
                `INSERT INTO "variable" ("id", "name", "value", "type", "workspaceId", "createdDate", "updatedDate") VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now'))`,
                ['null-var-0000000000001', 'nullish', 'n', 'string']
            )
            nullInserted = true
        } catch {
            nullInserted = false
        }
        const listed = await variables.getAllVariables(WS1)
        const listedIds = idsOf(listed)
        assert.deepEqual(listedIds, [own.variable])
        assert.ok(!listedIds.includes(blankId))
        if (nullInserted) {
            assert.ok(!listedIds.includes('null-var-0000000000001'))
        }
        const scoped = await ds.getRepository(Variable).findBy(scope.getWorkspaceSearchOptions(WS1))
        assert.ok(scoped.every((row) => row.workspaceId === WS1))
    })

    it('refuses a missing user id before listing memberships', async () => {
        const open = await scope.readWorkspaceUserByUserId(USER, undefined, ds)
        assert.deepEqual(open.map((row) => row.workspaceId).sort(), [WS1, WS2].sort())
        assert.deepEqual(await scope.readWorkspaceUserByUserId(CLOSED_USER, undefined, ds), [])
        assert.deepEqual(await scope.readWorkspaceUserByUserId(undefined, undefined, ds), [])
        assert.deepEqual(await scope.readWorkspaceUserByUserId('', undefined, ds), [])
        assert.deepEqual(await scope.readWorkspaceUserByUserId(null, undefined, ds), [])
    })

    it('does not open a non-public chatflow when the session has no user id', async () => {
        const chatflowsController = loadService('./src/controllers/chatflows/index.ts')
        const res = {
            statusCode: 200,
            body: null,
            status(code) {
                this.statusCode = code
                return this
            },
            json(body) {
                this.body = body
                return this
            }
        }
        let forwarded = null
        await chatflowsController.getSinglePublicChatflow(
            { params: { id: own.chatflow }, user: { activeWorkspaceId: WS1, activeOrganizationId: ORG } },
            res,
            (error) => {
                forwarded = error
            }
        )
        assert.equal(forwarded, null)
        assert.equal(res.statusCode, 404)
        assert.equal(res.body.message, 'Workspace user not found')
        assert.equal(res.body.id, undefined)
    })

    it('returns only credentials shared into the caller workspace', async () => {
        const shared = await scope.getSharedItemsForWorkspace(WS1, 'credential', ds)
        assert.deepEqual(
            shared.map((row) => row.id),
            [own.sharedCredential]
        )
    })

    it('scopes chatflows for a team member, an owner, and an API key', async () => {
        assert.deepEqual(idsOf(await chatflows.getAllChatflows('CHATFLOW', WS1)), [own.chatflow])
        await denied(() => chatflows.getChatflowById(other.chatflow, WS1))
        await denied(() => chatflows.deleteChatflow(other.chatflow, ORG, WS1, [EnumChatflowType.CHATFLOW]))
        assert.equal((await ds.getRepository(ChatFlow).findOneBy({ id: other.chatflow })).name, 'other flow')

        const keyWorkspace = (await ds.getRepository(ApiKey).findOneBy({ id: own.apiKey })).workspaceId
        assert.equal(
            scope.getActiveWorkspaceIdForRequest({
                user: { activeWorkspaceId: keyWorkspace, activeOrganizationId: ORG, isOrganizationAdmin: false }
            }),
            keyWorkspace
        )
        assert.ok(!idsOf(await chatflows.getAllChatflows(undefined, keyWorkspace)).includes(other.chatflow))
        await denied(() => chatflows.getChatflowById(other.chatflow, keyWorkspace))
    })

    it('scopes credentials', async () => {
        const listed = await credentials.getAllCredentials(undefined, WS1)
        const listedIds = listed.map((row) => row.id)
        assert.ok(listedIds.includes(own.credential))
        assert.ok(listedIds.includes(own.sharedCredential))
        assert.ok(!listedIds.includes(other.credential))
        await denied(() => credentials.getCredentialById(other.credential, WS1))
        await denied(() => credentials.updateCredential(other.credential, { name: 'stolen', plainDataObj: {} }, WS1))
        await credentials.deleteCredentials(other.credential, WS1)
        assert.equal((await ds.getRepository(Credential).findOneBy({ id: other.credential })).name, 'other cred')
    })

    it('scopes variables', async () => {
        assert.deepEqual(idsOf(await variables.getAllVariables(WS1)), [own.variable])
        assert.equal(await variables.getVariableById(other.variable, WS1), null)
        await variables.deleteVariable(other.variable, WS1)
        assert.equal((await ds.getRepository(Variable).findOneBy({ id: other.variable })).name, 'other var')
    })

    it('scopes tools', async () => {
        assert.deepEqual(idsOf(await tools.getAllTools(WS1)), [own.tool])
        await denied(() => tools.getToolById(other.tool, WS1))
        await denied(() => tools.updateTool(other.tool, { name: 'stolen' }, WS1))
        await tools.deleteTool(other.tool, WS1)
        assert.equal((await ds.getRepository(Tool).findOneBy({ id: other.tool })).name, 'other tool')
    })

    it('scopes assistants', async () => {
        assert.deepEqual(idsOf(await assistants.getAllAssistants(WS1)), [own.assistant])
        await denied(() => assistants.getAssistantById(other.assistant, WS1))
        await denied(() => assistants.updateAssistant(other.assistant, { details: JSON.stringify({ name: 'stolen' }) }, WS1))
        await denied(() => assistants.deleteAssistant(other.assistant, false, WS1))
        assert.equal((await ds.getRepository(Assistant).findOneBy({ id: other.assistant })).workspaceId, WS2)
    })

    it('scopes document stores', async () => {
        assert.deepEqual(idsOf(await documentStores.getAllDocumentStores(WS1)), [own.store])
        await denied(() => documentStores.getDocumentStoreById(other.store, WS1))
        await denied(() => documentStores.deleteDocumentStore(other.store, ORG, WS1, {}))
        assert.equal((await ds.getRepository(DocumentStore).findOneBy({ id: other.store })).name, 'other store')
    })

    it('scopes datasets', async () => {
        assert.deepEqual(idsOf(await datasets.getAllDatasets(WS1)), [own.dataset])
        await denied(() => datasets.getDataset(other.dataset, WS1))
        await denied(() => datasets.updateDataset(other.dataset, { name: 'stolen', description: 'no' }, WS1))
        await denied(() => datasets.deleteDataset(other.dataset, WS1))
        assert.equal((await ds.getRepository(Dataset).findOneBy({ id: other.dataset })).name, 'other dataset')
    })

    it('scopes evaluations, including versions that share a name and a bulk delete', async () => {
        const twin = await saveEvaluation(ds, WS2, 'own eval', other.chatflow)
        const detail = await evaluations.getEvaluation(own.evaluation, WS1)
        assert.equal(detail.versionCount, 1)
        assert.equal(detail.versionNo, 1)
        const versions = await evaluations.getVersions(own.evaluation, WS1)
        assert.deepEqual(
            versions.versions.map((row) => row.id),
            [own.evaluation]
        )
        assert.ok(!versions.versions.some((row) => row.id === twin))
        assert.deepEqual(idsOf(await evaluations.getAllEvaluations(WS1)), [own.evaluation])
        await denied(() => evaluations.getEvaluation(other.evaluation, WS1))
        await denied(() => evaluations.deleteEvaluation(other.evaluation, WS1))
        await evaluations.patchDeleteEvaluations([other.evaluation], WS1, true)
        assert.equal((await ds.getRepository(Evaluation).findOneBy({ id: other.evaluation })).name, 'other eval')
        assert.equal((await ds.getRepository(Evaluation).findOneBy({ id: twin })).workspaceId, WS2)
    })

    it('scopes executions', async () => {
        assert.deepEqual(idsOf(await executions.getAllExecutions({ workspaceId: WS1, page: 1, limit: 20 })), [own.execution])
        await denied(() => executions.getExecutionById(other.execution, WS1))
        await denied(() => executions.updateExecution(other.execution, { action: 'stolen' }, WS1))
        const removed = await executions.deleteExecutions([other.execution], WS1)
        assert.equal(removed.deletedCount, 0)
        assert.equal((await ds.getRepository(Execution).findOneBy({ id: other.execution })).workspaceId, WS2)
    })

    it('scopes API keys for a member and an owner, and keeps the organization list', async () => {
        const member = actor(WS1, false, ['chatflows:view'])
        const owner = actor(WS1, true, [])
        const keyUser = actor((await ds.getRepository(ApiKey).findOneBy({ id: own.apiKey })).workspaceId, false, ['chatflows:view'])
        assert.deepEqual(idsOf(await apiKeys.getAllApiKeys(member)), [own.apiKey])
        assert.deepEqual(idsOf(await apiKeys.getAllApiKeys(owner)), [own.apiKey])
        assert.deepEqual(idsOf(await apiKeys.getAllApiKeys(keyUser)), [own.apiKey])
        const orgWide = await apiKeys.getAllApiKeysByOrganization(ORG)
        assert.deepEqual(orgWide.map((row) => row.keyName).sort(), ['other key', 'own key'])
        await denied(() => apiKeys.updateApiKey(owner, other.apiKey, 'stolen', ['chatflows:view']))
        await apiKeys.deleteApiKey(other.apiKey, WS1)
        assert.equal((await ds.getRepository(ApiKey).findOneBy({ id: other.apiKey })).keyName, 'other key')
    })

    it('refuses node options when the request has no workspace', async () => {
        const nodesController = loadService('./src/controllers/nodes/index.ts')
        let forwarded = null
        await nodesController.getSingleNodeAsyncOptions(
            { params: { name: 'bufferMemory' }, body: {}, user: { id: USER, activeOrganizationId: ORG } },
            { json() {} },
            (error) => {
                forwarded = error
            }
        )
        assert.equal(forwarded.statusCode, 400)
        assert.equal(forwarded.message, 'Workspace ID is required')
    })

    it('does not authorize oauth for a credential in another workspace', async () => {
        const express = serverRequire('express')
        const oauthRouter = loadService('./src/routes/oauth2/index.ts')
        const appExpress = express()
        appExpress.use(express.json())
        appExpress.use((req, _res, next) => {
            req.user = { id: USER, activeWorkspaceId: WS1, activeOrganizationId: ORG }
            next()
        })
        appExpress.use(oauthRouter)
        appExpress.use((err, _req, res, _next) => {
            res.status(err.statusCode || 500).json({ message: err.message })
        })
        const http = serverRequire('supertest')
        const deniedCredential = await http(appExpress)
            .post('/authorize/' + other.credential)
            .send({})
        assert.equal(deniedCredential.status, 404)
        assert.match(deniedCredential.body.message, /not found/i)
        assert.equal((await ds.getRepository(Credential).findOneBy({ id: other.credential })).workspaceId, WS2)

        const missingWorkspace = express()
        missingWorkspace.use(express.json())
        missingWorkspace.use((req, _res, next) => {
            req.user = { id: USER, activeOrganizationId: ORG }
            next()
        })
        missingWorkspace.use(oauthRouter)
        missingWorkspace.use((err, _req, res, _next) => {
            res.status(err.statusCode || 500).json({ message: err.message })
        })
        const noWorkspace = await http(missingWorkspace)
            .post('/authorize/' + own.credential)
            .send({})
        assert.equal(noWorkspace.status, 401)
    })
})

async function saveCredential(ds, workspaceId, name) {
    const row = await ds.getRepository(Credential).save({ name, credentialName: 'openAIApi', encryptedData: 'cipher', workspaceId })
    return row.id
}

async function saveEvaluation(ds, workspaceId, name, chatflowId) {
    const row = await ds.getRepository(Evaluation).save({
        name,
        evaluationType: 'llm',
        chatflowId,
        chatflowName: name,
        datasetId: chatflowId,
        datasetName: name,
        status: 'completed',
        average_metrics: '{}',
        additionalConfig: '{}',
        workspaceId
    })
    return row.id
}

async function saveExecution(ds, workspaceId, chatflowId) {
    const row = await ds.getRepository(Execution).save({
        executionData: '[]',
        state: 'FINISHED',
        agentflowId: chatflowId,
        sessionId: 'session',
        stoppedDate: new Date(),
        workspaceId
    })
    return row.id
}

async function saveApiKey(ds, workspaceId, id, keyName) {
    await ds.getRepository(ApiKey).save({ id, apiKey: id, apiSecret: 'hash', keyName, permissions: ['chatflows:view'], workspaceId })
    return id
}
