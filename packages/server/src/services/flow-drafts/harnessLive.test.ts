// A harness edit is a draft. The roster POST /api/v1/harnesses/:name/runs reads stays the Live canvas
// until Publish (or a chatflow API save, which still writes Live) syncs it. Roll back syncs an older canvas.
// Jest cannot load the ESM harness package, so the roster sync runs in a Node child process.
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-harness-draft-'))
const previousData = process.env.CUTTLELY_DATA_DIR
const previousHermes = process.env.CUTTLELY_HERMES_HOME
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'hermes')
process.env.CUTTLELY_DRAFTS = 'on'
process.env.CUTTLELY_WARM_HERMES = 'false'

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
jest.mock('./harnessLimits', () => ({ assertHarnessDraftLimits: async () => undefined }))

import { afterLiveSet, discardDraft, draftToPublish, getDraftStatus, saveDraft } from './index'

const NAME = 'bakery-team'
const ROOT = path.resolve(__dirname, '../../../../..')
const canvas = (instructions: string) =>
    JSON.stringify({
        nodes: [
            {
                id: 'chief_0',
                data: { name: 'harnessChief', label: 'Harness Prime', category: 'Harness', inputs: { instructions } }
            },
            {
                id: 'model_0',
                data: { name: 'demoChat', label: 'Demo chat', category: 'Chat Models', inputs: { modelName: 'demo' } }
            },
            {
                id: 'spec_0',
                data: {
                    name: 'harnessSpecialist',
                    label: 'Harness Specialist',
                    category: 'Harness',
                    inputs: { specialistName: 'math', instructions: 'Return the calculator number.' }
                }
            }
        ],
        edges: [
            { id: 'e1', source: 'model_0', target: 'chief_0', targetHandle: 'chief_0-input-chatModel' },
            { id: 'e2', source: 'spec_0', target: 'chief_0', targetHandle: 'chief_0-input-specialists' }
        ]
    })

const LIVE = canvas('Live instructions')
const DRAFT = canvas('Draft instructions')
const API = canvas('API instructions')
const flow = () => ({ id: 'flow-1', type: 'HARNESS', flowData: LIVE, workspaceId: 'team-a', name: NAME })
const context = { userId: 'user-1', orgId: 'org-1', subscriptionId: 'sub-1' }

afterAll(() => {
    restoreEnv('CUTTLELY_DATA_DIR', previousData)
    restoreEnv('CUTTLELY_HERMES_HOME', previousHermes)
    fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
    rows.length = 0
    chats.length = 0
    chats.push({ id: 'flow-1', type: 'HARNESS', workspaceId: 'team-a' })
    fs.rmSync(path.join(dataDir, 'harnesses'), { recursive: true, force: true })
    fs.rmSync(path.join(dataDir, 'hermes'), { recursive: true, force: true })
})

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

// What Publish and a chatflow PUT do after they write Live: sync the roster runs read.
function rosterInstructions(flowData: string) {
    const syncUrl = pathToFileURL(path.join(ROOT, 'packages/harness/sync-from-flow.mjs')).href
    const script = [
        `import { rosterFromFlow } from ${JSON.stringify(syncUrl)};`,
        `const roster = rosterFromFlow({ name: ${JSON.stringify(
            NAME
        )}, chatflowId: 'flow-1', workspaceId: 'team-a', flowData: process.env.CANVAS });`,
        `process.stdout.write(roster.chief.instructions);`
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CUTTLELY_DATA_DIR: dataDir,
            CUTTLELY_HERMES_HOME: path.join(dataDir, 'hermes'),
            CUTTLELY_WARM_HERMES: 'false',
            CANVAS: flowData
        },
        encoding: 'utf8'
    })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `roster exited ${result.status}`)
    return result.stdout
}

