// A pipeline edit is a draft. Scheduled runs, a run you start, and a full rebuild read the Live
// pipeline version until Publish (or a chatflow API save, which still writes Live) records a new one.
// Preview runs the draft canvas and does not write the store. Jest cannot load the ESM pipeline
// package, so those calls run in a Node child process.
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-pipeline-draft-'))
const previousData = process.env.CUTTLELY_DATA_DIR
const previousEtl = process.env.CUTTLELY_ETL_DIR
const previousRoots = process.env.CUTTLELY_ETL_ROOTS
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_ETL_DIR = path.join(dataDir, 'etl')
process.env.CUTTLELY_ETL_ROOTS = dataDir
process.env.CUTTLELY_DRAFTS = 'on'

const rows: any[] = []
const chats: any[] = []
const fakeRepo = {
    findOneBy: jest.fn(async (where: any) => rows.find((row) => row.chatflowId === where.chatflowId) || null),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (row: any) => {
        const index = rows.findIndex((item) => item.chatflowId === row.chatflowId)
        const saved = { id: row.id || `state-${rows.length + 1}`, ...row }
        if (index >= 0) rows[index] = saved
        else rows.push(saved)
        return saved
    }),
    update: jest.fn(async (where: any, patch: any) => {
        const matches = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
        for (const row of matches) Object.assign(row, patch)
        return { affected: matches.length }
    }),
    delete: jest.fn()
}
const chatRepo = {
    findOneBy: jest.fn(async (where: any) => chats.find((row) => row.id === where.id) || null)
}
const repositoryFor = (entity: { name?: string }) => (entity?.name === 'ChatFlow' ? chatRepo : fakeRepo)
const manager = { getRepository: repositoryFor }
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: repositoryFor, transaction: async (fn: any) => fn(manager) },
        usageCacheManager: {}
    })
}))
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: () => false,
    updateFlowDataWithFilePaths: async (_id: string, flowData: string) => flowData
}))

import { afterLiveSet, discardDraft, draftToPublish, getDraftStatus, saveDraft } from './index'

const ROOT = path.resolve(__dirname, '../../../../..')
const ID = 'flow-1'
const WS = 'team-a'
const NAME = 'Outdoor Catalog'
const liveFile = path.join(dataDir, 'live.csv')
const draftFile = path.join(dataDir, 'draft.csv')
const apiFile = path.join(dataDir, 'api.csv')

const pipeline = (file: string, collection: string) =>
    JSON.stringify({
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            { id: 'tx', data: { name: 'etlTransform', label: 'Clean & Transform', category: 'ETL', inputs: { minChars: 1 } } },
            {
                id: 'emb',
                data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 64 } }
            },
            {
                id: 'vs',
                data: { name: 'etlLocalVectorStore', label: 'Local Vector Store', category: 'Vector Stores', inputs: { collection } }
            }
        ],
        edges: [
            { source: 'src', target: 'tx' },
            { source: 'tx', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    })

const LIVE = pipeline(liveFile, 'live-catalog')
const DRAFT = pipeline(draftFile, 'draft-catalog')
const API = pipeline(apiFile, 'api-catalog')
const flow = () => ({ id: ID, type: 'ETL', flowData: LIVE, workspaceId: WS, name: NAME })
const context = { userId: 'user-1', orgId: 'org-1', subscriptionId: 'sub-1' }

afterAll(() => {
    restoreEnv('CUTTLELY_DATA_DIR', previousData)
    restoreEnv('CUTTLELY_ETL_DIR', previousEtl)
    restoreEnv('CUTTLELY_ETL_ROOTS', previousRoots)
    fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
    rows.length = 0
    chats.length = 0
    chats.push({ id: ID, type: 'ETL', workspaceId: WS })
})

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

