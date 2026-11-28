// Two independently connected clients contend on the same route budget in a disposable database.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const server = createRequire(path.join(__dirname, '../packages/server/package.json'))
server('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'commonjs', target: 'ES2022' } })

test('named harness admission is atomic across PostgreSQL pools and survives reconnection', async (t) => {
    const { createTestDatabase, skipReason } = await import('../packages/etl/check/pg-source.mjs')
    if (skipReason) return t.skip(skipReason)
    const db = await createTestDatabase()
    const { DataSource } = server('typeorm')
    const { HarnessRequestWindows1801500000000: Migration } = server(
        './src/database/migrations/postgres/1801500000000-HarnessRequestWindows.ts'
    )
    const { claimHarnessRequest: claim } = server('./src/services/harnesses/sharedRateLimit.ts')
    const connect = () =>
        new DataSource({
            type: 'postgres',
            ...db.connection,
            username: db.connection.user,
            migrations: [Migration],
            extra: { max: 2 }
        }).initialize()
    const clients = []
    try {
        clients.push(await connect())
        clients.push(await connect())
        const [first, second] = clients
        const pids = await Promise.all(clients.map((client) => client.query('SELECT pg_backend_pid() AS pid')))
        assert.notEqual(pids[0][0].pid, pids[1][0].pid)
        assert.equal((await first.runMigrations()).length, 1)
        // Allow time for both small bursts in the same genuine database-clock minute.
        const [{ seconds }] = await first.query('SELECT extract(second FROM clock_timestamp())::float8 AS seconds')
        if (seconds >= 40) await delay(Math.ceil((60 - seconds) * 1000) + 50)
        const burst = await Promise.all(Array.from({ length: 32 }, (_, i) => claim(clients[i % 2], 'start', 'key:a', 8)))
        const admitted = burst.filter((answer) => answer.accepted)
        assert.deepEqual(
            admitted.map((x) => x.remaining).sort((a, b) => a - b),
            [0, 1, 2, 3, 4, 5, 6, 7]
        )
        assert.equal(burst.filter((answer) => !answer.accepted && answer.remaining === 0).length, 24)
        assert.ok(burst.every((answer) => Number.isInteger(answer.resetSeconds) && answer.resetSeconds >= 1 && answer.resetSeconds <= 60))
        assert.equal((await claim(second, 'read', 'key:a', 8)).remaining, 7)
        assert.equal((await claim(second, 'start', 'key:b', 8)).remaining, 7)
        assert.equal((await claim(second, 'start', 'user:a', 8)).remaining, 7)
        await second.destroy()
        const replacement = await connect()
        clients.push(replacement)
        assert.equal((await claim(replacement, 'start', 'key:a', 8)).accepted, false)
        const [row] = await first.query('SELECT hits FROM harness_request_window WHERE kind=$1 AND caller=$2', [
            'start',
            createHash('sha256').update('key:a').digest()
        ])
        assert.equal(row.hits, 8)
        await first.query(`INSERT INTO harness_request_window (minute,kind,caller,hits)
            SELECT 0, 'read', convert_to(n::text, 'UTF8'), 1 FROM generate_series(1,65) n`)
        const oldRows = async () => (await first.query('SELECT count(*)::int AS n FROM harness_request_window WHERE minute=0'))[0].n
        assert.equal((await claim(first, 'read', 'key:b', 8)).accepted, true)
        assert.equal(await oldRows(), 33)
        await Promise.all(clients.filter((c) => c.isInitialized).map((c) => claim(c, 'read', 'key:b', 8)))
        assert.equal(await oldRows(), 0)
        await first.undoLastMigration()
        await assert.rejects(claim(replacement, 'start', 'key:a', 8))
        assert.equal((await first.runMigrations()).length, 1)
        assert.equal((await claim(replacement, 'start', 'key:a', 8)).remaining, 7)
        await assert.rejects(claim({ options: { type: 'sqlite' } }, 'start', 'key:a', 8), /require PostgreSQL/)
    } finally {
        await Promise.all(clients.filter((client) => client.isInitialized).map((client) => client.destroy()))
        await db.cleanup()
    }
})
