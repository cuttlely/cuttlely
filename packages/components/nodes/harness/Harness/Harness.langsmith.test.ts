import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'

const mockAdditionalCallbacks = jest.fn()
const mockAssertWorkspace = jest.fn()
const mockRun = jest.fn()
const mockDirectRun = jest.fn()
const mockStore = jest.fn()

jest.mock('../../../src/handler', () => ({ additionalCallbacks: (...args: unknown[]) => mockAdditionalCallbacks(...args) }))
jest.mock('../engine', () => ({
    loadHarnessEngine: async () => ({
        assertHarnessWorkspace: (...args: unknown[]) => mockAssertWorkspace(...args),
        runQueuedHarness: (...args: unknown[]) => mockRun(...args),
        runHarness: (...args: unknown[]) => mockDirectRun(...args)
    })
}))
jest.mock('../../../src/storageUtils', () => ({
    addSingleFileToStorage: (...args: unknown[]) => mockStore(...args),
    getFileFromStorage: jest.fn()
}))

const { nodeClass: HarnessNode } = require('./Harness')
const nodeData = { id: 'harness_0', inputs: { harnessName: 'bakery' } }
const options = {
    chatId: 'fixture-chat',
    chatflowid: 'fixture-flow',
    workspaceId: 'fixture-workspace',
    analytic: JSON.stringify({ langSmith: { status: true, credentialId: 'fixture-credential', projectName: 'fixture-project' } })
}

function tracerFor(projectName = 'fixture-project') {
    const client = { createRun: jest.fn(async () => undefined), updateRun: jest.fn(async () => undefined) }
    const tracer = new LangChainTracer({ projectName, client: client as never })
    tracer.awaitHandlers = true
    return { tracer, client }
}

async function modelReply(args: any) {
    if (args.callbacks) {
        const [model] = await args.callbacks.handleLLMStart({ lc: 1, type: 'not_implemented', id: ['fixture', 'Model'] }, [args.input])
        await model.handleLLMEnd({ generations: [[{ text: 'fresh answer' }]], llmOutput: {} })
    }
    return { text: 'fresh answer', harness: 'bakery' }
}

