// The publish check runner: limits, stopping, and that it never writes chat history or Live.
const states = new Map<string, any>()
let draftsOn = true
jest.mock('../flow-drafts', () => ({
    __esModule: true,
    default: {
        getState: async (id: string) => states.get(id) || null,
        isDraftsEnabled: () => draftsOn
    },
    canvasHash: (flowData: string) => `hash:${flowData}`
}))
const messages: any[] = []
const datasets = new Map<string, any>()
const datasetRows: any[] = []
const evaluatorRows = new Map<string, any>()
const datasetHooks: { onLoad: null | (() => void) } = { onLoad: null }
const executions: any[] = []
const queryState = { take: undefined as number | undefined, skip: 0 }
const queryBuilder: any = {
    select: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
    leftJoinAndSelect: () => queryBuilder,
    orderBy: () => queryBuilder,
    addOrderBy: () => queryBuilder,
    take: (n: number) => {
        queryState.take = n
        return queryBuilder
    },
    skip: (n: number) => {
        queryState.skip = n
        return queryBuilder
    },
    getMany: async () => {
        const start = queryState.skip || 0
        const end = queryState.take == null ? undefined : start + queryState.take
        return messages.slice(start, end)
    },
    getManyAndCount: async () => {
        const ordered = [...executions].sort((a, b) => {
            const ta = new Date(a.updatedDate || a.createdDate || 0).getTime()
            const tb = new Date(b.updatedDate || b.createdDate || 0).getTime()
            if (tb !== ta) return tb - ta
            return String(b.id).localeCompare(String(a.id))
        })
        const start = queryState.skip || 0
        const end = queryState.take == null ? undefined : start + queryState.take
        return [ordered.slice(start, end), ordered.length]
    }
}
const writes = { save: jest.fn(), insert: jest.fn(), update: jest.fn() }
function repository(entity: { name?: string }) {
    const name = entity?.name
    if (name === 'Dataset') {
        return {
            ...writes,
            findOneBy: async (where: { id?: string; workspaceId?: string }) => {
                datasetHooks.onLoad?.()
                const row = where?.id ? datasets.get(where.id) : null
                if (!row || row.workspaceId !== where.workspaceId) return null
                return row
            }
        }
    }
    if (name === 'DatasetRow') {
        return {
            ...writes,
            find: async (opts: { where?: { datasetId?: string } }) =>
                datasetRows
                    .filter((row) => row.datasetId === opts?.where?.datasetId)
                    .slice()
                    .sort((a, b) => Number(a.sequenceNo) - Number(b.sequenceNo) || String(a.id).localeCompare(String(b.id)))
        }
    }
    if (name === 'Evaluator') {
        return {
            ...writes,
            findOneBy: async (where: { id?: string; workspaceId?: string }) => {
                const row = where?.id ? evaluatorRows.get(where.id) : null
                if (!row || row.workspaceId !== where.workspaceId) return null
                return row
            }
        }
    }
    return { createQueryBuilder: () => queryBuilder, ...writes }
}
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: (entity: { name?: string }) => repository(entity) }
    })
}))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/identity', () => ({ Workspace: class Workspace {}, Organization: class Organization {} }))
jest.mock('@cuttlely/components', () => ({ EvaluationRunner: { metrics: new Map() } }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), debug: jest.fn() } }))

import { checks, getCheck, getCheckSetup, priceHooks, replayHooks, startCheck, stopCheck } from './index'
import { scoreHooks } from './score'
import { noteGraderTokens } from '../evaluations/LLMEvaluationRunner'

const canvas = (word: string, extra: any[] = []) =>
    JSON.stringify({
        nodes: [{ id: 'chatOpenAI_0', data: { name: 'chatOpenAI', category: 'Chat Models', label: word } }, ...extra],
        edges: []
    })
const LIVE = canvas('MANGO')
const DRAFT = canvas('PAPAYA')
// An agentflow: a model step first (its label is the answer in these tests), then the Start step.
const agentCanvas = (word: string, startInputType = 'chatInput', extra: any[] = []) =>
    JSON.stringify({
        nodes: [
            { id: 'llmAgentflow_0', data: { name: 'llmAgentflow', category: 'Agent Flows', label: word } },
            {
                id: 'startAgentflow_0',
                data: { name: 'startAgentflow', category: 'Agent Flows', label: 'Start', inputs: { startInputType } }
            },
            ...extra
        ],
        edges: []
    })
const flow = (overrides: any = {}) => ({ id: 'flow-1', type: 'CHATFLOW', flowData: LIVE, workspaceId: 'team-a', ...overrides })
const wordOf = (flowData: string) => JSON.parse(flowData).nodes[0].data.label

async function settle(id = 'flow-1') {
    for (let i = 0; i < 200 && checks.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(() => {
    checks.clear()
    states.clear()
    messages.length = 0
    datasets.clear()
    datasetRows.length = 0
    evaluatorRows.clear()
    datasetHooks.onLoad = null
    scoreHooks.gradeLlm = null
    executions.length = 0
    queryState.take = undefined
    queryState.skip = 0
    draftsOn = true
    delete process.env.CUTTLELY_CHECK_MAX_TOKENS
    delete process.env.CUTTLELY_CHECK_MAX_SECONDS
    delete process.env.CUTTLELY_CHECK_CONCURRENCY
    states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: DRAFT, publishInstantly: false })
    replayHooks.run = async ({ flowData }) => ({ text: wordOf(flowData), metrics: [JSON.stringify({ totalTokens: 50 })] })
    priceHooks.load = null
    jest.clearAllMocks()
})

