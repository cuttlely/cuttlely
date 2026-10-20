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
    it('removes an input with no field definition carrying a key from a public chatflow', async () => {
        getChatflowById.mockResolvedValue({
            id: 'flow-1',
            isPublic: true,
            flowData: JSON.stringify({
                nodes: [
                    {
                        id: 'chatOpenAI_0',
                        data: {
                            name: 'chatOpenAI',
                            credential: 'cred-FAKE-0001',
                            inputParams: [{ name: 'modelName', type: 'string' }],
                            inputs: { modelName: 'gpt-4.1-mini', openAIApiKey: 'sk-FAKE-ORPHAN-123456' }
                        }
                    }
                ],
                edges: []
            })
        })

        const { res } = await run('flow-1')
        expect(res.statusCode).toBe(200)
        const serialized = JSON.stringify(res.body)
        expect(serialized).not.toContain('sk-FAKE-ORPHAN-123456')
        expect(serialized).not.toContain('cred-FAKE-0001')
        expect(JSON.parse(res.body.flowData).nodes[0].data.inputs).toEqual({ modelName: 'gpt-4.1-mini' })
    })

    it('answers 401 for a private chatflow without a user', async () => {
        getChatflowById.mockResolvedValue({ id: 'flow-2', isPublic: false, flowData: '{"nodes":[],"edges":[]}' })
        const { res } = await run('flow-2')
        expect(res.statusCode).toBe(401)
    })
})
