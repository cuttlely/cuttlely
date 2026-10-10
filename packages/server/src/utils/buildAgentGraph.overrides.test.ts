/**
 * API-1 B1: Multi-Agent and Sequential Agent nodes resolved `{{$flow.*}}` and `{{$vars.*}}` from the raw request
 * overrideConfig (buildAgentGraph.ts worker, supervisor and sequential call sites), even with API overrides off. These tests
 * drive the real buildAgentGraph at all three call sites with stand-in node classes that record the inputs they are given.
 * `$flow` must come from server-side fields only; a request var may set `$vars` only when overrides are on and that var is
 * allowlisted.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import logger from './logger'
import { buildAgentGraph } from './buildAgentGraph'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))
// The shared typeorm mock has no Equal; the workspace variable lookup builds a find filter with it.
jest.mock('typeorm', () => ({ ...jest.requireActual('typeorm'), Equal: (value: unknown) => value }))

// Xanth's repro template.
const TEMPLATE = 'You are {{$flow.persona}}. Key={{$vars.region}}'
const REQUEST = {
    persona: 'INJECTED-PROMPT',
    chatflowid: 'EVIL-FLOW',
    chatId: 'EVIL-CHAT',
    vars: { region: 'EVIL', tier: 'EVIL-TIER' }
}
const FLOW_CONFIG = { chatflowid: 'f1', chatflowId: 'f1', chatId: 'c1', sessionId: 's1', chatHistory: [], apiMessageId: 'm1' }

const promptInputs = () => ({
    systemMessagePrompt: TEMPLATE,
    flowFields: '{{$flow.chatflowid}}|{{$flow.chatflowId}}|{{$flow.chatId}}|{{$flow.sessionId}}|{{$flow.apiMessageId}}',
    otherVar: '{{$vars.tier}}'
})

let fixturePath = ''
beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api1-b1-'))
    fixturePath = path.join(dir, 'RecordingAgentNode.js')
    // init records the resolved inputs; a worker returns a minimal worker result so the supervisor call site is reached,
    // every other node stops the graph build right after recording.
    fs.writeFileSync(
        fixturePath,
        [
            'class RecordingAgentNode {',
            '  async init(nodeData) {',
            '    ;(globalThis.__b1 = globalThis.__b1 || []).push({ name: nodeData.name, inputs: JSON.parse(JSON.stringify(nodeData.inputs)) })',
            "    if (nodeData.name === 'worker') return { name: 'w', type: 'worker', parentSupervisorName: 'sup', node: async () => ({}) }",
            "    throw new Error('b1 stop')",
            '  }',
            '}',
            'module.exports = { nodeClass: RecordingAgentNode }',
            ''
        ].join('\n')
    )
})

const node = (id: string, name: string, extra: Record<string, unknown> = {}, inputs: Record<string, unknown> = promptInputs()) => ({
    id,
    type: 'customNode',
    position: { x: 0, y: 0 },
    data: { id, name, label: name, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {}, ...extra }
})

const multiAgentNodes = () => [
    node('worker_0', 'worker', { label: 'Worker', instance: { name: 'w', label: 'Worker' } }),
    node(
        'supervisor_0',
        'supervisor',
        { label: 'Supervisor', instance: { name: 'sup', label: 'Supervisor' } },
        {
            ...promptInputs(),
            supervisorName: 'Supervisor'
        }
    )
]

const seqNodes = () => [
    node('seqStart_0', 'seqStart', { label: 'Start', category: 'Sequential Agents', instance: { name: 'start', label: 'Start' } }, {}),
    node('seqAgent_0', 'seqAgent', { label: 'Agent', category: 'Sequential Agents', instance: { name: 'agent', label: 'Agent' } }),
    node('seqEnd_0', 'seqEnd', { label: 'End', category: 'Sequential Agents', instance: { name: 'end', label: 'End' } }, {})
]

const dbVariables = () => [
    { id: '1', name: 'region', type: 'static', value: 'us', workspaceId: 'w1', createdDate: new Date(0), updatedDate: new Date(0) },
    { id: '2', name: 'tier', type: 'static', value: 'gold', workspaceId: 'w1', createdDate: new Date(0), updatedDate: new Date(0) }
]

const sseStreamer = new Proxy({}, { get: () => jest.fn() })

/** Runs buildAgentGraph for one graph shape and returns the inputs each node's init received, by node name. */
const initsFor = async (shape: 'multi' | 'seq', apiConfig: Record<string, unknown> | undefined) => {
    ;(globalThis as any).__b1 = []
    const initializedNodes: any[] = shape === 'multi' ? multiAgentNodes() : seqNodes()
    const componentNodes: Record<string, any> = {}
    for (const n of initializedNodes) componentNodes[n.data.name] = { filePath: fixturePath }
    const depthQueue: Record<string, number> = {}
    initializedNodes.forEach((n, i) => (depthQueue[n.id] = i))
    await expect(
        buildAgentGraph({
            agentflow: {
                id: 'f1',
                name: 'b1',
                flowData: '{}',
                workspaceId: 'w1',
                apiConfig: apiConfig ? JSON.stringify({ overrideConfig: apiConfig }) : undefined
            } as any,
            flowConfig: { ...FLOW_CONFIG } as any,
            incomingInput: { question: 'hi', streaming: false, overrideConfig: JSON.parse(JSON.stringify(REQUEST)) } as any,
            nodes: [],
            edges: [],
            initializedNodes,
            endingNodeIds: shape === 'multi' ? ['worker_0'] : ['seqEnd_0'],
            startingNodeIds: [initializedNodes[0].id],
            depthQueue,
            chatHistory: [],
            uploadedFilesContent: '',
            appDataSource: { getRepository: () => ({ findBy: async () => dbVariables() }) } as any,
            componentNodes,
            sseStreamer: sseStreamer as any,
            shouldStreamResponse: false,
            cachePool: {} as any,
            baseURL: 'http://127.0.0.1',
            orgId: 'o1',
            workspaceId: 'w1'
        })
    ).rejects.toThrow('b1 stop')
    const seen: Record<string, any> = {}
    for (const rec of (globalThis as any).__b1) seen[rec.name] = rec.inputs
    return seen
}

