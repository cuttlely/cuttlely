jest.mock('../settings/bootstrap', () => ({ startState: { ignored: false, applied: [], problems: [], dir: undefined } }))
jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

import { BaseCommand } from './base'

/** The SIGTERM/SIGINT handler with a stopProcess that drains for as long as the test wants. */
function command() {
    let finishDrain: () => void = () => {}
    const self = {
        terminating: false,
        stopProcess: jest.fn(() => new Promise<void>((resolve) => (finishDrain = resolve))),
        failExit: jest.fn(async () => {})
    }
    const onTerminate = (BaseCommand.prototype as any).onTerminate.call(self) as () => Promise<void>
    return { self, onTerminate, finishDrain: () => finishDrain() }
}

describe('stop signals', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('drains on the first signal and stops at once on the second', async () => {
        const { self, onTerminate, finishDrain } = command()
        const first = onTerminate()
        expect(self.stopProcess).toHaveBeenCalledTimes(1)
        expect(self.failExit).not.toHaveBeenCalled()

        await onTerminate()
        expect(self.failExit).toHaveBeenCalledTimes(1)
        expect(self.stopProcess).toHaveBeenCalledTimes(1)

        finishDrain()
        await first
    })

    it('forces the exit 5 seconds after the drain time', async () => {
        const previous = process.env.CUTTLELY_DRAIN_TIMEOUT_MS
        process.env.CUTTLELY_DRAIN_TIMEOUT_MS = '1000'
        try {
            const { self, onTerminate } = command()
            void onTerminate()
            jest.advanceTimersByTime(5999)
            expect(self.failExit).not.toHaveBeenCalled()
            jest.advanceTimersByTime(1)
            expect(self.failExit).toHaveBeenCalledTimes(1)
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_DRAIN_TIMEOUT_MS
            else process.env.CUTTLELY_DRAIN_TIMEOUT_MS = previous
        }
    })
})
