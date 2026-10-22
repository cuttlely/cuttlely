import { harnessCardDescription, harnessDeleteBody, harnessDeleteTitle, harnessOpenProblem } from './harnessCard'

describe('agent team card text', () => {
    it('names the harness in the delete confirmation', () => {
        expect(harnessDeleteTitle('navi-harness')).toBe('Delete agent team "navi-harness"?')
        expect(harnessDeleteBody({ name: 'NAVI-B', chatflowId: 'c1' })).toContain('"NAVI-B"')
        expect(harnessDeleteBody({ name: 'NAVI-B', chatflowId: 'c1' })).toContain('canvas')
        expect(harnessDeleteBody({ name: 'navi', orphaned: true, chatflowId: 'c1' })).not.toContain('canvas and chat')
    })

    it('marks an orphan card', () => {
        expect(harnessCardDescription({ name: 'navi', orphaned: true, specialists: [{}] })).toMatch(/Canvas deleted/)
        expect(harnessCardDescription({ name: 'navi', specialists: [{}, {}] })).toBe('2 specialists')
    })
})

describe('opening an agent team', () => {
    it('explains an orphan instead of showing a broken page', () => {
        const problem = harnessOpenProblem({ name: 'navi', orphaned: true }, null)
        expect(problem.severity).toBe('warning')
        expect(problem.message).toMatch(/canvas this agent team was built from has been deleted/)
    })

    it('explains a missing team and a failed load', () => {
        expect(harnessOpenProblem(null, { response: { status: 404 } }).message).toMatch(/no longer exists/)
        expect(harnessOpenProblem(null, { response: { status: 500 } }).severity).toBe('error')
    })

    it('opens a healthy team normally', () => {
        expect(harnessOpenProblem({ name: 'navi', chatflowId: 'c1' }, null)).toBeNull()
    })
})