describe('setup', () => {
    test('recent questions, newest first, without file uploads, plus the limits', async () => {
        messages.push(
            { content: 'What is the code word?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null },
            { content: 'what is the code word? ', createdDate: new Date('2026-10-08T09:00:00Z'), fileUploads: null },
            { content: 'Read this file', createdDate: new Date('2026-10-08T08:00:00Z'), fileUploads: '[{"name":"a.pdf"}]' }
        )
        const setup = await getCheckSetup(flow())
        expect(setup.unavailable).toBeNull()
        expect(setup.questions).toEqual([{ text: 'What is the code word?', date: '2026-10-08T10:00:00.000Z' }])
        expect(setup.riskySteps).toEqual([])
        expect(setup.pastCount).toBe(1)
        expect(setup.pastTruncated).toBe(false)
        expect(setup.replayInputs).toBe(false)
        expect(setup.limits).toEqual({
            maxQuestions: 100,
            defaultQuestions: 4,
            maxQuestionChars: 2000,
            maxTokens: 100000,
            maxSeconds: 180,
            concurrency: 2
        })
        expect(setup.check).toBeNull()
    })

    test('the starter questions fill the list after the recent questions', async () => {
        const chatbotConfig = JSON.stringify({
            starterPrompts: { 0: { prompt: 'What is the code word?' }, 1: { prompt: ' Spell it ' }, 2: { prompt: '' } }
        })
        const setup = await getCheckSetup(flow({ chatbotConfig }))
        expect(setup.questions).toEqual([
            { text: 'What is the code word?', date: '', starter: true },
            { text: 'Spell it', date: '', starter: true }
        ])
        messages.push(
            { content: 'A real question', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null },
            { content: 'spell it', createdDate: new Date('2026-10-08T09:00:00Z'), fileUploads: null }
        )
        expect((await getCheckSetup(flow({ chatbotConfig }))).questions).toEqual([
            { text: 'A real question', date: '2026-10-08T10:00:00.000Z' },
            { text: 'spell it', date: '2026-10-08T09:00:00.000Z' },
            { text: 'What is the code word?', date: '', starter: true }
        ])
        messages.length = 0
        expect((await getCheckSetup(flow({ chatbotConfig: 'not json' }))).questions).toEqual([])
    })

    test('a flow saved only as a draft says Live is empty, and its check asks only the draft', async () => {
        const EMPTY = JSON.stringify({ nodes: [], edges: [] })
        expect((await getCheckSetup(flow())).liveEmpty).toBe(false)
        expect((await getCheckSetup(flow({ flowData: EMPTY }))).liveEmpty).toBe(true)
        const asked: string[] = []
        replayHooks.run = async ({ flowData }) => {
            asked.push(wordOf(flowData))
            return { text: wordOf(flowData), metrics: [JSON.stringify({ totalTokens: 50 })] }
        }
        await startCheck(flow({ flowData: EMPTY }), { questions: ['One?', 'Two?'] }, 'http://x')
        await settle()
        const done = await getCheck(flow({ flowData: EMPTY }), checks.get('flow-1')!.id)
        expect(asked).toEqual(['PAPAYA', 'PAPAYA'])
        expect(done.status).toBe('done')
        expect(done.liveEmpty).toBe(true)
        expect(done.completed).toBe(2)
        expect(done.cases.map((c) => [c.live, c.draft?.text, c.same])).toEqual([
            [null, 'PAPAYA', null],
            [null, 'PAPAYA', null]
        ])
        expect(done.summary).toMatchObject({ ran: 2, same: 0, changed: 0, errors: 0, liveTokens: 0, draftTokens: 100 })
    })

    test('says why the check is not available', async () => {
        expect((await getCheckSetup(flow({ type: 'MULTIAGENT' }))).unavailable?.code).toBe('type')
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'formInput'), publishInstantly: false })
        expect((await getCheckSetup(flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO') }))).unavailable?.code).toBe('start')
        states.clear()
        expect((await getCheckSetup(flow())).unavailable?.code).toBe('no-draft')
        draftsOn = false
        expect((await getCheckSetup(flow())).unavailable?.code).toBe('off')
    })

    test('the limits can be changed in the environment, within bounds', async () => {
        process.env.CUTTLELY_CHECK_MAX_TOKENS = '5000'
        process.env.CUTTLELY_CHECK_MAX_SECONDS = '5'
        process.env.CUTTLELY_CHECK_CONCURRENCY = '99'
        expect((await getCheckSetup(flow())).limits).toMatchObject({ maxTokens: 5000, maxSeconds: 10, concurrency: 8 })
        process.env.CUTTLELY_CHECK_CONCURRENCY = '0'
        expect((await getCheckSetup(flow())).limits.concurrency).toBe(2)
    })
})

describe('running', () => {
    test('replays each question against Live and the draft and compares them', async () => {
        const started = await startCheck(flow() as any, { questions: ['What is the code word?', 'Say it again'] }, 'http://x')
        expect(started.status).toBe('running')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('done')
        expect(done.cases.map((c) => [c.live?.text, c.draft?.text, c.same])).toEqual([
            ['MANGO', 'PAPAYA', false],
            ['MANGO', 'PAPAYA', false]
        ])
        expect(done.summary).toMatchObject({ ran: 2, changed: 2, same: 0, errors: 0, liveTokens: 100, draftTokens: 100 })
        expect(done.cases[0].live?.price).toBe('no price')
        expect(done.cases[0].live?.estimatedCostUsd).toBeNull()
        expect(done.draftChanged).toBe(false)
    })

    test('prices each side from the model tokens, and an unknown model is not zero', async () => {
        priceHooks.load = async () => ({
            unit: 'usd_per_million_tokens',
            rateFor(model: string) {
                if (model === 'gpt-4.1-mini') return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 }
                return null
            }
        })
        replayHooks.run = async ({ flowData }) => ({
            text: wordOf(flowData),
            metrics: [
                JSON.stringify({ model: 'gpt-4.1-mini', promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }),
                JSON.stringify({ model: 'custom-bakery', promptTokens: 100, completionTokens: 50, totalTokens: 150 })
            ]
        })
        const started = await startCheck(flow() as any, { questions: ['How much is a loaf?'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        // 1000 * $0.40 / 1,000,000 + 500 * $1.60 / 1,000,000 = $0.0012. custom-bakery is not priced at zero.
        expect(done.cases[0].live).toMatchObject({
            tokens: 1650,
            estimatedCostUsd: 0.0012,
            price: 'partial',
            unpricedModels: ['custom-bakery']
        })
        expect(done.cases[0].draft).toMatchObject({ estimatedCostUsd: 0.0012, price: 'partial' })
        expect(done.summary.liveEstimatedCostUsd).toBe(0.0012)
        expect(done.summary.draftEstimatedCostUsd).toBe(0.0012)
        expect(done.summary.livePrice).toBe('partial')
    })

    test('a chatflow prices the named sink, and an unnamed tracer count is not a second model', async () => {
        priceHooks.load = async () => ({
            unit: 'usd_per_million_tokens',
            rateFor(model: string) {
                if (model === 'gpt-4.1-mini') return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 }
                return null
            }
        })
        // The tracer's named row is a tokenizer estimate. The unnamed row is the provider count.
        // The lines are what the usage write keeps: 1000 in and 500 out on gpt-4.1-mini.
        replayHooks.run = async ({ flowData }) => ({
            text: wordOf(flowData),
            metrics: [
                JSON.stringify({ model: 'gpt-4.1-mini', promptTokens: 800, completionTokens: 400, totalTokens: 1200 }),
                { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }
            ],
            lines: [{ model: 'gpt-4.1-mini', inputTokens: 1000, outputTokens: 500 }]
        })
        const started = await startCheck(flow() as any, { questions: ['How much is a loaf?'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.cases[0].live).toMatchObject({
            estimatedCostUsd: 0.0012,
            price: 'known',
            unpricedModels: []
        })
        expect(done.cases[0].draft).toMatchObject({ estimatedCostUsd: 0.0012, price: 'known', unpricedModels: [] })
        expect(done.summary.liveEstimatedCostUsd).toBe(0.0012)
        expect(done.summary.livePrice).toBe('known')
        expect(done.summary.draftPrice).toBe('known')
    })

    test('writes nothing: no chat messages, no state, no Live save', async () => {
        const started = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        await settle()
        expect((await getCheck(flow(), started.id)).status).toBe('done')
        expect(writes.save).not.toHaveBeenCalled()
        expect(writes.insert).not.toHaveBeenCalled()
        expect(writes.update).not.toHaveBeenCalled()
        expect(states.get('flow-1').draftFlowData).toBe(DRAFT)
    })

    test('stops at the token limit and says so', async () => {
        process.env.CUTTLELY_CHECK_CONCURRENCY = '1'
        process.env.CUTTLELY_CHECK_MAX_TOKENS = '1000'
        replayHooks.run = async ({ flowData }) => ({ text: wordOf(flowData), metrics: [JSON.stringify({ totalTokens: 400 })] })
        const started = await startCheck(flow() as any, { questions: ['a', 'b', 'c', 'd'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('tokens')
        expect(done.completed).toBe(1)
        expect(done.cases[1].live).toBeNull()
    })

    test('a failed run is shown as an error, and the check goes on', async () => {
        replayHooks.run = async ({ flowData, question }) => {
            if (question === 'bad' && wordOf(flowData) === 'PAPAYA') throw new Error('Model said no')
            return { text: wordOf(flowData) }
        }
        const started = await startCheck(flow() as any, { questions: ['bad', 'good'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.cases[0].draft).toMatchObject({ text: null, error: 'Model said no', tokens: null })
        expect(done.summary).toMatchObject({ ran: 2, errors: 1, changed: 1 })
    })

    test('Stop ends the check and drops the half-run question', async () => {
        let release: () => void = () => {}
        replayHooks.run = ({ signal }) =>
            new Promise((resolve, reject) => {
                release = () => resolve({ text: 'late' })
                signal.signal.addEventListener('abort', () => reject(new Error('aborted')))
            })
        const started = await startCheck(flow() as any, { questions: ['a', 'b'] }, 'http://x')
        await new Promise((r) => setTimeout(r, 10))
        const stopping = await stopCheck(flow(), started.id)
        expect(stopping.id).toBe(started.id)
        await settle()
        release()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('stopped')
        expect(done.completed).toBe(0)
    })

    test('a draft saved after the check started is flagged', async () => {
        const started = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        await settle()
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: canvas('KIWI'), publishInstantly: false })
        expect((await getCheck(flow(), started.id)).draftChanged).toBe(true)
    })
})

describe('refusals', () => {
    test('bad question lists', async () => {
        for (const questions of [undefined, 'Q', [], [''], [42], ['x'.repeat(2001)], Array.from({ length: 11 }, (_, i) => `q${i}`)]) {
            await expect(startCheck(flow() as any, { questions }, 'http://x')).rejects.toMatchObject({ statusCode: 400 })
        }
        await expect(startCheck(flow() as any, { questions: ['Q'], includeRiskySteps: 'yes' }, 'http://x')).rejects.toMatchObject({
            statusCode: 400
        })
    })

    test('no draft, a legacy multi-agent flow, an agentflow with a form start, or drafts off', async () => {
        await expect(startCheck(flow({ type: 'MULTIAGENT' }) as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 409
        })
        const formStart = flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'formInput') })
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA'), publishInstantly: false })
        await expect(startCheck(formStart as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 409,
            message: 'The check asks questions, so it works on agentflows that start with a chat message.'
        })
        states.clear()
        await expect(startCheck(flow() as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({ statusCode: 409 })
    })

    test('risky steps need includeRiskySteps', async () => {
        states.set('flow-1', {
            chatflowId: 'flow-1',
            draftFlowData: canvas('PAPAYA', [
                { id: 'requestsPost_0', data: { name: 'requestsPost', category: 'Tools', label: 'Post the order' } }
            ]),
            publishInstantly: false
        })
        await expect(startCheck(flow() as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('Post the order')
        })
        const started = await startCheck(flow() as any, { questions: ['Q'], includeRiskySteps: true }, 'http://x')
        expect(started.includeRiskySteps).toBe(true)
        await settle()
    })

    test('one check at a time per flow, and an unknown check id is 404', async () => {
        replayHooks.run = () => new Promise(() => {})
        await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        await expect(startCheck(flow() as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({ statusCode: 409 })
        await expect(getCheck(flow(), 'nope')).rejects.toMatchObject({ statusCode: 404 })
        checks.clear()
    })
})

describe('agentflows', () => {
    const agentflow = (overrides: any = {}) => flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO'), ...overrides })

    beforeEach(() => {
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA'), publishInstantly: false })
    })

    test('an agentflow that starts with a chat message can be checked; the setup has its questions', async () => {
        messages.push({ content: 'When is the rye ready?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null })
        const setup = await getCheckSetup(agentflow())
        expect(setup.unavailable).toBeNull()
        expect(setup.questions.map((q) => q.text)).toEqual(['When is the rye ready?'])
        expect(setup.riskySteps).toEqual([])
    })

    test('replays Live and the draft and compares the answers, writing nothing', async () => {
        const seen: string[] = []
        replayHooks.run = async ({ flow: f, flowData }) => {
            seen.push(f.type as string)
            return { text: wordOf(flowData), metrics: [{ totalTokens: 21 }] }
        }
        const started = await startCheck(agentflow() as any, { questions: ['When is the rye ready?'] }, 'http://x')
        await settle()
        const done = await getCheck(agentflow(), started.id)
        expect(done.status).toBe('done')
        expect(done.cases[0]).toMatchObject({ live: { text: 'MANGO', tokens: 21 }, draft: { text: 'PAPAYA', tokens: 21 }, same: false })
        expect(seen).toEqual(['AGENTFLOW', 'AGENTFLOW'])
        expect(writes.save).not.toHaveBeenCalled()
        expect(writes.insert).not.toHaveBeenCalled()
        expect(writes.update).not.toHaveBeenCalled()
    })

    test('chat-started behavior is unchanged when the flow also has no executions', async () => {
        messages.push({ content: 'When is the rye ready?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null })
        const setup = await getCheckSetup(agentflow())
        expect(setup.replayInputs).toBe(false)
        expect(setup.replaySource).toBeNull()
        expect(setup.questions[0].source).toBeUndefined()
        expect(setup.questions.map((q) => q.text)).toEqual(['When is the rye ready?'])
        const started = await startCheck(agentflow() as any, { questions: ['When is the rye ready?'] }, 'http://x')
        await settle()
        expect((await getCheck(agentflow(), started.id)).cases[0].question).toBe('When is the rye ready?')
    })

    test('agentflow steps that act for real need includeRiskySteps', async () => {
        states.set('flow-1', {
            chatflowId: 'flow-1',
            draftFlowData: agentCanvas('PAPAYA', 'chatInput', [
                { id: 'httpAgentflow_0', data: { name: 'httpAgentflow', category: 'Agent Flows', label: 'Send the order' } }
            ]),
            publishInstantly: false
        })
        expect((await getCheckSetup(agentflow())).riskySteps).toEqual([{ id: 'httpAgentflow_0', label: 'Send the order' }])
        await expect(startCheck(agentflow() as any, { questions: ['Q'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('Send the order')
        })
    })
})

describe('form, webhook and schedule starts', () => {
    const webhookOutput = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
        webhook: { body, headers: { 'x-bakery': '1' }, query: {}, ...extra }
    })
    const execution = (output: unknown, iso: string, id: string) =>
        executions.push({
            id,
            executionData: JSON.stringify([
                { nodeId: 'startAgentflow_0', nodeLabel: 'Start', data: { name: 'startAgentflow', output }, status: 'FINISHED' }
            ]),
            createdDate: new Date(iso),
            updatedDate: new Date(iso)
        })
    const webhookFlow = () => flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'webhookTrigger') })

    beforeEach(() => {
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'webhookTrigger'), publishInstantly: false })
    })

    test('a webhook-started flow replays the newest distinct recorded payloads and writes nothing', async () => {
        execution(webhookOutput({ event: 'bake', loaf: 'rye' }), '2026-10-08T09:00:00Z', 'older')
        // Same payload, keys in another order: one input, and the newer copy is the one kept.
        execution(
            { webhook: { query: {}, headers: { 'x-bakery': '1' }, body: { loaf: 'rye', event: 'bake' } } },
            '2026-10-08T10:00:00Z',
            'same-payload'
        )
        execution(webhookOutput({ event: 'close' }), '2026-10-08T11:00:00Z', 'newer')
        const seen: string[] = []
        replayHooks.run = async ({ flow: f, question }) => {
            seen.push(`${f.type}:${JSON.parse(question).webhook.body.event}`)
            return { text: 'ok', metrics: [{ totalTokens: 8 }] }
        }
        const setup = await getCheckSetup(webhookFlow())
        expect(setup.unavailable).toBeNull()
        expect(setup.replayInputs).toBe(true)
        expect(setup.replaySource).toBe('webhook')
        expect(setup.pastCount).toBe(2)
        expect(setup.questions.map((q) => JSON.parse(q.text).webhook.body.event)).toEqual(['close', 'bake'])
        expect(setup.questions[0]).toMatchObject({ source: 'webhook', date: '2026-10-08T11:00:00.000Z' })
        expect(setup.questions[1]).toMatchObject({ source: 'webhook', date: '2026-10-08T10:00:00.000Z' })
        const started = await startCheck(webhookFlow() as any, { count: 4 }, 'http://x')
        expect(started.cases[0]).toMatchObject({ source: 'webhook', date: '2026-10-08T11:00:00.000Z' })
        expect(started.selection).toMatchObject({ requested: 4, available: 2, used: 2 })
        await settle()
        const done = await getCheck(webhookFlow(), started.id)
        expect(done.status).toBe('done')
        expect(done.cases.map((c) => JSON.parse(c.question).webhook.body.event)).toEqual(['close', 'bake'])
        expect(done.cases[0]).toMatchObject({ live: { text: 'ok' }, draft: { text: 'ok' }, same: true })
        expect(seen.filter((item) => item === 'AGENTFLOW:close')).toHaveLength(2)
        expect(seen.filter((item) => item === 'AGENTFLOW:bake')).toHaveLength(2)
        expect(writes.save).not.toHaveBeenCalled()
        expect(writes.insert).not.toHaveBeenCalled()
        expect(writes.update).not.toHaveBeenCalled()
    })

    test('volatile webhook headers collapse, and the response masks secrets while showing a real difference', async () => {
        const body = { event: 'bake' }
        execution(
            {
                webhook: {
                    body,
                    query: { page: '1' },
                    headers: { 'x-github-event': 'push', date: 'Mon', 'x-request-id': 'req-a', authorization: 'Bearer first-secret' }
                }
            },
            '2026-10-08T09:00:00Z',
            'noisy-old'
        )
        execution(
            {
                webhook: {
                    body,
                    query: { page: '1' },
                    headers: {
                        'x-github-event': 'push',
                        date: 'Tue',
                        'x-request-id': 'req-b',
                        'user-agent': 'Hookshot',
                        authorization: 'Bearer first-secret'
                    }
                }
            },
            '2026-10-08T10:00:00Z',
            'noisy-new'
        )
        execution(
            {
                webhook: {
                    body,
                    query: { page: '2', token: 'query-secret' },
                    headers: { 'x-github-event': 'release', authorization: 'Bearer second-secret' }
                }
            },
            '2026-10-08T11:00:00Z',
            'other-query'
        )
        const setup = await getCheckSetup(webhookFlow())
        expect(setup.pastCount).toBe(2)
        const shown = JSON.stringify(setup.questions)
        for (const secret of ['first-secret', 'second-secret', 'query-secret', 'Hookshot', 'req-a', 'req-b']) {
            expect(shown).not.toContain(secret)
        }
        expect(setup.questions.map((q) => q.preview)).toEqual([
            expect.stringContaining('query {"page":"2","token":"[REDACTED]"}'),
            expect.stringContaining('query {"page":"1"}')
        ])
        expect(setup.questions[0].preview).toContain('authorization: [REDACTED]')
        expect(setup.questions[0].preview).toContain('x-github-event: release')
        const started = await startCheck(webhookFlow() as any, { count: 4 }, 'http://x')
        expect(JSON.stringify(started.cases)).not.toContain('second-secret')
        expect(started.cases[0].preview).toContain('x-github-event: release')
        await settle()
    })

    test('a stored form string from a real run is replayed, including a schedule form', async () => {
        execution({ form: 'loaf: millet' }, '2026-10-08T10:00:00Z', 'form-run')
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'formInput'), publishInstantly: false })
        const formFlow = () => flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'formInput') })
        const setup = await getCheckSetup(formFlow())
        expect(setup.pastCount).toBe(1)
        expect(JSON.parse(setup.questions[0].text)).toEqual({ form: { loaf: 'millet' } })
        const started = await startCheck(formFlow() as any, { count: 4 }, 'http://x')
        expect(started.cases.map((c) => c.question)).toEqual([setup.questions[0].text])
        await settle()

        executions.length = 0
        execution({ form: 'team: bakery' }, '2026-10-08T11:00:00Z', 'schedule-form')
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'scheduleInput'), publishInstantly: false })
        const scheduleFlow = () => flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'scheduleInput') })
        const schedule = await getCheckSetup(scheduleFlow())
        expect(schedule.pastCount).toBe(1)
        expect(JSON.parse(schedule.questions[0].text)).toEqual({ form: { team: 'bakery' } })
    })

    test('rows that share one timestamp are paged without repeats or gaps', async () => {
        const stamp = '2026-10-08T10:00:00Z'
        for (let i = 1; i <= 60; i++) {
            const id = `e-${String(i).padStart(2, '0')}`
            execution(webhookOutput({ event: id }), stamp, id)
        }
        const setup = await getCheckSetup(webhookFlow())
        expect(setup.pastCount).toBe(60)
        expect(setup.pastTruncated).toBe(false)
        const events = setup.questions.map((q) => JSON.parse(q.text).webhook.body.event)
        expect(new Set(events).size).toBe(60)
        expect(events.slice(0, 3)).toEqual(['e-60', 'e-59', 'e-58'])
        expect(events[59]).toBe('e-01')
    })

    test('two calls that differ only by Authorization are one recorded input', async () => {
        const body = { event: 'bake', loaf: 'rye' }
        const stored = (id: string, iso: string) =>
            execution(
                {
                    webhook: {
                        body,
                        query: {},
                        // The webhook route stores Authorization as this placeholder before the execution is saved.
                        headers: { authorization: '[REDACTED]', 'content-type': 'application/json' }
                    }
                },
                iso,
                id
            )
        stored('auth-older', '2026-10-08T09:00:00Z')
        stored('auth-newer', '2026-10-08T10:00:00Z')
        const setup = await getCheckSetup(webhookFlow())
        expect(setup.pastCount).toBe(1)
        expect(setup.questions[0].preview).toBe('{"event":"bake","loaf":"rye"}')
        expect(setup.questions[0].preview).not.toContain('authorization')
        expect(JSON.stringify(setup.questions)).not.toContain('Bearer')
    })

    test('a kept non-sensitive header still splits two deliveries that share a body', async () => {
        const body = { event: 'bake', loaf: 'rye' }
        const stored = (oven: string, iso: string, id: string) =>
            execution(
                {
                    webhook: {
                        body,
                        query: {},
                        headers: { authorization: '[REDACTED]', 'x-bakery': oven }
                    }
                },
                iso,
                id
            )
        stored('oven-a', '2026-10-08T09:00:00Z', 'oven-a')
        stored('oven-b', '2026-10-08T10:00:00Z', 'oven-b')
        const setup = await getCheckSetup(webhookFlow())
        expect(setup.pastCount).toBe(2)
        expect(setup.questions.map((q) => q.preview)).toEqual([
            '{"event":"bake","loaf":"rye"} headers x-bakery: oven-b',
            '{"event":"bake","loaf":"rye"} headers x-bakery: oven-a'
        ])
        expect(JSON.stringify(setup.questions)).not.toContain('Bearer')
    })

    test('questions sent with count are refused for a webhook start', async () => {
        execution(webhookOutput({ event: 'bake' }), '2026-10-08T10:00:00Z', 'one')
        await expect(startCheck(webhookFlow() as any, { count: 4, questions: ['hello'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Questions are not used for a form, webhook or schedule start. Send count on its own.'
        })
    })

    test('no past executions names how to create one, and does not refuse the flow', async () => {
        const starts = [
            ['webhookTrigger', 'webhook', 'No past runs exist yet. Call the webhook once, then check again.'],
            ['formInput', 'form', 'No past runs exist yet. Submit the form once, then check again.'],
            ['scheduleInput', 'schedule', 'No past runs exist yet. Wait for the schedule, or trigger it once, then check again.']
        ] as const
        for (const [start, source, message] of starts) {
            checks.clear()
            states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', start), publishInstantly: false })
            const row = flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', start) })
            const setup = await getCheckSetup(row)
            expect(setup.unavailable).toBeNull()
            expect(setup.replayInputs).toBe(true)
            expect(setup.replaySource).toBe(source)
            expect(setup.questions).toEqual([])
            await expect(startCheck(row as any, { count: 4 }, 'http://x')).rejects.toMatchObject({ statusCode: 400, message })
        }
    })

    test('a risky step on a webhook-started flow is blocked the same way as a chat-started flow', async () => {
        execution(webhookOutput({ event: 'bake' }), '2026-10-08T10:00:00Z', 'one')
        states.set('flow-1', {
            chatflowId: 'flow-1',
            draftFlowData: agentCanvas('PAPAYA', 'webhookTrigger', [
                { id: 'httpAgentflow_0', data: { name: 'httpAgentflow', category: 'Agent Flows', label: 'Send the order' } }
            ]),
            publishInstantly: false
        })
        expect((await getCheckSetup(webhookFlow())).riskySteps).toEqual([{ id: 'httpAgentflow_0', label: 'Send the order' }])
        let ran = false
        replayHooks.run = async () => {
            ran = true
            return { text: 'should-not-run' }
        }
        await expect(startCheck(webhookFlow() as any, { count: 4 }, 'http://x')).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('Send the order')
        })
        expect(ran).toBe(false)
        replayHooks.run = async ({ flowData }) => ({ text: wordOf(flowData), metrics: [JSON.stringify({ totalTokens: 50 })] })
        const started = await startCheck(webhookFlow() as any, { count: 4, includeRiskySteps: true }, 'http://x')
        expect(started.includeRiskySteps).toBe(true)
        await settle()
        expect((await getCheck(webhookFlow(), started.id)).status).toBe('done')
    })
})

