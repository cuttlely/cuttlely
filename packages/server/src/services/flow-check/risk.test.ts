// Which chatflow and agentflow steps make the publish check stop and ask before replaying.
import { isRiskyNode, riskySteps } from './risk'

const canvas = (...nodes: Array<[string, string, string?]>) =>
    JSON.stringify({
        nodes: nodes.map(([name, category, label], i) => ({
            id: `${name}_${i}`,
            data: { id: `${name}_${i}`, name, category, label: label || name }
        })),
        edges: []
    })

describe('risky steps', () => {
    test('a model, a prompt, a chain and chat memory are safe', () => {
        const flow = canvas(
            ['chatOpenAI', 'Chat Models'],
            ['bufferMemory', 'Memory'],
            ['conversationChain', 'Chains'],
            ['promptTemplate', 'Prompts']
        )
        expect(riskySteps([flow])).toEqual([])
    })

    test('retrieval and read-only tools are safe', () => {
        for (const [name, category] of [
            ['pinecone', 'Vector Stores'],
            ['retrieverTool', 'Tools'],
            ['calculator', 'Tools'],
            ['requestsGet', 'Tools'],
            ['conversationalRetrievalQAChain', 'Chains'],
            ['stickyNote', 'Utilities']
        ]) {
            expect(isRiskyNode(name, category)).toBe(false)
        }
    })

    test('steps that send, write, post, keep outside state or run custom code are risky', () => {
        for (const [name, category] of [
            ['requestsPost', 'Tools'],
            ['customTool', 'Tools'],
            ['ChatflowTool', 'Tools'],
            ['slackMCP', 'Tools (MCP)'],
            ['RedisBackedChatMemory', 'Memory'],
            ['redisCache', 'Cache'],
            ['inMemoryCache', 'Cache'],
            ['postApiChain', 'Chains'],
            ['sqlDatabaseChain', 'Chains'],
            ['openAIAssistant', 'Agents'],
            ['customFunction', 'Utilities'],
            ['harness', 'Harness'],
            ['vectaraUpload', 'Vector Stores'],
            ['somethingNew', 'A Category Nobody Knows'],
            ['', 'Chat Models']
        ]) {
            expect(isRiskyNode(name, category)).toBe(true)
        }
    })

    test('lists each risky step once across Live and the draft, by label', () => {
        const live = canvas(['chatOpenAI', 'Chat Models'], ['requestsPost', 'Tools', 'Post the order'])
        const draft = canvas(['chatOpenAI', 'Chat Models'], ['requestsPost', 'Tools', 'Post the order'], ['customTool', 'Tools', 'Refund'])
        expect(riskySteps([live, draft])).toEqual([
            { id: 'requestsPost_1', label: 'Post the order' },
            { id: 'customTool_2', label: 'Refund' }
        ])
    })

    test('post-processing code in the flow settings counts, and a broken canvas has no steps', () => {
        expect(riskySteps(['not json'], JSON.stringify({ postProcessing: { enabled: true } }))).toEqual([
            { id: 'postProcessing', label: 'Post-processing code' }
        ])
        expect(riskySteps([canvas()], JSON.stringify({ postProcessing: { enabled: false } }))).toEqual([])
    })
})

describe('risky agentflow steps', () => {
    const A = 'Agent Flows'

    test('model, agent, condition, retriever, reply, loop and iteration steps are safe', () => {
        for (const name of [
            'startAgentflow',
            'llmAgentflow',
            'agentAgentflow',
            'conditionAgentflow',
            'conditionAgentAgentflow',
            'retrieverAgentflow',
            'directReplyAgentflow',
            'loopAgentflow',
            'iterationAgentflow',
            'stickyNoteAgentflow'
        ]) {
            expect(isRiskyNode(name, A)).toBe(false)
        }
    })

    test('custom code, HTTP requests, running another flow, waiting for a person and unknown steps are risky', () => {
        for (const name of [
            'customFunctionAgentflow',
            'httpAgentflow',
            'executeFlowAgentflow',
            'humanInputAgentflow',
            'brandNewAgentflow'
        ]) {
            expect(isRiskyNode(name, A)).toBe(true)
        }
    })

    test('a Tool step is risky unless its tool only looks things up or computes', () => {
        expect(isRiskyNode('toolAgentflow', A, { toolAgentflowSelectedTool: 'calculator' })).toBe(false)
        expect(isRiskyNode('toolAgentflow', A, { toolAgentflowSelectedTool: 'requestsPost' })).toBe(true)
        expect(isRiskyNode('toolAgentflow', A, {})).toBe(true)
    })

    test('a Tool step is judged by the tool it runs: the older selectedTool field comes first, as in the step', () => {
        expect(isRiskyNode('toolAgentflow', A, { selectedTool: 'requestsPost', toolAgentflowSelectedTool: 'calculator' })).toBe(true)
        expect(isRiskyNode('toolAgentflow', A, { selectedTool: 'calculator', toolAgentflowSelectedTool: 'requestsPost' })).toBe(false)
    })

    test('an Agent tool list saved as JSON text is read, and an unreadable one counts as risky', () => {
        expect(isRiskyNode('agentAgentflow', A, { agentTools: JSON.stringify([{ agentSelectedTool: 'calculator' }]) })).toBe(false)
        expect(isRiskyNode('agentAgentflow', A, { agentTools: JSON.stringify([{ agentSelectedTool: 'gmail' }]) })).toBe(true)
        expect(isRiskyNode('agentAgentflow', A, { agentTools: 'not json' })).toBe(true)
        expect(isRiskyNode('agentAgentflow', A, { agentTools: { agentSelectedTool: 'calculator' } })).toBe(true)
        expect(isRiskyNode('agentAgentflow', A, { agentTools: '' })).toBe(false)
    })

    test('an Agent is risky when one of its tools acts for real or waits for a person to approve it', () => {
        const tools = (...list: any[]) => ({ agentTools: list })
        expect(isRiskyNode('agentAgentflow', A, tools({ agentSelectedTool: 'calculator' }, { agentSelectedTool: 'retrieverTool' }))).toBe(
            false
        )
        expect(isRiskyNode('agentAgentflow', A, tools({ agentSelectedTool: 'calculator' }, { agentSelectedTool: 'gmail' }))).toBe(true)
        expect(
            isRiskyNode('agentAgentflow', A, tools({ agentSelectedTool: 'calculator', agentSelectedToolRequiresHumanInput: true }))
        ).toBe(true)
    })

    test('riskySteps reads the step inputs', () => {
        const flow = JSON.stringify({
            nodes: [
                {
                    id: 'agentAgentflow_0',
                    data: {
                        name: 'agentAgentflow',
                        category: A,
                        label: 'Order helper',
                        inputs: { agentTools: [{ agentSelectedTool: 'customTool' }] }
                    }
                },
                { id: 'llmAgentflow_0', data: { name: 'llmAgentflow', category: A, label: 'Writer' } }
            ],
            edges: []
        })
        expect(riskySteps([flow])).toEqual([{ id: 'agentAgentflow_0', label: 'Order helper' }])
    })
})
