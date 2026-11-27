import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createTestDatabase, skipReason } from '../etl/check/pg-source.mjs'
import { configureHarnessPostgres } from './side-store-postgres.mjs'
import { beginGuardedQueryTurns, VERIFIED_QUERY_POLICY } from './verified-query-output.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lock-'))
process.env.CUTTLELY_DATA_DIR = dir
const { acquireTurn, releaseTurn, renewTurn, database, immediate, closeQueueDb, startTurnRenewal, BUSY_MESSAGE } = await import(
    './lock.mjs'
)
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

test('PostgreSQL shares only fixed single-lease writes and preserves the raw and admission fences', { skip: skipReason }, async () => {
    const fixture = await createTestDatabase()
    const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
    const writer = new Client(fixture.connection)
    const name = 'lease-fence'
    const lockTimeout = { code: '55P03' }
    const schema = 'cuttlely_harness_queue'
    try {
        await writer.connect()
        closeQueueDb()
        configureHarnessPostgres({
            ...fixture.connection,
            options: '-c default_transaction_isolation=repeatable\\ read',
            lock_timeout: 300
        })
        const db = database()
        const { enqueueHarnessJob } = await import('./queue.mjs')
        const enqueue = (chatId) => enqueueHarnessJob({ name, chatId, input: 'fixture' })
        await writer.query('BEGIN')
        await writer.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [schema])
        const held = acquireTurn(name, 'open')
        renewTurn(held)
        releaseTurn(held)
        // The exact same statement submitted through the general adapter still waits for exclusivity.
        const rawInsert = 'INSERT INTO turns (session_key, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_key) DO NOTHING'
        assert.throws(() => db.prepare(rawInsert).run(name + ':raw', 'raw', 1), lockTimeout)
        assert.throws(() => db.exec('BEGIN'), lockTimeout)
        assert.throws(() => enqueue('open'), lockTimeout)
        await writer.query('ROLLBACK')
        assert.throws(() => db.writeTurnLease('unknown', []))
        const failure = new Error('rollback fixture')
        assert.throws(
            () =>
                immediate(() => {
                    acquireTurn(name, 'rollback')
                    throw failure
                }),
            (error) => error === failure
        )
        releaseTurn(acquireTurn(name, 'rollback'))

        const first = acquireTurn(name, 'raw-owner')
        await writer.query('BEGIN')
        await writer.query('SELECT 1 FROM cuttlely_harness_queue.turns WHERE session_key = $1 FOR UPDATE', [first.key])
        assert.throws(() => releaseTurn(first), lockTimeout)
        await writer.query('ROLLBACK')
        assert.throws(() => enqueue('raw-owner'), { code: 'busy' })
        releaseTurn(first)
        assert.ok(enqueue('raw-owner').id)

        await writer.query('BEGIN')
        await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
        assert.throws(() => acquireTurn(name, 'exclusive'), lockTimeout)
        await writer.query('ROLLBACK')
        releaseTurn(acquireTurn(name, 'exclusive'))
    } finally {
        await writer.end().catch(() => {})
        closeQueueDb()
        configureHarnessPostgres(undefined)
        await fixture.cleanup()
    }
})

test('a PostgreSQL job claim sees a contended admission and rolls back an invalid result', { skip: skipReason }, async () => {
    const fixture = await createTestDatabase()
    const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
    const writer = new Client(fixture.connection)
    try {
        await writer.connect()
        closeQueueDb()
        configureHarnessPostgres({ ...fixture.connection, options: '-c default_transaction_isolation=repeatable\\ read' })
        const db = database()
        const { claimJob } = await import('./queue.mjs')
        await writer.query('BEGIN')
        await writer.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_harness_queue'))")
        await writer.query(`INSERT INTO cuttlely_harness_queue.jobs(id,session_key,status,payload,created_at,updated_at)
                            VALUES ('pending','team:chat','queued','{}',1,1)`)
        // The independent writer commits only after PostgreSQL reports the claimant waiting on its lock.
        const commit = writer.query(`DO $$ BEGIN
            FOR attempt IN 1..300 LOOP
                IF EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                           AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) THEN RETURN; END IF;
                PERFORM pg_sleep(0.01);
            END LOOP;
            RAISE EXCEPTION 'Job claimant never reached the admission fence';
        END $$; COMMIT`)
        try {
            assert.deepEqual(claimJob(), { id: 'pending', payload: {}, cancelRequested: false })
        } finally {
            await commit
        }
        assert.equal(claimJob(), null)

        await writer.query("UPDATE cuttlely_harness_queue.jobs SET status = 'queued' WHERE id = 'pending'")
        const rollback = new Error('roll back enclosing operation')
        assert.throws(
            () =>
                immediate(() => {
                    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run('{"stage":1}', 'pending')
                    assert.deepEqual(claimJob(), { id: 'pending', payload: { stage: 1 }, cancelRequested: false })
                    assert.equal(claimJob(), null)
                    throw rollback
                }),
            (error) => error === rollback
        )
        assert.deepEqual(claimJob(), { id: 'pending', payload: {}, cancelRequested: false })

        await writer.query(
            "UPDATE cuttlely_harness_queue.jobs SET status = 'queued', cancel_requested = 9007199254740992 WHERE id = 'pending'"
        )
        assert.throws(() => claimJob(), /Harness PostgreSQL operation failed/)
        const result = await writer.query("SELECT status FROM cuttlely_harness_queue.jobs WHERE id = 'pending'")
        assert.equal(result.rows[0].status, 'queued')
    } finally {
        await writer.end().catch(() => {})
        closeQueueDb()
        configureHarnessPostgres(undefined)
        await fixture.cleanup()
    }
})

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