describe('a version from Dev as the candidate (Promote)', () => {
    const FROM_DEV = canvas('KIWI')
    const candidate = (overrides: any = {}) => ({ key: 'flow-1:promote', canvas: FROM_DEV, unavailable: null, ...overrides })

    test('replays each question against Live and the version from Dev, in a check of its own beside a draft check', async () => {
        const draftCheck = await startCheck(flow(), { questions: ['code word?'] }, 'http://x')
        await settle()
        const started = await startCheck(flow(), { questions: ['code word?'] }, 'http://x', candidate())
        for (let i = 0; i < 200 && checks.get('flow-1:promote')?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
        const done = await getCheck(flow(), started.id, candidate())
        expect(done.cases[0]).toMatchObject({ live: { text: 'MANGO' }, draft: { text: 'KIWI' }, same: false })
        expect(done.draftChanged).toBe(false)
        // The draft check is still there, under the flow's own key.
        expect((await getCheck(flow(), draftCheck.id)).cases[0].draft?.text).toBe('PAPAYA')
        await expect(getCheck(flow(), draftCheck.id, candidate())).rejects.toMatchObject({ statusCode: 404 })
        expect(writes.save).not.toHaveBeenCalled()
    })

    test('runs with drafts off, and says why it cannot run', async () => {
        draftsOn = false
        expect((await getCheckSetup(flow(), candidate())).unavailable).toBeNull()
        const missing = candidate({ canvas: null, unavailable: { code: 'credentials', message: 'Add the missing credentials first.' } })
        expect((await getCheckSetup(flow(), missing)).unavailable?.code).toBe('credentials')
        await expect(startCheck(flow(), { questions: ['q'] }, 'http://x', missing)).rejects.toMatchObject({ statusCode: 409 })
        expect((await getCheckSetup(flow({ type: 'MULTIAGENT' }), candidate())).unavailable?.code).toBe('type')
        expect((await getCheckSetup(flow({ type: 'MULTIAGENT' }), candidate())).unavailable?.message).toBe(
            'The check works on chatflows and agentflows.'
        )
    })

    test('a webhook-started flow replays executions recorded on this server', async () => {
        const live = agentCanvas('MANGO', 'webhookTrigger')
        const fromDev = agentCanvas('KIWI', 'webhookTrigger')
        executions.push({
            id: 'prod-run',
            executionData: JSON.stringify([
                {
                    nodeId: 'startAgentflow_0',
                    data: {
                        name: 'startAgentflow',
                        output: {
                            webhook: { body: { event: 'bake', loaf: 'rye' }, headers: { authorization: 'Bearer sekret' }, query: {} }
                        }
                    }
                }
            ]),
            createdDate: new Date('2026-10-08T11:00:00Z'),
            updatedDate: new Date('2026-10-08T11:00:00Z')
        })
        const row = flow({ type: 'AGENTFLOW', flowData: live, workspaceId: 'team-a' })
        const incoming = candidate({ canvas: fromDev })
        const wheres: Array<[string, unknown]> = []
        const previous = queryBuilder.andWhere
        queryBuilder.andWhere = (clause: string, params: unknown) => {
            wheres.push([clause, params])
            return queryBuilder
        }
        try {
            const setup = await getCheckSetup(row, incoming)
            expect(wheres).toEqual(
                expect.arrayContaining([
                    ['execution.agentflowId = :agentflowId', { agentflowId: 'flow-1' }],
                    ['execution.workspaceId = :workspaceId', { workspaceId: 'team-a' }]
                ])
            )
            expect(setup.unavailable).toBeNull()
            expect(setup.replayInputs).toBe(true)
            expect(setup.replaySource).toBe('webhook')
            expect(setup.questions).toHaveLength(1)
            expect(setup.questions[0]).toMatchObject({ source: 'webhook', date: '2026-10-08T11:00:00.000Z' })
            expect(setup.questions[0].text).toContain('authorization":"[REDACTED]"')
            expect(JSON.stringify(setup.questions)).not.toContain('sekret')
            const started = await startCheck(row as any, { count: 4 }, 'http://x', incoming)
            expect(started.cases[0]).toMatchObject({ source: 'webhook', date: '2026-10-08T11:00:00.000Z' })
            await settle('flow-1:promote')
            const done = await getCheck(row, started.id, incoming)
            expect(done.status).toBe('done')
            expect(done.cases[0]).toMatchObject({ live: { text: 'MANGO' }, draft: { text: 'KIWI' }, same: false, source: 'webhook' })
        } finally {
            queryBuilder.andWhere = previous
        }
    })

    test('a webhook-started flow with no executions on this server says how to call the webhook', async () => {
        const live = agentCanvas('MANGO', 'webhookTrigger')
        const fromDev = agentCanvas('KIWI', 'webhookTrigger')
        const row = flow({ type: 'AGENTFLOW', flowData: live })
        const incoming = candidate({ canvas: fromDev })
        const setup = await getCheckSetup(row, incoming)
        expect(setup.unavailable).toBeNull()
        expect(setup.replayInputs).toBe(true)
        expect(setup.replaySource).toBe('webhook')
        expect(setup.questions).toEqual([])
        await expect(startCheck(row as any, { count: 4 }, 'http://x', incoming)).rejects.toMatchObject({
            statusCode: 400,
            message: 'No past runs exist yet. Call the webhook once, then check again.'
        })
    })

    test('a chat-started agentflow still replays questions when promoted, and ignores executions', async () => {
        messages.push({ content: 'When is the rye ready?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null, id: 'q1' })
        executions.push({
            id: 'ignored',
            executionData: JSON.stringify([
                { nodeId: 'startAgentflow_0', data: { name: 'startAgentflow', output: { webhook: { body: { event: 'bake' } } } } }
            ]),
            createdDate: new Date('2026-10-08T11:00:00Z'),
            updatedDate: new Date('2026-10-08T11:00:00Z')
        })
        const row = flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'chatInput') })
        const incoming = candidate({ canvas: agentCanvas('KIWI', 'chatInput') })
        const setup = await getCheckSetup(row, incoming)
        expect(setup.replayInputs).toBe(false)
        expect(setup.replaySource).toBeNull()
        expect(setup.questions.map((q) => q.text)).toEqual(['When is the rye ready?'])
        expect(setup.questions[0].source).toBeUndefined()
        expect(JSON.stringify(setup.questions)).not.toContain('bake')
    })
})

