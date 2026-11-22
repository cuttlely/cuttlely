import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, mock, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-lease-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { saveHarness } = await import('./store.mjs')
const { runHarness, runHooks } = await import('./run.mjs')
const { database, acquireTurn, releaseTurn, closeQueueDb, BUSY_MESSAGE } = await import('./lock.mjs')
const { closeSessions, sessionKey } = await import('./session.mjs')
const { stopGateway } = await import('./gateway.mjs')
// Profile compilation asks for a gateway URL; this fixture uses fetchImpl only.
// Substitute listen so no server or socket is started by that registration.
const listener = mock.method(http.Server.prototype, 'listen', function () {
    return this
})
after(() => {
    stopGateway()
    listener.mock.restore()
    closeQueueDb()
    closeSessions()
    fs.rmSync(dir, { recursive: true, force: true })
})

const deferred = () => {
    let resolve
    const promise = new Promise((done) => (resolve = done))
    return { promise, resolve }
}
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

for (const exit of ['finish', 'failure', 'cancel', 'run timeout']) {
    test(`${exit} deletes the turn row and stops all renewal writes`, async (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 })
        process.env.CUTTLELY_HARNESS_LOCK_MS = '3000'
        t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
        const name = `lease-${exit.replaceAll(' ', '-')}`
        saveHarness({ name, chief: { model: { nodeName: 'fixtureChat' } }, specialists: [{ name: 'writer', modules: [] }] })
        const key = sessionKey(name, 'same')
        const row = () => database().prepare('SELECT * FROM turns WHERE session_key = ?').get(key)
        const prepare = t.mock.method(database(), 'prepare')
        const writes = () => prepare.mock.calls.filter((call) => call.arguments[0].startsWith('UPDATE turns SET')).length
        const entered = deferred()
        const answer = deferred()
        const stopping = deferred()
        const cleanup = deferred()
        const controller = new AbortController()
        const turn = runHarness({
            mode: 'agent',
            name,
            chatId: 'same',
            input: 'Wait.',
            budgetMs: 0,
            timeoutMs: 3000,
            signal: controller.signal,
            flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
            fetchImpl: async (url, options) => {
                if (url.endsWith('/stop')) {
                    stopping.resolve()
                    await cleanup.promise
                    return json({})
                }
                if (url.endsWith('/events')) {
                    entered.resolve()
                    await new Promise((resolve, reject) => {
                        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                        options.signal.addEventListener('abort', abort, { once: true })
                        answer.promise.then(() => {
                            options.signal.removeEventListener('abort', abort)
                            resolve()
                        })
                    })
                    return new Response('', { headers: { 'content-type': 'text/event-stream' } })
                }
                if (options.method === 'POST') return json({ run_id: 'fixture-run', status: 'running' })
                return json(
                    exit === 'failure' ? { status: 'failed', error: 'Fixture failed.' } : { status: 'completed', output: 'Finished.' }
                )
            }
        })
        // Attach rejection handling before advancing a timeout or cancellation.
        const result = turn.then(
            (value) => ({ value }),
            (error) => ({ error })
        )
        await entered.promise
        const original = row().expires_at
        t.mock.timers.tick(1000)
        assert.ok(row().expires_at > original)
        assert.equal(writes(), 1)
        await assert.rejects(
            runHarness({
                name,
                chatId: 'same',
                input: 'Second message.',
                flowOptions: {
                    appDataSource: {},
                    harnessCaller: { via: 'session' }
                }
            }),
            { code: 'busy', message: BUSY_MESSAGE }
        )
        if (exit === 'cancel') controller.abort()
        else if (exit === 'run timeout') t.mock.timers.tick(2000)
        else answer.resolve()
        if (exit === 'cancel' || exit === 'run timeout') {
            await stopping.promise
            // Cleanup is still pending: abort/deadline must already have stopped the timer.
            const before = writes()
            const expiry = row().expires_at
            t.mock.timers.tick(10000)
            assert.equal(writes(), before)
            assert.equal(row().expires_at, expiry)
            cleanup.resolve()
        }
        const outcome = await result
        if (exit === 'finish') assert.equal(outcome.value.text, 'Finished.')
        else assert.equal(outcome.error?.code, { failure: 'chief_failed', cancel: 'aborted', 'run timeout': 'run_timeout' }[exit])
        assert.equal(row(), undefined)
        const before = writes()
        t.mock.timers.tick(10000)
        assert.equal(row(), undefined)
        assert.equal(writes(), before)
        const next = acquireTurn(name, 'same')
        releaseTurn(next)
    })
}

for (const limits of [
    { budgetMs: 1500, timeoutMs: 0 },
    { budgetMs: 0, timeoutMs: 1500 }
]) {
    test(`hung pre-run work cannot renew past budget=${limits.budgetMs}, run timeout=${limits.timeoutMs}`, async (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 })
        process.env.CUTTLELY_HARNESS_LOCK_MS = '3000'
        t.after(() => {
            delete process.env.CUTTLELY_HARNESS_LOCK_MS
            runHooks.afterProfile = null
        })
        const name = `hung-${limits.budgetMs}`
        saveHarness({ name, chief: { model: { nodeName: 'fixtureChat' } }, specialists: [{ name: 'writer', modules: [] }] })
        const entered = deferred()
        const finish = deferred()
        runHooks.afterProfile = async () => {
            entered.resolve()
            await finish.promise
            throw new Error('Fixture cleanup')
        }
        const turn = runHarness({
            name,
            chatId: 'same',
            input: 'Wait.',
            ...limits,
            flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } }
        }).catch((error) => error)
        await entered.promise
        t.mock.timers.tick(1000)
        const row = () => database().prepare('SELECT expires_at FROM turns WHERE session_key = ?').get(sessionKey(name, 'same'))
        const expiry = row().expires_at
        t.mock.timers.tick(10000)
        assert.equal(row().expires_at, expiry)
        finish.resolve()
        assert.match((await turn).message, /Fixture cleanup/)
        assert.equal(row(), undefined)
    })
}
