// A real socket and express.json(), not a hand-built request. express.json() ends the
// request stream before the handler runs, which sets req.destroyed while the client is still waiting.
const states = new Map<string, any>()
const scan = {
    entered: () => undefined as void,
    wait: Promise.resolve() as Promise<void>
}
jest.mock('../../services/flow-drafts', () => ({
    __esModule: true,
    default: {
        isDraftsEnabled: () => true,
        getState: async (id: string) => {
            scan.entered()
            await scan.wait
            return states.get(id) || null
        }
    },
    canvasHash: (flowData: string) => `hash:${flowData}`
}))
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: async (id: string, workspaceId: string) => ({
            id,
            type: 'CHATFLOW',
            workspaceId,
            flowData: LIVE
        })
    }
}))
jest.mock('../../identity/rbac', () => ({
    hasAnyPermission: async () => true
}))
jest.mock('../../services/flow-versions', () => ({ __esModule: true, default: {} }))
jest.mock('../flow-versions', () => ({ putVersionLive: jest.fn() }))
jest.mock('../../database/entities/ChatFlow', () => ({ ChatFlow: class ChatFlow {} }))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/identity', () => ({ Workspace: class Workspace {}, Organization: class Organization {} }))
jest.mock('@cuttlely/components', () => ({ EvaluationRunner: { metrics: new Map() } }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), debug: jest.fn() } }))
const queryBuilder: any = {
    select: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
    orderBy: () => queryBuilder,
    addOrderBy: () => queryBuilder,
    take: () => queryBuilder,
    skip: () => queryBuilder,
    getMany: async () => [{ content: 'What time do you open?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null }]
}
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: () => ({ createQueryBuilder: () => queryBuilder }) }
    })
}))

import http from 'http'
import express from 'express'
import controller from './index'
import { checks, replayHooks } from '../../services/flow-check'

const LIVE = JSON.stringify({
    nodes: [{ id: 'chatOpenAI_0', data: { name: 'chatOpenAI', category: 'Chat Models', label: 'Live' } }],
    edges: []
})
const DRAFT = JSON.stringify({
    nodes: [{ id: 'chatOpenAI_0', data: { name: 'chatOpenAI', category: 'Chat Models', label: 'Draft' } }],
    edges: []
})
const FLOW = 'flow-http'

function app() {
    const server = express()
    server.use(express.json())
    server.post('/api/v1/flow-drafts/:chatflowId/check', (req, res, next) => {
        req.user = {
            id: 'user-1',
            activeWorkspaceId: 'team-a',
            activeOrganizationId: 'org-1',
            activeOrganizationSubscriptionId: 'sub-1'
        } as any
        return controller.startCheck(req, res, next)
    })
    server.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

function post(port: number, body: unknown) {
    const payload = JSON.stringify(body)
    let req: http.ClientRequest
    const done = new Promise<{ status: number; json: any; error?: Error }>((resolve) => {
        req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/api/v1/flow-drafts/${FLOW}/check`,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            },
            (res) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(chunk))
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8')
                    let json = null
                    try {
                        json = text ? JSON.parse(text) : null
                    } catch {
                        json = null
                    }
                    resolve({ status: res.statusCode || 0, json })
                })
            }
        )
        req.on('error', (error) => resolve({ status: 0, json: null, error }))
        req.end(payload)
    })
    return { request: () => req, done }
}

beforeEach(() => {
    checks.clear()
    states.clear()
    states.set(FLOW, { chatflowId: FLOW, draftFlowData: DRAFT, publishInstantly: false })
    scan.entered = () => undefined
    scan.wait = Promise.resolve()
    replayHooks.run = async () => ({ text: 'open at 7', metrics: [] })
})

describe('start check over a live socket', () => {
    it('returns 202 after express.json() has consumed the body', async () => {
        let release: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
            scan.entered = resolve
        })
        scan.wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const server = http.createServer(app())
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port
        try {
            const pending = post(port, { questions: ['What time do you open?'] })
            await entered
            release()
            const response = await pending.done
            expect(response.status).toBe(202)
            expect(response.json.status).toBe('running')
            expect(checks.get(FLOW)?.id).toBe(response.json.id)
            expect(['running', 'done']).toContain(checks.get(FLOW)?.status)
        } finally {
            server.close()
        }
    })

    it('drops a start whose socket is destroyed during the draft lookup and leaves no running check', async () => {
        let release: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
            scan.entered = resolve
        })
        scan.wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const server = http.createServer(app())
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port
        try {
            const pending = post(port, { questions: ['What time do you open?'] })
            await entered
            pending.request().destroy()
            await new Promise((resolve) => setTimeout(resolve, 50))
            release()
            await pending.done
            expect(checks.get(FLOW)?.status).not.toBe('running')
            scan.wait = Promise.resolve()
            scan.entered = () => undefined
            const again = await post(port, { questions: ['What time do you open?'] }).done
            expect(again.status).toBe(202)
            expect(again.json.status).toBe('running')
        } finally {
            server.close()
        }
    })
})
