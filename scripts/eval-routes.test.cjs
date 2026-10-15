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
const { FlowVersionState } = serverRequire('./src/database/entities/FlowVersionState.ts')
const { ChatMessage } = serverRequire('./src/database/entities/ChatMessage.ts')
const { ChatMessageFeedback } = serverRequire('./src/database/entities/ChatMessageFeedback.ts')
const { Execution } = serverRequire('./src/database/entities/Execution.ts')
const { WorkspaceShared } = serverRequire('./src/database/entities/identity/WorkspaceShared.ts')
const { casesFromDataset } = serverRequire('./src/services/flow-check/score.ts')
const flowCheck = serverRequire('./src/services/flow-check/index.ts')
const { getRatingScanCap, setRatingScanTestHook } = serverRequire('./src/services/dataset/index.ts')

async function stampFeedback(dataSource, id, value) {
    if (dataSource.options.type === 'postgres') {
        await dataSource.query(`UPDATE "chat_message_feedback" SET "createdDate" = $1 WHERE "id" = $2`, [value, id])
        return
    }
    await dataSource.query(`UPDATE "chat_message_feedback" SET "createdDate" = ? WHERE "id" = ?`, [value, id])
}

function storedClock(date) {
    return date.toISOString().replace('T', ' ').replace('Z', '')
}

function storedFraction(date) {
    return date
        .toISOString()
        .replace(/\.\d{3}Z$/, '')
        .replace('T', ' ')
}

const STORED_RATING_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/

async function assertDeletedMicrosecondAnchor(dataSource, api) {
    const now = Date.now()
    const dataset = await dataSource.getRepository(Dataset).save({
        name: 'Microsecond anchor',
        description: 'Made-up rows',
        workspaceId: WORKSPACE
    })
    const flow = await dataSource.getRepository(ChatFlow).save({
        name: 'Bakery desk',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: WORKSPACE
    })
    const fraction = storedFraction(new Date(now - 2 * 60 * 60 * 1000))
    const digits = ['000600', '000400', '000200', '000100']
    const feedbacks = []
    for (let index = 0; index < digits.length; index += 1) {
        const at = new Date(now - 2 * 60 * 60 * 1000)
        await dataSource.getRepository(ChatMessage).save({
            role: 'userMessage',
            chatflowid: flow.id,
            content: `Question ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-micro-${index}`,
            createdDate: new Date(at.getTime() - 1000)
        })
        const answer = await dataSource.getRepository(ChatMessage).save({
            role: 'apiMessage',
            chatflowid: flow.id,
            content: `Answer ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-micro-${index}`,
            createdDate: at
        })
        const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
            chatflowid: flow.id,
            chatId: `chat-micro-${index}`,
            messageId: answer.id,
            rating: 'THUMBS_DOWN',
            content: 'No.',
            createdDate: at
        })
        await stampFeedback(dataSource, feedback.id, `${fraction}.${digits[index]}`)
        feedbacks.push(feedback)
    }
    let deleted = false
    setRatingScanTestHook({
        pageSize: 2,
        afterPage: async (page) => {
            if (deleted) return
            deleted = true
            await dataSource.getRepository(ChatMessageFeedback).delete({ id: page[page.length - 1].id })
        }
    })
    const result = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        dryRun: true
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(deleted, true)
    assert.equal(result.body.feedbackIds.length, 4)
    for (const feedback of feedbacks) {
        assert.equal(result.body.feedbackIds.includes(feedback.id), true, feedback.id)
    }
}

async function assertClientCursorDeletedBeforePage(dataSource, api) {
    const now = Date.now()
    const dataset = await dataSource.getRepository(Dataset).save({
        name: 'Cursor removed',
        description: 'Made-up rows',
        workspaceId: WORKSPACE
    })
    const flow = await dataSource.getRepository(ChatFlow).save({
        name: 'Bakery desk',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: WORKSPACE
    })
    const fraction = storedFraction(new Date(now - 2 * 60 * 60 * 1000))
    const digits = ['000600', '000400', '000200', '000100']
    const feedbacks = []
    for (let index = 0; index < digits.length; index += 1) {
        const at = new Date(now - 2 * 60 * 60 * 1000)
        await dataSource.getRepository(ChatMessage).save({
            role: 'userMessage',
            chatflowid: flow.id,
            content: `Question ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-cursor-${index}`,
            createdDate: new Date(at.getTime() - 1000)
        })
        const answer = await dataSource.getRepository(ChatMessage).save({
            role: 'apiMessage',
            chatflowid: flow.id,
            content: `Answer ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-cursor-${index}`,
            createdDate: at
        })
        const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
            chatflowid: flow.id,
            chatId: `chat-cursor-${index}`,
            messageId: answer.id,
            rating: 'THUMBS_DOWN',
            content: 'No.',
            createdDate: at
        })
        await stampFeedback(dataSource, feedback.id, `${fraction}.${digits[index]}`)
        feedbacks.push(feedback)
    }
    const first = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        limit: 1,
        dryRun: true
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.cursor.id, feedbacks[0].id)
    let deleted = false
    setRatingScanTestHook({
        beforeFirstPage: async () => {
            deleted = true
            await dataSource.getRepository(ChatMessageFeedback).delete({ id: feedbacks[0].id })
        }
    })
    const next = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        dryRun: true,
        cursor: first.body.cursor
    })
    assert.equal(next.status, 200, JSON.stringify(next.body))
    assert.equal(deleted, true)
    assert.equal(next.body.feedbackIds.length, 3)
    for (const feedback of feedbacks.slice(1)) {
        assert.equal(next.body.feedbackIds.includes(feedback.id), true, feedback.id)
    }
}

async function assertSecondRequestKeepsSameMillisecond(dataSource, api) {
    asOwner()
    const now = Date.now()
    const dataset = await dataSource.getRepository(Dataset).save({
        name: 'Second page',
        description: 'Made-up rows',
        workspaceId: WORKSPACE
    })
    const flow = await dataSource.getRepository(ChatFlow).save({
        name: 'Bakery desk',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: WORKSPACE
    })
    const fraction = storedFraction(new Date(now - 2 * 60 * 60 * 1000))
    const digits = ['000600', '000400', '000200', '000100']
    const feedbacks = []
    for (let index = 0; index < digits.length; index += 1) {
        const at = new Date(now - 2 * 60 * 60 * 1000)
        await dataSource.getRepository(ChatMessage).save({
            role: 'userMessage',
            chatflowid: flow.id,
            content: `Question ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-page-${index}`,
            createdDate: new Date(at.getTime() - 1000)
        })
        const answer = await dataSource.getRepository(ChatMessage).save({
            role: 'apiMessage',
            chatflowid: flow.id,
            content: `Answer ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-page-${index}`,
            createdDate: at
        })
        const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
            chatflowid: flow.id,
            chatId: `chat-page-${index}`,
            messageId: answer.id,
            rating: 'THUMBS_DOWN',
            content: 'No.',
            createdDate: at
        })
        await stampFeedback(dataSource, feedback.id, `${fraction}.${digits[index]}`)
        feedbacks.push(feedback)
    }
    const first = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        limit: 2,
        dryRun: true
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.truncated, true)
    assert.equal(first.body.feedbackIds.length, 2)
    assert.equal(first.body.cursor.id, first.body.feedbackIds[1])
    assert.match(String(first.body.cursor.createdDate), STORED_RATING_TIMESTAMP)
    await dataSource.getRepository(ChatMessageFeedback).delete({ id: first.body.cursor.id })
    const second = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        dryRun: true,
        cursor: first.body.cursor
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.truncated, false)
    assert.equal(second.body.cursor, null)
    const expected = feedbacks.map((item) => item.id).filter((id) => !first.body.feedbackIds.includes(id))
    assert.deepEqual(second.body.feedbackIds, expected)
    assert.equal(new Set(second.body.feedbackIds).size, expected.length)
}

