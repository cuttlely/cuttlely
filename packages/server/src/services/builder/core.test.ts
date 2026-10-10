jest.mock('flowise-components', () => ({
    initAgentflowNode: (d: any, id: string) => jest.requireActual('./testParts').fakeInitNode(d, id)
}))

import { ChatMessage, runBuilder, systemPrompt } from './core'
import { RecipeContext } from './recipe'
import { workflowRecipe } from './recipes/workflow'
import { partsFromSamples } from './testParts'

const ctx: RecipeContext = {
    componentNodes: partsFromSamples(),
    chatModel: { name: 'chatOpenAI', credential: 'cred-1', inputs: { modelName: 'gpt-4.1-mini', FLOWISE_CREDENTIAL_ID: 'cred-1' } },
    credentials: [{ id: 'cred-1', name: 'OpenAI demo', credentialName: 'openAIApi' }],
    credentialLabels: { serpApi: 'Serp API' }
}

const questions = ['What is new in AI this week?', 'Summarize the news on solar power.', 'Find three facts about whales.']
const good = {
    title: 'Researcher',
    nodes: [
        { id: 'start', name: 'startAgentflow' },
        { id: 'agent', name: 'agentAgentflow', label: 'Researcher', instructions: 'Search and answer briefly.', tools: ['serpAPI'] }
    ],
    edges: [{ from: 'start', to: 'agent' }],
    starterQuestions: questions
}
const bad = { ...good, nodes: [...good.nodes, { id: 'x', name: 'notAPart' }] }

const fakeAsk = (replies: string[]) => {
    const seen: ChatMessage[][] = []
    const ask = async (messages: ChatMessage[]) => {
        seen.push(messages.map((m) => ({ ...m })))
        return replies[seen.length - 1] ?? ''
    }
    return { ask, seen }
}

describe('runBuilder', () => {
    it('builds a checked workflow on the first try and lists the missing credential by name', async () => {
        const { ask, seen } = fakeAsk([`Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``])
        const result = await runBuilder(workflowRecipe, 'Research the news with web search', ctx, ask)
        expect(seen).toHaveLength(1)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.repaired).toBe(false)
        expect(result.starterQuestions).toEqual(questions)
        expect(result.nodes.map((n) => n.id)).toEqual(['startAgentflow_0', 'agentAgentflow_0'])
        expect(result.missingCredentials).toEqual([{ part: 'Researcher: Serp API', credential: 'Serp API' }])
        const agent = result.nodes[1].data.inputs
        expect(agent.agentModel).toBe('chatOpenAI')
        expect(agent.agentModelConfig).toMatchObject({
            modelName: 'gpt-4.1-mini',
            FLOWISE_CREDENTIAL_ID: 'cred-1',
            agentModel: 'chatOpenAI'
        })
        expect(agent.agentMessages).toEqual([{ role: 'system', content: 'Search and answer briefly.' }])
        expect(result.edges[0]).toMatchObject({ source: 'startAgentflow_0', target: 'agentAgentflow_0', targetHandle: 'agentAgentflow_0' })
    })

    it('repairs once with the check in plain words', async () => {
        const { ask, seen } = fakeAsk([JSON.stringify(bad), JSON.stringify(good)])
        const result = await runBuilder(workflowRecipe, 'Research the news', ctx, ask)
        expect(result).toMatchObject({ ok: true, repaired: true })
        expect(seen).toHaveLength(2)
        const repair = seen[1][seen[1].length - 1].content
        expect(repair).toContain('"notAPart" (part "x") is not a part this canvas can use.')
        expect(seen[1][2]).toEqual({ role: 'assistant', content: JSON.stringify(bad) })
    })

    it('returns the problems and builds nothing when the repair also fails', async () => {
        const { ask, seen } = fakeAsk([JSON.stringify(bad), 'I cannot do that'])
        const result = await runBuilder(workflowRecipe, 'Research the news', ctx, ask)
        expect(seen).toHaveLength(2)
        expect(result).toEqual({ ok: false, repaired: true, problems: ['The reply had no JSON plan in it.'] })
    })

    it('never drops a part: an unknown one fails the build rather than vanishing', async () => {
        const { ask } = fakeAsk([JSON.stringify(bad), JSON.stringify(bad)])
        const result = await runBuilder(workflowRecipe, 'Research the news', ctx, ask)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.problems).toContain('"notAPart" (part "x") is not a part this canvas can use.')
    })

    it('puts parts, tools, rules and close examples in the prompt', () => {
        const prompt = systemPrompt(workflowRecipe, 'customer support with a human approval step', ctx)
        expect(prompt).toContain('- agentAgentflow:')
        expect(prompt).toContain('- serpAPI: Web search (needs a credential)')
        expect(prompt).toContain('Give exactly 3 starter questions: what a person would type')
        expect((prompt.match(/^Example \d+:/gm) || []).length).toBe(4)
    })
})
