import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createTestDatabase, skipReason } from '../etl/check/pg-source.mjs'
import { configureHarnessPostgres } from './side-store-postgres.mjs'
import { beginGuardedQueryTurns, VERIFIED_QUERY_POLICY } from './verified-query-output.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lock-'))
process.env.CUTTLELY_DATA_DIR = dir
const { acquireTurn, releaseTurn, renewTurn, database, closeQueueDb, startTurnRenewal, BUSY_MESSAGE } = await import('./lock.mjs')
after(() => {
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})
const lease = (held) => database().prepare('SELECT expires_at FROM turns WHERE session_key = ?').get(held.key)?.expires_at

for (const backend of ['sqlite', 'postgres']) {
    test(
        `replacing an expired lease detaches the prior guarded query on ${backend}`,
        { skip: backend === 'postgres' && skipReason },
        async (t) => {
            if (backend === 'postgres') {
                const fixture = await createTestDatabase()
                closeQueueDb()
                configureHarnessPostgres(fixture.connection)
                t.after(async () => {
                    closeQueueDb()
                    configureHarnessPostgres(null)
                    await fixture.cleanup()
                })
            }
            const held = acquireTurn('lease', 'guarded')
            const role = { profileName: 'guarded-profile', trustedOutputPolicy: VERIFIED_QUERY_POLICY }
            beginGuardedQueryTurns([role], 'guarded', 'previous', held.key)
            const stored = database().prepare('SELECT session_key FROM guarded_query_turns WHERE profile = ? AND source_turn = ?')
            const previous = () => stored.get(role.profileName, 'guarded-profile:guarded#turn-previous').session_key
            assert.equal(previous(), held.key)
            database().prepare('UPDATE turns SET expires_at = 0 WHERE session_key = ?').run(held.key)
            const replacement = acquireTurn('lease', 'guarded')
            try {
                assert.notEqual(replacement.owner, held.owner)
                assert.equal(previous(), null)
            } finally {
                releaseTurn(replacement)
            }
        }
    )
}

test('renewal extends only its owner, reads the live TTL, and ignores released rows', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '300'
    const held = acquireTurn('lease', 'owner')
    const original = lease(held)
    t.mock.timers.tick(100)
    renewTurn({ ...held, owner: 'other' })
    assert.equal(lease(held), original)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '600'
    renewTurn(held)
    assert.equal(lease(held), Date.now() + 600)
    releaseTurn(held)
    renewTurn(held)
    assert.equal(lease(held), undefined)
})

test('a short live lease renews and follows changes to and from never expires', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '1000'
    const held = acquireTurn('lease', 'live-change')
    const stop = startTurnRenewal(held)
    try {
        t.mock.timers.tick(333)
        assert.equal(lease(held), Date.now() + 1000)
        process.env.CUTTLELY_HARNESS_LOCK_MS = '0'
        t.mock.timers.tick(333)
        assert.equal(lease(held), Number.MAX_SAFE_INTEGER)
        assert.throws(() => acquireTurn('lease', 'live-change'), { code: 'busy' })
        process.env.CUTTLELY_HARNESS_LOCK_MS = '4000'
        t.mock.timers.tick(1000)
        assert.equal(lease(held), Date.now() + 4000)
    } finally {
        stop()
        releaseTurn(held)
    }
})

test('a zero TTL never expires and renewal makes no write', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '0'
    const held = acquireTurn('lease', 'unlimited')
    const original = lease(held)
    t.mock.timers.tick(86400000)
    renewTurn(held)
    assert.equal(lease(held), original)
    assert.throws(() => acquireTurn('lease', 'unlimited'), { code: 'busy' })
    releaseTurn(held)
})

