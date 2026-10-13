/**
 * Harness run spans. Traces are off unless CUTTLELY_OTEL_TRACES=true.
 * The tree follows the run card: route, each specialist, each tool, the handoff, and a model span per call.
 */
import { spawnSync } from 'child_process'
import path from 'path'
import { installInMemoryTraces, openHarnessRunTrace, silenceRunTraces, traceFlow, withNodeSpan, type FinishedTraceSpan } from './tracing'

type HarnessTraceSession = NonNullable<ReturnType<typeof openHarnessRunTrace>>

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() }
}))

const TRACE_ENV = ['CUTTLELY_OTEL_TRACES', 'CUTTLELY_OTEL_TRACES_ENDPOINT', 'CUTTLELY_OTEL_TRACES_PROTOCOL', 'CUTTLELY_OTEL_TRACES_CONTENT']

const T0 = 1_700_000_000_000
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const SQL = 'select loaf from oven'
const ROW_TEXT = 'rye'
const QUESTION = 'How many loaves?'
const ANSWER = 'Two loaves.'
const TASK = 'Count the loaves'

function clearTraceEnv(): void {
    for (const key of TRACE_ENV) delete process.env[key]
}

function contentKeys(spans: FinishedTraceSpan[]): string[] {
    return spans.flatMap((span) => Object.keys(span.attributes).filter((key) => key.startsWith('content.')))
}

function analystDetail(): string {
    return JSON.stringify({
        result: JSON.stringify({
            sql: SQL,
            rows: [{ loaf: ROW_TEXT }, { loaf: 'wheat' }],
            summary: '2 rows'
        })
    })
}

function bakeryEvents(): Record<string, unknown>[] {
    const detail = analystDetail()
    return [
        { type: 'route', phase: 'start', harness: 'bakery', at: T0 },
        {
            type: 'route',
            phase: 'done',
            harness: 'bakery',
            at: T0 + 40,
            ms: 40,
            model: 'prime',
            tokens: { prompt: 12, completion: 3 },
            steps: [{ specialist: 'analyst', task: TASK }],
            calls: [{ model: 'prime', startedAt: T0 + 2, endedAt: T0 + 38, tokens: { prompt: 12, completion: 3 } }]
        },
        { type: 'specialist', phase: 'start', name: 'analyst', task: TASK, model: 'analyst-model', at: T0 + 41 },
        { type: 'tool', phase: 'start', specialist: 'analyst', name: 'mcp__analyst__query', at: T0 + 50 },
        { type: 'tool', phase: 'done', specialist: 'analyst', name: 'mcp__analyst__query', at: T0 + 70, detail },
        {
            type: 'specialist',
            phase: 'done',
            name: 'analyst',
            status: 'completed',
            ms: 40,
            model: 'analyst-model',
            tokens: { prompt: 20, completion: 5 },
            task: TASK,
            at: T0 + 81,
            tools: [{ name: 'mcp__analyst__query', status: 'done', detail }],
            calls: [{ model: 'analyst-model', startedAt: T0 + 42, endedAt: T0 + 48, tokens: { prompt: 20, completion: 5 } }]
        },
        { type: 'handoff', phase: 'start', model: 'prime', at: T0 + 82 },
        {
            type: 'handoff',
            phase: 'done',
            at: T0 + 100,
            ms: 18,
            model: 'prime',
            tokens: { prompt: 30, completion: 8 },
            calls: [{ model: 'prime', startedAt: T0 + 83, endedAt: T0 + 99, tokens: { prompt: 30, completion: 8 } }]
        },
        {
            type: 'final',
            at: T0 + 101,
            text: ANSWER,
            trace: {
                status: 'completed',
                error: '',
                harness: 'bakery',
                tokens: { prompt: 62, completion: 16 },
                route: { status: 'done', steps: [{ specialist: 'analyst', task: TASK }] },
                specialists: [{ name: 'analyst', tools: [{ name: 'mcp__analyst__query', status: 'done', detail }] }],
                handoff: { status: 'done' }
            }
        }
    ]
}

function play(session: HarnessTraceSession, events = bakeryEvents()): void {
    for (const event of events) session.event(event)
    session.finish({ text: ANSWER, runId: 'run_11111111-1111-4111-8111-111111111111' })
}

