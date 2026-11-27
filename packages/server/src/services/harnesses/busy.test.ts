import harnessesService, { setHarnessModuleLoader } from './index'

jest.mock('../../utils/runtimeAvailability', () => ({ assertSelectedHarnessAvailable: jest.fn() }))
jest.mock('../../metrics/tracing', () => ({ openHarnessRunTrace: () => ({ event: jest.fn(), finish: jest.fn(), fail: jest.fn() }) }))
jest.mock('../usage', () => ({ recordCompletedRun: jest.fn() }))
jest.mock('../../utils/nestedFlowCall', () => ({ nestedFlowCallerFromHarness: () => undefined }))

const message = 'A reply is still in progress in this chat. Try again in a moment.'
afterEach(() => setHarnessModuleLoader(null))

it('maps a second turn to HTTP 409 with the exact busy message', async () => {
    const dispatch = jest.fn(async () => {
        throw Object.assign(new Error(message), { code: 'busy', harnessError: true })
    })
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return { getHarness: () => ({ name: 'bakery', workspaceId: 'team-a', specialists: [] }) }
        if (file === 'run.mjs') return { runHarness: dispatch }
        if (file === 'history.mjs') return { chatBelongsToOtherCaller: () => false }
        throw new Error(`Unexpected harness module: ${file}`)
    })
    await expect(
        harnessesService.startRun(
            'bakery',
            { question: 'Keep this question.', chatId: 'same' },
            {
                workspaceId: 'team-a',
                caller: { via: 'session' },
                runtime: { componentNodes: {}, appDataSource: {} } as any
            }
        )
    ).rejects.toMatchObject({ statusCode: 409, message, code: 'busy' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: 'Keep this question.', chatId: 'same' }))
})

it('boot recovery closes history rows with the stale allowance and never clears turns', async () => {
    const interruptOpenRuns = jest.fn(() => 1)
    const ttl = jest.fn(() => 1500)
    setHarnessModuleLoader(async (file) => {
        if (file === 'history.mjs') return { interruptOpenRuns }
        if (file === 'lock.mjs')
            return new Proxy(
                {},
                {
                    get: (_target, key) => {
                        if (key === 'then') return undefined
                        if (key === 'lockTtlMs') return ttl
                        throw new Error(`Boot must not mutate turns through ${String(key)}`)
                    }
                }
            )
        throw new Error(`Unexpected harness module: ${file}`)
    })
    const schedule = jest.fn()
    const before = Date.now()
    expect(await harnessesService.closeInterruptedRuns({ schedule })).toBe(1)
    expect(ttl).toHaveBeenCalledTimes(1)
    expect(interruptOpenRuns).toHaveBeenCalledTimes(1)
    expect((interruptOpenRuns.mock.calls[0] as any[])[0].before).toBeGreaterThanOrEqual(before - 16500)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 16500)
    schedule.mock.calls[0][0]()
    expect(interruptOpenRuns).toHaveBeenCalledTimes(2)
    expect((interruptOpenRuns.mock.calls[1] as any[])[0].before).toBeGreaterThanOrEqual(before)
})