const SERVER_FLOW_FIELDS = 'f1|f1|c1|s1|m1'
const varsOn = (names: string[]) => names.map((name) => ({ id: name, name, type: 'static', enabled: true }))

// The three call sites: worker and supervisor (compileMultiAgentsGraph), sequential agent (compileSeqAgentsGraph).
const SITES: [string, 'multi' | 'seq', string][] = [
    ['Multi-Agent worker', 'multi', 'worker'],
    ['Multi-Agent supervisor', 'multi', 'supervisor'],
    ['Sequential agent', 'seq', 'seqAgent']
]

beforeEach(() => (logger.warn as jest.Mock).mockClear())

describe.each(SITES)('API-1 B1 at the %s call site', (_site, shape, nodeName) => {
    it('overrides OFF: $flow.persona and $vars.region from the request are not used; $flow is server-built', async () => {
        for (const apiConfig of [undefined, { status: false, nodes: {}, variables: varsOn(['region', 'tier']) }]) {
            const inputs = (await initsFor(shape, apiConfig))[nodeName]
            expect(inputs.systemMessagePrompt).toBe('You are {{$flow.persona}}. Key=us')
            expect(inputs.flowFields).toBe(SERVER_FLOW_FIELDS)
            expect(inputs.otherVar).toBe('gold')
            expect(JSON.stringify(inputs)).not.toMatch(/INJECTED-PROMPT|EVIL/)
        }
    })

    it('overrides ON with an empty allowlist: the request vars are rejected and $flow stays server-built', async () => {
        const inputs = (await initsFor(shape, { status: true, nodes: {}, variables: [] }))[nodeName]
        expect(inputs.systemMessagePrompt).toBe('You are {{$flow.persona}}. Key=us')
        expect(inputs.flowFields).toBe(SERVER_FLOW_FIELDS)
        expect(inputs.otherVar).toBe('gold')
        expect(JSON.stringify(inputs)).not.toMatch(/INJECTED-PROMPT|EVIL/)
        expect((logger.warn as jest.Mock).mock.calls.map((c: any[]) => c[0])).toContain(
            '[server]: overrideConfig.vars: 2 ignored (variable not allowlisted): region, tier'
        )
    })

    it('overrides ON with only region allowlisted: only $vars.region takes the request value; $flow never does', async () => {
        const inputs = (await initsFor(shape, { status: true, nodes: {}, variables: varsOn(['region']) }))[nodeName]
        expect(inputs.systemMessagePrompt).toBe('You are {{$flow.persona}}. Key=EVIL')
        expect(inputs.flowFields).toBe(SERVER_FLOW_FIELDS)
        expect(inputs.otherVar).toBe('gold')
        expect(JSON.stringify(inputs)).not.toMatch(/INJECTED-PROMPT|EVIL-TIER|EVIL-FLOW|EVIL-CHAT/)
    })

    it('a string "true" in variableOverrides allows nothing', async () => {
        const variables = [{ id: 'r', name: 'region', type: 'static', enabled: 'true' }]
        const inputs = (await initsFor(shape, { status: true, nodes: {}, variables }))[nodeName]
        expect(inputs.systemMessagePrompt).toBe('You are {{$flow.persona}}. Key=us')
    })
})