function syncLive(flowData: string) {
    const syncUrl = pathToFileURL(path.join(ROOT, 'packages/harness/sync-from-flow.mjs')).href
    const storeUrl = pathToFileURL(path.join(ROOT, 'packages/harness/store.mjs')).href
    const script = [
        `import { syncHarnessFromFlow } from ${JSON.stringify(syncUrl)};`,
        `import { getHarness } from ${JSON.stringify(storeUrl)};`,
        `await syncHarnessFromFlow({ name: ${JSON.stringify(
            NAME
        )}, chatflowId: 'flow-1', workspaceId: 'team-a', flowData: process.env.CANVAS });`,
        `process.stdout.write(getHarness(${JSON.stringify(NAME)}).chief.instructions);`
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CUTTLELY_DATA_DIR: dataDir,
            CUTTLELY_HERMES_HOME: path.join(dataDir, 'hermes'),
            CUTTLELY_WARM_HERMES: 'false',
            CANVAS: flowData
        },
        encoding: 'utf8'
    })
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `harness sync exited ${result.status}`)
    }
    return result.stdout
}

describe('harness Live and drafts', () => {
    test('an existing harness is Live version 1: the roster and canvas stay, and the first edit is a draft', async () => {
        expect(syncLive(LIVE)).toBe('Live instructions')
        const existing = flow()
        expect(await getDraftStatus(existing)).toMatchObject({ mode: 'draft', draft: null, lastPublished: null })

        const before = fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')
        const status = await saveDraft(existing, DRAFT, context)
        expect(existing.flowData).toBe(LIVE)
        expect(status.draft?.flowData).toBe(DRAFT)
        expect(fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')).toBe(before)
    })

    test('Publish switches the roster runs serve, and Roll back switches it back without dropping the draft', async () => {
        syncLive(LIVE)
        await saveDraft(flow(), DRAFT, context)
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')).chief.instructions).toBe(
            'Live instructions'
        )

        const published = flow()
        published.flowData = await draftToPublish(published)
        expect(syncLive(published.flowData)).toBe('Draft instructions')
        const afterPublish = await afterLiveSet(published, 'a'.repeat(40), DRAFT)
        expect(afterPublish.draft).toBeNull()
        expect(afterPublish.lastPublished?.sha).toBe('a'.repeat(40))

        await saveDraft(published, canvas('Newer draft'), context)
        const rolled = flow()
        rolled.flowData = LIVE
        expect(syncLive(LIVE)).toBe('Live instructions')
        const afterRollback = await afterLiveSet(rolled, 'b'.repeat(40))
        expect(afterRollback.draft?.flowData).toBe(canvas('Newer draft'))
        expect(afterRollback.draft?.stale).toBe(false)
    })

    test('PUT /api/v1/chatflows still writes Live while a draft is open', async () => {
        syncLive(LIVE)
        await saveDraft(flow(), DRAFT, context)
        expect(syncLive(API)).toBe('API instructions')
        expect(rows[0].draftFlowData).toBe(DRAFT)
        expect((await getDraftStatus(flow())).draft?.flowData).toBe(DRAFT)
    })

    test('the canvas roster follows the draft while the saved harness stays Live, and they match after publish', () => {
        syncLive(LIVE)
        expect(rosterInstructions(DRAFT)).toBe('Draft instructions')
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')).chief.instructions).toBe(
            'Live instructions'
        )
        expect(syncLive(DRAFT)).toBe('Draft instructions')
        expect(rosterInstructions(DRAFT)).toBe('Draft instructions')
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')).chief.instructions).toBe(
            'Draft instructions'
        )
    })

    test('discarding a draft leaves the roster alone', async () => {
        syncLive(LIVE)
        await saveDraft(flow(), DRAFT, context)
        const before = fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')
        expect((await discardDraft(flow())).draft).toBeNull()
        expect(fs.readFileSync(path.join(dataDir, 'harnesses', `${NAME}.json`), 'utf8')).toBe(before)
    })

    test('the chatflow save syncs a harness and a draft save does not', () => {
        const chatflows = fs.readFileSync(path.join(__dirname, '../chatflows/index.ts'), 'utf8')
        const updateStart = chatflows.indexOf('const updateChatflow')
        const updateEnd = chatflows.indexOf('async function validateEtlCanvas')
        expect(chatflows.slice(updateStart, updateEnd)).toContain('await keepHarnessCanvas(dbResponse')
        expect(fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8').includes('syncHarness')).toBe(false)
    })
})
