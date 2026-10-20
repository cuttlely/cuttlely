const getChatflowById = jest.fn()

jest.mock('../../services/apikey', () => ({ __esModule: true, default: {} }))
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowById: (...args: unknown[]) => getChatflowById(...args) }
}))
jest.mock('../../services/schedule', () => ({ __esModule: true, default: {} }))
jest.mock('../../schedule/ScheduleBeat', () => ({ ScheduleBeat: { getInstance: jest.fn() } }))
const readWorkspaceUserByUserId = jest.fn()
const releaseQueryRunner = jest.fn()
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ AppDataSource: { createQueryRunner: () => ({ release: releaseQueryRunner }) } })
}))
jest.mock('../../identity/workspaceScope', () => ({
    ...jest.requireActual('../../identity/workspaceScope'),
    WorkspaceUserService: class WorkspaceUserService {
        readWorkspaceUserByUserId(...args: unknown[]) {
            return readWorkspaceUserByUserId(...args)
        }
    }
}))
jest.mock('../../utils/quotaUsage', () => ({ checkUsageLimit: jest.fn() }))
jest.mock('../../utils/rateLimit', () => ({ RateLimiterManager: class RateLimiterManager {} }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn(), http: jest.fn() }
}))

import chatflowsController from './index'

// Seven credential shapes a saved node can carry. All values are fake.
const variantParams = [
    { name: 'config', type: 'json' },
    { name: 'list', type: 'array' },
    { name: 'prompt', type: 'string' },
    { name: 'note', type: 'string' },
    { name: 'googleKey', type: 'string' },
    { name: 'credentialId', type: 'string' },
    { name: 'headers', type: 'array' },
    { name: 'temperature', type: 'number' }
]
const variantInputs = {
    config: { a: { b: 'sk-FAKE-NESTED-1' }, keep: 'ok' },
    list: ['fine', 'sk-FAKE-ARRAY-1'],
    prompt: 'Use the key sk-FAKE-SENTENCE-1 when asked',
    note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsig',
    googleKey: 'AIzaFAKEFAKEFAKEFAKE123',
    credentialId: 'cred-FAKE-ID-1',
    headers: [
        { key: 'X-Custom-Auth', value: 'FAKE-HDR-1' },
        { key: 'Accept', value: 'application/json' }
    ],
    temperature: 0.2
}
const variantSamples = ['FAKE-NESTED', 'FAKE-ARRAY', 'FAKE-SENTENCE', 'FAKEsig', 'AIzaFAKE', 'cred-FAKE-ID', 'FAKE-HDR']
const run = async (id: string, user?: { id: string }) => {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status(code: number) {
            this.statusCode = code
            return this
        },
        json(body: unknown) {
            this.body = body
            return this
        }
    }
    const next = jest.fn()
    await chatflowsController.getSinglePublicChatflow({ params: { id }, user } as any, res, next)
    return { res, next }
}

describe('GET /public-chatflows/:id', () => {
    it('returns metadata only for a public chatflow, never flowData', async () => {
        getChatflowById.mockResolvedValue({
            id: 'flow-1',
            name: 'Support',
            isPublic: true,
            apikeyid: '',
            workspaceId: 'ws-1',
            chatbotConfig: JSON.stringify({ title: 'Bot', allowedOrigins: ['x'], overrideConfig: { ...variantInputs } }),
            flowData: JSON.stringify({
                nodes: [
                    {
                        id: 'chatOpenAI_0',
                        data: {
                            name: 'chatOpenAI',
                            credential: 'cred-FAKE-0001',
                            inputParams: variantParams,
                            inputs: { ...variantInputs, openAIApiKey: 'sk-FAKE-ORPHAN-123456' }
                        }
                    }
                ],
                edges: []
            })
        })

        const { res } = await run('flow-1')
        expect(res.statusCode).toBe(200)
        expect(Object.keys(res.body).sort()).toEqual(['chatbotConfig', 'hasApiKey', 'id', 'isPublic', 'name'])
        expect(res.body).not.toHaveProperty('flowData')
        expect(res.body.hasApiKey).toBe(false)
        const serialized = JSON.stringify(res.body)
        for (const leak of [...variantSamples, 'sk-FAKE-ORPHAN', 'cred-FAKE-0001', 'allowedOrigins', 'ws-1']) {
            expect(serialized).not.toContain(leak)
        }
        expect(JSON.parse(res.body.chatbotConfig)).toEqual({ title: 'Bot' })
    })

    it('reports a key-protected public chatflow as needing a key without returning the key id', async () => {
        getChatflowById.mockResolvedValue({ id: 'flow-3', name: 'K', isPublic: true, apikeyid: 'apikey-9', flowData: '{}' })
        const { res } = await run('flow-3')
        expect(res.body.hasApiKey).toBe(true)
        expect(JSON.stringify(res.body)).not.toContain('apikey-9')
    })

    it('answers 401 for a private chatflow without a user', async () => {
        getChatflowById.mockResolvedValue({ id: 'flow-2', isPublic: false, flowData: '{"nodes":[],"edges":[]}' })
        const { res } = await run('flow-2')
        expect(res.statusCode).toBe(401)
    })

    // Intended: a signed-in member of the owning workspace keeps their normal access to a private chatflow here,
    // the same entity GET /api/v1/chatflows/:id gives them. Anyone else is refused.
    it('gives a signed-in workspace member of a private chatflow their normal access', async () => {
        const stored = { id: 'flow-4', name: 'Private', isPublic: false, workspaceId: 'ws-1', flowData: '{"nodes":[],"edges":[]}' }
        getChatflowById.mockResolvedValue(stored)
        readWorkspaceUserByUserId.mockResolvedValue([{ workspaceId: 'ws-1' }])
        const { res } = await run('flow-4', { id: 'user-1' })
        expect(res.statusCode).toBe(200)
        expect(res.body).toEqual(stored)
        expect(releaseQueryRunner).toHaveBeenCalled()
    })

    it('refuses a signed-in user outside the owning workspace', async () => {
        getChatflowById.mockResolvedValue({ id: 'flow-5', isPublic: false, workspaceId: 'ws-1', flowData: '{}' })
        readWorkspaceUserByUserId.mockResolvedValue([{ workspaceId: 'ws-2' }])
        const { res } = await run('flow-5', { id: 'user-2' })
        expect(res.statusCode).toBe(400)
        expect(res.body).not.toHaveProperty('flowData')
    })
})