async function assertCursorTextSurvivesDeleteAfterPageLoad(dataSource, api) {
    asOwner()
    const now = Date.now()
    const dataset = await dataSource.getRepository(Dataset).save({
        name: 'Page text',
        description: 'Made-up rows',
        workspaceId: WORKSPACE
    })
    const flow = await dataSource.getRepository(ChatFlow).save({
        name: 'Bakery desk',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: WORKSPACE
    })
    const fraction = storedFraction(new Date(now - 2 * 60 * 60 * 1000))
    const digits = ['000300', '000200', '000100']
    const feedbacks = []
    for (let index = 0; index < digits.length; index += 1) {
        const at = new Date(now - 2 * 60 * 60 * 1000)
        await dataSource.getRepository(ChatMessage).save({
            role: 'userMessage',
            chatflowid: flow.id,
            content: `Question ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-loaded-${index}`,
            createdDate: new Date(at.getTime() - 1000)
        })
        const answer = await dataSource.getRepository(ChatMessage).save({
            role: 'apiMessage',
            chatflowid: flow.id,
            content: `Answer ${index}`,
            chatType: 'INTERNAL',
            chatId: `chat-loaded-${index}`,
            createdDate: at
        })
        const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
            chatflowid: flow.id,
            chatId: `chat-loaded-${index}`,
            messageId: answer.id,
            rating: 'THUMBS_DOWN',
            content: 'No.',
            createdDate: at
        })
        await stampFeedback(dataSource, feedback.id, `${fraction}.${digits[index]}`)
        feedbacks.push(feedback)
    }
    let deletedId = null
    setRatingScanTestHook({
        pageSize: 1,
        afterPageLoaded: async (page) => {
            if (deletedId) return
            deletedId = page[page.length - 1].id
            await dataSource.getRepository(ChatMessageFeedback).delete({ id: deletedId })
        }
    })
    const first = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        limit: 1,
        dryRun: true
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(deletedId, feedbacks[0].id)
    assert.equal(first.body.truncated, true)
    assert.equal(first.body.cursor && first.body.cursor.id, deletedId)
    assert.match(String(first.body.cursor.createdDate), STORED_RATING_TIMESTAMP)
    setRatingScanTestHook(null)
    const second = await api.post('/datasets/rows/from-ratings').send({
        datasetId: dataset.id,
        flowId: flow.id,
        rating: 'THUMBS_DOWN',
        days: 1,
        dryRun: true,
        cursor: first.body.cursor
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.truncated, false)
    const expected = feedbacks.slice(1).map((item) => item.id)
    assert.deepEqual(second.body.feedbackIds, expected)
    assert.equal(new Set(second.body.feedbackIds).size, expected.length)
}

