// The publish check on a harness: questions from run history, both rosters, no writes, risky tools, dataset seam.
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
    }
}
const writes = { save: jest.fn(), insert: jest.fn(), update: jest.fn() }
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: () => ({ createQueryBuilder: () => queryBuilder, ...writes }) }
    })
}))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/identity', () => ({ Workspace: class Workspace {}, Organization: class Organization {} }))
jest.mock('@cuttlely/components', () => ({ EvaluationRunner: { metrics: new Map() } }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), debug: jest.fn() } }))

import { checks, getCheck, getCheckSetup, replayHooks, startCheck, stopCheck } from './index'
import { harnessCheckHooks, harnessReplayHooks, questionSources } from './harness'

const canvas = (word: string, extra: any[] = []) =>
    JSON.stringify({
        nodes: [
            { id: 'chief', data: { name: 'harnessChief', category: 'Harness', label: 'Harness Prime', inputs: { instructions: word } } },
            {
                id: 'clerk',
                data: {
                    name: 'harnessSpecialist',
                    category: 'Harness',
                    label: 'Clerk',
                    inputs: { specialistName: 'clerk', instructions: word }
                }
            },
            ...extra
        ],
        edges: []
    })

const LIVE = canvas('MANGO')
const DRAFT = canvas('PAPAYA')
const runs: Array<{ inputPreview: string; startedAt: string }> = []

const flow = (overrides: any = {}) => ({
    id: 'flow-1',
    name: 'bakery-team',
    type: 'HARNESS',
    flowData: LIVE,
    workspaceId: 'team-a',
    ...overrides
})

async function settle(id = 'flow-1') {
    for (let i = 0; i < 200 && checks.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(() => {
    checks.clear()
    states.clear()
    messages.length = 0
    runs.length = 0
    queryState.take = undefined
    queryState.skip = 0
    draftsOn = true
    states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: DRAFT, publishInstantly: false })
    harnessCheckHooks.listRuns = (name) => (name === 'bakery-team' ? runs : [])
    harnessReplayHooks.run = null
    questionSources.dataset = null
    replayHooks.run = async ({ flowData }) => {
        const word = JSON.parse(flowData).nodes[0].data.inputs.instructions
        return { text: word, metrics: [{ totalTokens: 8 }] }
    }
    jest.clearAllMocks()
})

afterEach(() => {
    harnessCheckHooks.listRuns = null
    harnessReplayHooks.run = null
    questionSources.dataset = null
    replayHooks.run = null
    delete process.env.CUTTLELY_CHECK_CONCURRENCY
})

