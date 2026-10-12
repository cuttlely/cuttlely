/**
 * The publish check replays a question through an agentflow with replay on. This drives the real executeAgentFlow
 * with two stand-in steps and a recording data source, and checks that a replay writes nothing: no execution record,
 * no chat messages, no telemetry and no streaming, and reads no earlier run or chat history.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executeAgentFlow } from './buildAgentflow'
import { stepTokens } from '../services/flow-check/compare'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))
jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))

let dir: string
let componentNodes: Record<string, { filePath: string }>

const step = (body: string) => `exports.nodeClass = class { async run(nodeData, input, options) { ${body} } }\n`

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-replay-'))
    const write = (name: string, body: string) => {
        const file = path.join(dir, `${name}.js`)
        fs.writeFileSync(file, step(body))
        return { filePath: file }
    }
    componentNodes = {
        startAgentflow: write(
            'start',
            `return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }`
        ),
        iterationAgentflow: write(
            'iteration',
            `return { id: nodeData.id, name: 'iterationAgentflow', input: { iterationInput: ['rye', 'spelt'] }, output: {} }`
        ),
        llmAgentflow: write(
            'llm',
            `return { id: nodeData.id, name: 'llmAgentflow', input: {}, output: { content: 'Fresh bread at 7 for: ' + input, usageMetadata: { input_tokens: 12, output_tokens: 9, total_tokens: 21 }, toldReplay: options.replay === true } }`
        )
    }
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const node = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    type: 'agentFlow',
    position: { x: 0, y: 0 },
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

const canvas = (startInputType: string) =>
    JSON.stringify({
        nodes: [
            node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType }),
            node('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModel: 'chatOpenAI' })
        ],
        edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'llmAgentflow_0', sourceHandle: 'a', targetHandle: 'b' }]
    })

// Records every read and write by table.
function recordingDataSource() {
    const calls: string[] = []
    const saved: Record<string, any> = {}
    const repo = (entity: any) => {
        const table = typeof entity === 'function' ? entity.name : String(entity)
        const log = (op: string) => calls.push(`${table}.${op}`)
        return {
            find: async () => (log('find'), []),
            findBy: async () => (log('findBy'), []),
            findOne: async () => (log('findOne'), saved[table] ?? null),
            findOneBy: async () => (log('findOneBy'), saved[table] ?? null),
            create: (value: unknown) => (log('create'), value),
            save: async (value: Record<string, unknown>) => {
                log('save')
                saved[table] = { id: `${table}-1`, ...value }
                return saved[table]
            },
            merge: (target: any, value: any) => Object.assign(target, value),
            update: async () => (log('update'), { affected: 1 }),
            createQueryBuilder: () => {
                log('query')
                const qb: any = { where: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
                return qb
            }
        }
    }
    return { calls, appDataSource: { getRepository: repo } }
}

const streamer = () => {
    const events: string[] = []
    return {
        events,
        sseStreamer: new Proxy({}, { get: (_t, name: string) => () => events.push(name) })
    }
}

// Start, then an iteration over two loaves with one model step inside it.
const iterationCanvas = () =>
    JSON.stringify({
        nodes: [
            node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
            node('iterationAgentflow_0', 'iterationAgentflow', 'Each loaf', {}),
            { ...node('llmAgentflow_1', 'llmAgentflow', 'Loaf helper', {}), parentNode: 'iterationAgentflow_0', extent: 'parent' }
        ],
        edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'iterationAgentflow_0', sourceHandle: 'a', targetHandle: 'b' }]
    })

async function run(opts: { replay: boolean; startInputType?: string; humanInput?: unknown; flowData?: string }) {
    const { calls, appDataSource } = recordingDataSource()
    const { events, sseStreamer } = streamer()
    const telemetry = { sendTelemetry: jest.fn() }
    const result = await executeAgentFlow({
        componentNodes,
        incomingInput: { question: 'When is the sourdough ready?', streaming: false, humanInput: opts.humanInput } as any,
        chatflow: {
            id: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
            name: 'Bakery helper',
            type: 'AGENTFLOW',
            flowData: opts.flowData || canvas(opts.startInputType || 'chatInput'),
            workspaceId: 'ws-1'
        } as any,
        chatId: 'c0ffee00-0000-4000-8000-000000000001',
        appDataSource: appDataSource as any,
        telemetry: telemetry as any,
        usageCacheManager: {} as any,
        cachePool: {} as any,
        sseStreamer: sseStreamer as any,
        baseURL: 'http://127.0.0.1',
        isInternal: true,
        orgId: 'org-1',
        workspaceId: 'ws-1',
        subscriptionId: 'sub-1',
        productId: 'prod-1',
        replay: opts.replay
    } as any)
    return { result, calls, events, telemetry }
}

describe('executeAgentFlow with replay on (publish check)', () => {
    it('without replay the recording data source sees the execution and the chat messages (the spy works)', async () => {
        const { calls, telemetry } = await run({ replay: false })
        expect(calls).toEqual(expect.arrayContaining(['Execution.find', 'Execution.save', 'ChatMessage.find', 'ChatMessage.save']))
        expect(telemetry.sendTelemetry).toHaveBeenCalled()
    })

    it('runs the steps and returns the answer and the steps, with their tokens', async () => {
        const { result } = await run({ replay: true })
        expect(result.text).toBe('Fresh bread at 7 for: When is the sourdough ready?')
        expect(result.status).toBe('FINISHED')
        expect(result.agentFlowExecutedData.map((s: any) => s.nodeLabel)).toEqual(['Start', 'Bakery helper'])
        expect(stepTokens(result.agentFlowExecutedData)).toEqual([{ totalTokens: 21 }])
        expect(result.chatMessageId).toBeUndefined()
        expect(result.executionId).toBeUndefined()
    })

    it('tells each step it is a replay, so a model step stores no generated image or file', async () => {
        const told = async (replay: boolean) =>
            (await run({ replay })).result.agentFlowExecutedData.find((s: any) => s.nodeLabel === 'Bakery helper').data.output.toldReplay
        expect(await told(true)).toBe(true)
        expect(await told(false)).toBe(false)
    })

    it('writes nothing and reads no earlier run or chat history', async () => {
        const { calls, events, telemetry } = await run({ replay: true })
        expect(calls.filter((c) => /\.(save|update|create|query)$/.test(c))).toEqual([])
        expect(calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])
        expect(events).toEqual([])
        expect(telemetry.sendTelemetry).not.toHaveBeenCalled()
    })

    it('runs an iteration in memory too: its steps come back and nothing is written', async () => {
        const { result, calls } = await run({ replay: true, flowData: iterationCanvas() })
        expect(result.status).toBe('FINISHED')
        const inner = result.agentFlowExecutedData.filter((s: any) => s.nodeLabel === 'Loaf helper')
        expect(inner).toHaveLength(2)
        expect(stepTokens(result.agentFlowExecutedData)).toEqual([{ totalTokens: 21 }, { totalTokens: 21 }])
        expect(calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])
        expect(calls.filter((c) => /\.(save|update|create|query)$/.test(c))).toEqual([])
    })

    it('without replay the same iteration writes its execution (the spy sees the iteration path)', async () => {
        const { calls } = await run({ replay: false, flowData: iterationCanvas() })
        expect(calls).toEqual(expect.arrayContaining(['Execution.findOne', 'Execution.save']))
    })

    it('ignores a human input answer sent with the question', async () => {
        const { calls, result } = await run({ replay: true, humanInput: { type: 'proceed', startNodeId: 'llmAgentflow_0' } })
        expect(result.status).toBe('FINISHED')
        expect(calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])
    })

    it('refuses a flow that does not start with a chat message', async () => {
        for (const startInputType of ['formInput', 'scheduleInput']) {
            await expect(run({ replay: true, startInputType })).rejects.toMatchObject({
                statusCode: 409,
                message: 'The check works on agentflows that start with a chat message.'
            })
        }
    })
})
