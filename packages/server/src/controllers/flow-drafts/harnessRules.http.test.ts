// The Rules cap on a harness draft save, over a real socket: PUT /api/v1/flow-drafts/:chatflowId, the route the
// canvas Save and Import JSON both use, through the real draft service. Jest cannot load the ESM harness
// package, so the harness limit check runs in a Node child process against the real packages/harness code.
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import express from 'express'

const ROOT = path.resolve(__dirname, '../../../../..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-rules-draft-'))
process.env.CUTTLELY_DRAFTS = 'on'

const childRuns: string[] = []
jest.mock('../../services/flow-drafts/harnessLimits', () => {
    const { spawnSync } = jest.requireActual('child_process')
    const { pathToFileURL } = jest.requireActual('url')
    const { AppError } = jest.requireActual('../../errors/appError')
    return {
        assertHarnessDraftLimits: async (name: string, flowData: string) => {
            childRuns.push(name)
            const syncUrl = pathToFileURL(path.join(ROOT, 'packages/harness/sync-from-flow.mjs')).href
            const script = [
                `import { assertFlowLimits } from ${JSON.stringify(syncUrl)};`,
                `try { assertFlowLimits({ name: process.env.NAME, flowData: process.env.CANVAS }); process.stdout.write('{}') }`,
                `catch (error) { process.stdout.write(JSON.stringify({ message: error.message, code: error.code })) }`
            ].join('\n')
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                env: { PATH: process.env.PATH, HOME: process.env.HOME, CUTTLELY_DATA_DIR: dataDir, NAME: name, CANVAS: flowData },
                encoding: 'utf8'
            })
            if (result.status !== 0) throw new Error(result.stderr || `limit check exited ${result.status}`)
            const outcome = JSON.parse(result.stdout)
            if (outcome.message) throw new AppError(400, outcome.message)
        }
    }
})

const rows: any[] = []
const chats = new Map<string, any>()
const stateRepo = {
    findOneBy: async (where: any) => rows.find((row) => row.chatflowId === where.chatflowId) || null,
    create: (data: any) => ({ ...data }),
    save: async (row: any) => {
        rows.push(row)
        return row
    },
    update: async (where: any, patch: any) => {
        for (const row of rows.filter((item) => item.chatflowId === where.chatflowId)) Object.assign(row, patch)
        return { affected: 1 }
    }
}
const chatRepo = { findOneBy: async (where: any) => chats.get(where.id) || null }
const repositoryFor = (entity: { name?: string }) => (entity?.name === 'ChatFlow' ? chatRepo : stateRepo)
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: repositoryFor, transaction: async (fn: any) => fn({ getRepository: repositoryFor }) },
        usageCacheManager: {}
    })
}))
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: () => false,
    updateFlowDataWithFilePaths: async (_id: string, flowData: string) => flowData
}))
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: async (id: string) => {
            const chat = chats.get(id)
            if (!chat) throw Object.assign(new Error('not found'), { statusCode: 404 })
            return chat
        }
    }
}))
jest.mock('../../identity/rbac', () => ({ hasAnyPermission: async () => true }))
jest.mock('../../services/flow-versions', () => ({ __esModule: true, default: {} }))
jest.mock('../flow-versions', () => ({ putVersionLive: jest.fn() }))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/identity', () => ({ Workspace: class Workspace {}, Organization: class Organization {} }))
jest.mock('@cuttlely/components', () => ({ EvaluationRunner: { metrics: new Map() } }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), debug: jest.fn(), warn: jest.fn() } }))

import controller from './index'

