const getChatflowById = jest.fn()

jest.mock('../../services/apikey', () => ({ __esModule: true, default: {} }))
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowById: (...args: unknown[]) => getChatflowById(...args) }
}))
jest.mock('../../services/schedule', () => ({ __esModule: true, default: {} }))
jest.mock('../../schedule/ScheduleBeat', () => ({ ScheduleBeat: { getInstance: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
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
const variantLeaks = ['FAKE-NESTED', 'FAKE-ARRAY', 'FAKE-SENTENCE', 'FAKEsig', 'AIzaFAKE', 'cred-FAKE-ID', 'FAKE-HDR']
const variantKept = {
    config: { a: {}, keep: 'ok' },
    list: ['fine'],
    headers: [{ key: 'Accept', value: 'application/json' }],
    temperature: 0.2
}

const run = async (id: string) => {
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
    await chatflowsController.getSinglePublicChatflow({ params: { id } } as any, res, next)
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
        for (const leak of [...variantLeaks, 'sk-FAKE-ORPHAN', 'cred-FAKE-0001', 'allowedOrigins', 'ws-1']) {
            expect(serialized).not.toContain(leak)
        }
        expect(JSON.parse(res.body.chatbotConfig)).toEqual({ title: 'Bot', overrideConfig: variantKept })
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
})