function etl(body: string, canvas?: string) {
    const apiUrl = pathToFileURL(path.join(ROOT, 'packages/etl/api.mjs')).href
    const versionsUrl = pathToFileURL(path.join(ROOT, 'packages/etl/versions.mjs')).href
    const runsUrl = pathToFileURL(path.join(ROOT, 'packages/etl/runs.mjs')).href
    const dbUrl = pathToFileURL(path.join(ROOT, 'packages/etl/db.mjs')).href
    const script = [
        `import * as api from ${JSON.stringify(apiUrl)};`,
        `import { getVersion, latestVersion, pipelineStats, recordVersion } from ${JSON.stringify(versionsUrl)};`,
        `import { getRun } from ${JSON.stringify(runsUrl)};`,
        `import { stmt } from ${JSON.stringify(dbUrl)};`,
        `const ID = ${JSON.stringify(ID)};`,
        `const WS = ${JSON.stringify(WS)};`,
        `const NAME = ${JSON.stringify(NAME)};`,
        `const collectionOf = (flowData) => {`,
        `  const node = JSON.parse(flowData).nodes.find((item) => item.data.name === 'etlLocalVectorStore');`,
        `  return node.data.inputs.collection;`,
        `};`,
        `const pinned = (version) => {`,
        `  const row = getVersion(ID, version, { withFlow: true });`,
        `  return { version: row.version, collection: collectionOf(row.flowData) };`,
        `};`,
        `const serving = () => {`,
        `  const row = latestVersion(ID, { withFlow: true });`,
        `  return { version: row.version, collection: collectionOf(row.flowData), chunks: pipelineStats(ID).chunks, problems: row.problems?.problems || [] };`,
        `};`,
        `const out = await (async () => { ${body} })();`,
        `process.stdout.write('__ETL__' + JSON.stringify(out));`
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CUTTLELY_DATA_DIR: dataDir,
            CUTTLELY_ETL_DIR: path.join(dataDir, 'etl'),
            CUTTLELY_ETL_ROOTS: dataDir,
            ...(canvas !== undefined ? { CANVAS: canvas } : {})
        },
        encoding: 'utf8'
    })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `etl exited ${result.status}`)
    const marker = result.stdout.lastIndexOf('__ETL__')
    if (marker < 0) throw new Error(result.stderr || result.stdout || 'etl returned no result')
    return JSON.parse(result.stdout.slice(marker + '__ETL__'.length))
}

beforeAll(() => {
    fs.writeFileSync(liveFile, 'sku,name,notes\nLIVE,Live tent,live-catalog-token\n')
    fs.writeFileSync(draftFile, 'sku,name,notes\nDRAFT,Draft stove,draft-catalog-token\n')
    fs.writeFileSync(apiFile, 'sku,name,notes\nAPI,Api mug,api-catalog-token\n')
})

