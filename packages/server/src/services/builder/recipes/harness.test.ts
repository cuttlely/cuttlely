import { sampleTemplates } from '../../marketplaces/sampleTemplates'
import { templateClearanceFailures } from '../../marketplaces/templateLayout'
import { fits } from '../classic'
import { planProblems } from '../core'
import { Plan } from '../plan'
import { RecipeContext } from '../recipe'
import { partNamesIn, realParts } from '../testRealParts'
import { harnessExamples, harnessParts, harnessRecipe, harnessSampleAsPlan } from './harness'

const samples = sampleTemplates().filter((template) => template.type === 'Harness')
const sampleFlows = samples.map((template) => ({ name: template.templateName, flow: JSON.parse(template.flowData) }))
const names = new Set<string>(['chatOpenAI', 'harnessChief', 'harnessSpecialist', 'calculator', 'serpAPI'])
for (const { flow } of sampleFlows) for (const node of flow.nodes) names.add(node.data.name)

const componentNodes = realParts([...names])
const ctx: RecipeContext = {
    componentNodes,
    chatModel: { name: 'chatOpenAI', credential: 'cred-1', inputs: { modelName: 'gpt-4.1-mini' } },
    credentials: [{ id: 'cred-1', name: 'OpenAI demo', credentialName: 'openAIApi' }],
    credentialLabels: { serpApi: 'Serp Api' }
}

const asPlan = (flow: any): Plan => harnessSampleAsPlan(flow)

const boxes = (nodes: any[]) =>
    nodes.map((n) => ({ id: n.id, name: n.data.name, x: n.position.x, y: n.position.y, w: n.width, h: n.height }))

const team = (extra: Partial<Plan> = {}): Plan => ({
    nodes: [
        { id: 'prime', name: 'harnessChief', instructions: 'Send maths to the calculator specialist.' },
        { id: 'maths', name: 'harnessSpecialist', label: 'Maths', inputs: { specialistName: 'maths' }, instructions: 'Work out sums.' },
        { id: 'calc', name: 'calculator' },
        ...(extra.nodes || [])
    ],
    edges: [{ from: 'maths', to: 'prime', input: 'specialists' }, { from: 'calc', to: 'maths', input: 'attached' }, ...(extra.edges || [])],
    starterQuestions: ['What is 2 + 2?', 'What is 10% of 250?', 'What is 17 times 3?']
})