describe('standalone Harness LangSmith tracing', () => {
    const originalQueue = process.env.CUTTLELY_HARNESS_QUEUE

    beforeEach(() => {
        jest.clearAllMocks()
        mockAssertWorkspace.mockReset()
        mockAdditionalCallbacks.mockReset().mockResolvedValue([])
        mockRun.mockReset().mockImplementation(modelReply)
        mockDirectRun.mockReset().mockImplementation(modelReply)
        mockStore.mockReset().mockResolvedValue({ path: 'FILE-STORAGE::fixture.png' })
        delete process.env.CUTTLELY_HARNESS_QUEUE
    })

    afterAll(() => {
        if (originalQueue === undefined) delete process.env.CUTTLELY_HARNESS_QUEUE
        else process.env.CUTTLELY_HARNESS_QUEUE = originalQueue
    })

    it.each(['queued', 'direct'])('exports a parent and child model run using the %s engine path', async (mode) => {
        if (mode === 'direct') process.env.CUTTLELY_HARNESS_QUEUE = 'off'
        const { tracer, client } = tracerFor()
        const counter = { name: 'token_counter', handleLLMEnd: jest.fn() }
        mockAdditionalCallbacks.mockResolvedValue([tracer, counter])

        const result = await new HarnessNode().run(nodeData, 'What is fresh?', { ...options, tokenUsageCallback: counter })

        expect(result.text).toBe('fresh answer')
        expect(mockAdditionalCallbacks).toHaveBeenCalledWith(nodeData, expect.objectContaining(options), ['langSmith'])
        const started = client.createRun.mock.calls.map((call: any[]) => call[0])
        const root = started.find((run: any) => run.run_type === 'chain')
        const child = started.find((run: any) => run.run_type === 'llm')
        expect(root).toEqual(expect.objectContaining({ inputs: { input: 'What is fresh?' }, session_name: 'fixture-project' }))
        expect(child).toEqual(expect.objectContaining({ parent_run_id: root.id, trace_id: root.trace_id }))
        expect(client.updateRun).toHaveBeenCalledWith(root.id, expect.objectContaining({ outputs: { output: 'fresh answer' } }))
        expect(counter.handleLLMEnd).not.toHaveBeenCalled()
        const engine = mode === 'queued' ? mockRun : mockDirectRun
        expect(engine.mock.calls[0][0].callbacks.handlers).toEqual([tracer])
    })

    it.each(['wrong_workspace', 'key_not_allowed'])('exports nothing before a %s refusal', async (code) => {
        mockAssertWorkspace.mockImplementation(() => {
            throw Object.assign(new Error('Not authorized'), { code })
        })
        await expect(new HarnessNode().run(nodeData, 'private question', options)).rejects.toMatchObject({ code })
        expect(mockAdditionalCallbacks).not.toHaveBeenCalled()
        expect(mockRun).not.toHaveBeenCalled()
    })

    it.each(['replay', 'cuttlelyReplay'])('does not construct tracing providers for %s', async (flag) => {
        await new HarnessNode().run(nodeData, 'What is fresh?', { ...options, [flag]: true })
        expect(mockAdditionalCallbacks).not.toHaveBeenCalled()
        expect(mockRun.mock.calls[0][0].callbacks).toBeUndefined()
    })

    it('runs normally when tracing is off or the configured credential produced no tracer', async () => {
        const result = await new HarnessNode().run(nodeData, 'What is fresh?', options)
        expect(result.text).toBe('fresh answer')
        expect(mockRun.mock.calls[0][0].callbacks).toBeUndefined()
    })

    it('leaves agentflow and Harness-as-tool parent tracing to their callers', async () => {
        await new HarnessNode().run(nodeData, 'What is fresh?', { ...options, agentflowRuntime: { state: {} } })
        const tool = await new HarnessNode().init(nodeData, 'What is fresh?', options)
        await tool.func('What is fresh?')
        expect(mockAdditionalCallbacks).not.toHaveBeenCalled()
    })

    it('records delivery failure as a failed parent rather than a successful answer', async () => {
        const { tracer, client } = tracerFor()
        mockAdditionalCallbacks.mockResolvedValue([tracer])
        mockRun.mockResolvedValue({
            text: 'verified answer',
            trustedOutput: true,
            artifacts: [{ type: 'png', base64: 'aW1hZ2U=', name: 'fixture.png' }]
        })
        mockStore.mockRejectedValue(new Error('Fixture storage failed'))
        await expect(new HarnessNode().run(nodeData, 'Make an image', options)).rejects.toThrow()
        const root = (client.createRun.mock.calls as any[][]).find((call) => call[0].run_type === 'chain')?.[0]
        expect(client.updateRun).toHaveBeenCalledWith(root.id, expect.objectContaining({ error: expect.any(String) }))
        expect(client.updateRun).not.toHaveBeenCalledWith(root.id, expect.objectContaining({ outputs: { output: 'verified answer' } }))
    })

    it('preserves the answer when tracing setup or final upload fails', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        try {
            mockAdditionalCallbacks.mockRejectedValueOnce(new Error('Fixture tracing unavailable'))
            expect((await new HarnessNode().run(nodeData, 'Question A', options)).text).toBe('fresh answer')
            const { tracer, client } = tracerFor()
            tracer.raiseError = true
            client.updateRun.mockRejectedValue(new Error('Fixture upload failed') as never)
            mockAdditionalCallbacks.mockResolvedValue([tracer])
            expect((await new HarnessNode().run(nodeData, 'Question B', options)).text).toBe('fresh answer')
        } finally {
            warn.mockRestore()
            error.mockRestore()
        }
    })

    it.each(['aborted', 'model_failed'])('closes the parent trace on %s without changing the execution error', async (code) => {
        const { tracer, client } = tracerFor()
        mockAdditionalCallbacks.mockResolvedValue([tracer])
        mockRun.mockRejectedValue(Object.assign(new Error('Fixture run failed'), { code }))
        await expect(new HarnessNode().run(nodeData, 'What is fresh?', options)).rejects.toMatchObject({ code })
        const root = (client.createRun.mock.calls as any[][]).find((call) => call[0].run_type === 'chain')?.[0]
        expect(root).toBeDefined()
        expect(client.updateRun).toHaveBeenCalledWith(
            root.id,
            expect.objectContaining({ error: expect.stringContaining('Fixture run failed') })
        )
    })

    it('keeps concurrent chats in their own project and parent trace', async () => {
        const a = tracerFor('project-a')
        const b = tracerFor('project-b')
        mockAdditionalCallbacks.mockResolvedValueOnce([a.tracer]).mockResolvedValueOnce([b.tracer])
        await Promise.all([
            new HarnessNode().run(nodeData, 'Question A', { ...options, chatId: 'chat-a' }),
            new HarnessNode().run(nodeData, 'Question B', { ...options, chatId: 'chat-b' })
        ])
        for (const [target, question, project] of [
            [a, 'Question A', 'project-a'],
            [b, 'Question B', 'project-b']
        ] as const) {
            const runs = target.client.createRun.mock.calls.map((call: any[]) => call[0])
            const root = runs.find((run: any) => run.run_type === 'chain')
            expect(root).toEqual(expect.objectContaining({ inputs: { input: question }, session_name: project }))
            expect(runs.find((run: any) => run.run_type === 'llm')?.parent_run_id).toBe(root.id)
        }
    })
})