async function writeRated(api, body) {
    const preview = await api.post('/datasets/rows/from-ratings').send({ ...body, dryRun: true })
    if (preview.status !== 200) return preview
    return api.post('/datasets/rows/from-ratings').send({
        ...body,
        dryRun: false,
        feedbackIds: preview.body.feedbackIds
    })
}

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
    FlowVersionState,
    ChatMessage,
    ChatMessageFeedback,
    Execution,
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
    for (const column of [
        'sourceType',
        'sourceMessageId',
        'sourceFlowId',
        'sourceDate',
        'sourceFeedbackId',
        'sourceRating',
        'sourceFeedbackText',
        'sourceRejectedAnswer',
        'needsExpectedAnswer'
    ]) {
        assert.ok((await names('dataset_row')).includes(column), column)
    }
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

    const chat = await dataSource.getRepository(ChatFlow).save({
        name: 'Support',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: WORKSPACE
    })
    const evaluation = await api.post('/evaluations').send({
        name: 'Sample run',
        evaluationType: 'benchmarking',
        datasetId,
        datasetName: 'Sample questions v2',
        chatflowId: JSON.stringify([chat.id]),
        chatflowName: JSON.stringify(['Support']),
        chatflowType: JSON.stringify(['Chatflow']),
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
            const chat = await dataSource.getRepository(ChatFlow).save({
                name: 'Grade flow',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const accepted = await api.post('/evaluations').send({
                name: 'Own grade',
                evaluationType: 'llm',
                credentialId: owned.id,
                datasetId: dataset.body.id,
                datasetName: 'Grade',
                chatflowId: JSON.stringify([chat.id]),
                chatflowName: JSON.stringify(['Grade flow']),
                chatflowType: JSON.stringify(['Chatflow']),
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
                chatflowId: JSON.stringify(['flow-for-dataset-check']),
                chatflowName: JSON.stringify(['Support']),
                chatflowType: JSON.stringify(['Chatflow'])
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

            const noFlow = await api.post('/evaluations').send({
                name: 'No flow',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: '[]',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(noFlow.status, 400, JSON.stringify(noFlow.body))
            assert.match(noFlow.body.message, /at least one chatflow or agentflow/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const missingList = await api.post('/evaluations').send({
                name: 'Missing list',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(missingList.status, 400, JSON.stringify(missingList.body))
            assert.match(missingList.body.message, /at least one chatflow or agentflow/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const emptyArray = await api.post('/evaluations').send({
                name: 'Empty array',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: [],
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(emptyArray.status, 400, JSON.stringify(emptyArray.body))
            assert.match(emptyArray.body.message, /at least one chatflow or agentflow/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const blank = await api.post('/evaluations').send({
                name: 'Blank list',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: '',
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(blank.status, 400, JSON.stringify(blank.body))
            assert.match(blank.body.message, /at least one chatflow or agentflow/i)
            assert.equal(await dataSource.getRepository(Evaluation).count(), 0)

            const nullList = await api.post('/evaluations').send({
                name: 'Null list',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: null,
                chatflowName: '[]',
                chatflowType: '[]'
            })
            assert.equal(nullList.status, 400, JSON.stringify(nullList.body))
            assert.match(nullList.body.message, /at least one chatflow or agentflow/i)
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

    it('stores a raw flow id array as the JSON string the runner parses', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const Previous = componentsStub.EvaluationRunner
        try {
            const { EvaluationRunner } = serverRequire('../components/evaluation/EvaluationRunner.ts')
            componentsStub.EvaluationRunner = EvaluationRunner
            asOwner()
            const dataset = await api.post('/datasets/set').send({ name: 'Questions', description: 'rows' })
            assert.equal(dataset.status, 200, JSON.stringify(dataset.body))
            const chat = await dataSource.getRepository(ChatFlow).save({
                name: 'Support',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const created = await api.post('/evaluations').send({
                name: 'Raw list',
                evaluationType: 'benchmarking',
                datasetId: dataset.body.id,
                datasetName: 'Questions',
                chatflowId: [chat.id],
                chatflowName: JSON.stringify(['Support']),
                chatflowType: JSON.stringify(['Chatflow'])
            })
            assert.ok(created.status >= 200 && created.status < 300, JSON.stringify(created.body))
            const saved = await dataSource.getRepository(Evaluation).findOneBy({ name: 'Raw list' })
            assert.equal(typeof saved.chatflowId, 'string')
            assert.equal(saved.chatflowId, JSON.stringify([chat.id]))
            const started = Date.now()
            let status = saved.status
            while (status === 'pending' && Date.now() - started < 5000) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                status = (await dataSource.getRepository(Evaluation).findOneBy({ id: saved.id })).status
            }
            assert.equal(status, 'completed', JSON.stringify(await dataSource.getRepository(Evaluation).findOneBy({ id: saved.id })))
            assert.deepEqual(JSON.parse(saved.chatflowId), [chat.id])
        } finally {
            componentsStub.EvaluationRunner = Previous
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

    it('saves a chat answer into a dataset, refuses the wrong team or permission, and that dataset runs in the publish check', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const asked = []
        flowCheck.replayHooks.run = async ({ question }) => {
            asked.push(question)
            return { text: 'checked answer' }
        }
        flowCheck.priceHooks.load = async () => null
        const flowData = JSON.stringify({
            nodes: [{ data: { name: 'chatOpenAI', category: 'Chat Models', label: 'Chat' } }]
        })
        const answerDate = new Date('2026-04-02T15:04:05.000Z')
        try {
            asOwner()
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'From chats',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const foreignDataset = await dataSource.getRepository(Dataset).save({
                name: 'Other team rows',
                description: 'Made-up rows',
                workspaceId: WORKSPACE_B
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData,
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const foreignFlow = await dataSource.getRepository(ChatFlow).save({
                name: 'Other desk',
                flowData,
                type: 'CHATFLOW',
                workspaceId: WORKSPACE_B
            })
            const agentFlow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery agent',
                flowData,
                type: 'AGENTFLOW',
                workspaceId: WORKSPACE
            })
            const userMessage = await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'Where is the rye?',
                chatType: 'INTERNAL',
                chatId: 'chat-1',
                createdDate: new Date('2026-04-02T15:04:00.000Z')
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'other session question',
                chatType: 'INTERNAL',
                chatId: 'chat-1',
                sessionId: 'other-session',
                createdDate: new Date('2026-04-02T15:04:02.000Z')
            })
            const sessionUser = await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'own session question',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-1',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:06:00.000Z')
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'other session question',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-2',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:06:01.000Z')
            })
            const sessionAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'In this session.',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-1',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:06:02.000Z')
            })
            const memoryUser = await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'own memory question',
                chatType: 'INTERNAL',
                chatId: 'chat-memory',
                sessionId: 'shared',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:07:00.000Z')
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'window question',
                chatType: 'INTERNAL',
                chatId: 'chat-memory',
                sessionId: 'shared',
                memoryType: 'window',
                createdDate: new Date('2026-04-02T15:07:01.000Z')
            })
            const memoryAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'In this memory.',
                chatType: 'INTERNAL',
                chatId: 'chat-memory',
                sessionId: 'shared',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:07:02.000Z')
            })
            const nullUser = await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'null session question',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: null,
                memoryType: null,
                createdDate: new Date('2026-04-02T15:08:00.000Z')
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'other session question',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: 'somewhere',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:08:01.000Z')
            })
            const nullAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'No session.',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: null,
                memoryType: null,
                createdDate: new Date('2026-04-02T15:08:02.000Z')
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'other session question',
                chatType: 'INTERNAL',
                chatId: 'chat-lonely',
                sessionId: 'somewhere',
                memoryType: 'buffer',
                createdDate: new Date('2026-04-02T15:08:50.000Z')
            })
            const lonelyAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'No question here.',
                chatType: 'INTERNAL',
                chatId: 'chat-lonely',
                sessionId: null,
                memoryType: null,
                createdDate: new Date('2026-04-02T15:09:00.000Z')
            })
            const answer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'In the back, on the left.',
                chatType: 'INTERNAL',
                chatId: 'chat-1',
                createdDate: answerDate
            })
            const secondAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'Still in the back.',
                chatType: 'INTERNAL',
                chatId: 'chat-1',
                createdDate: new Date('2026-04-02T15:04:10.000Z')
            })
            const foreignAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: foreignFlow.id,
                content: 'Not yours.',
                chatType: 'INTERNAL',
                chatId: 'chat-9',
                createdDate: answerDate
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: foreignFlow.id,
                content: 'Foreign question?',
                chatType: 'INTERNAL',
                chatId: 'chat-9',
                createdDate: new Date('2026-04-02T15:03:00.000Z')
            })
            const agentUser = await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: agentFlow.id,
                content: 'When does the oven start?',
                chatType: 'INTERNAL',
                chatId: 'chat-2',
                createdDate: new Date('2026-04-02T15:05:00.000Z')
            })
            const agentAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: agentFlow.id,
                content: 'At four.',
                chatType: 'INTERNAL',
                chatId: 'chat-2',
                createdDate: new Date('2026-04-02T15:05:05.000Z')
            })

            const manual = await api.post('/datasets/rows').send({ datasetId: dataset.id, input: 'Typed in', output: 'By hand' })
            assert.equal(manual.status, 200, JSON.stringify(manual.body))
            assert.equal(manual.body.sourceType ?? null, null)
            assert.equal(manual.body.sourceMessageId ?? null, null)

            const saved = await api.post('/datasets/rows/from-message').send({
                datasetId: dataset.id,
                messageId: answer.id,
                output: 'On the left in the back.'
            })
            assert.equal(saved.status, 200, JSON.stringify(saved.body))
            assert.equal(saved.body.input, 'Where is the rye?')
            assert.equal(saved.body.output, 'On the left in the back.')
            assert.equal(saved.body.sourceType, 'chat_message')
            assert.equal(saved.body.sourceMessageId, answer.id)
            assert.equal(saved.body.sourceFlowId, flow.id)
            assert.equal(new Date(saved.body.sourceDate).toISOString(), new Date(answer.createdDate).toISOString())
            assert.notEqual(saved.body.output, answer.content)

            const again = await api.post('/datasets/rows/from-message').send({
                datasetId: dataset.id,
                messageId: answer.id,
                output: 'A different expected answer'
            })
            assert.equal(again.status, 200, JSON.stringify(again.body))
            assert.equal(again.body.id, saved.body.id)
            assert.equal(again.body.output, 'On the left in the back.')
            assert.equal(
                await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id, sourceMessageId: answer.id } }),
                1
            )

            const plain = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: userMessage.id })
            assert.equal(plain.status, 400, JSON.stringify(plain.body))
            const followed = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: secondAnswer.id })
            assert.equal(followed.status, 400, JSON.stringify(followed.body))
            assert.match(followed.body.message, /No question was found/)
            assert.equal(
                await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id, sourceMessageId: secondAnswer.id } }),
                0
            )

            const sameChatOtherSession = await api
                .post('/datasets/rows/from-message')
                .send({ datasetId: dataset.id, messageId: sessionAnswer.id })
            assert.equal(sameChatOtherSession.status, 200, JSON.stringify(sameChatOtherSession.body))
            assert.equal(sameChatOtherSession.body.input, sessionUser.content)
            assert.notEqual(sameChatOtherSession.body.input, 'other session question')

            const sameSessionOtherMemory = await api
                .post('/datasets/rows/from-message')
                .send({ datasetId: dataset.id, messageId: memoryAnswer.id })
            assert.equal(sameSessionOtherMemory.status, 200, JSON.stringify(sameSessionOtherMemory.body))
            assert.equal(sameSessionOtherMemory.body.input, memoryUser.content)
            assert.notEqual(sameSessionOtherMemory.body.input, 'window question')

            const nullSession = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: nullAnswer.id })
            assert.equal(nullSession.status, 200, JSON.stringify(nullSession.body))
            assert.equal(nullSession.body.input, nullUser.content)
            assert.notEqual(nullSession.body.input, 'other session question')

            const noQuestionInSession = await api
                .post('/datasets/rows/from-message')
                .send({ datasetId: dataset.id, messageId: lonelyAnswer.id })
            assert.equal(noQuestionInSession.status, 400, JSON.stringify(noQuestionInSession.body))

            const missingDataset = await api.post('/datasets/rows/from-message').send({
                datasetId: foreignDataset.id,
                messageId: answer.id
            })
            assert.equal(missingDataset.status, 404, JSON.stringify(missingDataset.body))
            const missingMessage = await api.post('/datasets/rows/from-message').send({
                datasetId: dataset.id,
                messageId: foreignAnswer.id
            })
            assert.equal(missingMessage.status, 404, JSON.stringify(missingMessage.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: foreignDataset.id } }), 0)

            const asGrants = (permissions) => {
                currentUser = () => ({
                    id: MEMBER,
                    activeWorkspaceId: WORKSPACE,
                    activeOrganizationId: ORG,
                    permissions
                })
                setTeamPermissionLookup({
                    async accessFor() {
                        return { owner: false, permissions }
                    }
                })
            }
            asGrants(['datasets:view', 'chatflows:view'])
            assert.equal((await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: answer.id })).status, 403)
            asGrants(['datasets:update'])
            const noView = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: answer.id })
            assert.equal(noView.status, 403, JSON.stringify(noView.body))
            asGrants(['datasets:create'])
            assert.equal((await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: answer.id })).status, 403)
            asGrants(['datasets:update', 'agentflows:view'])
            const wrongType = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: answer.id })
            assert.equal(wrongType.status, 403, JSON.stringify(wrongType.body))
            asGrants(['datasets:update', 'chatflows:view'])
            const allowed = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: answer.id })
            assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
            assert.equal(allowed.body.id, saved.body.id)
            asGrants(['datasets:create', 'agentflows:view'])
            const agentSaved = await api.post('/datasets/rows/from-message').send({ datasetId: dataset.id, messageId: agentAnswer.id })
            assert.equal(agentSaved.status, 200, JSON.stringify(agentSaved.body))
            assert.equal(agentSaved.body.input, agentUser.content)
            assert.equal(agentSaved.body.output, agentAnswer.content)
            assert.equal(agentSaved.body.sourceType, 'chat_message')

            asOwner()
            const cases = await casesFromDataset(dataset.id, WORKSPACE)
            assert.deepEqual(
                cases.map((item) => item.question),
                [
                    'Typed in',
                    'Where is the rye?',
                    'own session question',
                    'own memory question',
                    'null session question',
                    'When does the oven start?'
                ]
            )
            assert.equal(cases[1].expected, 'On the left in the back.')

            const started = await flowCheck.startCheck(flow, { datasetId: dataset.id }, 'http://127.0.0.1', {
                key: flow.id,
                canvas: flowData
            })
            assert.equal(started.cases[1].question, 'Where is the rye?')
            assert.equal(started.cases[1].expected, 'On the left in the back.')
            let view = started
            for (let i = 0; i < 50 && view.status === 'running'; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                view = await flowCheck.getCheck(flow, started.id, { key: flow.id, canvas: flowData })
            }
            assert.equal(view.status, 'done', JSON.stringify(view))
            assert.equal(view.cases[1].draft.text, 'checked answer')
            assert.ok(asked.includes('Where is the rye?'))
            assert.ok(asked.includes('When does the oven start?'))
        } finally {
            flowCheck.replayHooks.run = null
            flowCheck.priceHooks.load = null
            flowCheck.checks.clear()
            asOwner()
            await cleanup()
        }
    })

    it('adds rated answers to a dataset, skips duplicates, and leaves a thumbs-down expected answer empty', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const flowData = JSON.stringify({ nodes: [{ data: { name: 'chatOpenAI', category: 'Chat Models', label: 'Chat' } }] })
        const marked = (value) => value === true || value === 1
        const rated = async (flow, chatId, question, answer, rating, when, content) => {
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: question,
                chatType: 'INTERNAL',
                chatId,
                createdDate: new Date(when.getTime() - 1000)
            })
            const message = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: answer,
                chatType: 'INTERNAL',
                chatId,
                createdDate: when
            })
            const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: flow.id,
                chatId,
                messageId: message.id,
                rating,
                content,
                createdDate: when
            })
            if (new Date(feedback.createdDate).getTime() !== when.getTime()) {
                await dataSource.query(`UPDATE "chat_message_feedback" SET "createdDate" = ? WHERE "id" = ?`, [
                    when.toISOString(),
                    feedback.id
                ])
                feedback.createdDate = when
            }
            return { message, feedback }
        }
        try {
            asOwner()
            await dataSource.getRepository(Workspace).save({
                id: WORKSPACE_B,
                name: 'Other Team',
                organizationId: ORG,
                createdBy: USER,
                updatedBy: USER
            })
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'From ratings',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const foreignDataset = await dataSource.getRepository(Dataset).save({
                name: 'Other ratings',
                description: 'Made-up rows',
                workspaceId: WORKSPACE_B
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData,
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const foreignFlow = await dataSource.getRepository(ChatFlow).save({
                name: 'Other desk',
                flowData,
                type: 'CHATFLOW',
                workspaceId: WORKSPACE_B
            })
            const now = Date.now()
            const recentDown = await rated(
                flow,
                'chat-down-new',
                'Why was the loaf late?',
                'The oven was cold.',
                'THUMBS_DOWN',
                new Date(now - 2 * 60 * 60 * 1000),
                'That is not the reason.'
            )
            const olderDown = await rated(
                flow,
                'chat-down-old',
                'Where is the rye?',
                'In the back.',
                'THUMBS_DOWN',
                new Date(now - 3 * 24 * 60 * 60 * 1000),
                'Wrong shelf.'
            )
            const oldestDown = await rated(
                flow,
                'chat-down-oldest',
                'Who opens the shop?',
                'Ada.',
                'THUMBS_DOWN',
                new Date(now - 4 * 24 * 60 * 60 * 1000),
                null
            )
            const outside = await rated(
                flow,
                'chat-down-outside',
                'What time is close?',
                'Six.',
                'THUMBS_DOWN',
                new Date(now - 10 * 24 * 60 * 60 * 1000),
                'Too early.'
            )
            const up = await rated(
                flow,
                'chat-up',
                'Is the rye in stock?',
                'Yes, two loaves.',
                'THUMBS_UP',
                new Date(now - 60 * 60 * 1000),
                'Helpful.'
            )
            await rated(
                foreignFlow,
                'chat-foreign',
                'Foreign question?',
                'Not yours.',
                'THUMBS_DOWN',
                new Date(now - 60 * 60 * 1000),
                'No.'
            )

            const beforeRows = await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } })
            const beforeUpdated = (await dataSource.getRepository(Dataset).findOneBy({ id: dataset.id })).updatedDate.toISOString()
            const dry = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true
            })
            assert.equal(dry.status, 200, JSON.stringify(dry.body))
            assert.equal(dry.body.dryRun, true)
            assert.equal(dry.body.count, 3)
            assert.equal(dry.body.skipped, 0)
            assert.equal(dry.body.preview[0].input, 'Why was the loaf late?')
            assert.equal(dry.body.preview[0].output, '')
            assert.equal(dry.body.preview[0].needsExpectedAnswer, true)
            assert.equal(dry.body.preview[0].feedbackId, recentDown.feedback.id)
            assert.equal(dry.body.preview[0].rating, 'THUMBS_DOWN')
            assert.equal(dry.body.truncated, false)
            assert.equal(dry.body.cursor, null)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), beforeRows)
            assert.equal((await dataSource.getRepository(Dataset).findOneBy({ id: dataset.id })).updatedDate.toISOString(), beforeUpdated)

            const badDays = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 0,
                dryRun: true
            })
            assert.equal(badDays.status, 400, JSON.stringify(badDays.body))
            const farDays = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 91
            })
            assert.equal(farDays.status, 400, JSON.stringify(farDays.body))
            const fractional = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1.5
            })
            assert.equal(fractional.status, 400, JSON.stringify(fractional.body))
            const badLimit = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                limit: 0
            })
            assert.equal(badLimit.status, 400, JSON.stringify(badLimit.body))
            const badDry = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: 'true'
            })
            assert.equal(badDry.status, 400, JSON.stringify(badDry.body))
            const badCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: 'not-a-date', id: 'fb' }
            })
            assert.equal(badCursor.status, 400, JSON.stringify(badCursor.body))
            const badCursorId = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: storedClock(new Date()), id: 'not-a-uuid' }
            })
            assert.equal(badCursorId.status, 400, JSON.stringify(badCursorId.body))
            const numericCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: '1', id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(numericCursor.status, 400, JSON.stringify(numericCursor.body))
            const isoCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: new Date().toISOString(), id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(isoCursor.status, 400, JSON.stringify(isoCursor.body))
            for (const createdDate of ['2026-02-31 00:00:00', '2026-04-31 12:00:00', '2026-02-29 00:00:00']) {
                const impossibleDay = await api.post('/datasets/rows/from-ratings').send({
                    datasetId: dataset.id,
                    flowId: flow.id,
                    rating: 'THUMBS_DOWN',
                    days: 7,
                    dryRun: true,
                    cursor: { createdDate, id: '00000000-0000-4000-8000-000000000000' }
                })
                assert.equal(impossibleDay.status, 400, `${createdDate} ${JSON.stringify(impossibleDay.body)}`)
            }
            const leapDay = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: '2024-02-29 00:00:00', id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(leapDay.status, 200, JSON.stringify(leapDay.body))
            const rowsBeforeCursorWrite = await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } })
            const badIdsCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                feedbackIds: [recentDown.feedback.id],
                cursor: { createdDate: '2026-02-31 00:00:00', id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(badIdsCursor.status, 400, JSON.stringify(badIdsCursor.body))
            const badIdsWrite = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: false,
                feedbackIds: [recentDown.feedback.id],
                cursor: { createdDate: '1', id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(badIdsWrite.status, 400, JSON.stringify(badIdsWrite.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), rowsBeforeCursorWrite)
            const ignoredCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                feedbackIds: [recentDown.feedback.id],
                cursor: { createdDate: '2024-02-29 12:00:00', id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(ignoredCursor.status, 200, JSON.stringify(ignoredCursor.body))
            assert.deepEqual(ignoredCursor.body.feedbackIds, [recentDown.feedback.id])
            const missingCursor = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: true,
                cursor: { createdDate: storedClock(new Date()), id: '00000000-0000-4000-8000-000000000000' }
            })
            assert.equal(missingCursor.status, 200, JSON.stringify(missingCursor.body))
            const missingIds = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7
            })
            assert.equal(missingIds.status, 400, JSON.stringify(missingIds.body))
            const emptyIds = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                dryRun: false,
                feedbackIds: []
            })
            assert.equal(emptyIds.status, 400, JSON.stringify(emptyIds.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), beforeRows)

            const capped = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                limit: 2
            })
            assert.equal(capped.status, 200, JSON.stringify(capped.body))
            assert.equal(capped.body.dryRun, false)
            assert.equal(capped.body.count, 2)
            assert.equal(capped.body.skipped, 0)
            const cappedRows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(cappedRows.length, 2)
            assert.ok(cappedRows.some((row) => row.sourceMessageId === recentDown.message.id))
            assert.ok(cappedRows.some((row) => row.sourceMessageId === olderDown.message.id))
            assert.ok(cappedRows.every((row) => row.sourceMessageId !== oldestDown.message.id))
            assert.ok(cappedRows.every((row) => row.sourceMessageId !== outside.message.id))

            const again = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 7,
                limit: 500
            })
            assert.equal(again.status, 200, JSON.stringify(again.body))
            assert.equal(again.body.count, 1)
            assert.equal(again.body.skipped, 0)
            const downRows = await dataSource.getRepository(DatasetRow).find({
                where: { datasetId: dataset.id },
                order: { sequenceNo: 'ASC' }
            })
            assert.equal(downRows.length, 3)
            const recentRow = downRows.find((row) => row.sourceMessageId === recentDown.message.id)
            assert.equal(recentRow.output, '')
            assert.equal(marked(recentRow.needsExpectedAnswer), true)
            assert.equal(recentRow.sourceType, 'chat_rating')
            assert.equal(recentRow.sourceRating, 'THUMBS_DOWN')
            assert.equal(recentRow.sourceFeedbackId, recentDown.feedback.id)
            assert.equal(recentRow.sourceFeedbackText, 'That is not the reason.')
            assert.equal(recentRow.sourceRejectedAnswer, 'The oven was cold.')
            assert.equal(recentRow.sourceFlowId, flow.id)
            assert.equal(recentRow.input, 'Why was the loaf late?')
            const quiet = downRows.find((row) => row.sourceMessageId === oldestDown.message.id)
            assert.equal(quiet.sourceFeedbackText ?? null, null)
            assert.equal(quiet.output, '')
            assert.ok(!downRows.some((row) => row.sourceMessageId === outside.message.id))

            const duplicate = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 30
            })
            assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body))
            assert.equal(duplicate.body.count, 1)
            assert.equal(duplicate.body.skipped, 0)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), 4)

            const upSaved = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_UP',
                days: 1,
                limit: 999
            })
            assert.equal(upSaved.status, 200, JSON.stringify(upSaved.body))
            assert.equal(upSaved.body.count, 1)
            assert.equal(upSaved.body.skipped, 0)
            const upRow = await dataSource.getRepository(DatasetRow).findOneBy({ datasetId: dataset.id, sourceMessageId: up.message.id })
            assert.equal(upRow.output, 'Yes, two loaves.')
            assert.equal(marked(upRow.needsExpectedAnswer), false)
            assert.equal(upRow.sourceRating, 'THUMBS_UP')
            assert.equal(upRow.sourceFeedbackId, up.feedback.id)
            assert.equal(upRow.sourceFeedbackText, 'Helpful.')
            assert.equal(upRow.sourceRejectedAnswer ?? null, null)
            assert.equal(upRow.sourceType, 'chat_rating')

            const dayWindow = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(dayWindow.status, 200, JSON.stringify(dayWindow.body))
            assert.equal(dayWindow.body.count, 0)
            assert.equal(dayWindow.body.skipped, 1)

            const foreignFlowCall = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: foreignFlow.id,
                rating: 'THUMBS_DOWN',
                days: 7
            })
            assert.equal(foreignFlowCall.status, 404, JSON.stringify(foreignFlowCall.body))
            const foreignDatasetCall = await api.post('/datasets/rows/from-ratings').send({
                datasetId: foreignDataset.id,
                flowId: flow.id,
                rating: 'THUMBS_UP',
                days: 7
            })
            assert.equal(foreignDatasetCall.status, 404, JSON.stringify(foreignDatasetCall.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: foreignDataset.id } }), 0)

            const asGrants = (permissions) => {
                currentUser = () => ({
                    id: MEMBER,
                    activeWorkspaceId: WORKSPACE,
                    activeOrganizationId: ORG,
                    permissions
                })
                setTeamPermissionLookup({
                    async accessFor() {
                        return { owner: false, permissions }
                    }
                })
            }
            const rowCount = await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } })
            asGrants(['datasets:view', 'chatflows:view'])
            assert.equal(
                (
                    await api.post('/datasets/rows/from-ratings').send({
                        datasetId: dataset.id,
                        flowId: flow.id,
                        rating: 'THUMBS_UP',
                        days: 7,
                        dryRun: true
                    })
                ).status,
                403
            )
            asGrants(['datasets:update'])
            assert.equal(
                (
                    await api.post('/datasets/rows/from-ratings').send({
                        datasetId: dataset.id,
                        flowId: flow.id,
                        rating: 'THUMBS_UP',
                        days: 7
                    })
                ).status,
                403
            )
            asGrants(['datasets:create', 'agentflows:view'])
            assert.equal(
                (
                    await api.post('/datasets/rows/from-ratings').send({
                        datasetId: dataset.id,
                        flowId: flow.id,
                        rating: 'THUMBS_UP',
                        days: 7
                    })
                ).status,
                403
            )
            asOwner()
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), rowCount)

            const casesBefore = await casesFromDataset(dataset.id, WORKSPACE)
            const late = casesBefore.find((item) => item.question === 'Why was the loaf late?')
            assert.equal(late.expected, '')
            const filled = await api.put(`/datasets/rows/${recentRow.id}`).send({
                input: recentRow.input,
                output: 'The carrier scan was two hours late.'
            })
            assert.equal(filled.status, 200, JSON.stringify(filled.body))
            assert.equal(filled.body.output, 'The carrier scan was two hours late.')
            assert.equal(marked(filled.body.needsExpectedAnswer), false)
            const casesAfter = await casesFromDataset(dataset.id, WORKSPACE)
            assert.equal(
                casesAfter.find((item) => item.question === 'Why was the loaf late?').expected,
                'The carrier scan was two hours late.'
            )
            assert.equal(casesAfter.find((item) => item.question === 'Is the rye in stock?').expected, 'Yes, two loaves.')

            const already = await api.post('/datasets/rows/from-message').send({
                datasetId: dataset.id,
                messageId: up.message.id,
                output: 'A different expected answer'
            })
            assert.equal(already.status, 200, JSON.stringify(already.body))
            assert.equal(already.body.id, upRow.id)
            assert.equal(already.body.output, 'Yes, two loaves.')
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('uses the same chat session and memory as a single answer, and skips an answer with no question', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const when = new Date(Date.now() - 20 * 60 * 1000)
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Session ratings',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'other session question',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'other-session',
                memoryType: 'buffer',
                createdDate: new Date(when.getTime() - 500)
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'own session question',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-1',
                memoryType: 'buffer',
                createdDate: new Date(when.getTime() - 2000)
            })
            const sessionAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'The rye is on the left.',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-1',
                memoryType: 'buffer',
                createdDate: when
            })
            await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: flow.id,
                chatId: 'chat-session',
                messageId: sessionAnswer.id,
                rating: 'THUMBS_DOWN',
                content: 'Wrong side.',
                createdDate: when
            })
            const followed = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'Still on the left.',
                chatType: 'INTERNAL',
                chatId: 'chat-session',
                sessionId: 'sess-1',
                memoryType: 'buffer',
                createdDate: new Date(when.getTime() + 1000)
            })
            await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: flow.id,
                chatId: 'chat-session',
                messageId: followed.id,
                rating: 'THUMBS_DOWN',
                content: 'Still wrong.',
                createdDate: new Date(when.getTime() + 1000)
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'null session question',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: null,
                memoryType: null,
                createdDate: new Date(when.getTime() - 3000)
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'somewhere else',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: 'somewhere',
                memoryType: 'buffer',
                createdDate: new Date(when.getTime() - 100)
            })
            const nullAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'The shop opens at four.',
                chatType: 'INTERNAL',
                chatId: 'chat-null',
                sessionId: null,
                memoryType: null,
                createdDate: new Date(when.getTime() + 2000)
            })
            await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: flow.id,
                chatId: 'chat-null',
                messageId: nullAnswer.id,
                rating: 'THUMBS_UP',
                content: 'Right.',
                createdDate: new Date(when.getTime() + 2000)
            })

            const down = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1
            })
            assert.equal(down.status, 200, JSON.stringify(down.body))
            assert.equal(down.body.count, 1)
            assert.equal(down.body.skipped, 0)
            const stored = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(stored.length, 1)
            assert.equal(stored[0].input, 'own session question')
            assert.equal(stored[0].sourceMessageId, sessionAnswer.id)
            assert.equal(stored[0].output, '')
            assert.notEqual(stored[0].input, 'other session question')

            const up = await writeRated(api, {
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_UP',
                days: 1
            })
            assert.equal(up.status, 200, JSON.stringify(up.body))
            assert.equal(up.body.count, 1)
            const nullRow = await dataSource.getRepository(DatasetRow).findOneBy({
                datasetId: dataset.id,
                sourceMessageId: nullAnswer.id
            })
            assert.equal(nullRow.input, 'null session question')
            assert.equal(nullRow.output, 'The shop opens at four.')
            assert.notEqual(nullRow.input, 'somewhere else')
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('parallel imports of the same answers do not fail or duplicate rows or sequence numbers', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const when = new Date(Date.now() - 15 * 60 * 1000)
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Parallel ratings',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const messages = []
            for (let index = 0; index < 2; index += 1) {
                const at = new Date(when.getTime() + index * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-parallel-${index}`,
                    createdDate: new Date(at.getTime() - 500)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-parallel-${index}`,
                    createdDate: at
                })
                await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-parallel-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                messages.push(answer)
            }
            const preview = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(preview.status, 200, JSON.stringify(preview.body))
            const send = () =>
                api.post('/datasets/rows/from-ratings').send({
                    datasetId: dataset.id,
                    flowId: flow.id,
                    rating: 'THUMBS_DOWN',
                    days: 1,
                    feedbackIds: preview.body.feedbackIds
                })
            const [first, second] = await Promise.all([send(), send()])
            assert.equal(first.status, 200, JSON.stringify(first.body))
            assert.equal(second.status, 200, JSON.stringify(second.body))
            assert.equal(first.body.count + first.body.skipped, 2)
            assert.equal(second.body.count + second.body.skipped, 2)
            assert.equal(first.body.count + second.body.count, 2)
            const rows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(rows.length, 2)
            assert.equal(new Set(rows.map((row) => row.sourceMessageId)).size, 2)
            assert.equal(new Set(rows.map((row) => row.sequenceNo)).size, 2)

            const single = api.post('/datasets/rows/from-message').send({
                datasetId: dataset.id,
                messageId: messages[0].id,
                output: 'The corrected answer.'
            })
            const bulk = send()
            const [singleResult, bulkResult] = await Promise.all([single, bulk])
            assert.equal(singleResult.status, 200, JSON.stringify(singleResult.body))
            assert.equal(bulkResult.status, 200, JSON.stringify(bulkResult.body))
            assert.equal(bulkResult.body.count + bulkResult.body.skipped, 2)
            const after = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(after.length, 2)
            assert.equal(new Set(after.map((row) => row.sourceMessageId)).size, 2)
            assert.equal(new Set(after.map((row) => row.sequenceNo)).size, 2)

            const other = await dataSource.getRepository(Dataset).save({
                name: 'Separate sequence',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const loneQuestionAt = new Date(when.getTime() + 10 * 1000)
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'A different question',
                chatType: 'INTERNAL',
                chatId: 'chat-lone',
                createdDate: new Date(loneQuestionAt.getTime() - 500)
            })
            const lone = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'A different answer',
                chatType: 'INTERNAL',
                chatId: 'chat-lone',
                createdDate: loneQuestionAt
            })
            const otherPreview = await api.post('/datasets/rows/from-ratings').send({
                datasetId: other.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(otherPreview.status, 200, JSON.stringify(otherPreview.body))
            const [singleOther, bulkOther] = await Promise.all([
                api.post('/datasets/rows/from-message').send({
                    datasetId: other.id,
                    messageId: lone.id,
                    output: 'The corrected answer.'
                }),
                api.post('/datasets/rows/from-ratings').send({
                    datasetId: other.id,
                    flowId: flow.id,
                    rating: 'THUMBS_DOWN',
                    days: 1,
                    feedbackIds: otherPreview.body.feedbackIds
                })
            ])
            assert.equal(singleOther.status, 200, JSON.stringify(singleOther.body))
            assert.equal(bulkOther.status, 200, JSON.stringify(bulkOther.body))
            const separate = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: other.id } })
            assert.equal(separate.length, 3)
            assert.equal(new Set(separate.map((row) => row.sourceMessageId)).size, 3)
            assert.equal(new Set(separate.map((row) => row.sequenceNo)).size, 3)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('a fresh answer saved on its own races a bulk add without duplicating the row', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const when = new Date(Date.now() - 25 * 60 * 1000)
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Fresh race',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const messages = []
            for (let index = 0; index < 2; index += 1) {
                const at = new Date(when.getTime() + index * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Fresh question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-fresh-${index}`,
                    createdDate: new Date(at.getTime() - 500)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Fresh answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-fresh-${index}`,
                    createdDate: at
                })
                await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-fresh-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                messages.push(answer)
            }
            const preview = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(preview.status, 200, JSON.stringify(preview.body))
            const [single, bulk] = await Promise.all([
                api.post('/datasets/rows/from-message').send({
                    datasetId: dataset.id,
                    messageId: messages[0].id,
                    output: 'The corrected answer.'
                }),
                api.post('/datasets/rows/from-ratings').send({
                    datasetId: dataset.id,
                    flowId: flow.id,
                    rating: 'THUMBS_DOWN',
                    days: 1,
                    feedbackIds: preview.body.feedbackIds
                })
            ])
            assert.equal(single.status, 200, JSON.stringify(single.body))
            assert.equal(bulk.status, 200, JSON.stringify(bulk.body))
            assert.equal(bulk.body.count + bulk.body.skipped, 2)
            const rows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(rows.length, 2)
            assert.equal(rows.filter((row) => row.sourceMessageId === messages[0].id).length, 1)
            assert.equal(new Set(rows.map((row) => row.sourceMessageId)).size, 2)
            assert.equal(new Set(rows.map((row) => row.sequenceNo)).size, 2)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('writes two datasets at the same time without failing', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const when = new Date(Date.now() - 20 * 60 * 1000)
        try {
            asOwner()
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const datasets = []
            for (const name of ['Left ratings', 'Right ratings']) {
                datasets.push(
                    await dataSource.getRepository(Dataset).save({
                        name,
                        description: 'Made-up rows',
                        workspaceId: WORKSPACE
                    })
                )
            }
            for (let index = 0; index < 8; index += 1) {
                const at = new Date(when.getTime() + index * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-two-${index}`,
                    createdDate: new Date(at.getTime() - 500)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-two-${index}`,
                    createdDate: at
                })
                await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-two-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
            }
            const preview = await api.post('/datasets/rows/from-ratings').send({
                datasetId: datasets[0].id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(preview.status, 200, JSON.stringify(preview.body))
            const [left, right] = await Promise.all(
                datasets.map((dataset) =>
                    api.post('/datasets/rows/from-ratings').send({
                        datasetId: dataset.id,
                        flowId: flow.id,
                        rating: 'THUMBS_DOWN',
                        days: 1,
                        feedbackIds: preview.body.feedbackIds
                    })
                )
            )
            assert.equal(left.status, 200, JSON.stringify(left.body))
            assert.equal(right.status, 200, JSON.stringify(right.body))
            assert.equal(left.body.count, 8)
            assert.equal(right.body.count, 8)
            for (const dataset of datasets) {
                const rows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
                assert.equal(rows.length, 8)
                assert.equal(new Set(rows.map((row) => row.sequenceNo)).size, 8)
            }
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('a well-formed cursor still scans when that rating is on another flow', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const when = new Date(Date.now() - 30 * 60 * 1000)
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Cursor scope',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const other = await dataSource.getRepository(ChatFlow).save({
                name: 'Other desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: other.id,
                content: 'Other question',
                chatType: 'INTERNAL',
                chatId: 'chat-other-flow',
                createdDate: new Date(when.getTime() - 1000)
            })
            const answer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: other.id,
                content: 'Other answer',
                chatType: 'INTERNAL',
                chatId: 'chat-other-flow',
                createdDate: when
            })
            const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: other.id,
                chatId: 'chat-other-flow',
                messageId: answer.id,
                rating: 'THUMBS_DOWN',
                content: 'No.',
                createdDate: when
            })
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true,
                cursor: { createdDate: storedClock(when), id: feedback.id }
            })
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(result.body.count, 0)
            assert.equal(result.body.truncated, false)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), 0)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('a row deleted from an earlier page does not skip a later rating', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Keyset page',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const feedbacks = []
            for (let index = 0; index < 4; index += 1) {
                const at = new Date(now - index * 60 * 60 * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-key-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-key-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-key-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                feedbacks.push(feedback)
            }
            let deleted = false
            setRatingScanTestHook({
                pageSize: 2,
                afterPage: async (page) => {
                    if (deleted) return
                    deleted = true
                    await dataSource.getRepository(ChatMessageFeedback).delete({ id: page[0].id })
                }
            })
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(deleted, true)
            assert.equal(result.body.truncated, false)
            for (const feedback of feedbacks) {
                assert.equal(result.body.feedbackIds.includes(feedback.id), true)
            }
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('a write with more rating ids than the limit is rejected', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Over the limit',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const ids = []
            for (let index = 0; index < 2; index += 1) {
                const at = new Date(now - (index + 1) * 60 * 60 * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-cap-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-cap-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-cap-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                ids.push(feedback.id)
            }
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 1,
                feedbackIds: ids
            })
            assert.equal(result.status, 400, JSON.stringify(result.body))
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), 0)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('deleting the last rating of a page does not drop the older ratings', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Deleted anchor',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const feedbacks = []
            for (let index = 0; index < 4; index += 1) {
                const at = new Date(now - index * 60 * 60 * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-anchor-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-anchor-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-anchor-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                feedbacks.push(feedback)
            }
            let deleted = false
            setRatingScanTestHook({
                pageSize: 2,
                afterPage: async (page) => {
                    if (deleted) return
                    deleted = true
                    await dataSource.getRepository(ChatMessageFeedback).delete({ id: page[page.length - 1].id })
                }
            })
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(deleted, true)
            assert.equal(result.body.truncated, false)
            assert.equal(result.body.feedbackIds.length, 4)
            for (const feedback of feedbacks) {
                assert.equal(result.body.feedbackIds.includes(feedback.id), true)
            }
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('a second request keeps same-millisecond ratings after the anchor is deleted', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            await assertSecondRequestKeepsSameMillisecond(dataSource, api)
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('deleting the last rating after the page loads still returns its stored time', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            await assertCursorTextSurvivesDeleteAfterPageLoad(dataSource, api)
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('a second request keeps same-millisecond ratings after the anchor is deleted on postgres', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres evaluation routes: PGPASSWORD is unset')
            return
        }
        const { Client } = serverRequire('pg')
        const name = `cuttlely_eval_page2_${process.pid}`
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
            appHandle.AppDataSource = dataSource
            asOwner()
            await seed(dataSource)
            await assertSecondRequestKeepsSameMillisecond(dataSource, request(httpApp()))
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })

    it('deleting the last rating after the page loads still returns its stored time on postgres', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres evaluation routes: PGPASSWORD is unset')
            return
        }
        const { Client } = serverRequire('pg')
        const name = `cuttlely_eval_pagetext_${process.pid}`
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
            appHandle.AppDataSource = dataSource
            asOwner()
            await seed(dataSource)
            await assertCursorTextSurvivesDeleteAfterPageLoad(dataSource, request(httpApp()))
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })

    it('deleting the client cursor after it is checked does not drop ratings in that millisecond', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            await assertClientCursorDeletedBeforePage(dataSource, api)
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('deleting the client cursor after it is checked does not drop ratings in that millisecond on postgres', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres evaluation routes: PGPASSWORD is unset')
            return
        }
        const { Client } = serverRequire('pg')
        const name = `cuttlely_eval_cursor_${process.pid}`
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
            appHandle.AppDataSource = dataSource
            asOwner()
            await seed(dataSource)
            await assertClientCursorDeletedBeforePage(dataSource, request(httpApp()))
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })

    it('deleting a microsecond anchor between pages does not drop the other ratings in that millisecond', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        try {
            await assertDeletedMicrosecondAnchor(dataSource, api)
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            await cleanup()
        }
    })

    it('deleting a microsecond anchor between pages does not drop the other ratings in that millisecond on postgres', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres evaluation routes: PGPASSWORD is unset')
            return
        }
        const { Client } = serverRequire('pg')
        const name = `cuttlely_eval_anchor_${process.pid}`
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
            appHandle.AppDataSource = dataSource
            asOwner()
            await seed(dataSource)
            await assertDeletedMicrosecondAnchor(dataSource, request(httpApp()))
        } finally {
            setRatingScanTestHook(null)
            asOwner()
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })

    it('a continuation keeps ratings that share a timestamp', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Same instant',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const make = async (index, at) => {
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-instant-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-instant-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-instant-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                return { answer, feedback }
            }
            const same = []
            for (let index = 0; index < 3; index += 1) {
                same.push(await make(index, new Date(now - 2 * 60 * 60 * 1000)))
            }
            const [stored] = await dataSource.query(`SELECT "createdDate" AS "createdDate" FROM "chat_message_feedback" WHERE "id" = ?`, [
                same[0].feedback.id
            ])
            for (const item of same) {
                await dataSource.query(`UPDATE "chat_message_feedback" SET "createdDate" = ? WHERE "id" = ?`, [
                    stored.createdDate,
                    item.feedback.id
                ])
            }
            const newestId = same
                .map((item) => item.feedback.id)
                .sort()
                .reverse()[0]
            const first = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 1,
                dryRun: true
            })
            assert.equal(first.status, 200, JSON.stringify(first.body))
            assert.equal(first.body.count, 1)
            assert.equal(first.body.truncated, true)
            assert.equal(first.body.cursor.id, newestId)
            const rest = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true,
                cursor: first.body.cursor
            })
            assert.equal(rest.status, 200, JSON.stringify(rest.body))
            assert.equal(rest.body.count, 2)
            const restIds = new Set(rest.body.preview.map((item) => item.messageId).concat(rest.body.feedbackIds))
            for (const item of same) {
                if (item.feedback.id === newestId) continue
                assert.equal(rest.body.feedbackIds.includes(item.feedback.id), true)
            }
            assert.equal(restIds.size >= 2, true)

            await dataSource.query(`DELETE FROM "chat_message_feedback" WHERE "id" IN (?, ?, ?)`, [
                same[0].feedback.id,
                same[1].feedback.id,
                same[2].feedback.id
            ])
            const fraction = storedFraction(new Date(now - 3 * 60 * 60 * 1000))
            const fine = []
            for (let index = 0; index < 3; index += 1) {
                fine.push(await make(10 + index, new Date(now - 3 * 60 * 60 * 1000)))
            }
            const digits = ['123456', '123400', '123000']
            for (let index = 0; index < fine.length; index += 1) {
                await dataSource.query(`UPDATE "chat_message_feedback" SET "createdDate" = ? WHERE "id" = ?`, [
                    `${fraction}.${digits[index]}`,
                    fine[index].feedback.id
                ])
            }
            const headed = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 1,
                dryRun: true
            })
            assert.equal(headed.status, 200, JSON.stringify(headed.body))
            assert.equal(headed.body.feedbackIds[0], fine[0].feedback.id)
            const inside = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true,
                cursor: headed.body.cursor
            })
            assert.equal(inside.status, 200, JSON.stringify(inside.body))
            assert.equal(inside.body.feedbackIds.includes(fine[1].feedback.id), true)
            assert.equal(inside.body.feedbackIds.includes(fine[2].feedback.id), true)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('an add writes the previewed ratings when a newer rating arrives', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Preview window',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const rated = async (index, at) => {
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-preview-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-preview-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-preview-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                return { answer, feedback }
            }
            const original = await rated(1, new Date(now - 2 * 60 * 60 * 1000))
            const preview = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 1,
                dryRun: true
            })
            assert.equal(preview.status, 200, JSON.stringify(preview.body))
            assert.deepEqual(preview.body.feedbackIds, [original.feedback.id])
            const arrived = await rated(2, new Date(now - 60 * 1000))
            const added = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 1,
                dryRun: false,
                feedbackIds: preview.body.feedbackIds
            })
            assert.equal(added.status, 200, JSON.stringify(added.body))
            assert.equal(added.body.count, 1)
            const rows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            assert.equal(rows.length, 1)
            assert.equal(rows[0].sourceMessageId, original.answer.id)
            assert.equal(
                rows.some((row) => row.sourceMessageId === arrived.answer.id),
                false
            )
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('a limit that stops mid-page continues from the last rating it read', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Mid page',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const feedbacks = []
            for (let index = 0; index < 5; index += 1) {
                const at = new Date(now - index * 60 * 60 * 1000)
                await dataSource.getRepository(ChatMessage).save({
                    role: 'userMessage',
                    chatflowid: flow.id,
                    content: `Question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-mid-${index}`,
                    createdDate: new Date(at.getTime() - 1000)
                })
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `Answer ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-mid-${index}`,
                    createdDate: at
                })
                const feedback = await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-mid-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    content: 'No.',
                    createdDate: at
                })
                feedbacks.push({ answer, feedback })
            }
            await dataSource.getRepository(DatasetRow).save({
                datasetId: dataset.id,
                input: 'Question 0',
                output: '',
                sequenceNo: 0,
                sourceType: 'chat_rating',
                sourceMessageId: feedbacks[0].answer.id,
                sourceFlowId: flow.id,
                sourceFeedbackId: feedbacks[0].feedback.id,
                sourceRating: 'THUMBS_DOWN',
                needsExpectedAnswer: true
            })
            const first = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                limit: 2,
                dryRun: true
            })
            assert.equal(first.status, 200, JSON.stringify(first.body))
            assert.equal(first.body.count, 2)
            assert.equal(first.body.skipped, 1)
            assert.equal(first.body.truncated, true)
            assert.equal(first.body.cursor.id, feedbacks[2].feedback.id)
            assert.notEqual(first.body.cursor.id, feedbacks[4].feedback.id)
            const tail = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true,
                cursor: first.body.cursor
            })
            assert.equal(tail.status, 200, JSON.stringify(tail.body))
            const continued = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                feedbackIds: tail.body.feedbackIds
            })
            assert.equal(continued.status, 200, JSON.stringify(continued.body))
            assert.equal(continued.body.count, 2)
            const rows = await dataSource.getRepository(DatasetRow).find({ where: { datasetId: dataset.id } })
            const storedIds = new Set(rows.map((row) => row.sourceMessageId))
            assert.equal(storedIds.has(feedbacks[3].answer.id), true)
            assert.equal(storedIds.has(feedbacks[4].answer.id), true)
            assert.equal(rows.length, 3)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('does not call an exact scan cap truncated when nothing older remains', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Exact window',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            for (let index = 0; index < getRatingScanCap(); index += 1) {
                const at = new Date(now - index)
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `No question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-exact-${index}`,
                    createdDate: at
                })
                await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-exact-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    createdDate: at
                })
            }
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(result.body.count, 0)
            assert.equal(result.body.truncated, false)
            assert.equal(result.body.cursor, null)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), 0)
        } finally {
            asOwner()
            await cleanup()
        }
    })

    it('stops scanning a window of question-less ratings and says so', async () => {
        const { dataSource, api, cleanup } = await openSqlite()
        const now = Date.now()
        try {
            asOwner()
            const dataset = await dataSource.getRepository(Dataset).save({
                name: 'Long window',
                description: 'Made-up rows',
                workspaceId: WORKSPACE
            })
            const flow = await dataSource.getRepository(ChatFlow).save({
                name: 'Bakery desk',
                flowData: '{}',
                type: 'CHATFLOW',
                workspaceId: WORKSPACE
            })
            const older = new Date(now - 3 * 60 * 60 * 1000)
            await dataSource.getRepository(ChatMessage).save({
                role: 'userMessage',
                chatflowid: flow.id,
                content: 'The question past the scan',
                chatType: 'INTERNAL',
                chatId: 'chat-older',
                createdDate: new Date(older.getTime() - 1000)
            })
            const olderAnswer = await dataSource.getRepository(ChatMessage).save({
                role: 'apiMessage',
                chatflowid: flow.id,
                content: 'An older answer',
                chatType: 'INTERNAL',
                chatId: 'chat-older',
                createdDate: older
            })
            await dataSource.getRepository(ChatMessageFeedback).save({
                chatflowid: flow.id,
                chatId: 'chat-older',
                messageId: olderAnswer.id,
                rating: 'THUMBS_DOWN',
                content: 'No.',
                createdDate: older
            })
            for (let index = 0; index < getRatingScanCap(); index += 1) {
                const at = new Date(now - index)
                const answer = await dataSource.getRepository(ChatMessage).save({
                    role: 'apiMessage',
                    chatflowid: flow.id,
                    content: `No question ${index}`,
                    chatType: 'INTERNAL',
                    chatId: `chat-empty-${index}`,
                    createdDate: at
                })
                await dataSource.getRepository(ChatMessageFeedback).save({
                    chatflowid: flow.id,
                    chatId: `chat-empty-${index}`,
                    messageId: answer.id,
                    rating: 'THUMBS_DOWN',
                    createdDate: at
                })
            }
            const result = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(result.body.truncated, true)
            assert.equal(result.body.count, 0)
            assert.equal(typeof result.body.cursor?.id, 'string')
            assert.ok(result.body.cursor.createdDate)
            assert.equal(await dataSource.getRepository(DatasetRow).count({ where: { datasetId: dataset.id } }), 0)

            const continued = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true,
                cursor: result.body.cursor
            })
            assert.equal(continued.status, 200, JSON.stringify(continued.body))
            assert.equal(continued.body.truncated, false)
            assert.equal(continued.body.cursor, null)
            assert.equal(continued.body.count, 1)
            assert.equal(continued.body.preview[0].messageId, olderAnswer.id)
            assert.equal(continued.body.preview[0].input, 'The question past the scan')
            const written = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                feedbackIds: continued.body.feedbackIds
            })
            assert.equal(written.status, 200, JSON.stringify(written.body))
            assert.equal(written.body.count, 1)
            const stored = await dataSource.getRepository(DatasetRow).findOneBy({
                datasetId: dataset.id,
                sourceMessageId: olderAnswer.id
            })
            assert.ok(stored)
            assert.equal(stored.input, 'The question past the scan')

            const again = await api.post('/datasets/rows/from-ratings').send({
                datasetId: dataset.id,
                flowId: flow.id,
                rating: 'THUMBS_DOWN',
                days: 1,
                dryRun: true
            })
            assert.equal(again.status, 200, JSON.stringify(again.body))
            assert.equal(again.body.count, 0)
            assert.equal(again.body.truncated, true)
        } finally {
            asOwner()
            await cleanup()
        }
    })
})