describe('pipeline Live and drafts', () => {
    test('an edit does not change what a scheduled run or a full rebuild reads until Publish, and rollback switches it back', async () => {
        const recorded = etl(
            `
            const saved = recordVersion({ id: ID, name: NAME, workspaceId: WS, flowData: process.env.CANVAS });
            return { problems: saved.problems, ...serving() };
        `,
            LIVE
        )
        expect(recorded.problems).toEqual([])
        expect(recorded).toMatchObject({ version: 1, collection: 'live-catalog', chunks: 0 })

        const existing = flow()
        expect(await getDraftStatus(existing)).toMatchObject({ mode: 'draft', draft: null, lastPublished: null })
        const status = await saveDraft(existing, DRAFT, context)
        const stamped = status.draft?.flowData || ''
        expect(existing.flowData).toBe(LIVE)
        expect(stamped).toContain('"collection":"draft-catalog"')
        expect(stamped).not.toBe(LIVE)
        expect(etl(`return serving();`)).toMatchObject({ version: 1, collection: 'live-catalog', chunks: 0 })

        const preview = etl(
            `
            const result = await api.previewPipeline({ pipelineId: ID, flowData: process.env.CANVAS, limit: 5, embed: false, ctx: { workspaceId: WS } });
            const sample = (result.steps?.load?.samples || []).map((row) => row.pageContent).join('\\n');
            return { sample, problems: result.problems, ...serving() };
        `,
            DRAFT
        )
        expect(preview.problems).toEqual([])
        expect(preview.sample).toContain('draft-catalog-token')
        expect(preview.sample).not.toContain('live-catalog-token')
        expect(preview).toMatchObject({ version: 1, collection: 'live-catalog', chunks: 0 })

        const scheduled = etl(`
            const created = api.createSchedule(ID, { kind: 'interval', every: 60, unit: 'minutes', mode: 'incremental' });
            stmt('UPDATE schedules SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', created.id);
            const outcomes = api.tickSchedules();
            const started = outcomes.find((item) => item.outcome === 'started');
            if (!started) return { outcomes };
            await api.waitForIdle();
            const run = getRun(started.runId);
            return { status: run.status, error: run.error, ...pinned(run.version), chunks: pipelineStats(ID).chunks };
        `)
        expect(scheduled).toMatchObject({ status: 'succeeded', version: 1, collection: 'live-catalog' })
        expect(scheduled.chunks).toBeGreaterThan(0)

        const rebuild = etl(`
            const started = api.startRun(ID, { mode: 'full', settings: { batchSize: 8, concurrency: 1, maxRetries: 0, maxErrors: 1 } });
            await api.waitForIdle();
            const run = getRun(started.id);
            return { status: run.status, error: run.error, mode: run.mode, ...pinned(run.version) };
        `)
        expect(rebuild).toMatchObject({ status: 'succeeded', mode: 'full', version: 1, collection: 'live-catalog' })

        const published = flow()
        published.flowData = await draftToPublish(published)
        expect(published.flowData).toBe(stamped)
        const afterPublishSync = etl(
            `
            const saved = recordVersion({ id: ID, name: NAME, workspaceId: WS, flowData: process.env.CANVAS });
            const started = api.startRun(ID, { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0, maxErrors: 1 } });
            await api.waitForIdle();
            const run = getRun(started.id);
            return { problems: saved.problems, status: run.status, error: run.error, ...pinned(run.version) };
        `,
            stamped
        )
        expect(afterPublishSync.problems).toEqual([])
        expect(afterPublishSync).toMatchObject({ status: 'succeeded', version: 2, collection: 'draft-catalog' })
        const afterPublish = await afterLiveSet(published, 'a'.repeat(40), stamped)
        expect(afterPublish.draft).toBeNull()
        expect(afterPublish.lastPublished?.sha).toBe('a'.repeat(40))

        const newer = await saveDraft(published, pipeline(draftFile, 'newer-catalog'), context)
        const rolled = flow()
        rolled.flowData = LIVE
        const afterRollbackSync = etl(
            `
            recordVersion({ id: ID, name: NAME, workspaceId: WS, flowData: process.env.CANVAS });
            const started = api.startRun(ID, { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0, maxErrors: 1 } });
            await api.waitForIdle();
            const run = getRun(started.id);
            return { status: run.status, error: run.error, ...pinned(run.version), serving: serving() };
        `,
            LIVE
        )
        expect(afterRollbackSync).toMatchObject({
            status: 'succeeded',
            version: 3,
            collection: 'live-catalog',
            serving: { version: 3, collection: 'live-catalog' }
        })
        const afterRollback = await afterLiveSet(rolled, 'b'.repeat(40))
        expect(afterRollback.draft?.flowData).toBe(newer.draft?.flowData)
        expect(afterRollback.draft?.flowData).toContain('"collection":"newer-catalog"')
        expect(afterRollback.draft?.stale).toBe(false)
    }, 120000)

    test('PUT /api/v1/chatflows still writes Live while a draft is open', async () => {
        etl(`recordVersion({ id: ID, name: NAME, workspaceId: WS, flowData: process.env.CANVAS }); return serving();`, LIVE)
        const saved = await saveDraft(flow(), DRAFT, context)
        const wrote = etl(
            `
            recordVersion({ id: ID, name: NAME, workspaceId: WS, flowData: process.env.CANVAS });
            return serving();
        `,
            API
        )
        expect(wrote.collection).toBe('api-catalog')
        expect(rows[0].draftFlowData).toBe(saved.draft?.flowData)
        expect(rows[0].draftFlowData).toContain('"collection":"draft-catalog"')
        expect((await getDraftStatus(flow())).draft?.flowData).toContain('"collection":"draft-catalog"')
    })

    test('preview of the draft writes nothing, and discarding the draft leaves the published pipeline alone', async () => {
        const before = etl(`return serving();`)
        await saveDraft(flow(), DRAFT, context)
        const preview = etl(
            `
            const chunksBefore = pipelineStats(ID).chunks;
            await api.previewPipeline({ pipelineId: ID, flowData: process.env.CANVAS, limit: 5, ctx: { workspaceId: WS } });
            return { chunksBefore, ...serving() };
        `,
            DRAFT
        )
        expect(preview.chunks).toBe(preview.chunksBefore)
        expect(preview.collection).toBe(before.collection)
        expect(preview.version).toBe(before.version)
        const snapshot = etl(`return serving();`)
        expect((await discardDraft(flow())).draft).toBeNull()
        expect(etl(`return serving();`)).toEqual(snapshot)
    })

    test('the chatflow save syncs a pipeline and a draft save does not', () => {
        const chatflows = fs.readFileSync(path.join(__dirname, '../chatflows/index.ts'), 'utf8')
        const updateStart = chatflows.indexOf('const updateChatflow')
        const updateEnd = chatflows.indexOf('async function validateEtlCanvas')
        expect(chatflows.slice(updateStart, updateEnd)).toContain('await syncEtlCanvas(dbResponse)')
        const drafts = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
        expect(drafts.includes('syncEtlCanvas')).toBe(false)
        expect(drafts.includes('recordVersion')).toBe(false)
    })
})
