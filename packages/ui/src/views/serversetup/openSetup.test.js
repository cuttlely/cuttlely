import { openSetupPage, rememberSetupCode, resetRememberedSetupCode } from './openSetup'

const EXPIRED = 'This setup code has expired. A new code was printed in the server log.'

function deferred() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function hooksFor(events) {
    return {
        onServiceName: (name) => events.push(['name', name]),
        onOwner: (code) => events.push(['owner', code]),
        onChoose: () => events.push(['choose']),
        onCode: (message) => events.push(['code', message]),
        onClosed: (next) => events.push(['closed', next?.message || ''])
    }
}

async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('opening the setup page', () => {
    beforeEach(() => {
        resetRememberedSetupCode()
    })

    it('ignores a late hint once begin has accepted the code', async () => {
        const events = []
        const accepted = { current: false }
        const hooks = hooksFor(events)
        const beginFirst = deferred()
        const hintFirst = deferred()
        const controller = new AbortController()
        const first = openSetupPage({
            code: rememberSetupCode('made-up-code'),
            api: {
                hint: () => hintFirst.promise,
                begin: () => beginFirst.promise,
                getState: async () => ({ data: {} })
            },
            signal: controller.signal,
            accepted,
            hooks
        })
        controller.abort()

        const beginSecond = deferred()
        const hintSecond = deferred()
        const second = openSetupPage({
            code: rememberSetupCode(''),
            api: {
                hint: () => hintSecond.promise,
                begin: () => beginSecond.promise,
                getState: async () => ({ data: {} })
            },
            signal: new AbortController().signal,
            accepted,
            hooks
        })
        expect(rememberSetupCode('')).toBe('made-up-code')

        beginSecond.resolve({ data: { next: 'owner' } })
        await second
        hintFirst.resolve({ data: { serviceName: 'bakery-web', open: true } })
        beginFirst.resolve({ data: { next: 'owner' } })
        hintSecond.resolve({ data: { serviceName: 'bakery-web', open: true } })
        await first
        await settle()

        expect(events.filter((row) => row[0] === 'code')).toEqual([])
        expect(events.filter((row) => row[0] === 'closed')).toEqual([])
        expect(events.filter((row) => row[0] === 'owner')).toEqual([['owner', 'made-up-code']])
        expect(events).toContainEqual(['name', 'bakery-web'])
    })

    it('drops a hint that resolves after the code was already accepted', async () => {
        const events = []
        const accepted = { current: false }
        const hint = deferred()
        const run = openSetupPage({
            code: '',
            api: {
                hint: () => hint.promise,
                begin: () => Promise.reject(new Error('unused'))
            },
            accepted,
            hooks: hooksFor(events)
        })
        await Promise.resolve()
        accepted.current = true
        hint.resolve({ data: { serviceName: 'bakery-web', open: true } })
        await run
        expect(events).toEqual([])
    })

    it('drops the answer from a run whose controller was aborted', async () => {
        const events = []
        const controller = new AbortController()
        const begin = deferred()
        const hint = deferred()
        const run = openSetupPage({
            code: 'made-up-code',
            api: {
                hint: () => hint.promise,
                begin: () => begin.promise
            },
            signal: controller.signal,
            accepted: { current: false },
            hooks: hooksFor(events)
        })
        controller.abort()
        begin.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
        hint.resolve({ data: { serviceName: 'bakery-web', open: true } })
        await run
        await settle()
        expect(events).toEqual([])
    })

    it('loads the service name on a code link, including when the code has expired', async () => {
        const events = []
        const hint = deferred()
        const failure = {
            response: {
                status: 404,
                data: { code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED }
            }
        }
        const run = openSetupPage({
            code: 'old-code',
            api: {
                hint: () => hint.promise,
                begin: () => Promise.reject(failure)
            },
            accepted: { current: false },
            hooks: hooksFor(events)
        })
        await Promise.resolve()
        hint.resolve({ data: { serviceName: 'bakery-web', open: true } })
        await run
        expect(events).toEqual([
            ['name', 'bakery-web'],
            ['code', EXPIRED]
        ])
    })
})
