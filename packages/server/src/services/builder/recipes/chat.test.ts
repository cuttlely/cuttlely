import { marketplaceFlowTemplates } from '../../marketplaces/sampleTemplates'
import { templateClearanceFailures } from '../../marketplaces/templateLayout'
import { planProblems } from '../core'
import { Plan } from '../plan'
import { RecipeContext } from '../recipe'
import { realParts } from '../testRealParts'
import { chatExamples, chatParts, chatRecipe, chatSampleAsPlan } from './chat'

const templates = marketplaceFlowTemplates().filter((template) => template.type === 'Chatflow')
const flows = templates.map((template) => ({ name: template.templateName, flow: JSON.parse(template.flowData) }))
const names = new Set<string>([
    'chatOpenAI',
    'toolAgent',
    'conversationChain',
    'bufferMemory',
    'calculator',
    'memoryVectorStore',
    'localHashEmbeddings',
    'plainText',
    'retrieverTool',
    'harness',
    'harnessChief',
    'openAIAssistant',
    'serpAPI',
    'vectorStoreRetriever',
    'chainTool',
    'llmChain',
    'promptTemplate'
])
for (const { flow } of flows) for (const node of flow.nodes) if (node.data?.name) names.add(node.data.name)
const componentNodes = realParts([...names])
const ctx: RecipeContext = {
    componentNodes,
    chatModel: { name: 'chatOpenAI', credential: 'cred-1', inputs: { modelName: 'gpt-4.1-mini' } },
    credentials: [{ id: 'cred-1', name: 'OpenAI demo', credentialName: 'openAIApi' }],
    credentialLabels: { openAIApi: 'OpenAI API', serpApi: 'Serp API' }
}
const starters = ['What is 12 times 7?', 'Add 19 and 23', 'What is 15% of 80?']

const toolAgent = (extra: Partial<Plan> = {}): Plan => ({
    nodes: [
        { id: 'agent', name: 'toolAgent', inputs: { systemMessage: 'You help with sums.' } },
        { id: 'memory', name: 'bufferMemory' },
        { id: 'calc', name: 'calculator' },
        ...(extra.nodes || [])
    ],
    edges: [{ from: 'memory', to: 'agent', input: 'memory' }, { from: 'calc', to: 'agent', input: 'tools' }, ...(extra.edges || [])],
    starterQuestions: starters
})

