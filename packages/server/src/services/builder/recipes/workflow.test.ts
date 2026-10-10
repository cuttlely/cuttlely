jest.mock('flowise-components', () => ({
    initAgentflowNode: (d: any, id: string) => jest.requireActual('../testParts').fakeInitNode(d, id)
}))

import { planProblems } from '../core'
import { Plan } from '../plan'
import { RecipeContext } from '../recipe'
import { partsFromSamples, readWorkflowSamples } from '../testParts'
import { pickExamples, workflowAsPlan, workflowCanvas, workflowRecipe } from './workflow'

const ctx: RecipeContext = {
    componentNodes: partsFromSamples(),
    chatModel: { name: 'chatOpenAI', credential: 'c1', inputs: { modelName: 'gpt-4.1-mini', FLOWISE_CREDENTIAL_ID: 'c1' } },
    credentials: [{ id: 's1', name: 'Search', credentialName: 'serpApi' }]
}
const questions = ['One?', 'Two?', 'Three?']
const withQuestions = (plan: Plan): Plan => ({ ...plan, starterQuestions: questions })

describe('workflow recipe', () => {
    it('passes every bundled workflow through the strict check', () => {
        const samples = readWorkflowSamples()
        expect(samples.length).toBeGreaterThanOrEqual(13)
        for (const { file, flow } of samples) {
            expect({ file, problems: planProblems(workflowRecipe, withQuestions(workflowAsPlan(flow)), ctx) }).toEqual({
                file,
                problems: []
            })
        }
    })

    it('rebuilds every bundled workflow with the same cards and connections', () => {
        for (const { file, flow } of readWorkflowSamples()) {
            const built = workflowCanvas(withQuestions(workflowAsPlan(flow)), ctx)
            expect({ file, cards: built.nodes.length, links: built.edges.length }).toEqual({
                file,
                cards: flow.nodes.length,
                links: flow.edges.length
            })
            const ids = new Set(built.nodes.map((n: any) => n.id))
            for (const edge of built.edges) {
                expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true)
                const source = built.nodes.find((n: any) => n.id === edge.source)
                expect(source.data.outputAnchors.map((a: any) => a.id)).toContain(edge.sourceHandle)
            }
        }
    })

    it('reports workflow problems in plain words', () => {
        const plan: Plan = {
            nodes: [
                { id: 's', name: 'startAgentflow' },
                { id: 's2', name: 'startAgentflow' },
                { id: 'c', name: 'conditionAgentAgentflow', scenarios: ['only one'] },
                { id: 'l', name: 'llmAgentflow', tools: ['serpAPI'] },
                { id: 't', name: 'toolAgentflow', tools: [] },
                { id: 'loop', name: 'loopAgentflow' },
                { id: 'kid', name: 'llmAgentflow', parent: 'l' },
                { id: 'lonely', name: 'llmAgentflow' },
                { id: 'reply', name: 'directReplyAgentflow' }
            ],
            edges: [
                { from: 's', to: 'c' },
                { from: 'c', to: 'l', branch: 3 },
                { from: 'l', to: 't', branch: 1 },
                { from: 't', to: 'loop' },
                { from: 'loop', to: 's' },
                { from: 'l', to: 'reply' },
                { from: 't', to: 'reply' }
            ],
            starterQuestions: questions
        }
        const problems = workflowRecipe.check(plan, ctx)
        expect(problems).toEqual(
            expect.arrayContaining([
                'A workflow needs exactly one startAgentflow part; this plan has 2.',
                'Nothing can connect into "s" (startAgentflow).',
                'Nothing can connect out of "loop" (loopAgentflow).',
                '"c" (conditionAgentAgentflow) needs two or more scenarios, each in a few words.',
                '"c" (conditionAgentAgentflow) has one route, so its connection to "l" cannot use branch 3.',
                '"l" (llmAgentflow) has one route, so its connection to "t" cannot use branch 1.',
                'Only agentAgentflow and toolAgentflow parts take tools; "l" (llmAgentflow) lists some.',
                '"t" (toolAgentflow) needs exactly one tool.',
                '"loop" (loopAgentflow) needs "loopBackTo" set to the id of another part in the plan.',
                '"kid" (llmAgentflow) sits inside "l", which is not an iteration part.',
                '"lonely" (llmAgentflow) has no connection into it, so it would never run.',
                '"reply" (directReplyAgentflow) has 2 connections into it. Give it one, or leave it out so each route\'s last part answers.'
            ])
        )
    })

    it('places a branching team left to right and fills scenarios, routes and the matched credential', () => {
        const plan: Plan = {
            nodes: [
                { id: 'start', name: 'startAgentflow' },
                { id: 'route', name: 'conditionAgentAgentflow', instructions: 'Sort the request', scenarios: ['billing', 'other'] },
                { id: 'bill', name: 'agentAgentflow', label: 'Billing', tools: ['serpAPI'] },
                { id: 'gen', name: 'llmAgentflow', label: 'General' }
            ],
            edges: [
                { from: 'start', to: 'route' },
                { from: 'route', to: 'bill', branch: 0 },
                { from: 'route', to: 'gen', branch: 1 }
            ],
            starterQuestions: questions
        }
        const built = workflowCanvas(plan, ctx)
        const [start, route, bill, gen] = built.nodes
        expect(start.position.x).toBeLessThan(route.position.x)
        expect(route.position.x).toBeLessThan(bill.position.x)
        expect(bill.position.x).toBe(gen.position.x)
        expect(bill.position.y).not.toBe(gen.position.y)
        expect(route.data.inputs.conditionAgentScenarios).toEqual([{ scenario: 'billing' }, { scenario: 'other' }])
        expect(route.data.inputs.conditionAgentInstructions).toBe('Sort the request')
        expect(built.edges.map((e: any) => e.sourceHandle)).toEqual([
            'startAgentflow_0-output-startAgentflow',
            'conditionAgentAgentflow_0-output-0',
            'conditionAgentAgentflow_0-output-1'
        ])
        expect(bill.data.inputs.agentTools[0].agentSelectedToolConfig).toEqual({
            agentSelectedTool: 'serpAPI',
            FLOWISE_CREDENTIAL_ID: 's1'
        })
        expect(built.missingCredentials).toEqual([])
    })

    it('lets a Direct Reply send the answer before it and keeps references to renamed cards', () => {
        const plan: Plan = {
            nodes: [
                { id: 'start', name: 'startAgentflow' },
                { id: 'draft', name: 'llmAgentflow', instructions: 'Write a draft.' },
                { id: 'check', name: 'llmAgentflow', instructions: 'Fix the mistakes in {{ draft }}.' },
                { id: 'reply', name: 'directReplyAgentflow' }
            ],
            edges: [
                { from: 'start', to: 'draft' },
                { from: 'draft', to: 'check' },
                { from: 'check', to: 'reply' }
            ],
            starterQuestions: questions
        }
        const built = workflowCanvas(plan, ctx)
        expect(built.nodes[2].data.inputs.llmMessages[0].content).toBe('Fix the mistakes in {{ llmAgentflow_0 }}.')
        expect(built.nodes[3].data.inputs.directReplyMessage).toContain('{{ llmAgentflow_1 }}')
    })

    it('picks the closest bundled workflows as examples', () => {
        const examples = pickExamples('a human reviews and approves the draft before it is sent')
        expect(examples).toHaveLength(4)
        expect(examples.map((e) => e.title).join(' ')).toMatch(/Human/i)
    })
})
