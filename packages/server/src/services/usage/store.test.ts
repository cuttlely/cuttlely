import { recordCompletedRun } from './store'

// A finished run returns its answer even when the usage write fails.
describe('recordCompletedRun', () => {
    it('resolves after a failed write and does not reject the run', async () => {
        const errors: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => {
            errors.push(args.map(String).join(' '))
        }
        const failing = {
            options: { type: 'sqlite' },
            query: async () => {
                throw new Error('disk full')
            }
        }
        const finish = async () => {
            const answer = { text: 'Fresh bread at 7.' }
            const pending = recordCompletedRun(failing, {
                workspaceId: 'ws-a',
                flowId: 'flow-a',
                result: {
                    trace: {
                        route: { model: 'gpt-4.1-mini', tokens: { prompt: 4, completion: 2 } },
                        specialists: [],
                        handoff: { status: 'skipped', tokens: null }
                    }
                }
            })
            return { answer, pending }
        }
        try {
            const { answer, pending } = await finish()
            expect(answer.text).toBe('Fresh bread at 7.')
            await expect(pending).resolves.toBeUndefined()
            expect(errors.some((line) => line.includes('token totals were not saved'))).toBe(true)
            expect(errors.join('\n')).not.toContain('disk full')
        } finally {
            console.error = original
        }
    })
})
