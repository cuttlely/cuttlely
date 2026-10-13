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

const user = {
    id: 'user-1',
    activeWorkspaceId: 'team-a',
    activeOrganizationId: 'org-1',
    activeOrganizationSubscriptionId: 'sub-1'
}

function app() {
    const server = express()
    server.use(express.json())
    server.post('/api/v1/flow-drafts/:chatflowId/check', (req, res, next) => {
        req.user = user as any
        return controller.startCheck(req, res, next)
    })
    server.get('/api/v1/flow-drafts/:chatflowId/check/:checkId', (req, res, next) => {
        req.user = user as any
        return controller.getCheck(req, res, next)
    })
    server.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

function post(port: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = JSON.stringify(body)
    let req: http.ClientRequest
    const done = new Promise<{ status: number; json: any; error?: Error }>((resolve) => {
        req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/api/v1/flow-drafts/${FLOW}/check`,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
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

function readCheck(port: number, id: string) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/flow-drafts/${FLOW}/check/${id}` }, (res) => {
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
        })
        req.on('error', reject)
    })
}

// Holds the replay until the check is stopped, so a finished replay cannot look like a freed slot.
function holdReplay() {
    let finish = () => undefined
    replayHooks.run = ({ signal }) =>
        new Promise((resolve) => {
            const done = () => resolve({ text: 'open at 7', metrics: [] })
            finish = done
            if (signal.signal.aborted) return done()
            signal.signal.addEventListener('abort', done, { once: true })
        })
    return () => finish()
}

async function listen(server: http.Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return (server.address() as any).port as number
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

    it('frees the running slot when the socket resets as the 202 is written', async () => {
        let release: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
            scan.entered = resolve
        })
        scan.wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const releaseReplay = holdReplay()
        const server = http.createServer(app())
        const port = await listen(server)
        try {
            const pending = post(port, { questions: ['What time do you open?'] })
            await entered
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    release()
                    pending.request().socket?.resetAndDestroy()
                    resolve()
                }, 0)
            })
            const response = await pending.done
            expect(response.error && (response.error as NodeJS.ErrnoException).code).toBe('ECONNRESET')
            const deadline = Date.now() + 2000
            while (checks.get(FLOW)?.status === 'running' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            expect(checks.get(FLOW)?.status).toBe('stopped')
            scan.wait = Promise.resolve()
            scan.entered = () => undefined
            replayHooks.run = async () => ({ text: 'open at 7', metrics: [] })
            const again = await post(port, { questions: ['What time do you open?'] }).done
            expect(again.status).toBe(202)
            expect(again.json.status).toBe('running')
        } finally {
            releaseReplay()
            server.close()
        }
    })

    it('keeps a check that the client read and then closed', async () => {
        const releaseReplay = holdReplay()
        const server = http.createServer(app())
        const port = await listen(server)
        try {
            const response = await post(port, { questions: ['What time do you open?'] }, { connection: 'close' }).done
            expect(response.status).toBe(202)
            expect(response.json.status).toBe('running')
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(checks.get(FLOW)?.status).toBe('running')
            const read = await readCheck(port, response.json.id)
            expect(read.status).toBe(200)
            expect(read.json.status).toBe('running')
            expect(read.json.id).toBe(response.json.id)
        } finally {
            releaseReplay()
            server.close()
        }
    })

    it('keeps a check when fetch aborts after reading the response body', async () => {
        const releaseReplay = holdReplay()
        const server = http.createServer(app())
        const port = await listen(server)
        try {
            const ac = new AbortController()
            const response = await fetch(`http://127.0.0.1:${port}/api/v1/flow-drafts/${FLOW}/check`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ questions: ['What time do you open?'] }),
                signal: ac.signal
            })
            const json = await response.json()
            expect(response.status).toBe(202)
            ac.abort()
            await new Promise((resolve) => setTimeout(resolve, 50))
            expect(checks.get(FLOW)?.id).toBe(json.id)
            expect(checks.get(FLOW)?.status).toBe('running')
            const read = await readCheck(port, json.id)
            expect(read.status).toBe(200)
            expect(read.json.status).toBe('running')
        } finally {
            releaseReplay()
            server.close()
        }
    })
})
