// Datasets, evaluators, and evaluations: create, list, read, update, and delete
// on the migrated schema. Jest mocks typeorm, so this file uses node:test.
const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdtemp, rm } = require('node:fs/promises')
const { createRequire, Module } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { mkdtempSync } = require('node:fs')
const { after, describe, it } = require('node:test')

process.env.LOG_PATH = mkdtempSync(path.join(tmpdir(), 'cuttlely-eval-logs-'))

const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
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

const appHandle = {
    nodesPool: {},
    telemetry: {
        async sendTelemetry() {
            return undefined
        }
    },
    AppDataSource: null
}

const componentsStub = {
    EvaluationRunner: class EvaluationRunner {
        async runEvaluations() {
            // Stay pending so a test can close the database without a late write.
            return new Promise(() => {})
        }
    },
    convertSchemaToZod() {
        return null
    },
    StorageProviderFactory: {
        getProvider() {
            return {
                getLoggerTransports() {
                    return []
                },
                getMulterStorage() {
                    const multer = serverRequire('multer')
                    return multer({ storage: multer.memoryStorage() })
                }
            }
        }
    }
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (request === '@cuttlely/components') return componentsStub
    if (typeof request === 'string' && request.includes('getRunningExpressApp')) {
        return { getRunningExpressApp: () => appHandle }
    }
    return originalLoad.call(this, request, parent, isMain)
}

const { DataSource } = serverRequire('typeorm')
const express = serverRequire('express')
const request = serverRequire('supertest')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { postgresMigrations } = serverRequire('./src/database/migrations/postgres/index.ts')
const { denyClosedFeature } = serverRequire('./src/identity/ossPlatform.ts')
const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
const { teamAccess } = serverRequire('./src/identity/sqlStore.ts')
const datasetRouter = serverRequire('./src/routes/dataset/index.ts').default
const evaluatorRouter = serverRequire('./src/routes/evaluator/index.ts').default
const evaluationsRouter = serverRequire('./src/routes/evaluations/index.ts').default
const errorHandlerMiddleware = serverRequire('./src/middlewares/errors/index.ts').default
const { User } = serverRequire('./src/database/entities/identity/User.ts')
const { Organization } = serverRequire('./src/database/entities/identity/Organization.ts')
const { Workspace } = serverRequire('./src/database/entities/identity/Workspace.ts')
const { Dataset } = serverRequire('./src/database/entities/Dataset.ts')
const { DatasetRow } = serverRequire('./src/database/entities/DatasetRow.ts')
const { Evaluator } = serverRequire('./src/database/entities/Evaluator.ts')
const { Evaluation } = serverRequire('./src/database/entities/Evaluation.ts')
const { EvaluationRun } = serverRequire('./src/database/entities/EvaluationRun.ts')
const { Credential } = serverRequire('./src/database/entities/Credential.ts')
const { Assistant } = serverRequire('./src/database/entities/Assistant.ts')
const { ChatFlow } = serverRequire('./src/database/entities/ChatFlow.ts')
const { WorkspaceShared } = serverRequire('./src/database/entities/identity/WorkspaceShared.ts')

Module._load = originalLoad

const ROUND_TRIP_ENTITIES = [
    User,
    Organization,
    Workspace,
    Dataset,
    DatasetRow,
    Evaluator,
    Evaluation,
    EvaluationRun,
    Credential,
    Assistant,
    ChatFlow,
    WorkspaceShared
]

const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444'
const MEMBER = '55555555-5555-4555-8555-555555555555'
const ROLE_ORG = '66666666-6666-4666-8666-666666666666'
const ROLE_TEAM = '77777777-7777-4777-8777-777777777777'
const PG_PASSWORD = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''

const ownerUser = () => ({
    id: USER,
    activeWorkspaceId: WORKSPACE,
    activeOrganizationId: ORG
})
let currentUser = ownerUser

function httpApp() {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        req.user = currentUser()
        next()
    })
    app.use('/datasets', denyClosedFeature('feat:datasets'), datasetRouter)
    app.use('/evaluators', denyClosedFeature('feat:evaluators'), evaluatorRouter)
    app.use('/evaluations', denyClosedFeature('feat:evaluations'), evaluationsRouter)
    app.use(errorHandlerMiddleware)
    return app
}

function rowsOf(body) {
    if (Array.isArray(body)) return body
    if (body && Array.isArray(body.data)) return body.data
    return []
}

async function seed(dataSource) {
    await dataSource.getRepository(User).save({
        id: USER,
        name: 'Ada Admin',
        email: 'ada@example.com',
        status: 'active',
        createdBy: USER,
        updatedBy: USER
    })
    await dataSource.getRepository(Organization).save({
        id: ORG,
        name: 'Example Org',
        createdBy: USER,
        updatedBy: USER
    })
    await dataSource.getRepository(Workspace).save({
        id: WORKSPACE,
        name: 'Example Team',
        organizationId: ORG,
        createdBy: USER,
        updatedBy: USER
    })
}