describe('harness recipe', () => {
    it('finds the 6 bundled harnesses', () => {
        expect(samples).toHaveLength(6)
    })

    // The Research sample's Custom Retriever has nothing in its required Vector Store plug, so the builder
    // does not learn from it.
    const unfit = ['Research Harness']

    it.each(sampleFlows.map((s) => [s.name, s.flow]))('the bundled "%s" passes the check as a plan', (name, flow) => {
        const plan = { ...asPlan(flow), starterQuestions: ['a?', 'b?', 'c?'] }
        const problems = planProblems(harnessRecipe, plan, ctx)
        if (unfit.includes(name)) expect(problems.join('\n')).toMatch(/needs something in its vectorStore plug/)
        else expect(problems).toEqual([])
    })

    it.each(sampleFlows.map((s) => [s.name, s.flow]))('the bundled "%s" rebuilds into clear, connected cards', (_name, flow) => {
        const plan = asPlan(flow)
        const built = harnessRecipe.materialize(plan, ctx)
        expect(templateClearanceFailures(boxes(built.nodes))).toEqual([])
        const prime = built.nodes.find((n) => n.data.name === 'harnessChief')
        const model = built.nodes.find((n) => n.data.name === 'chatOpenAI')
        expect(prime.data.inputs.chatModel).toBe(`{{${model.id}.data.instance}}`)
        expect(model.data.credential).toBe('cred-1')
        const specialists = built.nodes.filter((n) => n.data.name === 'harnessSpecialist')
        expect(prime.data.inputs.specialists).toHaveLength(specialists.length)
        // Prime sits to the right of every specialist, and every tool to the left of what it feeds.
        for (const s of specialists) expect(prime.position.x).toBeGreaterThan(s.position.x)
        for (const edge of built.edges) {
            const source = built.nodes.find((n) => n.id === edge.source)
            const target = built.nodes.find((n) => n.id === edge.target)
            if (source !== model) expect(source.position.x).toBeLessThan(target.position.x)
            expect(target.data.inputAnchors.some((a: any) => a.id === edge.targetHandle)).toBe(true)
        }
    })

    it('offers team parts and specialist parts, not chat models or other canvases', () => {
        const names = harnessParts(componentNodes).map((p) => p.name)
        expect(names).toEqual(expect.arrayContaining(['harnessChief', 'harnessSpecialist', 'calculator', 'memoryVectorStore']))
        expect(names).not.toContain('chatOpenAI')
    })

    it('lets every tool plug into a specialist', () => {
        const tools = realParts(partNamesIn('tools'))
        const attached = componentNodes.harnessSpecialist.inputs?.find((input) => input.name === 'attached') as Record<string, any>
        const unfit = Object.values(tools)
            .filter((tool) => tool.category === 'Tools' && !fits(tool, attached))
            .map((tool) => tool.name)
        expect(unfit).toEqual([])
    })

    it('picks examples close to the request', () => {
        const examples = harnessExamples('a research team that searches documents')
        expect(examples.length).toBeGreaterThan(0)
        expect(examples.length).toBeLessThanOrEqual(4)
        for (const example of examples) expect(example.plan.nodes.some((n) => n.name === 'harnessChief')).toBe(true)
        const checked = harnessExamples('research documents retriever', ctx)
        expect(checked.map((e) => e.title)).not.toContain('Research Harness')
        for (const example of checked) expect(harnessRecipe.check(example.plan, ctx)).toEqual([])
    })

    it('lists team problems in plain words', () => {
        const plan: Plan = {
            nodes: [
                { id: 'a', name: 'harnessSpecialist', inputs: { specialistName: 'Bad Name' } },
                { id: 'b', name: 'harnessSpecialist', inputs: { specialistName: 'helper', enableShell: 'yes' }, instructions: 'Help.' },
                { id: 'c', name: 'calculator' }
            ],
            edges: [],
            starterQuestions: ['a?', 'b?', 'c?']
        }
        const problems = harnessRecipe.check(plan, ctx).join('\n')
        expect(problems).toMatch(/exactly one harnessChief/)
        expect(problems).toMatch(/short, lowercase/)
        expect(problems).toMatch(/needs "instructions"/)
        expect(problems).toMatch(/"enableShell" on .* must be true or false/)
        expect(problems).toMatch(/does not reach a specialist/)
    })

    it('rejects a connection whose type does not fit the plug', () => {
        const wrongPlug = team({ nodes: [{ id: 'text', name: 'plainText' }], edges: [{ from: 'text', to: 'prime', input: 'specialists' }] })
        expect(harnessRecipe.check(wrongPlug, ctx).join('\n')).toMatch(/does not fit the specialists plug/)
        const missingPlug = team({
            nodes: [{ id: 'store', name: 'memoryVectorStore' }],
            edges: [{ from: 'store', to: 'maths', input: 'attached' }]
        })
        expect(harnessRecipe.check(missingPlug, ctx).join('\n')).toMatch(/needs something in its embeddings plug/)
        const fixed = team({
            nodes: [
                { id: 'store', name: 'memoryVectorStore' },
                { id: 'emb', name: 'localHashEmbeddings' }
            ],
            edges: [
                { from: 'store', to: 'maths', input: 'attached' },
                { from: 'emb', to: 'store', input: 'embeddings' }
            ]
        })
        expect(harnessRecipe.check(fixed, ctx)).toEqual([])
    })

    it('builds cards with the specialist name, abilities and missing credentials listed by name', () => {
        const plan = team({ nodes: [{ id: 'search', name: 'serpAPI' }], edges: [{ from: 'search', to: 'maths', input: 'attached' }] })
        plan.nodes[1].inputs = { specialistName: 'maths', enableBrowser: true }
        expect(harnessRecipe.check(plan, ctx)).toEqual([])
        const built = harnessRecipe.materialize(plan, ctx)
        const maths = built.nodes.find((n) => n.data.name === 'harnessSpecialist')
        expect(maths.data.inputs.specialistName).toBe('maths')
        expect(maths.data.inputs.instructions).toBe('Work out sums.')
        expect(maths.data.inputs.enableBrowser).toBe(true)
        expect(maths.data.inputs.enableShell).toBe(false)
        expect(maths.data.inputs.attached).toHaveLength(2)
        expect(built.missingCredentials).toEqual([{ part: 'Serp API', credential: 'Serp Api' }])
    })
})
