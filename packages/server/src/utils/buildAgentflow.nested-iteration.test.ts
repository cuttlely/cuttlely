import fs from 'fs'
import os from 'os'
import path from 'path'
import { ChatFlow } from '../database/entities/ChatFlow'
import type { IComponentNodes, IHarnessCaller } from '../Interface'
import { executeAgentFlow } from './buildAgentflow'
import { MAX_NESTED_FLOW_DEPTH } from './nestedFlowCall'
import type { NestedFlowNodeOptions } from './nestedFlowCall'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))
jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))

// Only target dispatch is substituted: every target uses the real agentflow engine and nested-call runner.
const mockExecuteFlow = jest.fn((params: any): Promise<any> => executeAgentFlow({ ...params, replay: true }))
jest.mock('./buildChatflow', () => ({ executeFlow: (params: any) => mockExecuteFlow(params) }))

let directory: string
let componentNodes: Record<string, { filePath: string }>

beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-nested-iteration-'))
    const write = (name: string, body: string) => {
        const filePath = path.join(directory, `${name}.js`)
        fs.writeFileSync(filePath, `exports.nodeClass = class { async run(data, input, options) { ${body} } }\n`)
        return { filePath }
    }
    componentNodes = {
        startAgentflow: write('start', 'return { output: { question: input } }'),
        iterationAgentflow: write('iteration', "return { input: { iterationInput: ['one'] }, output: {} }"),
        customFunctionAgentflow: write('call', 'return options.appDataSource.visit(data, options)')
    }
})

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))
beforeEach(() => mockExecuteFlow.mockClear())

const node = (id: string, name: string, inputs: Record<string, unknown> = {}) => ({
    id,
    type: 'agentFlow',
    position: { x: 0, y: 0 },
    data: { id, name, label: id, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

function flow(id: string, iteration: boolean, target?: string): ChatFlow {
    const start = node('start', 'startAgentflow', { startInputType: 'chatInput' })
    const call = node('call', 'customFunctionAgentflow', { target })
    return {
        id,
        name: id,
        type: 'AGENTFLOW',
        workspaceId: 'workspace',
        apiAccessMode: 'private',
        flowData: JSON.stringify({
            nodes: iteration
                ? [start, node('iteration', 'iterationAgentflow'), { ...call, parentNode: 'iteration', extent: 'parent' }]
                : [start, call],
            edges: [{ id: 'edge', source: 'start', target: iteration ? 'iteration' : 'call' }]
        })
    } as ChatFlow
}

function run(chatflow: ChatFlow, appDataSource: any, nested: { harnessCaller: IHarnessCaller; [key: string]: unknown }) {
    return executeAgentFlow({
        componentNodes: componentNodes as IComponentNodes,
        incomingInput: { question: 'hello', streaming: false },
        chatflow,
        chatId: 'chat',
        appDataSource,
        telemetry: {} as any,
        cachePool: {} as any,
        usageCacheManager: {} as any,
        sseStreamer: {} as any,
        baseURL: 'http://localhost:3000',
        isInternal: true,
        orgId: 'organization',
        workspaceId: 'workspace',
        subscriptionId: 'subscription',
        productId: 'product',
        replay: true,
        ...nested
    })
}

it('keeps the parent runner and depth inside an iteration subrun', async () => {
    const runNestedFlow = jest.fn(async () => ({ text: 'answer' }))
    const caller = { via: 'session' } as const
    const appDataSource = {
        getRepository: () => ({ find: async () => [], findBy: async () => [] }),
        visit: jest.fn(async (_data: unknown, options: NestedFlowNodeOptions) => {
            expect(options.nestedFlowDepth).toBe(4)
            expect(options.nestedFlowCaller).toEqual(caller)
            expect(options.runNestedFlow).toBe(runNestedFlow)
            return { output: { content: (await options.runNestedFlow({ targetFlowId: 'target', question: 'hello' })).text } }
        })
    }
    const result = await run(flow('parent', true), appDataSource, {
        harnessCaller: caller,
        nestedFlowOptions: { nestedFlowCaller: caller, nestedFlowDepth: 4, runNestedFlow }
    })
    expect(result.text).toBe('answer')
    expect(appDataSource.visit).toHaveBeenCalledTimes(1)
    expect(runNestedFlow).toHaveBeenCalledTimes(1)
})

it('advances depth through a cycle containing an iteration until the nested-call limit refuses it', async () => {
    const first = flow('first', true, 'second')
    const second = flow('second', false, 'first')
    const depths: number[] = []
    const refusals: Error[] = []
    const appDataSource = {
        getRepository: (entity: unknown) => ({
            find: async () => [],
            findBy: async () => [],
            findOneBy: async ({ id }: { id: string }) =>
                entity === ChatFlow ? [first, second].find((candidate) => candidate.id === id) : null
        }),
        visit: async (data: { inputs: { target: string } }, options: NestedFlowNodeOptions) => {
            depths.push(options.nestedFlowDepth)
            // Bound the regression itself if the iteration loses depth again.
            if (depths.length > MAX_NESTED_FLOW_DEPTH + 2) throw new Error('Test execution budget exceeded')
            try {
                const result = await options.runNestedFlow({ targetFlowId: data.inputs.target, question: 'hello' })
                return { output: { content: result.text } }
            } catch (error) {
                refusals.push(error as Error)
                return { output: { content: (error as Error).message } }
            }
        }
    }
    const result = await run(first, appDataSource, {
        harnessCaller: { via: 'session' },
        nestedFlowCaller: { via: 'session' },
        nestedFlowDepth: 0
    })
    expect(depths).toEqual(Array.from({ length: MAX_NESTED_FLOW_DEPTH + 1 }, (_, depth) => depth))
    expect(mockExecuteFlow).toHaveBeenCalledTimes(MAX_NESTED_FLOW_DEPTH)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ statusCode: 400, message: `Nested flow calls are limited to ${MAX_NESTED_FLOW_DEPTH} levels.` })
    expect(result.text).toBe(refusals[0].message)
})