const asked = (text: string, iso: string, id: string, fileUploads: string | null = null) =>
    messages.push({ content: text, createdDate: new Date(iso), fileUploads, id })

describe('count', () => {
    test('picks the newest distinct questions, drops repeats, and clamps the count', async () => {
        asked('  Newest ', '2026-10-08T12:00:00Z', '4')
        asked('newest', '2026-10-08T11:00:00Z', '3')
        asked('Middle', '2026-10-08T10:00:00Z', '2')
        asked('Oldest', '2026-10-08T09:00:00Z', '1')
        asked('With a file', '2026-10-08T13:00:00Z', '5', '[{"name":"a.pdf"}]')
        const started = await startCheck(flow() as any, { count: 2 }, 'http://x')
        expect(started.selection).toEqual({ requested: 2, available: 3, used: 2, truncated: false })
        expect(started.cases.map((c) => c.question)).toEqual(['Newest', 'Middle'])
        await settle()
        checks.clear()
        const again = await startCheck(flow() as any, { count: 2 }, 'http://x')
        expect(again.cases.map((c) => c.question)).toEqual(['Newest', 'Middle'])
        await settle()
        checks.clear()
        const wide = await startCheck(flow() as any, { count: 250 }, 'http://x')
        expect(wide.selection).toMatchObject({ requested: 100, available: 3, used: 3 })
        expect(wide.cases.map((c) => c.question)).toEqual(['Newest', 'Middle', 'Oldest'])
        await settle()
        checks.clear()
        const narrow = await startCheck(flow() as any, { count: 0 }, 'http://x')
        expect(narrow.selection).toMatchObject({ requested: 1, used: 1 })
        expect(narrow.cases.map((c) => c.question)).toEqual(['Newest'])
    })

    test('a missing count still uses the question list, capped at 10', async () => {
        await expect(startCheck(flow() as any, { count: 4.5 }, 'http://x')).rejects.toMatchObject({ statusCode: 400 })
        await expect(startCheck(flow() as any, { count: '4' }, 'http://x')).rejects.toMatchObject({ statusCode: 400 })
        await expect(startCheck(flow() as any, { count: 4 }, 'http://x')).rejects.toMatchObject({
            statusCode: 400,
            message: 'No past questions to compare. Add a question to check.'
        })
        await expect(
            startCheck(flow() as any, { questions: Array.from({ length: 11 }, (_, i) => `q${i}`) }, 'http://x')
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    test('extra questions are added after the past ones, and one failure does not stop the rest', async () => {
        asked('From history', '2026-10-08T10:00:00Z', '1')
        replayHooks.run = async ({ question }) => {
            if (question === 'Added') throw new Error('Model said no')
            return { text: 'ok', metrics: [JSON.stringify({ totalTokens: 4 })] }
        }
        const started = await startCheck(flow() as any, { count: 4, questions: ['Added', 'added'] }, 'http://x')
        expect(started.cases.map((c) => c.question)).toEqual(['From history', 'Added'])
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('done')
        expect(done.cases[1].draft).toMatchObject({ error: 'Model said no' })
        expect(done.cases[0].same).toBe(true)
        expect(done.summary.ran).toBe(2)
    })

    test('pages the history until it has enough different questions', async () => {
        for (let i = 0; i < 200; i++) asked('same question', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), `s${i}`)
        asked('the other one', '2026-10-09T00:00:00Z', 'other')
        const setup = await getCheckSetup(flow())
        expect(setup.pastCount).toBe(2)
        expect(setup.pastTruncated).toBe(false)
        expect(setup.questions.map((q) => q.text)).toEqual(['same question', 'the other one'])
    })

    test('says when the scan stopped before the history ended', async () => {
        for (let i = 0; i < 2000; i++) asked('same question', new Date(Date.UTC(2026, 0, 1) + i).toISOString(), `s${i}`)
        const setup = await getCheckSetup(flow())
        expect(setup.pastCount).toBe(1)
        expect(setup.pastTruncated).toBe(true)
    })

    test('runs a few questions at a time, and Stop keeps the ones that finished', async () => {
        process.env.CUTTLELY_CHECK_CONCURRENCY = '2'
        let active = 0
        let maxActive = 0
        const gate: { release: () => void } = { release: () => {} }
        asked('q1', '2026-10-08T12:00:00Z', '4')
        asked('q2', '2026-10-08T11:00:00Z', '3')
        asked('q3', '2026-10-08T10:00:00Z', '2')
        asked('q4', '2026-10-08T09:00:00Z', '1')
        replayHooks.run = ({ question, signal }) => {
            active += 1
            maxActive = Math.max(maxActive, active)
            if (question === 'q1') {
                active -= 1
                return Promise.resolve({ text: 'done', metrics: [JSON.stringify({ totalTokens: 3 })] })
            }
            return new Promise((resolve, reject) => {
                const finish = () => {
                    active -= 1
                    resolve({ text: 'later' })
                }
                gate.release = finish
                signal.signal.addEventListener('abort', () => {
                    active -= 1
                    reject(new Error('aborted'))
                })
            })
        }
        const started = await startCheck(flow() as any, { count: 4 }, 'http://x')
        await new Promise((r) => setTimeout(r, 30))
        expect(maxActive).toBeLessThanOrEqual(2)
        await stopCheck(flow(), started.id)
        await settle()
        gate.release()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('stopped')
        expect(done.cases[0]).toMatchObject({ question: 'q1', live: { text: 'done' }, draft: { text: 'done' } })
        expect(done.completed).toBe(1)
        expect(done.cases.filter((c) => c.question !== 'q1').every((c) => c.live === null && c.draft === null)).toBe(true)
    })
})

const saveEvaluator = (id: string, type: string, config: object, workspaceId = 'team-a', name = id) => {
    evaluatorRows.set(id, {
        id,
        name,
        type,
        config: JSON.stringify(config),
        workspaceId,
        createdDate: new Date('2026-10-01T00:00:00Z'),
        updatedDate: new Date('2026-10-01T00:00:00Z')
    })
}

describe('a dataset and evaluators', () => {
    const modelCanvas = (word: string) =>
        JSON.stringify({
            nodes: [
                {
                    id: 'chatOpenAI_0',
                    data: {
                        name: 'chatOpenAI',
                        category: 'Chat Models',
                        label: word,
                        credential: 'cred-team-a',
                        inputs: { modelName: 'gpt-test' }
                    }
                }
            ],
            edges: []
        })

    beforeEach(() => {
        datasets.set('ds-1', { id: 'ds-1', name: 'Bakery questions', workspaceId: 'team-a' })
        datasetRows.push(
            { id: 'r2', datasetId: 'ds-1', input: 'Second?', output: 'two', sequenceNo: 2 },
            { id: 'r1', datasetId: 'ds-1', input: 'First?', output: 'one', sequenceNo: 1 },
            { id: 'r3', datasetId: 'ds-1', input: 'First?', output: 'one again', sequenceNo: 3 },
            { id: 'r4', datasetId: 'ds-1', input: '   ', output: 'blank', sequenceNo: 0 }
        )
    })

    test('replays dataset rows in sequence order, and keeps the expected answer', async () => {
        const started = await startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x')
        expect(started.selection).toBeNull()
        expect(started.cases.map((c) => [c.question, c.expected])).toEqual([
            ['First?', 'one'],
            ['Second?', 'two'],
            ['First?', 'one again']
        ])
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.cases.map((c) => c.live?.text)).toEqual(['MANGO', 'MANGO', 'MANGO'])
        expect(done.cases[0].live?.scores).toBeUndefined()
        expect(done.summary.scores).toBeUndefined()
        expect(writes.save).not.toHaveBeenCalled()
        expect(writes.insert).not.toHaveBeenCalled()
        expect(writes.update).not.toHaveBeenCalled()
    })

    test('scores text, json, numeric and llm evaluators, and an errored answer is Error', async () => {
        saveEvaluator('text-1', 'text', { operator: 'ContainsAny', value: 'mango' }, 'team-a', 'Mentions mango')
        saveEvaluator('json-1', 'json', { operator: 'IsValidJSON' }, 'team-a', 'Valid JSON')
        saveEvaluator('num-1', 'numeric', { operator: 'greaterThan', measure: 'totalTokens', value: '10' }, 'team-a', 'Enough tokens')
        saveEvaluator('llm-1', 'llm', { prompt: 'Grade {actualOutput} against {expectedOutput}', outputSchema: [] }, 'team-a', 'Graded')
        const graded: any[] = []
        scoreHooks.gradeLlm = async (data, actual) => {
            graded.push({
                workspaceId: data.workspaceId,
                credentialId: data.llmConfig.credentialId,
                question: data.input,
                expected: data.expectedOutput,
                actual: actual[0]
            })
            return [{ pass: String(actual[0]).startsWith('{') }]
        }
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: modelCanvas('PAPAYA'), publishInstantly: false })
        replayHooks.run = async ({ flowData }) => ({
            text: flowData.includes('MANGO') ? 'mango {"ok":true}' : '{"ok":true}',
            metrics: [JSON.stringify({ totalTokens: 50 })]
        })
        const started = await startCheck(
            flow({ flowData: modelCanvas('MANGO') }) as any,
            { datasetId: 'ds-1', evaluatorIds: ['llm-1', 'text-1', 'json-1', 'num-1', 'text-1'] },
            'http://x'
        )
        await settle()
        const done = await getCheck(flow({ flowData: modelCanvas('MANGO') }), started.id)
        const live = done.cases[0].live?.scores || []
        const draft = done.cases[0].draft?.scores || []
        expect(live.map((score) => score.name)).toEqual(['Graded', 'Mentions mango', 'Valid JSON', 'Enough tokens'])
        expect(live.map((score) => score.result)).toEqual(['Fail', 'Pass', 'Fail', 'Pass'])
        expect(draft.map((score) => score.result)).toEqual(['Pass', 'Fail', 'Pass', 'Pass'])
        expect(done.summary.scores?.live).toEqual({ passed: 6, failed: 6, errored: 0, passRate: 50 })
        expect(done.summary.scores?.draft).toEqual({ passed: 9, failed: 3, errored: 0, passRate: 75 })
        expect(graded[0]).toMatchObject({ workspaceId: 'team-a', credentialId: 'cred-team-a', question: 'First?', expected: 'one' })
        expect(writes.save).not.toHaveBeenCalled()

        checks.clear()
        replayHooks.run = async () => {
            throw new Error('Model said no')
        }
        const failed = await startCheck(
            flow({ flowData: modelCanvas('MANGO') }) as any,
            { datasetId: 'ds-1', evaluatorIds: ['text-1'] },
            'http://x'
        )
        await settle()
        const errored = await getCheck(flow({ flowData: modelCanvas('MANGO') }), failed.id)
        expect(errored.cases[0].draft?.error).toBe('Model said no')
        expect(errored.cases[0].draft?.scores).toEqual([{ id: 'text-1', name: 'Mentions mango', result: 'Error' }])
        expect(errored.summary.scores?.draft?.errored).toBe(3)
        expect(errored.summary.scores?.draft?.failed).toBe(0)
    })

    test('a dataset or evaluator from another workspace is 404 and starts nothing', async () => {
        datasets.set('ds-b', { id: 'ds-b', workspaceId: 'team-b' })
        saveEvaluator('ev-b', 'text', { operator: 'ContainsAny', value: 'x' }, 'team-b')
        await expect(startCheck(flow() as any, { datasetId: 'ds-b' }, 'http://x')).rejects.toMatchObject({
            statusCode: 404,
            message: 'Dataset ds-b not found'
        })
        await expect(startCheck(flow() as any, { datasetId: 'missing' }, 'http://x')).rejects.toMatchObject({ statusCode: 404 })
        await expect(startCheck(flow() as any, { questions: ['Hi'], evaluatorIds: ['ev-b'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluator ev-b not found'
        })
        await expect(startCheck(flow() as any, { questions: ['Hi'], evaluatorIds: ['missing'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 404
        })
        expect(checks.size).toBe(0)
        expect(writes.save).not.toHaveBeenCalled()
    })

    test('mixing a dataset with questions or count is 400, and so is a non-chat start', async () => {
        await expect(startCheck(flow() as any, { datasetId: 'ds-1', questions: ['Hi'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 400
        })
        await expect(startCheck(flow() as any, { datasetId: 'ds-1', count: 4 }, 'http://x')).rejects.toMatchObject({ statusCode: 400 })
        datasets.set('empty', { id: 'empty', workspaceId: 'team-a' })
        datasetRows.push({ id: 'long', datasetId: 'empty', input: 'x'.repeat(2001), output: 'no', sequenceNo: 1 })
        await expect(startCheck(flow() as any, { datasetId: 'empty' }, 'http://x')).rejects.toMatchObject({
            statusCode: 400,
            message: 'This dataset has no questions the check can ask.'
        })
        await expect(startCheck(flow() as any, { datasetId: '' }, 'http://x')).rejects.toMatchObject({ statusCode: 400 })
        await expect(startCheck(flow() as any, { questions: ['Hi'], evaluatorIds: 'text-1' }, 'http://x')).rejects.toMatchObject({
            statusCode: 400
        })
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'formInput'), publishInstantly: false })
        await expect(
            startCheck(
                flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'webhookTrigger') }) as any,
                { datasetId: 'ds-1' },
                'http://x'
            )
        ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('webhook') })
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: agentCanvas('PAPAYA', 'scheduleInput'), publishInstantly: false })
        await expect(
            startCheck(
                flow({ type: 'AGENTFLOW', flowData: agentCanvas('MANGO', 'scheduleInput') }) as any,
                { datasetId: 'ds-1' },
                'http://x'
            )
        ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('schedule') })
        expect(checks.size).toBe(0)
    })

    test('an abort during dataset loading leaves no check running', async () => {
        let dropped = false
        datasetHooks.onLoad = () => {
            dropped = true
        }
        await expect(
            startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x', undefined, { closed: () => dropped })
        ).rejects.toMatchObject({
            statusCode: 400,
            message: 'The check was cancelled before it started.'
        })
        expect(checks.get('flow-1')).toBeUndefined()
        datasetHooks.onLoad = null
        const again = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        expect(again.status).toBe('running')
        expect(checks.get('flow-1')?.status).toBe('running')
    })

    test('an aborted dataset load does not stop a check already running on this flow', async () => {
        replayHooks.run = () => new Promise(() => {})
        const dialog = await startCheck(flow() as any, { questions: ['Keep this'] }, 'http://x')
        let dropped = false
        datasetHooks.onLoad = () => {
            dropped = true
        }
        await expect(
            startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x', undefined, { closed: () => dropped })
        ).rejects.toMatchObject({
            statusCode: 400
        })
        expect(checks.get('flow-1')?.id).toBe(dialog.id)
        expect(checks.get('flow-1')?.status).toBe('running')
        expect(checks.get('flow-1')?.stopRequested).toBe(false)
    })

    test('a disconnect after a dataset record is stored stops that record', async () => {
        const started = await startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x', undefined, {
            closed: () => Boolean(checks.get('flow-1'))
        })
        expect(started.status).toBe('stopped')
        expect(checks.get('flow-1')?.status).toBe('stopped')
        const again = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        expect(again.status).toBe('running')
    })

    test('a count request is unchanged: no expected answer and no scores', async () => {
        asked('From history', '2026-10-08T10:00:00Z', '1')
        const started = await startCheck(flow() as any, { count: 4 }, 'http://x')
        expect(started.cases.map((c) => c.question)).toEqual(['From history'])
        expect(started.cases[0].expected).toBeNull()
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.cases[0].live?.scores).toBeUndefined()
        expect(done.summary.scores).toBeUndefined()
        expect(done.summary).toMatchObject({ ran: 1, same: 0, changed: 1 })
    })

    test('a viewer without dataset or evaluator permission sees no row inputs, expected outputs, or evaluator names', async () => {
        saveEvaluator('text-1', 'text', { operator: 'ContainsAny', value: 'mango' }, 'team-a', 'Mentions mango')
        replayHooks.run = async () => ({ text: 'mango', metrics: [JSON.stringify({ totalTokens: 4 })] })
        const started = await startCheck(flow() as any, { datasetId: 'ds-1', evaluatorIds: ['text-1'] }, 'http://x')
        expect(started.cases[0].question).toBe('First?')
        expect(started.cases[0].expected).toBe('one')
        await settle()
        const hidden = { datasets: false, evaluators: false }
        const read = await getCheck(flow(), started.id, undefined, hidden)
        const setup = await getCheckSetup(flow(), undefined, hidden)
        const body = JSON.stringify({ read, check: setup.check })
        expect(body).not.toContain('First?')
        expect(body).not.toContain('Second?')
        expect(body).not.toContain('"one"')
        expect(body).not.toContain('Mentions mango')
        expect(body).not.toContain('text-1')
        expect(read.cases[0].question).toBe('')
        expect(read.cases[0].expected).toBeNull()
        expect(read.cases[0].live?.scores?.[0]).toEqual({ result: 'Pass' })
        expect(setup.check?.cases[0].question).toBe('')
        const shown = { datasets: true, evaluators: true }
        const full = await getCheck(flow(), started.id, undefined, shown)
        const fullSetup = await getCheckSetup(flow(), undefined, shown)
        expect(full.cases.map((item) => [item.question, item.expected])).toEqual([
            ['First?', 'one'],
            ['Second?', 'two'],
            ['First?', 'one again']
        ])
        expect(full.cases[0].live?.scores?.[0]).toEqual({ id: 'text-1', name: 'Mentions mango', result: 'Pass' })
        expect(fullSetup.check?.cases[0].question).toBe('First?')
        expect(fullSetup.check?.cases[0].expected).toBe('one')
    })

    test('a recent question stays visible without dataset permission', async () => {
        const started = await startCheck(flow() as any, { questions: ['What time do you open?'] }, 'http://x')
        await settle()
        const read = await getCheck(flow(), started.id, undefined, { datasets: false, evaluators: false })
        expect(read.cases[0].question).toBe('What time do you open?')
        expect(read.cases[0].expected).toBeNull()
    })
})

