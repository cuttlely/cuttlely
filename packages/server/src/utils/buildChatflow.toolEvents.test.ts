import fs from 'fs'
import os from 'os'
import path from 'path'
import * as utils from './index'
import * as usage from '../services/usage'
import { executeFlow } from './buildChatflow'
import { SSEStreamer } from './SSEStreamer'

jest.mock('./logger', () => ({ __esModule: true, default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

let fixtureDir: string
let fixturePath: string
beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-event-node-'))
    fixturePath = path.join(fixtureDir, 'agent.js')
    fs.writeFileSync(
        fixturePath,
        'module.exports.nodeClass = class { async run(data, input, options) { return globalThis.__toolEventRun(options) } }'
    )
})
afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }))
afterEach(() => {
    jest.restoreAllMocks()
    delete (globalThis as any).__toolEventRun
})

it.each([
    [undefined, true, false],
    [false, true, false],
    [true, true, true],
    [true, false, false]
])('executes a chatflow with setting=%s streaming=%s and preserves saved response fields', async (status, streaming, events) => {
    const node = {
        id: 'agent_0',
        position: { x: 0, y: 0 },
        data: { id: 'agent_0', name: 'toolAgent', label: 'Tool Agent', category: 'Agents', inputs: {}, outputs: {}, inputParams: [] }
    }
    jest.spyOn(utils, 'buildFlow').mockResolvedValue([node] as any)
    jest.spyOn(utils, 'isFlowValidForStream').mockReturnValue(true)
    jest.spyOn(usage, 'recordCompletedRun').mockResolvedValue(undefined)
    const saved: any[] = []
    const repo = {
        findBy: async () => [],
        create: (row: any) => row,
        save: async (row: any) => {
            saved.push(row)
            return row
        }
    }
    const response = { write: jest.fn(), end: jest.fn() }
    const streamer = new SSEStreamer()
    streamer.addClient('chat', response as any)
    const resultFields = {
        text: 'Answer',
        sourceDocuments: [{ pageContent: 'Source' }],
        usedTools: [{ tool: 'mcp_database_query', toolOutput: 'Rows' }],
        artifacts: [{ type: 'png', data: 'chart' }],
        fileAnnotations: [{ fileName: 'report.csv' }],
        action: { id: 'approval', elements: [] }
    }
    ;(globalThis as any).__toolEventRun = (options: any) => {
        expect(options.chatflowType).toBe('CHATFLOW')
        expect(options.showToolEvents).toBe(status === true)
        if (options.sseStreamer) {
            options.sseStreamer.streamStartEvent('chat', '')
            options.sseStreamer.streamUsedToolsEvent('chat', resultFields.usedTools)
            options.sseStreamer.streamCustomEvent('chat', 'agent_trace', { name: 'mcp_database_query' })
            options.sseStreamer.streamCustomEvent('chat', 'harness.route', { harness: 'bakery', phase: 'start' })
            options.sseStreamer.streamTokenEvent('chat', resultFields.text)
        }
        return { ...resultFields }
    }
    const result = await executeFlow({
        componentNodes: { toolAgent: { filePath: fixturePath } },
        incomingInput: { question: 'Question', streaming },
        chatflow: {
            id: 'flow',
            type: 'CHATFLOW',
            workspaceId: 'workspace',
            flowData: JSON.stringify({ nodes: [node], edges: [] }),
            chatbotConfig: status === undefined ? undefined : JSON.stringify({ showToolEvents: { status } })
        },
        chatId: 'chat',
        appDataSource: { getRepository: () => repo },
        telemetry: { sendTelemetry: jest.fn() },
        cachePool: {},
        usageCacheManager: {},
        sseStreamer: streamer,
        isInternal: true,
        orgId: 'org',
        workspaceId: 'workspace',
        harnessCaller: { via: 'session' }
    } as any)
    expect(result).toMatchObject(resultFields)
    const answer = saved.find((row) => row.role === 'apiMessage')
    expect(answer.content).toBe(resultFields.text)
    for (const key of ['sourceDocuments', 'usedTools', 'artifacts', 'fileAnnotations', 'action'] as const) {
        expect(JSON.parse(answer[key])).toEqual(resultFields[key])
    }
    const sent = response.write.mock.calls.map(([frame]) => JSON.parse(frame.split('data:')[1]).event)
    expect(sent.includes('usedTools')).toBe(events)
    expect(sent.includes('agent_trace')).toBe(events)
    expect(sent.includes('harness.route')).toBe(streaming)
    expect(sent.includes('token')).toBe(streaming)
})
