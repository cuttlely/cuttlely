import { ChatFlow } from '../database/entities/ChatFlow'

const mockAuthorizeNestedFlowKey = jest.fn()
const mockExecuteFlow = jest.fn(async (_params?: unknown) => ({ text: 'nested answer' }))
const mockStartCanvasRun = jest.fn(async (..._args: unknown[]) => ({
    chatId: 'harness-chat',
    run: { id: 'run-1' },
    payload: { text: 'team answer' }
}))

jest.mock('../services/accessKeys/authorization', () => ({
    authorizeNestedFlowKey: (...args: unknown[]) => mockAuthorizeNestedFlowKey(...args)
}))
jest.mock('./buildChatflow', () => ({
    executeFlow: (params: unknown) => mockExecuteFlow(params)
}))
jest.mock('../services/harnesses', () => ({
    __esModule: true,
    default: { startCanvasRun: (...args: unknown[]) => mockStartCanvasRun(...args) }
}))

import { authorizeNestedFlowCaller, MAX_NESTED_FLOW_DEPTH, nestedFlowCallerFromHarness, nestedFlowNodeOptions } from './nestedFlowCall'

const privateFlow = (type: string = 'CHATFLOW', workspaceId = 'one') =>
    ({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'target',
        type,
        workspaceId,
        apiAccessMode: 'private',
        flowData: '{}'
    } as ChatFlow)

beforeEach(() => {
    mockAuthorizeNestedFlowKey.mockReset()
    mockExecuteFlow.mockClear()
    mockStartCanvasRun.mockClear()
})

it.each(['CHATFLOW', 'AGENTFLOW'])('allows a signed-in parent to call a same-workspace private %s', async (type) => {
    await expect(authorizeNestedFlowCaller({ via: 'session' }, 'one', privateFlow(type))).resolves.toEqual({ via: 'session' })
})

it('keeps anonymous public access narrow and refuses private or cross-workspace targets', async () => {
    await expect(authorizeNestedFlowCaller({ via: 'flow' }, 'one', privateFlow())).rejects.toMatchObject({ statusCode: 401 })
    await expect(
        authorizeNestedFlowCaller({ via: 'flow' }, 'one', { ...privateFlow(), apiAccessMode: 'public', apikeyid: undefined })
    ).resolves.toEqual({ via: 'flow' })
    await expect(authorizeNestedFlowCaller({ via: 'session' }, 'one', privateFlow('CHATFLOW', 'other'))).rejects.toMatchObject({
        statusCode: 403
    })
})

it('delegates a serialized key id without a bearer and converts Harness callers without secrets', async () => {
    mockAuthorizeNestedFlowKey.mockResolvedValue({ via: 'api_key', apiKeyId: 'key-1', harnesses: [] })
    await expect(authorizeNestedFlowCaller({ via: 'api_key', apiKeyId: 'key-1' }, 'one', privateFlow())).resolves.toMatchObject({
        apiKeyId: 'key-1'
    })
    expect(mockAuthorizeNestedFlowKey).toHaveBeenCalledWith('key-1', expect.objectContaining({ id: privateFlow().id }))
    expect(nestedFlowCallerFromHarness({ via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'], harnessIds: { team: 'h-1' } })).toEqual({
        via: 'api_key',
        apiKeyId: 'key-1'
    })
})

it('rebuilds the in-process runner from serializable job fields and advances nesting depth', async () => {
    const target = privateFlow('AGENTFLOW')
    const options = nestedFlowNodeOptions({
        parentFlowId: '11111111-1111-4111-8111-111111111111',
        parentWorkspaceId: 'one',
        caller: { via: 'session' },
        depth: 2,
        baseURL: 'http://localhost:3000',
        orgId: 'org',
        subscriptionId: 'sub',
        productId: 'product',
        componentNodes: {},
        appDataSource: { getRepository: () => ({ findOneBy: async () => target }) } as any,
        telemetry: {} as any,
        cachePool: {} as any,
        usageCacheManager: {} as any,
        sseStreamer: {} as any
    })

    expect(JSON.parse(JSON.stringify(options))).toEqual({ nestedFlowCaller: { via: 'session' }, nestedFlowDepth: 2 })
    await expect(
        options.runNestedFlow({ targetFlowId: target.id, question: 'hello', chatId: 'chat', overrideConfig: { temperature: 0 } })
    ).resolves.toEqual({ text: 'nested answer' })
    expect(mockExecuteFlow).toHaveBeenCalledWith(
        expect.objectContaining({
            chatflow: target,
            isInternal: true,
            isTool: true,
            workspaceId: 'one',
            nestedFlowCaller: { via: 'session' },
            nestedFlowDepth: 3,
            harnessCaller: { via: 'session' }
        })
    )
})

it('runs a same-server Harness target in process with the parent caller and next depth', async () => {
    const target = privateFlow('HARNESS')
    const runtime = {
        parentFlowId: '11111111-1111-4111-8111-111111111111',
        parentWorkspaceId: 'one',
        caller: { via: 'session' as const },
        depth: 3,
        baseURL: 'http://localhost:3000',
        orgId: 'org',
        subscriptionId: 'sub',
        productId: 'product',
        componentNodes: {},
        appDataSource: { getRepository: () => ({ findOneBy: async () => target }) } as any,
        telemetry: {} as any,
        cachePool: {} as any,
        usageCacheManager: {} as any,
        sseStreamer: {} as any,
        signal: new AbortController()
    }
    const options = nestedFlowNodeOptions(runtime)

    await expect(options.runNestedFlow({ targetFlowId: target.id, question: 'ask the team' })).resolves.toEqual({
        chatId: 'harness-chat',
        run: { id: 'run-1' },
        text: 'team answer'
    })
    expect(mockStartCanvasRun).toHaveBeenCalledWith(
        target,
        expect.objectContaining({ question: 'ask the team', streaming: false }),
        expect.objectContaining({
            caller: { via: 'session' },
            canvas: 'live',
            nestedFlowCaller: { via: 'session' },
            nestedFlowDepth: 4,
            runtime,
            signal: runtime.signal.signal
        })
    )
    expect(mockExecuteFlow).not.toHaveBeenCalled()
})

it('refuses self-calls and excessive in-process nesting before resolving a target', async () => {
    const repository = { findOneBy: jest.fn() }
    const make = (parentFlowId: string, depth: number) =>
        nestedFlowNodeOptions({
            parentFlowId,
            parentWorkspaceId: 'one',
            caller: { via: 'session' },
            depth,
            baseURL: 'http://localhost:3000',
            orgId: 'org',
            subscriptionId: 'sub',
            productId: 'product',
            componentNodes: {},
            appDataSource: { getRepository: () => repository } as any,
            telemetry: {} as any,
            cachePool: {} as any,
            usageCacheManager: {} as any,
            sseStreamer: {} as any
        })
    await expect(make('same', 0).runNestedFlow({ targetFlowId: 'same', question: 'hello' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(make('parent', MAX_NESTED_FLOW_DEPTH).runNestedFlow({ targetFlowId: 'child', question: 'hello' })).rejects.toMatchObject({
        statusCode: 400
    })
    expect(repository.findOneBy).not.toHaveBeenCalled()
})
