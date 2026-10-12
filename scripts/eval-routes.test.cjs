// Datasets, evaluators, and evaluations: create, list, read, update, and delete
// on the migrated schema. Jest mocks typeorm, so this file uses node:test.
const assert = require('node:assert/strict')
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
            return { rows: [] }
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

Module._load = originalLoad

const ROUND_TRIP_ENTITIES = [User, Organization, Workspace, Dataset, DatasetRow, Evaluator, Evaluation, EvaluationRun]

const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PG_PASSWORD = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''

function httpApp() {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        req.user = {
            id: USER,
            activeWorkspaceId: WORKSPACE,
            activeOrganizationId: ORG
        }
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

async function roundTrip(dataSource) {
    appHandle.AppDataSource = dataSource
    setTeamPermissionLookup({
        async accessFor() {
            return { owner: true, permissions: null }
        }
    })
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