describe('chatflow recipe', () => {
    it('finds the 24 bundled chatflows', () => expect(templates).toHaveLength(24))

    it('offers agents, chains, memory, tools and the harness tool, not models or parts with their own setup', () => {
        expect(chatParts(componentNodes).map((p) => p.name)).not.toContain('harness')
        const offered = chatParts(componentNodes, ['Trip-Planning-Harness']).map((p) => p.name)
        expect(offered).toEqual(
            expect.arrayContaining(['toolAgent', 'conversationChain', 'bufferMemory', 'calculator', 'retrieverTool', 'harness'])
        )
        for (const name of ['chatOpenAI', 'harnessChief', 'openAIAssistant', 'vectorStoreRetriever']) expect(offered).not.toContain(name)
        expect(chatRecipe.partsSummary(ctx)).toMatch(/- retrieverTool: [^\n]*Fill: name, description\./)
    })

    it('learns from the closest bundled chatflows that pass the check', () => {
        const examples = chatExamples('an assistant that uses a calculator and searches the web', ctx)
        expect(examples.length).toBeGreaterThan(0)
        expect(examples.length).toBeLessThanOrEqual(3)
        for (const example of examples) expect(chatRecipe.check({ ...example.plan, starterQuestions: starters }, ctx)).toEqual([])
        // The calculator sample calls a saved harness named calculator, so it teaches only where that harness exists.
        expect(examples.flatMap((e) => e.plan.nodes.map((n) => n.name))).not.toContain('harness')
        const withCalculator = { ...ctx, harnessNames: ['calculator'] }
        const teamExamples = chatExamples('an assistant that uses a calculator and searches the web', withCalculator)
        expect(teamExamples.map((e) => e.title)).toContain('OpenAI Calculator Chatflow')
    })

    it('leaves the models of a bundled chatflow out of its plan', () => {
        const tool = flows.find((f) => f.name === 'Tool Agent')!
        const plan = chatSampleAsPlan(tool.flow)
        expect(plan.nodes.map((n) => n.name)).not.toContain('chatOpenAI')
        expect(plan.nodes.map((n) => n.name)).toContain('toolAgent')
    })

    it('builds a tool agent with the chosen model plugged in, clear of overlaps', () => {
        const plan = toolAgent()
        expect(planProblems(chatRecipe, plan, ctx)).toEqual([])
        const built = chatRecipe.materialize(plan, ctx)
        const agent = built.nodes.find((n) => n.data.name === 'toolAgent')
        expect(agent.data.inputs.model).toBe('{{chatOpenAI_0.data.instance}}')
        expect(agent.data.inputs.memory).toBe('{{bufferMemory_0.data.instance}}')
        expect(agent.data.inputs.systemMessage).toBe('You help with sums.')
        const model = built.nodes.find((n) => n.data.name === 'chatOpenAI')
        expect(model.data.credential).toBe('cred-1')
        expect(model.data.inputs.modelName).toBe('gpt-4.1-mini')
        for (const n of built.nodes) if (n !== agent) expect(n.position.x).toBeLessThan(agent.position.x)
        const boxes = built.nodes.map((n) => ({ id: n.id, name: n.data.name, x: n.position.x, y: n.position.y, w: n.width, h: n.height }))
        expect(templateClearanceFailures(boxes)).toEqual([])
        expect(built.missingCredentials).toEqual([])
    })

    it('answers from your own text with parts that need no key', () => {
        const plan = toolAgent({
            nodes: [
                { id: 'facts', name: 'plainText', inputs: { text: 'The Lumen lamp has three brightness levels.' } },
                { id: 'store', name: 'memoryVectorStore' },
                { id: 'emb', name: 'localHashEmbeddings' },
                { id: 'lookup', name: 'retrieverTool', inputs: { name: 'lamp_facts', description: 'Facts about the Lumen lamp' } }
            ],
            edges: [
                { from: 'facts', to: 'store', input: 'document' },
                { from: 'emb', to: 'store', input: 'embeddings' },
                { from: 'store', to: 'lookup', input: 'retriever' },
                { from: 'lookup', to: 'agent', input: 'tools' }
            ]
        })
        expect(planProblems(chatRecipe, plan, ctx)).toEqual([])
        const built = chatRecipe.materialize(plan, ctx)
        expect(built.missingCredentials).toEqual([])
    })

    it('lists chatflow problems in plain words', () => {
        const two = toolAgent({ nodes: [{ id: 'chain', name: 'conversationChain' }] })
        expect(chatRecipe.check(two, ctx).join('\n')).toMatch(/exactly one ending .* this plan has 2/)
        const toolOnly: Plan = { nodes: [{ id: 'calc', name: 'calculator' }], edges: [], starterQuestions: starters }
        expect(chatRecipe.check(toolOnly, ctx).join('\n')).toMatch(/cannot answer a chat; end on an Agent or a Chain/)
        const withModel = toolAgent({ nodes: [{ id: 'm', name: 'chatOpenAI' }], edges: [{ from: 'm', to: 'agent', input: 'model' }] })
        expect(chatRecipe.check(withModel, ctx).join('\n')).toMatch(/is a model; leave models out/)
        const noMemory = toolAgent()
        noMemory.edges = noMemory.edges.filter((e) => e.input !== 'memory')
        noMemory.nodes = noMemory.nodes.filter((n) => n.id !== 'memory')
        expect(chatRecipe.check(noMemory, ctx).join('\n')).toMatch(/needs something in its memory plug/)
        const wrongPlug = toolAgent()
        wrongPlug.edges[0] = { from: 'memory', to: 'agent', input: 'tools' }
        expect(chatRecipe.check(wrongPlug, ctx).join('\n')).toMatch(/does not fit the tools plug/)
        const retrieverPlan = toolAgent({
            nodes: [
                { id: 'facts', name: 'plainText', inputs: { text: 'The lamp has three brightness levels.' } },
                { id: 'emb', name: 'localHashEmbeddings' },
                { id: 'store', name: 'memoryVectorStore' },
                { id: 'wrap', name: 'vectorStoreRetriever', inputs: { name: 'facts', description: 'Lamp facts' } },
                { id: 'tool', name: 'retrieverTool', inputs: { name: 'facts', description: 'Lamp facts' } }
            ],
            edges: [
                { from: 'facts', to: 'store', input: 'document' },
                { from: 'emb', to: 'store', input: 'embeddings' },
                { from: 'store', to: 'wrap', input: 'vectorStore' },
                { from: 'wrap', to: 'tool', input: 'retriever' },
                { from: 'tool', to: 'agent', input: 'tools' }
            ]
        })
        expect(chatRecipe.check(retrieverPlan, ctx).join('\n')).toMatch(
            /"wrap" \(vectorStoreRetriever\) does not fit the retriever plug on "tool", which takes BaseRetriever\. In this plan, "store" \(memoryVectorStore\) fits it\./
        )
        const chainWithMemory: Plan = {
            nodes: [
                { id: 'prompt', name: 'chatPromptTemplate', inputs: { systemMessagePrompt: 'You quiz me.', humanMessagePrompt: '{text}' } },
                { id: 'memory', name: 'bufferMemory' },
                { id: 'chain', name: 'llmChain' }
            ],
            edges: [
                { from: 'prompt', to: 'chain', input: 'prompt' },
                { from: 'memory', to: 'chain', input: 'memory' }
            ],
            starterQuestions: starters
        }
        expect(chatRecipe.check(chainWithMemory, ctx).join('\n')).toMatch(
            /"memory" is not a plug on "chain"; its plugs are [^.]+\. Chains parts with a memory plug: [^.]*conversationChain/
        )
        const namelessTool = toolAgent({
            nodes: [
                { id: 'prompt', name: 'promptTemplate', inputs: { template: 'Suggest a recipe for {text}' } },
                { id: 'chain', name: 'llmChain' },
                { id: 'recipes', name: 'chainTool' }
            ],
            edges: [
                { from: 'prompt', to: 'chain', input: 'prompt' },
                { from: 'chain', to: 'recipes', input: 'baseChain' },
                { from: 'recipes', to: 'agent', input: 'tools' }
            ]
        })
        expect(chatRecipe.check(namelessTool, ctx).join('\n')).toMatch(
            /"recipes" \(chainTool\) needs "inputs.name" \([^)]+\) and "inputs.description"/
        )
        namelessTool.nodes[namelessTool.nodes.length - 1].inputs = { name: 'recipes', description: 'Suggests a recipe' }
        expect(chatRecipe.check(namelessTool, ctx).join('\n')).not.toMatch(/needs "inputs/)
        namelessTool.nodes[namelessTool.nodes.length - 1].inputs = { name: 'Recipe ideas', description: 'Suggests a recipe' }
        expect(chatRecipe.check(namelessTool, ctx).join('\n')).toMatch(/"inputs.name" is "Recipe ideas"; use letters, digits, _ or - only/)
        const chatPrompt = (humanMessagePrompt: string): Plan => ({
            nodes: [
                { id: 'memory', name: 'bufferMemory' },
                {
                    id: 'prompt',
                    name: 'chatPromptTemplate',
                    inputs: { systemMessagePrompt: 'You write polite emails.', humanMessagePrompt }
                },
                { id: 'chain', name: 'conversationChain' }
            ],
            edges: [
                { from: 'memory', to: 'chain', input: 'memory' },
                { from: 'prompt', to: 'chain', input: 'chatPromptTemplate' }
            ],
            starterQuestions: starters
        })
        expect(chatRecipe.check(chatPrompt('{query}'), ctx).join('\n')).toMatch(/uses \{query\}; the chat fills only \{input\}/)
        expect(chatRecipe.check(chatPrompt('{input}'), ctx).join('\n')).not.toMatch(/fills only/)
        const withTeams = { ...ctx, harnessNames: ['Trip-Planning-Harness'] }
        const team = toolAgent({ nodes: [{ id: 'team', name: 'harness' }], edges: [{ from: 'team', to: 'agent', input: 'tools' }] })
        expect(chatRecipe.check(team, withTeams).join('\n')).toMatch(/needs "inputs.harnessName"/)
        team.nodes[team.nodes.length - 1].inputs = { harnessName: 'Study-Team' }
        expect(chatRecipe.check(team, withTeams).join('\n')).toMatch(
            /"Study-Team", which is not a saved harness. Use one of: Trip-Planning-Harness/
        )
        team.nodes[team.nodes.length - 1].inputs = { harnessName: 'Trip-Planning-Harness' }
        expect(chatRecipe.check(team, withTeams).join('\n')).not.toMatch(/harness/i)
    })

    it('lists a named service credential that is missing', () => {
        const plan = toolAgent({ nodes: [{ id: 'web', name: 'serpAPI' }], edges: [{ from: 'web', to: 'agent', input: 'tools' }] })
        expect(chatRecipe.check(plan, ctx)).toEqual([])
        const built = chatRecipe.materialize(plan, ctx)
        expect(built.missingCredentials).toEqual([{ part: 'Serp API', credential: 'Serp API' }])
    })
})
