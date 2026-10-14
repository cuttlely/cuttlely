// SQLite has one connection and no row lock. Nine first draft saves and one settings
// write for a flow with no state row must all succeed, leave one row, keep the gate,
// and keep one of those drafts.
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createRequire, Module } = require('node:module')
const { describe, it, after } = require('node:test')

process.env.LOG_PATH = mkdtempSync(path.join(tmpdir(), 'cuttlely-draft-race-logs-'))

const app = { AppDataSource: null, usageCacheManager: {}, nodesPool: {} }
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

const componentsStub = {
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
        return { getRunningExpressApp: () => app }
    }
    return originalLoad.call(this, request, parent, isMain)
}

const { DataSource } = serverRequire('typeorm')
const { ChatFlow } = serverRequire('./src/database/entities/ChatFlow.ts')
const { FlowVersionState } = serverRequire('./src/database/entities/FlowVersionState.ts')
const { Dataset } = serverRequire('./src/database/entities/Dataset.ts')
const { DatasetRow } = serverRequire('./src/database/entities/DatasetRow.ts')
const { Evaluator } = serverRequire('./src/database/entities/Evaluator.ts')
const { saveDraft, updateDraftSettings } = serverRequire('./src/services/flow-drafts/index.ts')
Module._load = originalLoad

const canvas = (label) => JSON.stringify({ nodes: [{ id: 'n1', data: { label } }], edges: [] })
const FLOW = 'flow-sqlite-race'
const context = { userId: 'user-1', orgId: 'org-1', subscriptionId: 'sub-1' }

describe('SQLite first state writes', () => {
    let dir
    let dataSource

    after(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('keeps the gate and one draft when nine draft saves and one settings write start together', async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-draft-race-'))
        dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'database.sqlite'),
            synchronize: true,
            entities: [ChatFlow, FlowVersionState, Dataset, DatasetRow, Evaluator]
        })
        await dataSource.initialize()
        app.AppDataSource = dataSource
        const live = canvas('Live')
        await dataSource.getRepository(ChatFlow).save({
            id: FLOW,
            name: 'Bakery',
            flowData: live,
            type: 'CHATFLOW',
            workspaceId: 'team-a'
        })
        await dataSource.getRepository(Dataset).save({
            id: 'ds-1',
            name: 'Rows',
            description: 'Made-up rows',
            workspaceId: 'team-a'
        })
        await dataSource.getRepository(DatasetRow).save({
            id: 'row-1',
            datasetId: 'ds-1',
            input: 'Do you have rye?',
            output: 'Yes',
            sequenceNo: 1
        })
        await dataSource.getRepository(Evaluator).save({
            id: 'ev-1',
            name: 'Yes',
            type: 'text',
            config: JSON.stringify({ operator: 'Contains', value: 'Yes' }),
            workspaceId: 'team-a'
        })

        const drafts = Array.from({ length: 9 }, (_, index) => canvas(`Draft ${index}`))
        const flow = { id: FLOW, type: 'CHATFLOW', flowData: live, workspaceId: 'team-a' }
        const results = await Promise.all(
            [
                ...drafts.map((flowData) => saveDraft(flow, flowData, context)),
                updateDraftSettings(flow, {
                    publishGate: { enabled: true, datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 80 }
                })
            ].map(async (pending) => {
                try {
                    await pending
                    return { ok: true }
                } catch (error) {
                    return { ok: false, statusCode: error.statusCode, message: error.message }
                }
            })
        )

        const failed = results.filter((result) => !result.ok)
        assert.deepEqual(failed, [], `every first save should succeed, got ${JSON.stringify(failed)}`)
        const rows = await dataSource.getRepository(FlowVersionState).find({ where: { chatflowId: FLOW } })
        assert.equal(rows.length, 1)
        assert.equal(Boolean(rows[0].publishGate), true)
        assert.equal(rows[0].publishGateDatasetId, 'ds-1')
        assert.deepEqual(JSON.parse(rows[0].publishGateEvaluatorIds), ['ev-1'])
        assert.equal(Number(rows[0].publishGateThreshold), 80)
        assert.ok(drafts.includes(rows[0].draftFlowData), `draft missing from the nine saves: ${rows[0].draftFlowData}`)
    })
})