async function assertColumns(dataSource, dialect) {
    const tables =
        dialect === 'sqlite'
            ? async (table) => dataSource.query(`PRAGMA table_info("${table}")`)
            : async (table) => dataSource.query(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1`, [table])
    const names = async (table) => (await tables(table)).map((column) => column.name)
    assert.ok((await names('dataset')).includes('workspaceId'))
    assert.ok((await names('dataset_row')).includes('sequence_no'))
    assert.ok((await names('evaluator')).includes('workspaceId'))
    assert.ok((await names('evaluation')).includes('workspaceId'))
    assert.ok((await names('evaluation_run')).includes('errors'))
}

function asOwner() {
    currentUser = ownerUser
    setTeamPermissionLookup({
        async accessFor() {
            return { owner: true, permissions: null }
        }
    })
}

async function openSqlite() {
    const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-eval-'))
    const dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(dir, 'database.sqlite'),
        synchronize: false,
        entities: ROUND_TRIP_ENTITIES,
        migrations: sqliteMigrations
    })
    await dataSource.initialize()
    await dataSource.runMigrations()
    appHandle.AppDataSource = dataSource
    await seed(dataSource)
    return {
        dataSource,
        api: request(httpApp()),
        async cleanup() {
            if (dataSource.isInitialized) await dataSource.destroy()
            await rm(dir, { recursive: true, force: true })
        }
    }
}

async function roundTrip(dataSource) {
    appHandle.AppDataSource = dataSource
    asOwner()
    await seed(dataSource)
    const api = request(httpApp())

    const created = await api.post('/datasets/set').send({ name: 'Sample questions', description: 'Made-up rows' })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const datasetId = created.body.id
    assert.ok(datasetId)

    const first = await api.post('/datasets/rows').send({ datasetId, input: 'Where is order 1001?', output: 'On the truck' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await api.post('/datasets/rows').send({ datasetId, input: 'What is the remedy?', output: 'A replacement' })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(first.body.sequenceNo, 0)
    assert.equal(second.body.sequenceNo, 1)

    const listed = await api.get('/datasets').query({ page: 1, limit: 10 })
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.equal(listed.body.total, 1)
    assert.equal(listed.body.data[0].name, 'Sample questions')
    assert.equal(listed.body.data[0].rowCount, 2)

    const viewed = await api.get(`/datasets/set/${datasetId}`)
    assert.equal(viewed.status, 200, JSON.stringify(viewed.body))
    assert.deepEqual(
        viewed.body.rows.map((row) => row.input),
        ['Where is order 1001?', 'What is the remedy?']
    )

    const edited = await api.put(`/datasets/set/${datasetId}`).send({ name: 'Sample questions v2', description: 'Made-up rows' })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body.name, 'Sample questions v2')

    const evaluator = await api.post('/evaluators').send({
        name: 'Mentions the truck',
        type: 'text',
        operator: 'ContainsAny',
        value: 'truck'
    })
    assert.equal(evaluator.status, 200, JSON.stringify(evaluator.body))
    const evaluatorId = evaluator.body.id
    assert.equal(evaluator.body.operator, 'ContainsAny')

    const evaluators = await api.get('/evaluators').query({ page: 1, limit: 10 })
    assert.equal(evaluators.status, 200, JSON.stringify(evaluators.body))
    assert.equal(evaluators.body.data[0].name, 'Mentions the truck')

    const evaluatorView = await api.get(`/evaluators/${evaluatorId}`)
    assert.equal(evaluatorView.status, 200, JSON.stringify(evaluatorView.body))
    assert.equal(evaluatorView.body.value, 'truck')

    const evaluatorEdit = await api.put(`/evaluators/${evaluatorId}`).send({
        name: 'Mentions a replacement',
        type: 'text',
        operator: 'ContainsAny',
        value: 'replacement'
    })
    assert.equal(evaluatorEdit.status, 200, JSON.stringify(evaluatorEdit.body))
    assert.equal(evaluatorEdit.body.name, 'Mentions a replacement')

    const evaluation = await api.post('/evaluations').send({
        name: 'Sample run',
        evaluationType: 'benchmarking',
        datasetId,
        datasetName: 'Sample questions v2',
        chatflowId: '[]',
        chatflowName: '[]',
        chatflowType: '[]',
        selectedSimpleEvaluators: [],
        datasetAsOneConversation: false
    })
    assert.equal(evaluation.status, 200, JSON.stringify(evaluation.body))
    const createdEval = rowsOf(evaluation.body).find((item) => item.name === 'Sample run')
    assert.ok(createdEval, JSON.stringify(evaluation.body))

    const evaluations = await api.get('/evaluations').query({ page: 1, limit: 10 })
    assert.equal(evaluations.status, 200, JSON.stringify(evaluations.body))
    assert.equal(evaluations.body.data[0].name, 'Sample run')
    const evaluationId = evaluations.body.data[0].id

    const evaluationView = await api.get(`/evaluations/${evaluationId}`)
    assert.equal(evaluationView.status, 200, JSON.stringify(evaluationView.body))
    assert.equal(evaluationView.body.datasetId, datasetId)
    assert.equal(evaluationView.body.name, 'Sample run')

    const versions = await api.get(`/evaluations/versions/${evaluationId}`)
    assert.equal(versions.status, 200, JSON.stringify(versions.body))
    assert.equal(versions.body.versions.length, 1)
    assert.equal(versions.body.versions[0].id, evaluationId)

    assert.equal((await api.delete(`/evaluations/${evaluationId}`)).status, 200)
    assert.equal((await api.delete(`/evaluators/${evaluatorId}`)).status, 200)
    assert.equal((await api.delete(`/datasets/set/${datasetId}`)).status, 200)

    const datasetsAfter = await api.get('/datasets').query({ page: 1, limit: 10 })
    assert.equal(datasetsAfter.body.total, 0)
    const evaluatorsAfter = await api.get('/evaluators').query({ page: 1, limit: 10 })
    assert.equal(evaluatorsAfter.body.total, 0)
    const evaluationsAfter = await api.get('/evaluations').query({ page: 1, limit: 10 })
    assert.equal(evaluationsAfter.body.total, 0)
}

describe('evaluation pages', () => {
    it('wires the menu and the routes to the same view permissions', () => {
        const routes = require('node:fs').readFileSync(path.join(__dirname, '../packages/ui/src/routes/MainRoutes.jsx'), 'utf8')
        const menu = require('node:fs').readFileSync(path.join(__dirname, '../packages/ui/src/menu-items/dashboard.js'), 'utf8')
        const pages = [
            ['/datasets', 'datasets:view'],
            ['/dataset_rows/:id', 'datasets:view'],
            ['/evaluators', 'evaluators:view'],
            ['/evaluations', 'evaluations:view'],
            ['/evaluation_results/:id', 'evaluations:view']
        ]
        for (const [route, permission] of pages) {
            const at = routes.indexOf(`path: '${route}'`)
            assert.ok(at > -1, route)
            assert.ok(routes.slice(at, at + 400).includes(`permission={'${permission}'}`), `${route} ${permission}`)
        }
        for (const [url, permission] of [
            ['/datasets', 'datasets:view'],
            ['/evaluators', 'evaluators:view'],
            ['/evaluations', 'evaluations:view']
        ]) {
            const at = menu.indexOf(`url: '${url}'`)
            assert.ok(at > -1, url)
            assert.ok(menu.slice(at, at + 400).includes(`permission: '${permission}'`), `${url} ${permission}`)
        }
        const redirect = require('node:fs').readFileSync(path.join(__dirname, '../packages/ui/src/routes/DefaultRedirect.jsx'), 'utf8')
        const block = redirect.slice(redirect.indexOf('routesToCheck'), redirect.indexOf('if (!isAuthenticated)'))
        const datasetsAt = block.indexOf("permission: 'datasets:view'")
        const evaluatorsAt = block.indexOf("permission: 'evaluators:view'")
        const evaluationsAt = block.indexOf("permission: 'evaluations:view'")
        assert.ok(datasetsAt > block.indexOf("permission: 'documentStores:view'"))
        assert.ok(evaluatorsAt > datasetsAt)
        assert.ok(evaluationsAt > evaluatorsAt)
    })
})

describe('evaluation routes', () => {
    after(() => {
        setTeamPermissionLookup(null)
        require('node:fs').rmSync(process.env.LOG_PATH, { recursive: true, force: true })
    })

    it('round-trips a dataset, an evaluator, and an evaluation on sqlite', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-eval-'))
        const dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'database.sqlite'),
            synchronize: false,
            entities: ROUND_TRIP_ENTITIES,
            migrations: sqliteMigrations
        })
        try {
            await dataSource.initialize()
            await dataSource.runMigrations()
            await assertColumns(dataSource, 'sqlite')
            await roundTrip(dataSource)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('refuses a bulk row delete that includes another workspace, and deletes nothing', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            asOwner()
            const created = await api.post('/datasets/set').send({ name: 'Ours', description: 'rows' })
            assert.equal(created.status, 200, JSON.stringify(created.body))
            const own = await api.post('/datasets/rows').send({ datasetId: created.body.id, input: 'ours', output: 'ours' })
            assert.equal(own.status, 200, JSON.stringify(own.body))
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const foreignDataset = await dataSource.getRepository(Dataset).save({
                name: 'Theirs',
                description: 'rows',
                workspaceId: WORKSPACE_B
            })
            const foreign = await dataSource.getRepository(DatasetRow).save({
                datasetId: foreignDataset.id,
                input: 'theirs',
                output: 'theirs',
                sequenceNo: 0
            })
            const mixed = await api.patch('/datasets/rows').send({ ids: [own.body.id, foreign.id] })
            assert.ok(mixed.status >= 400, JSON.stringify(mixed.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { id: own.body.id } }), 1)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { id: foreign.id } }), 1)
            const onlyForeign = await api.patch('/datasets/rows').send({ ids: [foreign.id] })
            assert.ok(onlyForeign.status >= 400, JSON.stringify(onlyForeign.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { id: foreign.id } }), 1)
            const ownOnly = await api.patch('/datasets/rows').send({ ids: [own.body.id] })
            assert.equal(ownOnly.status, 200, JSON.stringify(ownOnly.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { id: own.body.id } }), 0)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { id: foreign.id } }), 1)
        } finally {
            await cleanup()
        }
    })

    it('rejects another workspace credential before an evaluation run starts', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const Previous = componentsStub.EvaluationRunner
        let runs = 0
        componentsStub.EvaluationRunner = class extends Previous {
            async runEvaluations(...args) {
                runs += 1
                return super.runEvaluations(...args)
            }
        }
        try {
            asOwner()
            const dataset = await api.post('/datasets/set').send({ name: 'Grade', description: 'rows' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const foreign = await dataSource.getRepository(Credential).save({
                name: 'Foreign key',
                credentialName: 'openAIApi',
                encryptedData: 'do-not-decrypt',
                workspaceId: WORKSPACE_B
            })
            const owned = await dataSource.getRepository(Credential).save({
                name: 'Own key',
                credentialName: 'openAIApi',
                encryptedData: 'own-cipher',
                workspaceId: WORKSPACE
            })
            const rejected = await api.post('/evaluations').send({
                name: 'Foreign grade',
                evaluationType: 'llm',
                credentialId: foreign.id,
                datasetId: dataset.body.id,
                datasetName: 'Grade',
                chatflowId: '[]',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(rejected.status, 404, JSON.stringify(rejected.body))
            assert.equal(runs, 0)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
            const accepted = await api.post('/evaluations').send({
                name: 'Own grade',
                evaluationType: 'llm',
                credentialId: owned.id,
                datasetId: dataset.body.id,
                datasetName: 'Grade',
                chatflowId: '[]',
                chatflowName: '[]',
                chatflowType: '[]',
                llm: 'openAI',
                model: 'gpt-4o-mini'
            })
            assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
            assert.equal(runs, 1)
        } finally {
            componentsStub.EvaluationRunner = Previous
            await cleanup()
        }
    })

    it('posts a real evaluation to the prediction route when APP_URL is unset', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const hits = []
        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url.startsWith('/api/v1/prediction/')) {
                const chunks = []
                req.on('data', (chunk) => chunks.push(chunk))
                req.on('end', () => {
                    hits.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ text: 'On the truck' }))
                })
                return
            }
            res.writeHead(404)
            res.end()
        })
        const Previous = componentsStub.EvaluationRunner
        const previousApp = process.env.APP_URL
        const previousPort = process.env.PORT
        try {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
            const { EvaluationRunner } = serverRequire('../components/evaluation/EvaluationRunner.ts')
            componentsStub.EvaluationRunner = EvaluationRunner
            delete process.env.APP_URL
            process.env.PORT = String(server.address().port)
            asOwner()
            await dataSource.getRepository(ChatFlow).save({
                id: 'flow-local',
                name: 'Local flow',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const dataset = await api.post('/datasets/set').send({ name: 'Live', description: 'one row' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            const row = await api.post('/datasets/rows').send({
                datasetId: dataset.body.id,
                input: 'Where is order 1001?',
                output: 'On the truck'
            })
            assert.equal(row.status, 200, JSON.stringify(row.body))
            const evaluation = await api.post('/evaluations').send({
                name: 'Local run',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Live',
                chatflowId: JSON.stringify(['flow-local']),
                chatflowName: JSON.stringify(['Local flow']),
                chatflowType: '[]',
                selectedSimpleEvaluators: []
            })
            assert.equal(evaluation.status, 200, JSON.stringify(evaluation.body))
            const started = Date.now()
            while (hits.length === 0 && Date.now() - started < 5000) {
                await new Promise((resolve) => setTimeout(resolve, 25))
            }
            assert.equal(hits.length, 1)
            assert.equal(hits[0].url, '/api/v1/prediction/flow-local')
            assert.equal(hits[0].body.question, 'Where is order 1001?')
            const settled = Date.now()
            while (Date.now() - settled < 5000) {
                const pending = await dataSource.getRepository(Evaluation).count({ where: { status: 'pending' } })
                if (pending === 0) break
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
        } finally {
            componentsStub.EvaluationRunner = Previous
            if (previousApp === undefined) delete process.env.APP_URL
            else process.env.APP_URL = previousApp
            if (previousPort === undefined) delete process.env.PORT
            else process.env.PORT = previousPort
            await new Promise((resolve) => server.close(resolve))
            await cleanup()
        }
    })

    it('rejects a missing name, a missing dataset, a bad flow list, and a custom assistant before saving', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            asOwner()
            const emptyDataset = await api.post('/datasets/set').send({})
            assert.equal(emptyDataset.status, 400, JSON.stringify(emptyDataset.body))
            assert.match(emptyDataset.body.message, /name/i)
            assert.equal(await dataSource.getRepository(Dataset).count(), 0)

            const emptyEvaluator = await api.post('/evaluators').send({})
            assert.equal(emptyEvaluator.status, 400, JSON.stringify(emptyEvaluator.body))
            assert.match(emptyEvaluator.body.message, /name/i)
            assert.equal(await dataSource.getRepository(Evaluator).count(), 0)

            const missingDataset = await api.post('/evaluations').send({
                name: 'Missing dataset',
                evaluationType: 'benchmarking',
                datasetId: 'does-not-exist',
                datasetName: 'Missing',
                chatflowId: '[]',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(missingDataset.status, 404, JSON.stringify(missingDataset.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const dataset = await api.post('/datasets/set').send({ name: 'Questions', description: 'rows' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            const malformed = await api.post('/evaluations').send({
                name: 'Bad flow list',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: '{',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(malformed.status, 400, JSON.stringify(malformed.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const assistant = await dataSource.getRepository(Assistant).save({
                details: JSON.stringify({ name: 'Helper' }),
                credential: '88888888-8888-4888-8888-888888888888',
                workspaceId: WORKSPACE
            })
            const custom = await api.post('/evaluations').send({
                name: 'Assistant run',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: JSON.stringify([assistant.id]),
                chatflowName: JSON.stringify(['Helper']),
                chatflowType: JSON.stringify(['Custom Assistant'])
            })
            assert.equal(custom.status, 400, JSON.stringify(custom.body))
            assert.match(custom.body.message, /Custom assistants/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
        } finally {
            await cleanup()
        }
    })

    it('rejects an unknown flow, a flow from another workspace, and a mixed list before saving', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            asOwner()
            const dataset = await api.post('/datasets/set').send({ name: 'Questions', description: 'rows' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            const own = await dataSource.getRepository(ChatFlow).save({
                name: 'Support',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const foreign = await dataSource.getRepository(ChatFlow).save({
                name: 'Theirs',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE_B
            })
            const agent = await dataSource.getRepository(ChatFlow).save({
                name: 'Orders',
                flowData: '{}',
                type: 'AGENTFLOW',
                workspaceId: WORKSPACE
            })
            const post = (ids) =>
                api.post('/evaluations').send({
                    name: 'Check',
                    evaluationType: 'benchmarking',
                    datasetId: dataset.body.id,
                    datasetName: 'Questions',
                    chatflowId: JSON.stringify(ids),
                    chatflowName: JSON.stringify(ids.map(() => 'Flow')),
                    chatflowType: JSON.stringify(ids.map(() => 'Chatflow'))
                })
            const unknown = await post(['does-not-exist'])
            assert.equal(unknown.status, 404, JSON.stringify(unknown.body))
            assert.match(unknown.body.message, /not found/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
            const otherTeam = await post([foreign.id])
            assert.equal(otherTeam.status, 404, JSON.stringify(otherTeam.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
            const mixed = await post([own.id, 'does-not-exist'])
            assert.equal(mixed.status, 404, JSON.stringify(mixed.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
            setTeamPermissionLookup({
                async accessFor() {
                    return { owner: false, permissions: ['evaluations:create', 'chatflows:view'] }
                }
            })
            currentUser = () => ({ id: MEMBER, activeWorkspaceId: WORKSPACE, activeOrganizationId: ORG })
            const hiddenAgent = await post([agent.id])
            assert.equal(hiddenAgent.status, 404, JSON.stringify(hiddenAgent.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('decrypts an owned or shared credential and refuses one from an unrelated workspace', async () => {
        const { dataSource, cleanup } = await openSqlite()
        const previousKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
        const previousAlias = process.env.FLOWISE_SECRETKEY_OVERWRITE
        process.env.CUTTLELY_SECRETKEY_OVERWRITE = 'cuttlely-test-credential-key'
        delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        try {
            const { AES } = serverRequire('crypto-js')
            const { getCredentialData } = serverRequire('../components/src/utils.ts')
            const seal = (secret) =>
                AES.encrypt(JSON.stringify({ openAIApiKey: secret }), process.env.CUTTLELY_SECRETKEY_OVERWRITE).toString()
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const WORKSPACE_C = '99999999-9999-4999-8999-999999999999'
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_C,
                name: 'Unrelated Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const owned = await dataSource.getRepository(Credential).save({
                name: 'Owned',
                credentialName: 'openAIApi',
                encryptedData: seal('owned-secret'),
                workspaceId: WORKSPACE
            })
            const shared = await dataSource.getRepository(Credential).save({
                name: 'Shared',
                credentialName: 'openAIApi',
                encryptedData: seal('shared-secret'),
                workspaceId: WORKSPACE_B
            })
            await dataSource.getRepository(WorkspaceShared).save({
                workspaceId: WORKSPACE,
                sharedItemId: shared.id,
                itemType: 'credential'
            })
            const unrelated = await dataSource.getRepository(Credential).save({
                name: 'Unrelated',
                credentialName: 'openAIApi',
                encryptedData: seal('unrelated-secret'),
                workspaceId: WORKSPACE_C
            })
            const options = (workspaceId) => ({
                appDataSource: dataSource,
                databaseEntities: { Credential },
                workspaceId
            })
            assert.equal((await getCredentialData(owned.id, options(WORKSPACE))).openAIApiKey, 'owned-secret')
            assert.equal((await getCredentialData(shared.id, options(WORKSPACE))).openAIApiKey, 'shared-secret')
            await assert.rejects(() => getCredentialData(unrelated.id, options(WORKSPACE)), /not found/)
        } finally {
            if (previousKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
            else process.env.CUTTLELY_SECRETKEY_OVERWRITE = previousKey
            if (previousAlias === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
            else process.env.FLOWISE_SECRETKEY_OVERWRITE = previousAlias
            await cleanup()
        }
    })

    it('run again returns 404 and writes no row when the flow is gone or the role cannot view it', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            asOwner()
            const dataset = await api.post('/datasets/set').send({ name: 'Questions', description: 'rows' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            const chat = await dataSource.getRepository(ChatFlow).save({
                name: 'Support',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const agent = await dataSource.getRepository(ChatFlow).save({
                name: 'Orders',
                flowData: '{}',
                type: 'AGENTFLOW',
                workspaceId: WORKSPACE
            })
            const created = await api.post('/evaluations').send({
                name: 'Again',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: JSON.stringify([chat.id]),
                chatflowName: JSON.stringify(['Support']),
                chatflowType: JSON.stringify(['Chatflow'])
            })
            assert.equal(created.status, 200, JSON.stringify(created.body))
            const evaluationId = rowsOf(created.body).find((item) => item.name === 'Again').id
            assert.equal(await dataSource.getRepository(Evaluation).count(), 1)
            await dataSource.getRepository(ChatFlow).delete({ id: chat.id })
            const missing = await api.post(`/evaluations/run-again/${evaluationId}`)
            assert.equal(missing.status, 404, JSON.stringify(missing.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 1)

            const agentRun = await api.post('/evaluations').send({
                name: 'Agent again',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: JSON.stringify([agent.id]),
                chatflowName: JSON.stringify(['Orders']),
                chatflowType: JSON.stringify(['Agentflow v2'])
            })
            assert.equal(agentRun.status, 200, JSON.stringify(agentRun.body))
            const agentEvalId = rowsOf(agentRun.body).find((item) => item.name === 'Agent again').id
            const before = await dataSource.getRepository(Evaluation).count()
            setTeamPermissionLookup({
                async accessFor() {
                    return { owner: false, permissions: ['evaluations:run', 'chatflows:view'] }
                }
            })
            currentUser = () => ({ id: MEMBER, activeWorkspaceId: WORKSPACE, activeOrganizationId: ORG })
            const hidden = await api.post(`/evaluations/run-again/${agentEvalId}`)
            assert.equal(hidden.status, 404, JSON.stringify(hidden.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), before)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('run again returns 404 and writes no row when the evaluation is missing or in another workspace', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            asOwner()
            const missing = await api.post('/evaluations/run-again/00000000-0000-4000-8000-000000000000')
            assert.equal(missing.status, 404, JSON.stringify(missing.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            await dataSource.getRepository(Evaluation).save({
                name: 'Elsewhere',
                evaluationType: 'benchmarking',
                chatflowId: '[]',
                chatflowName: '[]',
                datasetId: 'dataset-b',
                datasetName: 'Elsewhere',
                status: 'completed',
                average_metrics: '{}',
                additionalConfig: '{}',
                workspaceId: WORKSPACE_B
            })
            const saved = await dataSource.getRepository(Evaluation).findOneBy({ workspaceId: WORKSPACE_B })
            const otherTeam = await api.post(`/evaluations/run-again/${saved.id}`)
            assert.equal(otherTeam.status, 404, JSON.stringify(otherTeam.body))
            assert.equal(await dataSource.getRepository(Evaluation).count(), 1)
            assert.equal((await dataSource.getRepository(Evaluation).find())[0].workspaceId, WORKSPACE_B)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('rejects another team memory credential on history load, clear, and an evaluation run', async () => {
        const fs = require('node:fs')
        const { dataSource, cleanup } = await openSqlite()
        const previousKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
        const previousAlias = process.env.FLOWISE_SECRETKEY_OVERWRITE
        const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-memory-node-'))
        const file = path.join(dir, 'memory-node.mjs')
        process.env.CUTTLELY_SECRETKEY_OVERWRITE = 'cuttlely-test-credential-key'
        delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        const { getSessionChatHistory, clearSessionMemory } = serverRequire('./src/utils/index.ts')
        const { executeFlow } = serverRequire('./src/utils/buildChatflow.ts')
        const { getCredentialData } = serverRequire('../components/src/utils.ts')
        fs.writeFileSync(
            file,
            [
                'export class nodeClass {',
                '    async init(nodeData, _input, options) {',
                '        const data = await globalThis.__memoryCredential(nodeData.credential, options)',
                '        globalThis.__memorySecrets.push(data.password || "")',
                '        return {',
                '            async getChatMessages() { return [] },',
                '            async clearChatMessages() {}',
                '        }',
                '    }',
                '}',
                ''
            ].join('\n')
        )
        const fileUrl = file
        globalThis.__memoryCredential = getCredentialData
        globalThis.__memorySecrets = []
        try {
            const { AES } = serverRequire('crypto-js')
            const seal = (secret) => AES.encrypt(JSON.stringify({ password: secret }), process.env.CUTTLELY_SECRETKEY_OVERWRITE).toString()
            const WORKSPACE_C = '99999999-9999-4999-8999-999999999999'
            for (const [id, name] of [
                [WORKSPACE_B, 'Other Team'],
                [WORKSPACE_C, 'Unrelated Team']
            ]) {
                await dataSource.getRepository(Workspace).save({
                    id,
                    name,
                    organizationId: ORG,
                    createdBy: USER,
                    updatedBy: USER
                })
            }
            const saveKey = (name, secret, workspaceId) =>
                dataSource.getRepository(Credential).save({
                    name,
                    credentialName: 'postgresApi',
                    encryptedData: seal(secret),
                    workspaceId
                })
            const owned = await saveKey('Owned', 'owned-secret', WORKSPACE)
            const shared = await saveKey('Shared', 'shared-secret', WORKSPACE_B)
            await dataSource.getRepository(WorkspaceShared).save({
                workspaceId: WORKSPACE,
                sharedItemId: shared.id,
                itemType: 'credential'
            })
            const foreign = await saveKey('Foreign', 'foreign-secret', WORKSPACE_C)
            const componentNodes = {
                seqStart: { filePath: fileUrl },
                seqAgent: { filePath: fileUrl },
                postgresAgentMemory: { filePath: fileUrl }
            }
            const memoryNode = (credentialId) => ({
                id: 'postgresAgentMemory_0',
                data: {
                    id: 'postgresAgentMemory_0',
                    name: 'postgresAgentMemory',
                    label: 'Postgres Agent Memory',
                    category: 'Memory',
                    type: 'PostgresAgentMemory',
                    credential: credentialId,
                    inputs: {}
                }
            })
            const history = (credentialId) =>
                getSessionChatHistory(
                    'flow-memory',
                    'session-1',
                    memoryNode(credentialId),
                    componentNodes,
                    dataSource,
                    { Credential },
                    { info() {}, warn() {}, error() {} },
                    [],
                    WORKSPACE
                )
            globalThis.__memorySecrets = []
            await assert.rejects(() => history(foreign.id), /not found/)
            assert.deepEqual(globalThis.__memorySecrets, [])

            globalThis.__memorySecrets = []
            assert.deepEqual(await history(owned.id), [])
            assert.deepEqual(globalThis.__memorySecrets, ['owned-secret'])

            globalThis.__memorySecrets = []
            assert.deepEqual(await history(shared.id), [])
            assert.deepEqual(globalThis.__memorySecrets, ['shared-secret'])

            const clear = (credentialId) =>
                clearSessionMemory(
                    [memoryNode(credentialId)],
                    componentNodes,
                    'chat-1',
                    dataSource,
                    ORG,
                    'session-1',
                    undefined,
                    undefined,
                    WORKSPACE
                )
            globalThis.__memorySecrets = []
            await assert.rejects(() => clear(foreign.id), /not found/)
            assert.deepEqual(globalThis.__memorySecrets, [])

            globalThis.__memorySecrets = []
            await clear(owned.id)
            assert.deepEqual(globalThis.__memorySecrets, ['owned-secret'])

            globalThis.__memorySecrets = []
            await clear(shared.id)
            assert.deepEqual(globalThis.__memorySecrets, ['shared-secret'])

            const run = (credentialId) => {
                const nodes = [
                    {
                        id: 'seqStart_0',
                        data: {
                            id: 'seqStart_0',
                            name: 'seqStart',
                            label: 'Start',
                            category: 'Sequential Agents',
                            inputs: { agentMemory: '{{postgresAgentMemory_0.data.instance}}' }
                        }
                    },
                    memoryNode(credentialId),
                    {
                        id: 'seqAgent_0',
                        data: {
                            id: 'seqAgent_0',
                            name: 'seqAgent',
                            label: 'Agent',
                            category: 'Sequential Agents',
                            inputs: {}
                        }
                    }
                ]
                const edges = [{ source: 'seqStart_0', target: 'seqAgent_0', id: 'e1' }]
                return executeFlow({
                    incomingInput: { question: 'hello', history: [] },
                    chatflow: {
                        id: 'flow-memory',
                        name: 'Memory flow',
                        type: 'MULTIAGENT',
                        workspaceId: WORKSPACE,
                        flowData: JSON.stringify({ nodes, edges })
                    },
                    chatId: 'chat-eval',
                    orgId: ORG,
                    workspaceId: WORKSPACE,
                    subscriptionId: 'sub',
                    productId: 'oss',
                    baseURL: 'http://127.0.0.1:3000',
                    isInternal: true,
                    isEvaluation: true,
                    evaluationRunId: 'eval-run-1',
                    appDataSource: dataSource,
                    componentNodes,
                    sseStreamer: {},
                    telemetry: { sendTelemetry() {} },
                    cachePool: {},
                    usageCacheManager: {}
                })
            }
            globalThis.__memorySecrets = []
            await assert.rejects(() => run(foreign.id), /not found/)
            assert.deepEqual(globalThis.__memorySecrets, [])

            for (const [credentialId, secret] of [
                [owned.id, 'owned-secret'],
                [shared.id, 'shared-secret']
            ]) {
                globalThis.__memorySecrets = []
                try {
                    await run(credentialId)
                } catch (error) {
                    assert.doesNotMatch(String(error && error.message), /not found/)
                }
                assert.deepEqual(globalThis.__memorySecrets, [secret])
            }
        } finally {
            delete globalThis.__memoryCredential
            delete globalThis.__memorySecrets
            if (previousKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
            else process.env.CUTTLELY_SECRETKEY_OVERWRITE = previousKey
            if (previousAlias === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
            else process.env.FLOWISE_SECRETKEY_OVERWRITE = previousAlias
            await rm(dir, { recursive: true, force: true })
            await cleanup()
        }
    })

    it('passes the caller workspace into the grading credential load', async () => {
        const fs = require('node:fs')
        const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-eval-node-'))
        const file = path.join(dir, 'stub-llm.mjs')
        fs.writeFileSync(
            file,
            [
                'export class nodeClass {',
                '    async init(nodeData, _input, options) {',
                '        globalThis.__evalNode = { credential: nodeData.credential, workspaceId: options.workspaceId }',
                '        return {}',
                '    }',
                '}',
                ''
            ].join('\n')
        )
        try {
            const { LLMEvaluationRunner } = serverRequire('./src/services/evaluations/LLMEvaluationRunner.ts')
            appHandle.nodesPool = { componentNodes: { StubLLM: { filePath: file } } }
            const runner = new LLMEvaluationRunner()
            await runner.createLLM({
                llmConfig: { llm: 'StubLLM', model: 'stub', credentialId: 'cred-foreign', workspaceId: WORKSPACE }
            })
            assert.equal(globalThis.__evalNode.credential, 'cred-foreign')
            assert.equal(globalThis.__evalNode.workspaceId, WORKSPACE)
        } finally {
            delete globalThis.__evalNode
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('enforces list permissions for an invited team role and for a scoped API key', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            await dataSource.query(
                `INSERT INTO "user" ("id", "name", "email", "status", "createdBy", "updatedBy") VALUES (?, 'Bea Member', 'bea@example.com', 'active', ?, ?)`,
                [MEMBER, USER, USER]
            )
            await dataSource.query(
                `INSERT INTO "role" ("id", "organizationId", "name", "permissions", "createdBy", "updatedBy") VALUES (?, ?, 'member', '[]', ?, ?)`,
                [ROLE_ORG, ORG, USER, USER]
            )
            await dataSource.query(
                `INSERT INTO "role" ("id", "organizationId", "name", "permissions", "createdBy", "updatedBy") VALUES (?, ?, 'limited', ?, ?, ?)`,
                [ROLE_TEAM, ORG, JSON.stringify(['tools:view']), USER, USER]
            )
            await dataSource.query(
                `INSERT INTO "organization_user" ("organizationId", "userId", "roleId", "status", "createdBy", "updatedBy") VALUES (?, ?, ?, 'active', ?, ?)`,
                [ORG, MEMBER, ROLE_ORG, USER, USER]
            )
            // Team membership stays invited. The user row is active, which is what a local session requires.
            await dataSource.query(
                `INSERT INTO "workspace_user" ("workspaceId", "userId", "roleId", "status", "createdBy", "updatedBy") VALUES (?, ?, ?, 'invited', ?, ?)`,
                [WORKSPACE, MEMBER, ROLE_TEAM, USER, USER]
            )
            setTeamPermissionLookup({
                accessFor: (userId, workspaceId) => teamAccess(dataSource, userId, workspaceId)
            })
            currentUser = () => ({ id: MEMBER, activeWorkspaceId: WORKSPACE, activeOrganizationId: ORG })
            assert.equal((await api.get('/datasets')).status, 403)
            assert.equal((await api.get('/evaluators')).status, 403)
            assert.equal((await api.get('/evaluations')).status, 403)
            // The same write PUT /api/v1/role persists: the team role's permissions JSON.
            await dataSource.query(`UPDATE "role" SET "permissions" = ? WHERE "id" = ?`, [JSON.stringify(['datasets:view']), ROLE_TEAM])
            assert.equal((await api.get('/datasets')).status, 200)
            assert.equal((await api.get('/evaluators')).status, 403)
            assert.equal((await api.get('/evaluations')).status, 403)

            setTeamPermissionLookup(null)
            currentUser = () => ({
                permissions: ['tools:view'],
                activeWorkspaceId: WORKSPACE,
                activeOrganizationId: ORG,
                isOrganizationAdmin: false
            })
            assert.equal((await api.get('/datasets')).status, 403)
            assert.equal((await api.get('/evaluators')).status, 403)
            assert.equal((await api.get('/evaluations')).status, 403)
            currentUser = () => ({
                permissions: ['datasets:view'],
                activeWorkspaceId: WORKSPACE,
                activeOrganizationId: ORG,
                isOrganizationAdmin: false
            })
            assert.equal((await api.get('/datasets')).status, 200)
            assert.equal((await api.get('/evaluators')).status, 403)
            assert.equal((await api.get('/evaluations')).status, 403)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('round-trips the same records on postgres when a server is configured', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres evaluation routes: PGPASSWORD is unset')
            return
        }
        const { Client } = serverRequire('pg')
        const name = `cuttlely_eval_${process.pid}`
        const admin = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
        await admin.connect()
        await admin.query(`DROP DATABASE IF EXISTS ${name}`)
        await admin.query(`CREATE DATABASE ${name}`)
        await admin.end()
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            port: 5432,
            username: 'postgres',
            password: PG_PASSWORD,
            database: name,
            synchronize: false,
            entities: ROUND_TRIP_ENTITIES,
            migrations: postgresMigrations
        })
        try {
            await dataSource.initialize()
            await dataSource.runMigrations()
            await assertColumns(dataSource, 'postgres')
            await roundTrip(dataSource)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })
})