for (const exit of ['abort', 'deadline', 'stop']) {
    test(`renewal stops on ${exit} even when the work has not settled`, (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 })
        t.mock.method(performance, 'now', () => Date.now())
        process.env.CUTTLELY_HARNESS_LOCK_MS = '3000'
        t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
        const held = acquireTurn('lease', exit)
        const controller = new AbortController()
        const stop = startTurnRenewal(held, { signal: controller.signal, deadlineMs: exit === 'deadline' ? 1500 : 0 })
        t.mock.timers.tick(1000)
        assert.equal(lease(held), Date.now() + 3000)
        if (exit === 'abort') controller.abort()
        else if (exit === 'stop') stop()
        else t.mock.timers.tick(500)
        const expiry = lease(held)
        t.mock.timers.tick(10000)
        assert.equal(lease(held), expiry)
        const next = acquireTurn('lease', exit)
        // Finally from an obsolete holder cannot release the replacement.
        releaseTurn(held)
        assert.notEqual(lease(next), undefined)
        releaseTurn(next)
        stop()
    })
}

function child(t, mode, chat) {
    const process = fork(new URL('./fixtures/lock-holder.mjs', import.meta.url), [mode, chat], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    const waiters = []
    let stderr = ''
    process.stderr.on('data', (data) => (stderr += data))
    process.on('message', (message) => {
        if (waiters.length) waiters.shift()(message)
        else messages.push(message)
    })
    const exited = once(process, 'exit')
    t.after(async () => {
        if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
        await exited
    })
    return {
        process,
        exited,
        next: () => {
            if (messages.length) return Promise.resolve(messages.shift())
            return Promise.race([
                new Promise((resolve) => waiters.push(resolve)),
                exited.then(() => {
                    throw new Error(`Lease fixture exited: ${stderr}`)
                })
            ])
        }
    }
}

for (const restart of [false, true]) {
    test(
        `SIGKILL releases a renewed lease within one lease for ${restart ? 'a fresh process' : 'the existing process'}`,
        { timeout: 10000 },
        async (t) => {
            process.env.CUTTLELY_HARNESS_LOCK_MS = '1500'
            t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
            const chat = `kill-${restart}`
            const holder = child(t, 'hold', chat)
            const initial = await holder.next()
            assert.equal(initial.type, 'held')
            const renewed = await holder.next()
            assert.equal(renewed.type, 'renewed')
            assert.ok(renewed.expires_at > initial.expires_at)
            // Kill between renewals, leaving room for polling inside the next lease.
            await new Promise((resolve) => setTimeout(resolve, 100))
            const killedAt = Date.now()
            holder.process.kill('SIGKILL')
            assert.deepEqual(await holder.exited, [null, 'SIGKILL'])
            assert.throws(() => acquireTurn('crash-lease', chat), { code: 'busy', message: BUSY_MESSAGE })
            let fresh
            if (restart) {
                fresh = child(t, 'acquire', chat)
                const opened = await fresh.next()
                assert.equal(opened.type, 'opened')
                assert.deepEqual(
                    opened.rows.find((row) => row.session_key === renewed.session_key),
                    {
                        session_key: renewed.session_key,
                        owner: renewed.owner,
                        expires_at: renewed.expires_at
                    }
                )
            }
            const attempt = async () => {
                if (fresh) {
                    fresh.process.send('acquire')
                    return fresh.next()
                }
                try {
                    const held = acquireTurn('crash-lease', chat)
                    releaseTurn(held)
                    return { acquired: true, at: Date.now() }
                } catch (error) {
                    return { code: error.code, message: error.message, at: Date.now() }
                }
            }
            const before = await attempt()
            assert.equal(before.code, 'busy')
            assert.equal(before.message, BUSY_MESSAGE)
            assert.ok(before.at < renewed.expires_at)
            let result
            do {
                result = await attempt()
                if (result.acquired) break
                assert.equal(result.code, 'busy')
                assert.ok(Date.now() - killedAt < 1500, 'lease stayed busy after one lease')
                await new Promise((resolve) => setTimeout(resolve, 15))
            } while (true)
            assert.ok(result.at >= renewed.expires_at, 'acquired before the live lease expired')
            assert.ok(result.at - killedAt <= 1500)
            assert.equal(database().prepare('SELECT 1 FROM turns WHERE session_key = ?').get(renewed.session_key), undefined)
        }
    )
}
