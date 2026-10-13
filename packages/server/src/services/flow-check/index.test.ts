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
const queryState = { take: undefined as number | undefined, skip: 0 }
const queryBuilder: any = {
    select: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
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

import { checks, getCheck, getCheckSetup, replayHooks, startCheck, stopCheck } from './index'
import { scoreHooks } from './score'

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
    queryState.take = undefined
    queryState.skip = 0
    draftsOn = true
    delete process.env.CUTTLELY_CHECK_MAX_TOKENS
    delete process.env.CUTTLELY_CHECK_MAX_SECONDS
    delete process.env.CUTTLELY_CHECK_CONCURRENCY
    states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: DRAFT, publishInstantly: false })
    replayHooks.run = async ({ flowData }) => ({ text: wordOf(flowData), metrics: [JSON.stringify({ totalTokens: 50 })] })
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
        expect(done.draftChanged).toBe(false)
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
