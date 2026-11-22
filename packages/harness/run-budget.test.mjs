import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-budget-output-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { saveHarness } = await import('./store.mjs')
const { runHarness } = await import('./run.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const source = 'RAW_PREREQUISITE: retrieved working material, not a finished deliverable.'
const independent = 'Independent completed result.'
const final = 'Requested final deliverable.'

async function waitForAbort(signal) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000)
        const abort = () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
    })
}

async function run({ extra = false, handoffTimeout = false }) {
    const name = `budget-output-${extra}-${handoffTimeout}`
    const steps = [{ specialist: 'source', task: 'Retrieve the supplied source material.' }]
    if (extra) steps.push({ specialist: 'independent', task: 'Return the separate requested answer.' })
    steps.push({ specialist: 'deliverable', task: 'Build the requested deliverable from the source.', after: 'source' })
    saveHarness({
        name,
        chief: { model: { nodeName: 'fixtureChat', inputs: {} } },
        specialists: [
            { name: 'source', instructions: 'SOURCE_ONLY', modules: [] },
            { name: 'deliverable', instructions: 'FINAL_WORK', modules: [] },
            ...(extra ? [{ name: 'independent', instructions: 'INDEPENDENT_WORK', modules: [] }] : [])
        ]
    })
    return runHarness({
        name,
        chatId: 'fixture-chat',
        input: 'Create the requested deliverable, and return any separately requested independent answer.',
        budgetMs: 300,
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages, options) => {
                            const system = String(messages[0]?.content)
                            if (system.includes('You route work')) return { content: JSON.stringify({ steps }) }
                            if (system.includes('Your specialists already did the work')) {
                                await waitForAbort(options?.signal)
                                return { content: 'late handoff' }
                            }
                            if (system.includes('SOURCE_ONLY')) return { content: source }
                            if (system.includes('INDEPENDENT_WORK')) return { content: independent }
                            if (system.includes('FINAL_WORK')) {
                                if (!handoffTimeout) await waitForAbort(options?.signal)
                                return { content: final }
                            }
                            throw new Error('Unexpected fixture model call')
                        }
                    }
                }
            }
    })
}

for (const extra of [false, true]) {
    test(`timed-out dependent work does not deliver its prerequisite${extra ? '; independent work survives' : ''}`, async () => {
        const result = await run({ extra })
        assert.equal(result.agents.find((a) => a.name === 'source')?.status, 'completed')
        assert.equal(result.agents.find((a) => a.name === 'deliverable')?.status, 'failed')
        assert.ok(!result.text.includes('RAW_PREREQUISITE'))
        if (extra) assert.equal(result.text, independent)
        else assert.match(result.text, /time budget.*final work/)
    })
}

test('a handoff timeout preserves the completed final result without duplicating its source', async () => {
    const result = await run({ handoffTimeout: true })
    assert.ok(result.agents.every((a) => a.status === 'completed'))
    assert.equal(result.text, final)
})

const { acquireTurn, releaseTurn, closeQueueDb } = await import('./lock.mjs')
after(closeQueueDb)

test('a slow turn renews past its original expiry and clears its unref timer on release', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '3000'
    const timers = []
    const set = globalThis.setTimeout
    const clear = t.mock.method(globalThis, 'clearTimeout')
    t.mock.method(globalThis, 'setTimeout', (...args) => {
        const timer = set(...args)
        if (args[1] === 1000) {
            t.mock.method(timer, 'unref')
            timers.push(timer)
        }
        return timer
    })
    saveHarness({
        name: 'slow-lease',
        chief: { model: { nodeName: 'fixtureChat' } },
        specialists: [{ name: 'writer', instructions: 'Write.', modules: [] }]
    })
    let finish
    let entered
    const ready = new Promise((resolve) => (entered = resolve))
    const gate = new Promise((resolve) => (finish = resolve))
    const turn = runHarness({
        name: 'slow-lease',
        chatId: 'same',
        input: 'Wait.',
        budgetMs: 0,
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => {
                            entered()
                            await gate
                            return {
                                content: String(messages[0]?.content).includes('You route work')
                                    ? JSON.stringify({ steps: [{ specialist: 'writer', task: 'Write.' }] })
                                    : 'Finished.'
                            }
                        }
                    }
                }
            }
    })
    await ready
    for (let i = 0; i < 5; i++) t.mock.timers.tick(1000)
    assert.throws(() => acquireTurn('slow-lease', 'same'), { code: 'busy' })
    assert.ok(timers.length >= 5)
    assert.equal(timers.at(-1).unref.mock.callCount(), 1)
    finish()
    await turn
    assert.ok(clear.mock.calls.some((call) => call.arguments[0] === timers.at(-1)))
    const count = timers.length
    t.mock.timers.tick(10000)
    assert.equal(timers.length, count)
    const next = acquireTurn('slow-lease', 'same')
    releaseTurn(next)
})