function traceViewSteps(events: Record<string, unknown>[]): { specialists: string[]; tools: string[]; handoff: boolean; route: boolean } {
    const file = path.resolve(__dirname, '../../../harness/trace.mjs')
    const script = `
        const { emptyTrace, reduceHarnessEvent } = await import(${JSON.stringify(file)})
        const events = ${JSON.stringify(events)}
        const view = events.reduce((trace, event) => reduceHarnessEvent(trace, event), emptyTrace('bakery'))
        process.stdout.write(JSON.stringify({
            specialists: (view.specialists || []).map((item) => item.name),
            tools: (view.specialists || []).flatMap((item) => (item.tools || []).map((tool) => tool.name)),
            handoff: view.handoff?.status === 'done',
            route: Boolean(view.route)
        }))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'trace view reducer failed')
    return JSON.parse(result.stdout)
}

describe('harness run spans', () => {
    let memory: { spans: () => FinishedTraceSpan[]; reset: () => void }

    beforeAll(() => {
        memory = installInMemoryTraces()
    })

    beforeEach(() => {
        memory.reset()
        clearTraceEnv()
    })

    afterEach(() => {
        clearTraceEnv()
    })

    it('matches the run card and nests under the chatflow prediction', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const events = bakeryEvents()
        const card = traceViewSteps(events)
        await traceFlow('chatflow', 'flow-bakery', async () => {
            await withNodeSpan('node-harness', 'harness', async () => {
                const session = openHarnessRunTrace({ name: 'bakery', workspaceId: WORKSPACE, question: QUESTION })
                expect(session).toBeDefined()
                play(session as HarnessTraceSession, events)
            })
        })
        const spans = memory.spans()
        const prediction = spans.find((span) => span.name === 'chatflow.prediction')
        const node = spans.find((span) => span.name === 'node')
        const root = spans.find((span) => span.name === 'harness.run')
        expect(prediction).toBeDefined()
        expect(node?.parentSpanId).toBe(prediction?.spanId)
        expect(root?.parentSpanId).toBe(node?.spanId)
        expect(root?.traceId).toBe(prediction?.traceId)
        expect(root?.attributes).toMatchObject({
            'harness.name': 'bakery',
            'workspace.id': WORKSPACE,
            'run.id': 'run_11111111-1111-4111-8111-111111111111',
            'flow.id': 'flow-bakery',
            'flow.kind': 'chatflow',
            status: 'ok',
            'tokens.input': 62,
            'tokens.output': 16
        })
        expect(root?.startTimeMs).toBe(T0)
        expect(root?.endTimeMs).toBe(T0 + 101)

        const children = spans.filter((span) => span.parentSpanId === root?.spanId).map((span) => span.name)
        expect(children).toEqual(expect.arrayContaining(['harness.route', 'harness.specialist', 'harness.handoff']))
        const specialist = spans.find((span) => span.name === 'harness.specialist')
        const tool = spans.find((span) => span.name === 'tool')
        const route = spans.find((span) => span.name === 'harness.route')
        const handoff = spans.find((span) => span.name === 'harness.handoff')
        expect(specialist?.attributes['specialist.name']).toBe('analyst')
        expect(specialist?.attributes).toMatchObject({
            'tokens.input': 20,
            'tokens.output': 5,
            'model.name': 'analyst-model',
            status: 'ok'
        })
        expect(tool?.parentSpanId).toBe(specialist?.spanId)
        expect(tool?.attributes).toMatchObject({ 'tool.name': 'mcp__analyst__query', 'tool.rows': 2, status: 'ok' })
        expect(tool?.startTimeMs).toBe(T0 + 50)
        expect(tool?.endTimeMs).toBe(T0 + 70)
        expect(route?.attributes).toMatchObject({ 'model.name': 'prime', 'tokens.input': 12, 'tokens.output': 3, status: 'ok' })
        expect(handoff?.attributes).toMatchObject({ 'model.name': 'prime', 'tokens.input': 30, 'tokens.output': 8, status: 'ok' })

        const models = spans.filter((span) => span.name === 'model')
        expect(models).toHaveLength(3)
        expect(models.map((span) => span.parentSpanId).sort()).toEqual([route?.spanId, specialist?.spanId, handoff?.spanId].sort())
        expect(models.find((span) => span.parentSpanId === route?.spanId)?.attributes).toMatchObject({
            'model.name': 'prime',
            'tokens.input': 12,
            'tokens.output': 3
        })

        expect(spans.filter((span) => span.name === 'harness.specialist').map((span) => span.attributes['specialist.name'])).toEqual(
            card.specialists
        )
        expect(spans.filter((span) => span.name === 'tool').map((span) => span.attributes['tool.name'])).toEqual(card.tools)
        expect(Boolean(handoff)).toBe(card.handoff)
        expect(Boolean(route)).toBe(card.route)

        const dumped = JSON.stringify(spans)
        expect(contentKeys(spans)).toEqual([])
        expect(dumped).not.toContain(SQL)
        expect(dumped).not.toContain(ROW_TEXT)
        expect(dumped).not.toContain(QUESTION)
        expect(dumped).not.toContain(ANSWER)
        expect(dumped).not.toContain(TASK)
    })

    it('adds question, answer, SQL, and rows only when content is on', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'true'
        const session = openHarnessRunTrace({ name: 'bakery', workspaceId: WORKSPACE, question: QUESTION })
        play(session as HarnessTraceSession)
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'harness.run')
        const tool = spans.find((span) => span.name === 'tool')
        const specialist = spans.find((span) => span.name === 'harness.specialist')
        expect(root?.attributes['content.input']).toBe(QUESTION)
        expect(root?.attributes['content.output']).toBe(ANSWER)
        expect(tool?.attributes['content.input']).toBe(SQL)
        expect(String(tool?.attributes['content.output'])).toContain(ROW_TEXT)
        expect(specialist?.attributes['content.input']).toBe(TASK)
        expect(tool?.attributes['tool.rows']).toBe(2)
    })

    it('does not put a non-id workspace value on the span', () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const session = openHarnessRunTrace({ name: 'bakery', workspaceId: 'not-a-team', question: QUESTION })
        session?.event({
            type: 'final',
            at: T0,
            text: ANSWER,
            trace: {
                status: 'completed',
                error: '',
                tokens: { prompt: 1, completion: 1 },
                route: {},
                specialists: [],
                handoff: { status: 'skipped' }
            }
        })
        session?.finish({ text: ANSWER })
        const root = memory.spans().find((span) => span.name === 'harness.run')
        expect(root?.attributes['workspace.id']).toBeUndefined()
        expect(JSON.stringify(root?.attributes)).not.toContain('not-a-team')
        expect(JSON.stringify(root?.attributes)).not.toContain(QUESTION)
    })

    it('exports nothing when traces are off, silenced, or the run is a draft or a replay', async () => {
        expect(openHarnessRunTrace({ name: 'bakery', question: QUESTION })).toBeUndefined()
        expect(memory.spans()).toEqual([])

        process.env.CUTTLELY_OTEL_TRACES = 'true'
        expect(openHarnessRunTrace({ name: 'bakery', draft: true })).toBeUndefined()
        expect(openHarnessRunTrace({ name: 'bakery', replay: true })).toBeUndefined()
        expect(openHarnessRunTrace({ name: 'bakery', cuttlelyReplay: true })).toBeUndefined()
        await silenceRunTraces(async () => {
            expect(openHarnessRunTrace({ name: 'bakery', question: QUESTION })).toBeUndefined()
        })
        expect(memory.spans()).toEqual([])
    })

    it('marks a failed run as error and still leaves the question off the span', () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const session = openHarnessRunTrace({ name: 'bakery', question: QUESTION })
        session?.event({ type: 'route', phase: 'start', at: T0 })
        session?.fail(new Error('Client disconnected'))
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'harness.run')
        expect(root?.attributes.status).toBe('error')
        expect(root?.attributes.error).toBe('Client disconnected')
        expect(contentKeys(spans)).toEqual([])
        expect(JSON.stringify(spans)).not.toContain(QUESTION)
    })
})