describe('harness publish check', () => {
    test('offers the newest distinct run previews, then starter questions', async () => {
        runs.push(
            { inputPreview: 'What time do you open?', startedAt: '2026-10-08T10:00:00.000Z' },
            { inputPreview: 'what time do you open?', startedAt: '2026-10-08T09:00:00.000Z' },
            { inputPreview: 'Do you have rye?', startedAt: '2026-10-08T08:00:00.000Z' }
        )
        const setup = await getCheckSetup(
            flow({
                chatbotConfig: JSON.stringify({
                    starterPrompts: { a: { prompt: 'What time do you open?' }, b: { prompt: 'Any rye left?' } }
                })
            })
        )
        expect(setup.unavailable).toBeNull()
        expect(setup.replayInputs).toBe(false)
        expect(setup.questions).toEqual([
            { text: 'What time do you open?', date: '2026-10-08T10:00:00.000Z' },
            { text: 'Do you have rye?', date: '2026-10-08T08:00:00.000Z' },
            { text: 'Any rye left?', date: '', starter: true }
        ])
        expect(setup.pastCount).toBe(2)
    })

    test('replays each question on the Live canvas and the draft canvas and writes nothing', async () => {
        const seen: string[] = []
        replayHooks.run = async ({ flowData, question }) => {
            seen.push(`${question}:${JSON.parse(flowData).nodes[0].data.inputs.instructions}`)
            return { text: JSON.parse(flowData).nodes[0].data.inputs.instructions, metrics: [{ totalTokens: 11 }] }
        }
        const started = await startCheck(flow() as any, { questions: ['Do you have rye?'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.status).toBe('done')
        expect(done.cases[0]).toMatchObject({
            question: 'Do you have rye?',
            live: { text: 'MANGO', tokens: 11, error: null },
            draft: { text: 'PAPAYA', tokens: 11, error: null },
            same: false
        })
        expect(seen).toEqual(['Do you have rye?:MANGO', 'Do you have rye?:PAPAYA'])
        expect(writes.save).not.toHaveBeenCalled()
        expect(writes.insert).not.toHaveBeenCalled()
        expect(writes.update).not.toHaveBeenCalled()
    })

    test('sums route, specialist and handoff tokens from the run report', async () => {
        replayHooks.run = null
        harnessReplayHooks.run = async ({ flowData }) => ({
            text: JSON.parse(flowData).nodes[0].data.inputs.instructions,
            report: { tokens: { prompt: 10, completion: 4, cached: 3 } }
        })
        const started = await startCheck(flow() as any, { questions: ['Do you have rye?'] }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.cases[0].live?.tokens).toBe(14)
        expect(done.cases[0].draft?.tokens).toBe(14)
        expect(done.summary.liveTokens).toBe(14)
        expect(done.summary.draftTokens).toBe(14)
    })

    test('a shell specialist needs confirmation, and Stop aborts the replay', async () => {
        const shell = {
            id: 'clerk',
            data: {
                name: 'harnessSpecialist',
                category: 'Harness',
                label: 'Clerk',
                inputs: { specialistName: 'clerk', enableShell: true }
            }
        }
        states.set('flow-1', { chatflowId: 'flow-1', draftFlowData: canvas('PAPAYA', [shell]), publishInstantly: false })
        const risky = flow({ flowData: canvas('MANGO', [shell]) })
        const setup = await getCheckSetup(risky)
        expect(setup.riskySteps).toEqual([{ id: 'clerk', label: 'clerk (Shell)' }])
        await expect(startCheck(risky as any, { questions: ['Run it'] }, 'http://x')).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('clerk (Shell)')
        })
        let aborted = false
        replayHooks.run = ({ signal }) =>
            new Promise((_, reject) => {
                signal.signal.addEventListener('abort', () => {
                    aborted = true
                    reject(new Error('aborted'))
                })
            })
        const started = await startCheck(risky as any, { questions: ['Run it'], includeRiskySteps: true }, 'http://x')
        await new Promise((r) => setTimeout(r, 30))
        await stopCheck(risky, started.id)
        await settle()
        expect(aborted).toBe(true)
        const done = await getCheck(risky, started.id)
        expect(done.status).toBe('stopped')
        expect(done.cases[0].live).toBeNull()
        expect(done.cases[0].draft).toBeNull()
    })

    test('dataset rows replay on both rosters when a loader is plugged in, and are refused until then', async () => {
        runs.push({ inputPreview: 'From a real run', startedAt: '2026-10-08T10:00:00.000Z' })
        await expect(startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x')).rejects.toMatchObject({
            statusCode: 400,
            message: 'A dataset check is not available on this server yet.'
        })
        process.env.CUTTLELY_CHECK_CONCURRENCY = '1'
        questionSources.dataset = async () => [{ text: 'Second?' }, { text: 'First?' }, { text: '   ' }]
        const seen: string[] = []
        replayHooks.run = async ({ flowData, question }) => {
            seen.push(`${question}:${JSON.parse(flowData).nodes[0].data.inputs.instructions}`)
            return { text: question, metrics: [{ totalTokens: 2 }] }
        }
        const started = await startCheck(flow() as any, { datasetId: 'ds-1' }, 'http://x')
        await settle()
        const done = await getCheck(flow(), started.id)
        expect(done.selection).toBeNull()
        expect(done.cases.map((item) => item.question)).toEqual(['Second?', 'First?'])
        expect(seen).toEqual(['Second?:MANGO', 'Second?:PAPAYA', 'First?:MANGO', 'First?:PAPAYA'])
        expect(seen.join(' ')).not.toContain('From a real run')
    })

    test('a chatflow check still reads chat messages and ignores a dataset id', async () => {
        messages.push({ content: 'From chat', createdDate: new Date('2026-10-08T10:00:00.000Z'), fileUploads: null })
        runs.push({ inputPreview: 'From a run', startedAt: '2026-10-08T10:00:00.000Z' })
        const chatNode = (label: string) =>
            JSON.stringify({ nodes: [{ id: 'n', data: { name: 'chatOpenAI', category: 'Chat Models', label } }], edges: [] })
        const chat = flow({ type: 'CHATFLOW', flowData: chatNode('MANGO') })
        states.set('flow-1', {
            chatflowId: 'flow-1',
            draftFlowData: chatNode('PAPAYA'),
            publishInstantly: false
        })
        replayHooks.run = async ({ flowData }) => ({ text: JSON.parse(flowData).nodes[0].data.label, metrics: [{ totalTokens: 1 }] })
        const setup = await getCheckSetup(chat)
        expect(setup.questions.map((q) => q.text)).toEqual(['From chat'])
        const started = await startCheck(chat as any, { questions: ['From chat'], datasetId: 'ds-1' }, 'http://x')
        await settle()
        const done = await getCheck(chat, started.id)
        expect(done.cases[0].question).toBe('From chat')
        expect(done.status).toBe('done')
    })
})
