import {
    initialRestart,
    nextRestart,
    readProbe,
    restartFailed,
    restartSteps,
    restartSummary,
    restartTitle,
    SLOW_AFTER_MS,
    withOutcome
} from './restart'

const status = (state) => Object.fromEntries(restartSteps(state).map((step) => [step.id, step.status]))

describe('restart screen', () => {
    it('reads pings', () => {
        expect(readProbe({ error: true })).toEqual({ kind: 'down' })
        expect(readProbe({ status: 200 })).toEqual({ kind: 'up' })
        expect(readProbe({ status: 503, body: { status: 'starting', step: 'Opening the database' } })).toEqual({
            kind: 'starting',
            step: 'Opening the database'
        })
        expect(readProbe({ status: 502 })).toEqual({ kind: 'down' })
    })

    it('does not call it back before the old server went away', () => {
        let state = initialRestart({ saved: 2, startedAt: 0 })
        state = nextRestart(state, { kind: 'up' }, 1000)
        expect(state.back).toBe(false)
        expect(status(state)).toMatchObject({ saved: 'done', stopping: 'active', starting: 'waiting', back: 'waiting' })
    })

    it('walks through runs, stopping, starting with the live step, and back', () => {
        let state = initialRestart({ saved: 3, waitingFor: 2, startedAt: 0 })
        expect(restartSteps(state).map((s) => s.label)).toEqual(['Saved 3 settings', 'Let 2 runs finish', 'Stopping', 'Starting', 'Back'])
        expect(status(state)).toMatchObject({ runs: 'active', stopping: 'waiting' })
        state = nextRestart(state, { kind: 'up' }, 1000)
        state = nextRestart(state, { kind: 'down' }, 2000)
        expect(status(state)).toMatchObject({ runs: 'done', stopping: 'done', starting: 'active' })
        state = nextRestart(state, { kind: 'starting', step: 'Loading the building blocks (the slowest step)' }, 3000)
        expect(restartSteps(state)[3].label).toBe('Starting: Loading the building blocks (the slowest step)')
        state = nextRestart(state, { kind: 'up' }, 4000)
        expect(state.back).toBe(true)
        expect(status(state).back).toBe('done')
        expect(restartSummary(state)).toBe('Running with 3 new settings applied.')
    })

    it('says so when it takes too long', () => {
        let state = initialRestart({ startedAt: 0 })
        state = nextRestart(state, { kind: 'down' }, SLOW_AFTER_MS + 1)
        expect(state.slow).toBe(true)
        expect(restartSummary(state)).toMatch(/longer than usual/)
    })

    it('shows the failure state when safe boot put back the last settings that worked', () => {
        let state = initialRestart({ saved: 2, startedAt: 0 })
        state = nextRestart(state, { kind: 'down' }, 1000)
        state = nextRestart(state, { kind: 'starting', step: 'Opening the database' }, 2000)
        state = nextRestart(state, { kind: 'down' }, 3000)
        state = nextRestart(state, { kind: 'up' }, 9000)
        expect(state.outcome).toBe('checking')
        expect(restartFailed(state)).toBe(false)
        const failed = withOutcome(state, true)
        expect(restartFailed(failed)).toBe(true)
        expect(restartTitle(failed)).toBe('The new settings did not start')
        expect(status(failed)).toMatchObject({ saved: 'done', stopping: 'done', starting: 'failed', rollback: 'done', back: 'done' })
        expect(restartSummary(failed)).toMatch(/safe boot put back the last settings that worked/)
        expect(restartSummary(failed)).not.toMatch(/applied/)
    })

    it('reports the new settings as applied when they started, or when the outcome could not be read', () => {
        let state = initialRestart({ saved: 1, startedAt: 0 })
        state = nextRestart(nextRestart(state, { kind: 'down' }, 1000), { kind: 'up' }, 2000)
        expect(restartSummary(withOutcome(state, false))).toBe('Running with 1 new setting applied.')
        expect(withOutcome(state, null).outcome).toBe('applied')
        expect(withOutcome(initialRestart({}), true).outcome).toBe('checking')
    })
})
