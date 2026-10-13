/**
 * The publish check replays a question through an agentflow with replay on. This drives the real executeAgentFlow
 * with two stand-in steps and a recording data source, and checks that a replay writes nothing: no execution record,
 * no chat messages, no telemetry and no streaming, and reads no earlier run or chat history.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { recordedQuestion, replayFromQuestion } from '../services/flow-check/inputs'
import {
    STORED_FORM_MARKER,
    executeAgentFlow,
    formObjectToReadableLines,
    formObjectToStoredLines,
    parseStoredForm,
    resolveVariables
} from './buildAgentflow'
import { stepTokens } from '../services/flow-check/compare'
import * as usage from '../services/usage'

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
        ),
        // The same rule as the Start node: a form is stored from agentflowRuntime.form, otherwise from the input the engine passed.
        formStart: write(
            'form-start',
            `const type = nodeData.inputs && nodeData.inputs.startInputType
            const mode = nodeData.inputs && nodeData.inputs.scheduleInputMode
            const output = {}
            const runtimeForm = options.agentflowRuntime && options.agentflowRuntime.form
            const runtimeWebhook = options.agentflowRuntime && options.agentflowRuntime.webhook
            if (type === 'formInput' || (type === 'scheduleInput' && mode === 'form')) {
                output.form = runtimeForm && Object.keys(runtimeForm).length ? runtimeForm : input
            } else if (type === 'webhookTrigger') {
                let webhook = input
                if (typeof webhook === 'string') {
                    try { webhook = JSON.parse(webhook) } catch (e) { /* the runtime object is used instead */ }
                }
                output.webhook = runtimeWebhook && Object.keys(runtimeWebhook).length ? runtimeWebhook : webhook
            } else {
                output.question = input
            }
            return { id: nodeData.id, name: 'startAgentflow', input: {}, output, state: {} }`
        ),
        // Same assignment as Custom Function: $flow.input is the string the engine passed in.
        customFunctionAgentflow: write(
            'custom-function',
            `const flow = { input: input }
            return { id: nodeData.id, name: 'customFunctionAgentflow', input: {}, output: { content: flow.input }, state: {} }`
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
function recordingDataSource(previousExecutions: any[] = []) {
    const calls: string[] = []
    const saved: Record<string, any> = {}
    const repo = (entity: any) => {
        const table = typeof entity === 'function' ? entity.name : String(entity)
        const log = (op: string) => calls.push(`${table}.${op}`)
        return {
            find: async () => (log('find'), table === 'Execution' ? previousExecutions : []),
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
    return { calls, saved, appDataSource: { getRepository: repo } }
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

async function run(opts: {
    replay: boolean
    startInputType?: string
    humanInput?: unknown
    flowData?: string
    incoming?: Record<string, unknown>
    chatType?: string
    nodes?: Record<string, { filePath: string }>
    previousExecutions?: any[]
}) {
    const { calls, saved, appDataSource } = recordingDataSource(opts.previousExecutions)
    const { events, sseStreamer } = streamer()
    const telemetry = { sendTelemetry: jest.fn() }
    const result = await executeAgentFlow({
        componentNodes: opts.nodes || componentNodes,
        incomingInput: {
            streaming: false,
            humanInput: opts.humanInput,
            ...(opts.incoming || { question: 'When is the sourdough ready?' })
        } as any,
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
        chatType: opts.chatType,
        orgId: 'org-1',
        workspaceId: 'ws-1',
        subscriptionId: 'sub-1',
        productId: 'prod-1',
        replay: opts.replay
    } as any)
    return { result, calls, events, telemetry, saved }
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

    it('records each iteration step once on the top-level run', async () => {
        const spy = jest.spyOn(usage, 'recordCompletedRun').mockImplementation(() => Promise.resolve())
        try {
            await run({ replay: false, flowData: iterationCanvas() })
            expect(spy).toHaveBeenCalledTimes(1)
            const recorded = usage.usageLinesFromRun(spy.mock.calls[0][1].result)
            expect(recorded).toEqual([{ model: 'unknown', inputTokens: 24, outputTokens: 18 }])
        } finally {
            spy.mockRestore()
        }
    })

    it('ignores a human input answer sent with the question', async () => {
        const { calls, result } = await run({ replay: true, humanInput: { type: 'proceed', startNodeId: 'llmAgentflow_0' } })
        expect(result.status).toBe('FINISHED')
        expect(calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])
    })

    it('replays a form, webhook or schedule start from the recorded input and writes nothing', async () => {
        const readable = 'path: C:\\temp\nbio: line one\nline two'
        const form = await run({
            replay: true,
            startInputType: 'formInput',
            incoming: { form: { path: 'C:\\temp', bio: 'line one\nline two' } }
        })
        expect(form.result.status).toBe('FINISHED')
        expect(form.result.text).toBe(`Fresh bread at 7 for: ${readable}`)
        expect(form.result.text).not.toContain('\u0000')
        expect(form.result.text).not.toContain('C:\\\\temp')
        expect(form.result.text).not.toContain('line one\\nline two')
        expect(form.calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])

        const webhookCanvas = JSON.stringify({
            nodes: [
                node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'webhookTrigger', webhookInputMode: 'payload' }),
                node('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModel: 'chatOpenAI' })
            ],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'llmAgentflow_0', sourceHandle: 'a', targetHandle: 'b' }]
        })
        const webhook = await run({
            replay: true,
            startInputType: 'webhookTrigger',
            chatType: 'WEBHOOK',
            flowData: webhookCanvas,
            incoming: { webhook: { body: { event: 'bake' }, headers: {}, query: {} } }
        })
        expect(webhook.result.status).toBe('FINISHED')
        expect(webhook.result.text).toContain('bake')
        expect(webhook.calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])

        const schedule = await run({
            replay: true,
            startInputType: 'scheduleInput',
            chatType: 'SCHEDULED',
            incoming: { question: 'Run the daily report' }
        })
        expect(schedule.result.status).toBe('FINISHED')
        expect(schedule.result.text).toContain('Run the daily report')
        expect(schedule.calls.filter((c) => c.startsWith('Execution.') || c.startsWith('ChatMessage.'))).toEqual([])
    })

    it('a real form prediction stores name: value lines, and the check reads that stored string', async () => {
        const nodes = { ...componentNodes, startAgentflow: componentNodes.formStart }
        const form = await run({
            replay: false,
            startInputType: 'formInput',
            incoming: { form: { loaf: 'millet' } },
            nodes
        })
        const stored = JSON.parse(form.saved.Execution.executionData).find((step: any) => step.data?.name === 'startAgentflow')
        expect(stored.data.output.form).toBe(`${STORED_FORM_MARKER}\nloaf: millet`)
        expect(JSON.parse(recordedQuestion(form.saved.Execution.executionData, 'formInput') as string)).toEqual({
            form: { loaf: 'millet' }
        })

        const scheduleCanvas = JSON.stringify({
            nodes: [
                node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'scheduleInput', scheduleInputMode: 'form' }),
                node('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModel: 'chatOpenAI' })
            ],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'llmAgentflow_0', sourceHandle: 'a', targetHandle: 'b' }]
        })
        const schedule = await run({
            replay: false,
            chatType: 'SCHEDULED',
            flowData: scheduleCanvas,
            incoming: { form: { team: 'bakery' } },
            nodes
        })
        const scheduleStored = JSON.parse(schedule.saved.Execution.executionData).find((step: any) => step.data?.name === 'startAgentflow')
        expect(scheduleStored.data.output.form).toBe(`${STORED_FORM_MARKER}\nteam: bakery`)
        expect(JSON.parse(recordedQuestion(schedule.saved.Execution.executionData, 'scheduleInput') as string)).toEqual({
            form: { team: 'bakery' }
        })
    })

    it('gives the model and $flow.input the readable lines, and stores the marked form', async () => {
        const submitted = { path: 'C:\\temp', bio: 'line one\nline two', note: '' }
        const readable = 'path: C:\\temp\nbio: line one\nline two\nnote: '
        const flowData = JSON.stringify({
            nodes: [
                node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'formInput' }),
                node('customFunctionAgentflow_0', 'customFunctionAgentflow', 'Read input', {}),
                node('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModel: 'chatOpenAI' })
            ],
            edges: [
                { id: 'e1', source: 'startAgentflow_0', target: 'customFunctionAgentflow_0', sourceHandle: 'a', targetHandle: 'b' },
                { id: 'e2', source: 'customFunctionAgentflow_0', target: 'llmAgentflow_0', sourceHandle: 'a', targetHandle: 'b' }
            ]
        })
        const nodes = { ...componentNodes, startAgentflow: componentNodes.formStart }
        const live = await run({ replay: false, startInputType: 'formInput', flowData, incoming: { form: submitted }, nodes })
        expect(live.result.text).toBe(`Fresh bread at 7 for: ${readable}`)
        expect(live.result.text).not.toContain('\u0000')
        const seen = live.result.agentFlowExecutedData.find((row: any) => row.nodeLabel === 'Read input')
        expect(seen.data.output.content).toBe(readable)
        const stored = JSON.parse(live.saved.Execution.executionData).find((row: any) => row.data?.name === 'startAgentflow')
        expect(stored.data.output.form).toBe(formObjectToStoredLines(submitted))
        expect(stored.data.output.form.startsWith(`${STORED_FORM_MARKER}\n`)).toBe(true)
        expect(stored.data.output.form).toContain('path: C:\\\\temp')
        expect(stored.data.output.form).toContain('bio: line one\\nline two')
        expect(parseStoredForm(stored.data.output.form)).toEqual({ form: submitted, duplicateKey: false })

        const replay = await run({
            replay: true,
            startInputType: 'formInput',
            flowData,
            incoming: { form: parseStoredForm(stored.data.output.form).form },
            nodes
        })
        expect(replay.result.text).toBe(live.result.text)
        expect(replay.result.agentFlowExecutedData.find((row: any) => row.nodeLabel === 'Read input').data.output.content).toBe(readable)
    })

    it('replays a form in the stored field order', () => {
        const lines = 'path: C:\\temp\nbio: line one\nnote: keep'
        const stored = JSON.stringify([
            {
                nodeId: 'startAgentflow_0',
                data: { name: 'startAgentflow', output: { form: lines } },
                status: 'FINISHED'
            }
        ])
        const text = recordedQuestion(stored, 'formInput') as string
        const form = replayFromQuestion(text, 'formInput').incoming.form as Record<string, string>
        expect(Object.keys(form)).toEqual(['path', 'bio', 'note'])
        expect(formObjectToReadableLines(form)).toBe(lines)
    })

    it('a blank form value stays empty on both sides, and escapes round-trip', async () => {
        const isEmpty = (value: unknown) => [undefined, null, ''].includes(value as string)
        const stored = formObjectToStoredLines({ name: 'ada', note: '' })
        expect(stored).toBe(`${STORED_FORM_MARKER}\nname: ada\nnote: `)
        expect(parseStoredForm('note:    ').form).toEqual({ note: '' })
        const parsed = parseStoredForm(stored).form
        expect(parsed).toEqual({ name: 'ada', note: '' })
        const field = {
            id: 'n',
            inputs: { value1: '{{$form.note}}' },
            inputParams: [{ name: 'value1', acceptVariable: true }]
        } as any
        const live = await resolveVariables(field, '', { name: 'ada', note: '' }, undefined, [], '', [], {} as any)
        const checked = await resolveVariables(field, '', parsed, undefined, [], '', [], {} as any)
        expect(live.inputs?.value1).toBe('')
        expect(checked.inputs?.value1).toBe('')
        expect(isEmpty(live.inputs?.value1)).toBe(true)
        expect(isEmpty(checked.inputs?.value1)).toBe(true)

        const rich = {
            bio: 'line1\nname: eve',
            path: 'C:\\temp',
            win: 'a\r\nb',
            note: 'size: large',
            colon: 'a: b',
            blank: ''
        }
        const lines = formObjectToStoredLines(rich)
        expect(lines.startsWith(`${STORED_FORM_MARKER}\n`)).toBe(true)
        expect(lines.split('\n')).toHaveLength(7)
        expect(parseStoredForm(lines)).toEqual({ form: rich, duplicateKey: false })
        const spaced = formObjectToStoredLines({ note: '  millet  ', blank: '' })
        expect(parseStoredForm(spaced).form.note).toBe('  millet  ')
        expect(parseStoredForm(spaced).form.blank).toBe('')
        const broken = parseStoredForm('bio: line1\nline2')
        expect(broken.duplicateKey).toBe(true)
        expect(parseStoredForm('loaf: rye\ncount: 2')).toEqual({ form: { loaf: 'rye', count: '2' }, duplicateKey: false })
        expect(parseStoredForm('team: bakery')).toEqual({ form: { team: 'bakery' }, duplicateKey: false })
        const legacy = parseStoredForm('name: ada\nbio: line1\nname: eve')
        expect(legacy.duplicateKey).toBe(true)
        expect(legacy.form.name).toBe('eve')
    })

    // Values an older run stored with no escapes. Each one contains a backslash the unescape step would rewrite.
    const legacyForm = {
        notes: 'C:\\notes\\readme',
        fresh: 'C:\\new',
        share: '\\\\server\\share',
        report: 'C:\\reports\\q1',
        literal: 'line\\nbreak',
        temp: 'C:\\temp'
    }
    const legacyText = Object.entries(legacyForm)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')

    it('an older form line keeps a backslash as typed', () => {
        expect(legacyText.startsWith(STORED_FORM_MARKER)).toBe(false)
        expect(parseStoredForm(legacyText)).toEqual({ form: legacyForm, duplicateKey: false })
        for (const [key, value] of Object.entries(legacyForm)) {
            expect(parseStoredForm(`${key}: ${value}`).form[key]).toBe(value)
        }
        // A field name that begins with the marker is still a legacy `name: value` line.
        const named = `${STORED_FORM_MARKER}: C:\\new`
        expect(parseStoredForm(named).form[STORED_FORM_MARKER]).toBe('C:\\new')
    })

    it('a later message in a legacy form session keeps the stored text', async () => {
        const probe = path.join(dir, 'form-probe.js')
        fs.writeFileSync(
            probe,
            step(
                `const form = (options.agentflowRuntime && options.agentflowRuntime.form) || {}
                return { id: nodeData.id, name: 'llmAgentflow', input: {}, output: { content: JSON.stringify(form) }, state: {} }`
            )
        )
        const previous = {
            id: 'exec-legacy',
            state: 'FINISHED',
            sessionId: 'c0ffee00-0000-4000-8000-000000000001',
            agentflowId: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
            workspaceId: 'ws-1',
            executionData: JSON.stringify([
                {
                    nodeId: 'startAgentflow_0',
                    nodeLabel: 'Start',
                    data: { name: 'startAgentflow', output: { form: legacyText } },
                    status: 'FINISHED'
                }
            ])
        }
        const resumed = await run({
            replay: false,
            startInputType: 'formInput',
            incoming: { question: 'next' },
            nodes: { ...componentNodes, startAgentflow: componentNodes.formStart, llmAgentflow: { filePath: probe } },
            previousExecutions: [previous]
        })
        const stored = JSON.parse(resumed.saved.Execution.executionData).find((row: any) => row.data?.name === 'startAgentflow')
        expect(stored.data.output.form).toBe(legacyText)
        expect(JSON.parse(resumed.result.text)).toEqual(legacyForm)
        expect(JSON.parse(recordedQuestion(resumed.saved.Execution.executionData, 'formInput') as string).form).toEqual(legacyForm)
    })

    it('random form text round-trips through the old lines and the marked lines', () => {
        let state = 0xc0ffee
        const next = () => {
            state = (state + 0x6d2b79f5) >>> 0
            let t = Math.imul(state ^ (state >>> 15), state | 1)
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
        const body = ['a', 'b', 'n', 'r', '\\', ':', '0', 'Z', '.', '_']
        const glue = ['', ' ', ':', ': ']
        const chunk = () => {
            const len = 1 + Math.floor(next() * 4)
            let out = ''
            for (let i = 0; i < len; i++) out += body[Math.floor(next() * body.length)]
            return out
        }
        const text = () => {
            const parts = 1 + Math.floor(next() * 4)
            let out = ''
            for (let i = 0; i < parts; i++) out += (i ? glue[Math.floor(next() * glue.length)] : '') + chunk()
            return out
        }
        const legacyLines = (form: Record<string, string>) =>
            Object.entries(form)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')
        for (let trial = 0; trial < 40; trial++) {
            const form: Record<string, string> = {}
            const fields = 1 + Math.floor(next() * 4)
            for (let i = 0; i < fields; i++) form[`k${trial}_${i}_${chunk()}`] = i === fields - 1 && next() < 0.2 ? '' : text()
            form[`p${trial}`] = `${text()}\\n${text()}\\r${text()}: ${text()}`
            const unmarked = legacyLines(form)
            expect(unmarked.startsWith(STORED_FORM_MARKER)).toBe(false)
            expect(parseStoredForm(unmarked)).toEqual({ form, duplicateKey: false })
            const marked = formObjectToStoredLines(form)
            expect(marked.startsWith(`${STORED_FORM_MARKER}\n`)).toBe(true)
            expect(parseStoredForm(marked)).toEqual({ form, duplicateKey: false })
        }
    })

    it('a nested webhook query is stored, and the check hides the password', async () => {
        const nodes = { ...componentNodes, startAgentflow: componentNodes.formStart }
        const webhook = await run({
            replay: false,
            startInputType: 'webhookTrigger',
            chatType: 'WEBHOOK',
            nodes,
            incoming: {
                webhook: { body: { event: 'bake' }, query: { user: { password: 's3cret', name: 'ada' }, note: 'keep' }, headers: {} }
            }
        })
        const stored = JSON.parse(webhook.saved.Execution.executionData).find((step: any) => step.data?.name === 'startAgentflow')
        expect(stored.data.output.webhook.query.user.password).toBe('s3cret')
        expect(stored.data.output.webhook.query.user.name).toBe('ada')
        expect(stored.data.output.webhook.query.note).toBe('keep')
        const shown = recordedQuestion(webhook.saved.Execution.executionData, 'webhookTrigger') as string
        expect(shown).not.toContain('s3cret')
        expect(shown).toContain('[REDACTED]')
        expect(shown).toContain('ada')
        expect(shown).toContain('keep')
    })

    it('still refuses a webhook or schedule replay that is not that kind of call', async () => {
        await expect(run({ replay: true, startInputType: 'webhookTrigger', incoming: { webhook: { body: {} } } })).rejects.toMatchObject({
            statusCode: 400
        })
        await expect(run({ replay: true, startInputType: 'scheduleInput', incoming: { question: 'Run it' } })).rejects.toMatchObject({
            statusCode: 400
        })
    })
})