const user = { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', activeOrganizationSubscriptionId: 'sub-1' }
const LIMIT = 2000
const EMPTY = JSON.stringify({ nodes: [], edges: [] })

// What Import JSON reads: the shipped sample harness file, with Rules set on its PostgreSQL MCP card.
function importedSample(rules: string) {
    const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/harnesses/chief-of-staff.canvas.json'), 'utf8'))
    const canvas = typeof file.flowData === 'string' ? JSON.parse(file.flowData) : file.flowData
    const pg = canvas.nodes.find((node: any) => node.data?.name === 'postgreSQLMCP')
    pg.data.inputs = { ...pg.data.inputs, analystRules: rules }
    return JSON.stringify(canvas)
}

// A draft through the API: one specialist with two PostgreSQL MCP cards and no model yet.
function apiCanvas(first: string, second = '') {
    const pg = (id: string, label: string, analystRules: string) => ({
        id,
        data: { name: 'postgreSQLMCP', label, category: 'Tools (MCP)', inputs: { mcpActions: '["query"]', analystRules } }
    })
    return JSON.stringify({
        nodes: [
            { id: 'chief_0', data: { name: 'harnessChief', label: 'Harness Prime', category: 'Harness', inputs: {} } },
            {
                id: 'spec_0',
                data: { name: 'harnessSpecialist', label: 'Harness Specialist', category: 'Harness', inputs: { specialistName: 'bakery' } }
            },
            pg('pg_0', 'Bakery DB', first),
            pg('pg_1', 'Shops DB', second)
        ],
        edges: [
            { id: 'e0', source: 'spec_0', target: 'chief_0' },
            { id: 'e1', source: 'pg_0', target: 'spec_0' },
            { id: 'e2', source: 'pg_1', target: 'spec_0' }
        ]
    })
}

function app() {
    const server = express()
    server.use(express.json({ limit: '5mb' }))
    server.put('/api/v1/flow-drafts/:chatflowId', (req, res, next) => {
        req.user = user as any
        return controller.saveDraft(req, res, next)
    })
    server.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

let server: http.Server
let port = 0

function put(id: string, flowData: string) {
    const payload = JSON.stringify({ flowData })
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/api/v1/flow-drafts/${id}`,
                method: 'PUT',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            },
            (res) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(chunk))
                res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
            }
        )
        req.on('error', reject)
        req.end(payload)
    })
}

beforeAll(async () => {
    server = http.createServer(app())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as any).port
})

afterAll(() => {
    server.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
    rows.length = 0
    childRuns.length = 0
    chats.clear()
    for (const [id, type] of [
        ['harness-1', 'HARNESS'],
        ['chat-1', 'CHATFLOW'],
        ['agent-1', 'AGENTFLOW']
    ]) {
        chats.set(id, { id, type, name: 'bakery-accounts', workspaceId: 'team-a', flowData: EMPTY })
    }
})

describe('Rules cap on a harness draft save', () => {
    test('Import JSON: an imported harness file with Rules over the cap is refused and no draft is stored', async () => {
        const response = await put('harness-1', importedSample('r'.repeat(LIMIT + 1)))
        expect(response.status).toBe(400)
        expect(response.json.message).toBe(
            `Rules on PostgreSQL MCP for specialist "analyst" on harness "bakery-accounts" are ${
                LIMIT + 1
            } characters. The limit is ${LIMIT}. Shorten them and save again.`
        )
        expect(rows).toEqual([])
        expect(childRuns).toEqual(['bakery-accounts'])
    })

    test('Import JSON: the same file with Rules at the cap saves as a draft', async () => {
        const canvas = importedSample('r'.repeat(LIMIT))
        const response = await put('harness-1', canvas)
        expect(response.status).toBe(200)
        expect(response.json.draft.flowData).toContain(`"analystRules":"${'r'.repeat(LIMIT)}"`)
    })

    test('API: one card over the cap is refused on a draft with no model yet', async () => {
        const response = await put('harness-1', apiCanvas('x'.repeat(LIMIT + 5)))
        expect(response.status).toBe(400)
        expect(response.json.message).toContain(
            `Rules on Bakery DB for specialist "bakery" on harness "bakery-accounts" are ${LIMIT + 5} characters.`
        )
        expect(rows).toEqual([])
    })

    test('API: two cards that fit alone but not joined are refused, not cut', async () => {
        const response = await put('harness-1', apiCanvas('a'.repeat(1200), 'b'.repeat(1200)))
        expect(response.status).toBe(400)
        expect(response.json.message).toBe(
            `Rules on Bakery DB, Shops DB for specialist "bakery" on harness "bakery-accounts" are 2402 characters together. The analyst gets them as one section, and the limit is ${LIMIT}. Shorten them and save again.`
        )
        expect(rows).toEqual([])
    })

    test('API: two cards that fit joined save as a draft', async () => {
        const response = await put('harness-1', apiCanvas('a'.repeat(999), 'b'.repeat(999)))
        expect(response.status).toBe(200)
        expect(rows[0].draftFlowData).toContain('b'.repeat(999))
    })

    test('chatflow and agentflow drafts keep the field and are not run through the harness check', async () => {
        for (const id of ['chat-1', 'agent-1']) {
            const response = await put(id, apiCanvas('x'.repeat(LIMIT + 5)))
            expect(response.status).toBe(200)
            expect(response.json.draft.flowData).toContain('analystRules')
        }
        expect(childRuns).toEqual([])
    })
})
