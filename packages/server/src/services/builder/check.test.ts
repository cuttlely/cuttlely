import { sharedProblems } from './check'
import { extractJson, toPlan } from './plan'

const questions = ['What can you do?', 'Summarize this.', 'Who should I ask?']

describe('builder plan', () => {
    it('reads a fenced or bare JSON plan and keeps malformed parts for the check', () => {
        expect(extractJson('Here:\n```json\n{"nodes": []}\n```')).toEqual({ nodes: [] })
        expect(extractJson('sure {"a": 1} done')).toEqual({ a: 1 })
        expect(() => extractJson('no plan here')).toThrow('no JSON plan')
        const plan = toPlan({ nodes: [{ name: 'llmAgentflow' }, 'junk'], edges: [{ from: 'a', to: 'b', branch: '1' }] })
        expect(plan.nodes).toHaveLength(2)
        expect(plan.nodes[0]).toEqual({ id: '', name: 'llmAgentflow' })
        expect(plan.edges[0].branch).toBe(1)
    })

    it('reports every shared problem instead of dropping anything', () => {
        const plan = toPlan({
            nodes: [{ id: 'a', name: 'known' }, { id: 'a', name: 'known' }, { id: 'c', name: 'madeUp' }, { name: 'known' }],
            edges: [
                { from: 'a', to: 'zzz' },
                { from: 'c', to: 'c' }
            ],
            starterQuestions: ['Only one?']
        })
        const problems = sharedProblems(plan, new Set(['known']))
        expect(problems).toEqual(
            expect.arrayContaining([
                'Two parts share the id "a".',
                '"madeUp" (part "c") is not a part this canvas can use.',
                'Part 4 has no id.',
                'Connection 1 (a to zzz) ends at a part that is not in the plan.',
                'Connection 2 (c to c) connects a part to itself.',
                'Give exactly 3 starter questions someone could ask the finished flow.'
            ])
        )
    })

    it('passes a clean plan', () => {
        const plan = toPlan({
            nodes: [
                { id: 'a', name: 'known' },
                { id: 'b', name: 'known' }
            ],
            edges: [{ from: 'a', to: 'b' }],
            starterQuestions: questions
        })
        expect(sharedProblems(plan, new Set(['known']))).toEqual([])
        expect(sharedProblems({ ...plan, starterQuestions: [...questions.slice(0, 2), 'x'.repeat(201)] }, new Set(['known']))).toEqual([
            'Keep each starter question under 200 characters.'
        ])
    })
})