describe('a start the client abandons', () => {
    const originalGetMany = queryBuilder.getMany
    const page = () => {
        const start = queryState.skip || 0
        const end = queryState.take == null ? undefined : start + queryState.take
        return messages.slice(start, end)
    }
    afterEach(() => {
        queryBuilder.getMany = originalGetMany
    })

    test('an abort during the question scan leaves no check running', async () => {
        messages.push({ content: 'What time do you open?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null })
        let dropped = false
        queryBuilder.getMany = async () => {
            dropped = true
            return page()
        }
        await expect(startCheck(flow() as any, { count: 4 }, 'http://x', undefined, { closed: () => dropped })).rejects.toMatchObject({
            statusCode: 400
        })
        expect(checks.get('flow-1')).toBeUndefined()
        queryBuilder.getMany = originalGetMany
        const again = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        expect(again.status).toBe('running')
        expect(checks.get('flow-1')?.status).toBe('running')
    })

    test('an aborted start does not stop a check the dialog already started on this flow', async () => {
        replayHooks.run = () => new Promise(() => {})
        const dialog = await startCheck(flow() as any, { questions: ['Keep this'] }, 'http://x')
        messages.push({ content: 'What time do you open?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null })
        let dropped = false
        queryBuilder.getMany = async () => {
            dropped = true
            return page()
        }
        await expect(startCheck(flow() as any, { count: 4 }, 'http://x', undefined, { closed: () => dropped })).rejects.toMatchObject({
            statusCode: 400
        })
        expect(checks.get('flow-1')?.id).toBe(dialog.id)
        expect(checks.get('flow-1')?.status).toBe('running')
        expect(checks.get('flow-1')?.stopRequested).toBe(false)
    })

    test('a disconnect after the record is stored stops that record and leaves another flow running', async () => {
        states.set('flow-2', { chatflowId: 'flow-2', draftFlowData: DRAFT, publishInstantly: false })
        replayHooks.run = () => new Promise(() => {})
        const other = await startCheck(flow({ id: 'flow-2' }) as any, { questions: ['Stay'] }, 'http://x')
        messages.push({ content: 'What time do you open?', createdDate: new Date('2026-10-08T10:00:00Z'), fileUploads: null })
        queryBuilder.getMany = async () => page()
        const started = await startCheck(flow() as any, { count: 4 }, 'http://x', undefined, {
            closed: () => Boolean(checks.get('flow-1'))
        })
        expect(started.id).not.toBe(other.id)
        expect(checks.get('flow-1')?.status).toBe('stopped')
        expect(checks.get('flow-2')?.id).toBe(other.id)
        expect(checks.get('flow-2')?.status).toBe('running')
        expect(checks.get('flow-2')?.stopRequested).toBe(false)
        const again = await startCheck(flow() as any, { questions: ['Q'] }, 'http://x')
        expect(again.status).toBe('running')
    })
})

const gradedCanvas = (word: string) =>
    JSON.stringify({
        nodes: [
            {
                id: 'chatOpenAI_0',
                data: {
                    name: 'chatOpenAI',
                    category: 'Chat Models',
                    label: word,
                    credential: 'cred-team-a',
                    inputs: { modelName: 'gpt-test' }
                }
            }
        ],
        edges: []
    })

describe('grading limits', () => {
    beforeEach(() => {
        saveEvaluator('llm-1', 'llm', { prompt: 'Grade {actualOutput}', outputSchema: [] }, 'team-a', 'Graded')
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: gradedCanvas('PAPAYA'), publishInstantly: false })
    })

    test('a missing prompt, completion, or total token count scores Error, not Fail', async () => {
        saveEvaluator('prompt', 'numeric', { operator: 'lessThan', measure: 'promptTokens', value: '5' }, 'team-a', 'Prompt')
        saveEvaluator('completion', 'numeric', { operator: 'lessThan', measure: 'completionTokens', value: '5' }, 'team-a', 'Completion')
        saveEvaluator('total', 'numeric', { operator: 'lessThan', measure: 'totalTokens', value: '5' }, 'team-a', 'Total')
        saveEvaluator('length', 'numeric', { operator: 'greaterThan', measure: 'responseLength', value: '1' }, 'team-a', 'Length')
        replayHooks.run = async () => ({ text: 'ok', metrics: [JSON.stringify({ totalTokens: 50 })] })
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q'], evaluatorIds: ['prompt', 'completion', 'total', 'length'] },
            'http://x'
        )
        await settle()
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.cases[0].live?.scores?.map((score) => score.result)).toEqual(['Error', 'Error', 'Fail', 'Pass'])
        expect(done.summary.scores?.live).toMatchObject({ failed: 1, errored: 2 })

        checks.clear()
        replayHooks.run = async () => ({ text: 'ok', metrics: [] })
        const missing = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q'], evaluatorIds: ['total'] },
            'http://x'
        )
        await settle()
        const noTotal = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), missing.id)
        expect(noTotal.cases[0].draft?.scores).toEqual([{ id: 'total', name: 'Total', result: 'Error' }])
        expect(noTotal.summary.scores?.draft).toMatchObject({ failed: 0, errored: 1 })
    })

    test('Stop during grading ends the check as stopped', async () => {
        scoreHooks.gradeLlm = () => new Promise(() => undefined)
        replayHooks.run = async () => ({ text: 'ok', metrics: [JSON.stringify({ totalTokens: 4 })] })
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q'], evaluatorIds: ['llm-1'] },
            'http://x'
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
        await stopCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        await settle()
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('stopped')
        const again = await startCheck(flow({ flowData: gradedCanvas('MANGO') }) as any, { questions: ['Next'] }, 'http://x')
        expect(again.status).toBe('running')
    })

    test('a grader that never resolves times out and frees the check', async () => {
        process.env.CUTTLELY_CHECK_MAX_SECONDS = '10'
        scoreHooks.gradeLlm = () => new Promise(() => undefined)
        replayHooks.run = async () => ({ text: 'ok', metrics: [JSON.stringify({ totalTokens: 4 })] })
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q'], evaluatorIds: ['llm-1'] },
            'http://x'
        )
        for (let i = 0; i < 80 && checks.get('flow-1')?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 250))
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('time')
        scoreHooks.gradeLlm = null
        const again = await startCheck(flow({ flowData: gradedCanvas('MANGO') }) as any, { questions: ['Next'] }, 'http://x')
        expect(again.status).toBe('running')
    }, 20000)

    test('grader tokens push the check over the cap before the next question', async () => {
        process.env.CUTTLELY_CHECK_MAX_TOKENS = '1000'
        process.env.CUTTLELY_CHECK_CONCURRENCY = '1'
        const asked: string[] = []
        replayHooks.run = async ({ question }) => {
            asked.push(question)
            return { text: 'ok', metrics: [JSON.stringify({ totalTokens: 600 })] }
        }
        scoreHooks.gradeLlm = async () => ({ grades: [{ pass: true }], tokens: 500 })
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q1', 'Q2'], evaluatorIds: ['llm-1'] },
            'http://x'
        )
        await settle()
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('tokens')
        expect(asked).toEqual(['Q1'])
    })

    test('a grader that reports usage only via estimatedTokenUsage still hits the token cap', async () => {
        process.env.CUTTLELY_CHECK_MAX_TOKENS = '1000'
        process.env.CUTTLELY_CHECK_CONCURRENCY = '1'
        const asked: string[] = []
        replayHooks.run = async ({ question }) => {
            asked.push(question)
            return { text: 'ok', metrics: [JSON.stringify({ totalTokens: 600 })] }
        }
        scoreHooks.gradeLlm = async () => {
            let tokens = 0
            noteGraderTokens({ llmOutput: { estimatedTokenUsage: { totalTokens: 500 } } }, (count) => {
                tokens += count
            })
            return { grades: [{ pass: true }], tokens }
        }
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q1', 'Q2'], evaluatorIds: ['llm-1'] },
            'http://x'
        )
        await settle()
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('tokens')
        expect(asked).toEqual(['Q1'])
    })

    test('a grading model that cannot start leaves the other scores', async () => {
        saveEvaluator('text-1', 'text', { operator: 'ContainsAny', value: 'ok' }, 'team-a', 'Contains ok')
        saveEvaluator('num-1', 'numeric', { operator: 'greaterThan', measure: 'totalTokens', value: '1' }, 'team-a', 'Has tokens')
        scoreHooks.gradeLlm = async () => {
            throw new Error('Error creating LLM')
        }
        replayHooks.run = async () => ({ text: 'ok', metrics: [JSON.stringify({ totalTokens: 20 })] })
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q'], evaluatorIds: ['text-1', 'llm-1', 'num-1'] },
            'http://x'
        )
        await settle()
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(done.cases[0].live?.scores).toEqual([
            { id: 'text-1', name: 'Contains ok', result: 'Pass' },
            { id: 'llm-1', name: 'Graded', result: 'Error', message: 'The grading model could not be started.' },
            { id: 'num-1', name: 'Has tokens', result: 'Pass' }
        ])
        expect(done.cases[0].draft?.scores?.[1].message).toBe('The grading model could not be started.')
        expect(done.status).toBe('done')
    })

    test('a per-grade abort keeps the first evaluator usage and the cap stops the next question', async () => {
        process.env.CUTTLELY_CHECK_MAX_TOKENS = '1000'
        process.env.CUTTLELY_CHECK_CONCURRENCY = '1'
        saveEvaluator('llm-2', 'llm', { prompt: 'Grade {actualOutput}', outputSchema: [] }, 'team-a', 'Second')
        const asked: string[] = []
        const startedEvaluators: string[] = []
        replayHooks.run = async ({ question }) => {
            asked.push(question)
            return { text: 'ok', metrics: [JSON.stringify({ totalTokens: 600 })] }
        }
        scoreHooks.gradeLlm = async (_data, _actual, _errors, map, run) => {
            for (const item of map) {
                if (run.signal.aborted) break
                startedEvaluators.push(item.evaluatorId)
                if (startedEvaluators.length === 1) {
                    run.addTokens?.(500)
                    continue
                }
                await new Promise((_resolve, reject) => {
                    if (run.signal.aborted) {
                        reject(new Error('aborted'))
                        return
                    }
                    run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                })
            }
            return { grades: [], tokens: null }
        }
        const started = await startCheck(
            flow({ flowData: gradedCanvas('MANGO') }) as any,
            { questions: ['Q1', 'Q2'], evaluatorIds: ['llm-1', 'llm-2'] },
            'http://x'
        )
        for (let i = 0; i < 80 && checks.get('flow-1')?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 1000))
        const done = await getCheck(flow({ flowData: gradedCanvas('MANGO') }), started.id)
        expect(startedEvaluators).toEqual(['llm-1', 'llm-2'])
        expect(done.status).toBe('stopped')
        expect(done.stopReason).toBe('tokens')
        expect(asked).toEqual(['Q1'])
    }, 90000)
})
