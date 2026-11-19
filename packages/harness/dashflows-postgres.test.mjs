// Dash Flows on the application database's Postgres (#516): boot copy, verify, rollback and refusals.
// The Postgres cases need a disposable server (CI: CUTTLELY_TEST_PG_REQUIRED=1); the switch-off and
// non-Postgres cases run everywhere.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { after, before, mock, test } from 'node:test'
import { compilePinned } from './runtime/pinned-query.mjs'
import { DASH_STORE_MID_MOVE, appDatabaseStoresOn, dashStore, openSqliteDashStore, setDashStore } from './dashflows.mjs'
import { copyDashStoreToAppDb, initDashStore } from './dashflows-postgres.mjs'
import { adminConfig, adminQuery, freshDatabase, pgSkip, poolSource } from './test/dashflows-pg.mjs'

const SNAPSHOT_TEXT = 'zz-snapshot-row-text'
const pin = {
    id: 'sample-pin',
    name: 'pq_monthly',
    version: 1,
    sql: 'SELECT region, amount FROM demo_totals WHERE month = :month LIMIT 100',
    params: [{ name: 'month', type: 'date', required: true }],
    testedStamp: 'synthetic-test-stamp',
    testedColumns: [
        { name: 'region', type: 'text' },
        { name: 'amount', type: 'numeric' }
    ]
}
const card = {
    id: 'card-1',
    title: 'Regional amount',
    kind: 'bar',
    source: 'analyst:0:sample-pin',
    hash: compilePinned(pin).statementHash,
    params: { month: '2026-10-01' },
    scope: 'October 2026 / all regions',
    valueField: 'amount',
    labelField: 'region',
    x: 0,
    y: 0
}
const weekly = (title) => ({ title, harness: 'synthetic-contract', intervalSeconds: 604800, cards: [card] })
const onDemand = (title) => ({ title, harness: 'synthetic-contract', intervalSeconds: 0, cards: [card] })
const snapshot = (id) => ({ id, cards: [{ cardId: card.id, rows: [{ region: SNAPSHOT_TEXT, amount: '1' }] }] })

const allLogs = []
const capture = () => {
    const lines = []
    const errors = []
    const push = (line) => {
        lines.push(line)
        allLogs.push(line)
    }
    const error = (line) => {
        errors.push(line)
        push(line)
    }
    return { lines, errors, log: { info: push, warn: push, error } }
}
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dashflow-move-')), 'dashflows.sqlite')
const digestFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// Four dashboards: a weekly public one, a private published one, one whose last refresh failed,
// and a weekly one that is already due. The public one has two report slots.
async function seed(file) {
    const store = openSqliteDashStore(file)
    const ids = {}
    const publicBoard = await store.save(null, 'team-a', 'owner-1', weekly('Public weekly'))
    await store.settle(publicBoard.id, 'team-a', await store.claim(publicBoard.id, 'team-a'), snapshot('public'), null)
    const { publicToken } = await store.publish(publicBoard.id, 'team-a', publicBoard.revision, true)
    ids.public = publicBoard.id
    const privateBoard = await store.save(null, 'team-a', 'owner-1', onDemand('Private'))
    await store.settle(privateBoard.id, 'team-a', await store.claim(privateBoard.id, 'team-a'), snapshot('private'), null)
    await store.publish(privateBoard.id, 'team-a', privateBoard.revision)
    ids.private = privateBoard.id
    const failed = await store.save(null, 'team-a', 'owner-2', onDemand('Failed last refresh'))
    await store.settle(failed.id, 'team-a', await store.claim(failed.id, 'team-a'), snapshot('kept'), null)
    await store.settle(failed.id, 'team-a', await store.claim(failed.id, 'team-a'), null, 'Source unavailable')
    ids.failed = failed.id
    const due = await store.save(null, 'team-b', 'owner-3', weekly('Due weekly'))
    await store.settle(due.id, 'team-b', await store.claim(due.id, 'team-b'), snapshot('due'), null)
    ids.due = due.id
    for (let i = 0; i < 2; i++) await store.attachPublicReport(await store.reservePublicReport(publicToken), `run-${i}`)
    await store
        .queryCache(publicBoard.id, 'team-a')
        .then((cache) => cache.put('cached', { raw: { rows: [] }, fetchedAt: new Date().toISOString() }))
    store.close()
    publicTokens.push(publicToken)
    const db = new DatabaseSync(file)
    db.prepare('UPDATE dash_flow SET next_refresh=? WHERE id=?').run(Date.now() - 60000, due.id)
    db.close()
    return { ids, publicToken }
}

const publicTokens = []
// Everything a user or API caller can read, for before/after equality.
async function readsOf(file, seeded) {
    const store = openSqliteDashStore(file)
    try {
        return await reads(store, seeded)
    } finally {
        store.close()
    }
}
async function reads(store, { ids, publicToken }) {
    const out = { lists: {}, get: {}, status: {}, published: {} }
    for (const ws of ['team-a', 'team-b']) out.lists[ws] = await store.list(ws)
    for (const [name, id] of Object.entries(ids)) {
        const ws = name === 'due' ? 'team-b' : 'team-a'
        out.get[name] = await store.get(id, ws)
        out.status[name] = await store.status(id, ws)
        out.published[name] = await store.published(id, ws).catch((error) => `${error.status} ${error.message}`)
    }
    out.publicView = await store.publicView(publicToken)
    out.reports = [await store.hasPublicReport(publicToken, 'run-0'), await store.hasPublicReport(publicToken, 'run-1')]
    return out
}

// A source that records every call and must not be used.
const untouchedSource = (dialect) => {
    const calls = []
    const record = (name) => async () => {
        calls.push(name)
        throw new Error('must not be called')
    }
    return { calls, source: { dialect, query: record('query'), transaction: record('transaction') } }
}

test('AC1 switch off: same file and reads, and the Postgres source is never called', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const before = await readsOf(file, seeded)
    const hash = digestFile(file)
    const { calls, source } = untouchedSource('postgres')
    const { lines, log } = capture()
    for (const value of [undefined, '', '0', 'false', 'yes', 'TRUE']) {
        const enabled = appDatabaseStoresOn({ CUTTLELY_APP_DATABASE_STORES: value })
        const result = await initDashStore({ file, source, enabled, log })
        assert.deepEqual(result, { backend: 'sqlite', outcome: 'unchanged' })
    }
    assert.deepEqual(calls, [])
    assert.deepEqual(lines, [])
    assert.equal(digestFile(file), hash)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    setDashStore(openSqliteDashStore(file))
    assert.deepEqual(await reads(dashStore(), seeded), before)
    setDashStore(null)
})

test('AC2 switch on but not Postgres: one info line, no copy, the same file', async () => {
    for (const dialect of ['sqlite', 'mysql', 'mariadb', null]) {
        const file = tempFile()
        await seed(file)
        const hash = digestFile(file)
        const { calls, source } = untouchedSource(dialect)
        const { lines, log } = capture()
        const result = await initDashStore({ file, source: dialect ? source : null, enabled: true, log })
        assert.deepEqual(result, { backend: 'sqlite', outcome: 'unchanged' })
        assert.deepEqual(lines, [
            'CUTTLELY_APP_DATABASE_STORES is ignored: the application database is not Postgres. Dash Flows stays on dashflows.sqlite.'
        ])
        assert.deepEqual(calls, [])
        assert.equal(digestFile(file), hash)
        assert.equal(fs.existsSync(`${file}.migrated`), false)
    }
})

test('the switch accepts only 1 or true', async () => {
    for (const value of ['1', 'true']) assert.equal(appDatabaseStoresOn({ CUTTLELY_APP_DATABASE_STORES: value }), true)
    for (const value of [undefined, '', '0', 'false', 'TRUE', 'yes', ' 1'])
        assert.equal(appDatabaseStoresOn({ CUTTLELY_APP_DATABASE_STORES: value }), false)
})

test('a writer lock held for the whole wait refuses the copy with the busy wording and touches nothing', async () => {
    const file = tempFile()
    await seed(file)
    const hash = digestFile(file)
    const writer = new DatabaseSync(file)
    writer.exec('BEGIN IMMEDIATE')
    const { calls, source } = untouchedSource('postgres')
    const { lines, log } = capture()
    try {
        const started = Date.now()
        assert.deepEqual(await copyDashStoreToAppDb(file, source, { log, waitMs: 200, pollMs: 50 }), { outcome: 'refused-lease' })
        assert.ok(Date.now() - started >= 200)
    } finally {
        writer.exec('ROLLBACK')
        writer.close()
    }
    assert.deepEqual(lines, [
        'Dash Flows storage move not started: dashflows.sqlite stayed locked by another writer for 2 minutes. Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start. If another Cuttlely instance shares this data directory, stop it first.'
    ])
    assert.deepEqual(calls, [])
    assert.equal(digestFile(file), hash)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
})

test('a moved-aside file without dashflows.sqlite answers 503 and never creates an empty file', async () => {
    const file = tempFile()
    await seed(file)
    fs.renameSync(file, `${file}.migrated`)
    const midMove = (error) => error.status === 503 && error.message === DASH_STORE_MID_MOVE
    setDashStore(null, file)
    try {
        assert.throws(() => dashStore(), midMove)
        assert.throws(() => openSqliteDashStore(file), midMove)
    } finally {
        setDashStore(null)
    }
    assert.equal(fs.existsSync(file), false)
    assert.equal(DASH_STORE_MID_MOVE, 'Dash Flows storage is mid-move; check the start log.')
})

// ---- Real Postgres ----
let database
let pg
before(async () => {
    if (pgSkip) return
    database = await freshDatabase('zz_dashflows_move')
    pg = poolSource(database.config)
})
after(async () => {
    setDashStore(null)
    await pg?.end()
    await database?.drop()
})
const reset = () => pg.source.query('DROP SCHEMA IF EXISTS cuttlely_dashflows CASCADE')
const pgRows = async (table) => pg.source.query(`SELECT * FROM cuttlely_dashflows.${table}`)
const marker = async () => {
    const [row] = await pg.source.query(`SELECT value FROM cuttlely_dashflows.dash_flow_store_meta WHERE key='copy'`)
    return row ? JSON.parse(row.value) : null
}
const schemaPresent = async () => (await pg.source.query(`SELECT to_regnamespace('cuttlely_dashflows') AS oid`))[0].oid !== null
const init = (file, log, options = {}) =>
    initDashStore({ file, source: pg.source, enabled: true, log, waitMs: 200, pollMs: 50, ...options })
const pgTest = (name, fn) =>
    test(name, { skip: pgSkip }, async () => {
        await reset()
        try {
            await fn()
        } finally {
            setDashStore(null)
        }
    })

pgTest('AC1 switch off on a Postgres host creates no schema', async () => {
    const file = tempFile()
    await seed(file)
    const { log } = capture()
    assert.deepEqual(await initDashStore({ file, source: pg.source, enabled: false, log }), { backend: 'sqlite', outcome: 'unchanged' })
    assert.equal(await schemaPresent(), false)
})

pgTest('AC3 AC11 the copy keeps every dashboard, list order, publication, public link, due time and last status', async () => {
    const saved = process.env.CUTTLELY_DASH_FLOWS
    delete process.env.CUTTLELY_DASH_FLOWS // The copy runs whether or not the BETA is on.
    try {
        const file = tempFile()
        const seeded = await seed(file)
        const before = await readsOf(file, seeded)
        const { lines, log } = capture()
        const result = await init(file, log)
        assert.deepEqual(result, { backend: 'postgres', outcome: 'copied' })
        assert.equal(dashStore().backend, 'postgres')
        assert.deepEqual(await reads(dashStore(), seeded), before)
        assert.equal((await pgRows('dash_flow')).length, 4)
        assert.equal((await pgRows('dash_flow_public_report')).length, 2)
        assert.equal((await pgRows('dash_flow_query_cache')).length, 0)
        assert.ok((await pgRows('dash_flow')).every((row) => row.lease === null && Number(row.lease_until) === 0))
        assert.deepEqual((await marker()).rows, { dash_flow: 4, dash_flow_refresh_status: 4, dash_flow_public_report: 2 })
        assert.equal(fs.existsSync(file), false)
        assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
        assert.equal(fs.existsSync(`${file}-wal`), false)
        assert.match(
            lines.at(-1),
            /^Dash Flows is in the application database \(dash_flow: 4 rows, dash_flow_refresh_status: 4 rows, dash_flow_public_report: 2 rows; digest [0-9a-f]{12}\)/
        )
    } finally {
        if (saved !== undefined) process.env.CUTTLELY_DASH_FLOWS = saved
    }
})

pgTest('AC4 AC8 writes land in Postgres, the moved file keeps its size and time, and a due weekly refresh runs once', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const { log } = capture()
    await init(file, log)
    const moved = fs.statSync(`${file}.migrated`)
    const store = dashStore()
    // Deferred, not dropped: the due weekly dashboard is due on the first tick after start, once.
    assert.deepEqual(
        (await store.due()).map((row) => row.id),
        [seeded.ids.due]
    )
    const claim = await store.claim(seeded.ids.due, 'team-b')
    await store.settle(seeded.ids.due, 'team-b', claim, snapshot('refreshed'), null)
    assert.deepEqual(await store.due(), [])
    const created = await store.save(null, 'team-a', 'owner-1', onDemand('Made after the move'))
    await store.save(seeded.ids.private, 'team-a', 'owner-1', onDemand('Edited after the move'), 1)
    await store.unpublish(seeded.ids.public, 'team-a')
    await store.settle(seeded.ids.failed, 'team-a', await store.claim(seeded.ids.failed, 'team-a'), snapshot('fresh'), null)
    await store.publish(seeded.ids.failed, 'team-a', 1)
    const rows = Object.fromEntries((await pgRows('dash_flow')).map((row) => [row.id, row]))
    assert.ok(rows[created.id])
    assert.equal(JSON.parse(rows[seeded.ids.private].definition).title, 'Edited after the move')
    assert.equal(rows[seeded.ids.public].published, null)
    assert.equal(JSON.parse(rows[seeded.ids.failed].published).snapshot.id, 'fresh')
    assert.equal(JSON.parse(rows[seeded.ids.due].snapshot).id, 'refreshed')
    assert.equal((await store.list('team-a'))[0].id, created.id)
    const after = fs.statSync(`${file}.migrated`)
    assert.equal(after.size, moved.size)
    assert.equal(after.mtimeMs, moved.mtimeMs)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(`${file}-wal`), false)
    assert.equal(fs.existsSync(`${file}-shm`), false)
})

pgTest('AC5 a second start copies nothing; a crash during the copy or before moving the file aside resumes cleanly', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const before = await readsOf(file, seeded)
    // Crash during the copy: the Postgres transaction rolls back and dashflows.sqlite is untouched.
    const hash = digestFile(file)
    const crashing = {
        ...pg.source,
        transaction: (work) =>
            pg.source.transaction((tx) =>
                work({
                    query: (sql, params) => {
                        if (sql.includes('INSERT INTO cuttlely_dashflows.dash_flow_public_report')) throw new Error('simulated kill')
                        return tx.query(sql, params)
                    }
                })
            )
    }
    const { lines, log } = capture()
    assert.deepEqual(await init(file, log, { source: crashing }), { backend: 'sqlite', outcome: 'failed' })
    assert.match(lines.at(-1), /^Dash Flows storage move failed \(Error\)\. Nothing was switched/)
    assert.equal(digestFile(file), hash)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    assert.equal(await schemaPresent(), false)
    assert.deepEqual((await init(file, log)).outcome, 'copied')
    assert.deepEqual(await reads(dashStore(), seeded), before)
    // A second start finds nothing to copy and keeps Postgres writes.
    const created = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Kept'))
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'nothing-to-copy' })
    assert.ok(await dashStore().get(created.id, 'team-a'))
    // Crash after the commit but before the file moved aside: only the move is redone, nothing is copied again.
    fs.chmodSync(`${file}.migrated`, 0o644)
    fs.renameSync(`${file}.migrated`, file)
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'already-copied' })
    assert.ok(await dashStore().get(created.id, 'team-a'))
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
})

pgTest('AC6 a live refresh lease refuses the copy and leaves nothing behind; the next start copies', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const sqlite = openSqliteDashStore(file)
    const claim = await sqlite.claim(seeded.ids.private, 'team-a')
    const { lines, log } = capture()
    const started = Date.now()
    assert.deepEqual(await init(file, log), { backend: 'sqlite', outcome: 'refused-lease' })
    assert.ok(Date.now() - started >= 200)
    assert.equal(
        lines.at(-1),
        `Dash Flows storage move not started: a dashboard refresh is still running after 2 minutes (dashboard ${seeded.ids.private}, workspace team-a). Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start. If another Cuttlely instance shares this data directory, stop it first.`
    )
    assert.equal(await schemaPresent(), false)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    // The refresh finishes on SQLite.
    await dashStore().settle(seeded.ids.private, 'team-a', claim, snapshot('finished-on-sqlite'), null)
    sqlite.close()
    assert.equal((await dashStore().get(seeded.ids.private, 'team-a')).snapshot.id, 'finished-on-sqlite')
    assert.equal((await init(file, log)).outcome, 'copied')
    assert.equal((await dashStore().get(seeded.ids.private, 'team-a')).snapshot.id, 'finished-on-sqlite')
})

pgTest('AC7 a failed verify switches nothing and every read is unchanged', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const before = await readsOf(file, seeded)
    const tampering = {
        ...pg.source,
        transaction: (work) =>
            pg.source.transaction((tx) =>
                work({
                    query: (sql, params) =>
                        tx.query(
                            sql,
                            sql.includes('INSERT INTO cuttlely_dashflows.dash_flow(')
                                ? params.map((v, i) => (i === 7 ? 'altered' : v))
                                : params
                        )
                })
            )
    }
    const { lines, log } = capture()
    assert.deepEqual(await init(file, log, { source: tampering }), { backend: 'sqlite', outcome: 'verify-failed' })
    assert.equal(
        lines.at(-1),
        'Dash Flows storage move failed verification (dash_flow: 4 rows in dashflows.sqlite, 4 copied). Nothing was switched; Dash Flows keeps using dashflows.sqlite.'
    )
    assert.equal(fs.existsSync(file), true)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    assert.equal(dashStore().backend, 'sqlite')
    assert.deepEqual(await reads(dashStore(), seeded), before)
    assert.equal(await schemaPresent(), false)
})

pgTest('AC9 switching off restores the data as it was at the copy; switching on again reuses the Postgres copy', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const before = await readsOf(file, seeded)
    const { lines, log } = capture()
    await init(file, log)
    const created = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved while on'))
    assert.deepEqual(await initDashStore({ file, source: pg.source, enabled: false, log }), { backend: 'sqlite', outcome: 'rolled-back' })
    assert.equal(
        lines.at(-1),
        'Dash Flows is back on dashflows.sqlite because CUTTLELY_APP_DATABASE_STORES is off. Changes made while it was on are still in the application database and were not copied back.'
    )
    assert.equal(fs.statSync(file).mode & 0o777, 0o644)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    assert.equal(dashStore().backend, 'sqlite')
    assert.deepEqual(await reads(dashStore(), seeded), before)
    await assert.rejects(dashStore().get(created.id, 'team-a'), /not found/)
    assert.ok((await pgRows('dash_flow')).some((row) => row.id === created.id))
    assert.ok((await marker()).rolledBackAt)
    // A save while off stays in dashflows.sqlite and is not carried forward.
    const offline = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved while off'))
    setDashStore(null)
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'reused' })
    assert.ok(
        lines.includes(
            'Dash Flows is using the copy already in the application database. Changes made in dashflows.sqlite while CUTTLELY_APP_DATABASE_STORES was off were not carried forward.'
        )
    )
    assert.ok(await dashStore().get(created.id, 'team-a'))
    await assert.rejects(dashStore().get(offline.id, 'team-a'), /not found/)
    assert.equal(fs.existsSync(file), false)
    assert.equal((await marker()).rolledBackAt, undefined)
})

pgTest(
    'switching on again after a switch-off when the move aside fails: the reused copy serves and the next start only finishes the move',
    async () => {
        const file = tempFile()
        await seed(file)
        const { lines, log } = capture()
        assert.equal((await init(file, log)).outcome, 'copied')
        const created = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved while on'))
        assert.equal((await initDashStore({ file, source: pg.source, enabled: false, log })).outcome, 'rolled-back')
        const offline = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved while off'))
        setDashStore(null)
        const real = fs.renameSync
        const blocked = mock.method(fs, 'renameSync', (from, to) => {
            if (String(to).endsWith('.migrated')) throw Object.assign(new Error('blocked'), { code: 'EACCES' })
            return real(from, to)
        })
        try {
            assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'reused' })
        } finally {
            blocked.mock.restore()
        }
        assert.equal(
            lines.at(-1),
            'Dash Flows is in the application database, but dashflows.sqlite could not be moved aside (EACCES). It was left in place and is not used; the move aside finishes at the next start.'
        )
        assert.equal(fs.existsSync(file), true)
        assert.ok(await dashStore().get(created.id, 'team-a'))
        await assert.rejects(dashStore().get(offline.id, 'team-a'), /not found/)
        // The marker now describes the reused file, and keeps the first copy's fingerprint.
        const reused = await marker()
        assert.equal(reused.rolledBackAt, undefined)
        assert.ok(reused.copiedDigest && reused.copiedDigest !== reused.sourceDigest)
        assert.equal(reused.reusedRows.dash_flow, 5)
        assert.equal(reused.rows.dash_flow, 4)
        // The next start only finishes the move aside; it neither refuses nor serves the off-period save.
        setDashStore(null)
        assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'already-copied' })
        assert.ok(await dashStore().get(created.id, 'team-a'))
        await assert.rejects(dashStore().get(offline.id, 'team-a'), /not found/)
        assert.equal(fs.existsSync(file), false)
        assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
        assert.ok(rowsIn(`${file}.migrated`).includes(offline.id))
    }
)

pgTest('both files present after a committed copy: neither is touched, Postgres is served and both names are logged', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const { lines, log } = capture()
    assert.equal((await init(file, log)).outcome, 'copied')
    const created = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved after the copy'))
    setDashStore(null)
    // A copy of the moved file is put back beside it, for example by hand.
    fs.copyFileSync(`${file}.migrated`, file)
    fs.chmodSync(file, 0o644)
    const live = digestFile(file)
    const moved = fs.statSync(`${file}.migrated`)
    const movedHash = digestFile(`${file}.migrated`)
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'already-copied' })
    assert.equal(
        lines.at(-1),
        'Dash Flows is in the application database. dashflows.sqlite and dashflows.sqlite.migrated both exist and were left in place; remove or rename one to finish the move.'
    )
    assert.equal(digestFile(file), live)
    assert.equal(fs.statSync(file).mode & 0o777, 0o644)
    assert.equal(digestFile(`${file}.migrated`), movedHash)
    assert.equal(fs.statSync(`${file}.migrated`).mtimeMs, moved.mtimeMs)
    assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
    assert.equal(dashStore().backend, 'postgres')
    assert.ok(await dashStore().get(created.id, 'team-a'))
    assert.ok(await dashStore().get(seeded.ids.private, 'team-a'))
})

// Rows in a moved-aside file, read from a scratch copy so the read-only file is never opened.
function rowsIn(migrated) {
    const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dashflow-check-')), 'copy.sqlite')
    fs.copyFileSync(migrated, scratch)
    const db = new DatabaseSync(scratch)
    try {
        return db
            .prepare('SELECT id FROM dash_flow ORDER BY id')
            .all()
            .map((row) => row.id)
    } finally {
        db.close()
    }
}

const READER = `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('BEGIN')
db.prepare('SELECT count(*) AS n FROM dash_flow').get()
process.stdout.write('ready\\n')
process.stdin.resume()
process.stdin.on('end', () => {
    db.exec('COMMIT')
    db.close()
    process.exit(0)
})`

pgTest('another process reading dashflows.sqlite during the move: the WAL is kept, nothing is moved aside, Postgres serves', async () => {
    const file = tempFile()
    await seed(file)
    const child = spawn(process.execPath, ['-e', READER, file], { stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise((resolve) => child.on('exit', resolve))
    try {
        await new Promise((resolve, reject) => {
            child.stdout.on('data', (chunk) => String(chunk).includes('ready') && resolve())
            child.on('exit', () => reject(new Error('reader exited early')))
        })
        // A commit after the reader's snapshot leaves frames the checkpoint cannot copy while it reads.
        const writer = openSqliteDashStore(file)
        const late = await writer.save(null, 'team-a', 'owner-1', onDemand('Written while another process reads'))
        writer.close()
        const { lines, log } = capture()
        assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'copied' })
        assert.equal(
            lines.at(-1),
            'Dash Flows is in the application database, but another process is still reading dashflows.sqlite, so its WAL checkpoint did not finish. dashflows.sqlite and its WAL were left as they are and are not used; the move aside finishes at the next start.'
        )
        assert.equal(fs.existsSync(file), true)
        assert.equal(fs.existsSync(`${file}-wal`), true)
        assert.equal(fs.existsSync(`${file}.migrated`), false)
        assert.equal(dashStore().backend, 'postgres')
        assert.ok(await dashStore().get(late.id, 'team-a'))
        setDashStore(null)
        child.stdin.end()
        await exited
        // With the reader gone, the next start only finishes the move, and the moved-aside file is whole.
        assert.equal((await init(file, log)).outcome, 'already-copied')
        assert.equal(fs.existsSync(file), false)
        assert.equal(fs.existsSync(`${file}-wal`), false)
        assert.deepEqual(rowsIn(`${file}.migrated`), (await pgRows('dash_flow')).map((row) => row.id).sort())
        assert.ok(rowsIn(`${file}.migrated`).includes(late.id))
    } finally {
        if (child.exitCode === null) child.kill()
    }
})

pgTest(
    'a failed move aside after the commit serves Postgres, says so, and the next start finishes it without dropping writes',
    async () => {
        const file = tempFile()
        await seed(file)
        const real = fs.renameSync
        const blocked = mock.method(fs, 'renameSync', (from, to) => {
            if (String(to).endsWith('.migrated')) throw Object.assign(new Error('blocked'), { code: 'EACCES' })
            return real(from, to)
        })
        const { lines, log } = capture()
        try {
            assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'copied' })
        } finally {
            blocked.mock.restore()
        }
        assert.equal(
            lines.at(-1),
            'Dash Flows is in the application database, but dashflows.sqlite could not be moved aside (EACCES). It was left in place and is not used; the move aside finishes at the next start.'
        )
        assert.ok(lines.every((line) => !line.includes('Nothing was switched')))
        assert.equal(fs.existsSync(file), true)
        assert.equal(fs.existsSync(`${file}.migrated`), false)
        assert.equal(dashStore().backend, 'postgres')
        const created = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Saved after the commit'))
        setDashStore(null)
        assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'already-copied' })
        assert.ok(await dashStore().get(created.id, 'team-a'))
        assert.equal(fs.existsSync(file), false)
        assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
    }
)

pgTest('a move aside that fails after the move itself says the file was moved, and Postgres serves', async () => {
    const file = tempFile()
    await seed(file)
    const real = fs.chmodSync
    const blocked = mock.method(fs, 'chmodSync', (target, mode) => {
        if (String(target).endsWith('.migrated')) throw Object.assign(new Error('blocked'), { code: 'EPERM' })
        return real(target, mode)
    })
    const { lines, log } = capture()
    try {
        assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'copied' })
    } finally {
        blocked.mock.restore()
    }
    assert.equal(
        lines.at(-1),
        'Dash Flows is in the application database. dashflows.sqlite was moved aside as dashflows.sqlite.migrated, but the move did not finish (EPERM): dashflows.sqlite.migrated may still be writable, and dashflows.sqlite-wal or dashflows.sqlite-shm may remain. Neither is used while CUTTLELY_APP_DATABASE_STORES stays on.'
    )
    assert.equal(fs.existsSync(file), false)
    assert.notEqual(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
    assert.equal(dashStore().backend, 'postgres')
})

pgTest('a difference with no recorded switch-off is refused and stays on SQLite, dropping neither side', async () => {
    const file = tempFile()
    const seeded = await seed(file)
    const { lines, errors, log } = capture()
    assert.equal((await init(file, log)).outcome, 'copied')
    const inPostgres = await dashStore().save(null, 'team-a', 'owner-1', onDemand('Only in Postgres'))
    setDashStore(null)
    const copied = await marker()
    // A crash before the move aside, then a write into dashflows.sqlite by another process.
    fs.chmodSync(`${file}.migrated`, 0o644)
    fs.renameSync(`${file}.migrated`, file)
    const writer = openSqliteDashStore(file)
    const inSqlite = await writer.save(null, 'team-a', 'owner-1', onDemand('Only in SQLite'))
    writer.close()
    assert.deepEqual(await init(file, log), { backend: 'sqlite', outcome: 'diverged' })
    assert.equal(
        lines.at(-1),
        'Dash Flows storage move stopped: dashflows.sqlite differs from the copy in the application database, and no switch-off was recorded. Dash Flows serves dashflows.sqlite; changes made in the application database since the copy are kept there but not shown. Decide which copy to keep before starting with CUTTLELY_APP_DATABASE_STORES on again.'
    )
    // The refusal is logged at error level; nothing else is.
    assert.deepEqual(errors, [lines.at(-1)])
    assert.deepEqual(await marker(), copied)
    assert.equal(fs.existsSync(file), true)
    assert.equal(fs.existsSync(`${file}.migrated`), false)
    assert.equal(dashStore().backend, 'sqlite')
    assert.ok(await dashStore().get(inSqlite.id, 'team-a'))
    assert.ok(await dashStore().get(seeded.ids.private, 'team-a'))
    assert.ok((await pgRows('dash_flow')).some((row) => row.id === inPostgres.id))
    // Recovery, keep the application-database copy: with Cuttlely stopped, move dashflows.sqlite aside as
    // dashflows.sqlite.migrated, then start. The committed copy serves.
    setDashStore(null)
    fs.renameSync(file, `${file}.migrated`)
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'nothing-to-copy' })
    assert.ok(await dashStore().get(inPostgres.id, 'team-a'))
    await assert.rejects(dashStore().get(inSqlite.id, 'team-a'), /not found/)
    // Recovery, keep dashflows.sqlite: from the same refusal, delete the copy row and start. The file is copied
    // again, replaces the application-database copy, and is moved aside.
    setDashStore(null)
    fs.chmodSync(`${file}.migrated`, 0o644)
    fs.renameSync(`${file}.migrated`, file)
    assert.equal((await init(file, log)).outcome, 'diverged')
    await pg.source.query(`DELETE FROM cuttlely_dashflows.dash_flow_store_meta WHERE key='copy'`)
    assert.deepEqual(await init(file, log), { backend: 'postgres', outcome: 'copied' })
    assert.ok(await dashStore().get(inSqlite.id, 'team-a'))
    assert.ok(!(await pgRows('dash_flow')).some((row) => row.id === inPostgres.id))
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.statSync(`${file}.migrated`).mode & 0o777, 0o444)
})

pgTest('AC15 a login without CREATE gets the named refusal and stays on SQLite', async () => {
    const role = `zz_dash_nocreate_${randomBytes(4).toString('hex')}`
    const password = randomBytes(12).toString('hex')
    await adminQuery(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    const limited = poolSource(adminConfig(database.name, { user: role, password }))
    try {
        const file = tempFile()
        await seed(file)
        const hash = digestFile(file)
        const { lines, log } = capture()
        assert.deepEqual(await init(file, log, { source: limited.source }), { backend: 'sqlite', outcome: 'refused-privilege' })
        assert.equal(
            lines.at(-1),
            'Dash Flows storage move not started: the application database user lacks CREATE on the application database. Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start.'
        )
        assert.equal(digestFile(file), hash)
        assert.equal(await schemaPresent(), false)
        assert.equal(dashStore().backend, 'sqlite')
        // An existing schema without USAGE and CREATE for this login is refused the same way.
        await pg.source.query('CREATE SCHEMA cuttlely_dashflows')
        assert.equal((await init(file, log, { source: limited.source })).outcome, 'refused-privilege')
        assert.match(lines.at(-1), /lacks USAGE and CREATE on schema cuttlely_dashflows\./)
        // The re-copy of a moved file with no committed copy is checked too: the file is put back, nothing
        // is created, and Dash Flows stays on SQLite.
        await pg.source.query('DROP SCHEMA cuttlely_dashflows')
        fs.renameSync(file, `${file}.migrated`)
        fs.chmodSync(`${file}.migrated`, 0o444)
        assert.deepEqual(await init(file, log, { source: limited.source }), { backend: 'sqlite', outcome: 'refused-privilege' })
        assert.match(lines.at(-1), /lacks CREATE on the application database\./)
        assert.equal(digestFile(file), hash)
        assert.equal(fs.statSync(file).mode & 0o777, 0o644)
        assert.equal(fs.existsSync(`${file}.migrated`), false)
        assert.equal(await schemaPresent(), false)
        assert.equal(dashStore().backend, 'sqlite')
    } finally {
        await limited.end()
        await pg.source.query('DROP SCHEMA IF EXISTS cuttlely_dashflows CASCADE')
        await adminQuery(`DROP ROLE IF EXISTS ${role}`)
    }
})

test('AC10 logs carry ids and counts only: no connection details, passwords, public tokens or snapshot text', { skip: pgSkip }, () => {
    assert.ok(allLogs.length >= 10)
    const text = allLogs.join('\n')
    const config = adminConfig()
    const secrets = [
        config.password,
        `${config.host}:${config.port}`,
        'postgres://',
        'postgresql://',
        database.name,
        SNAPSHOT_TEXT,
        'Public weekly'
    ]
    for (const secret of [...secrets, ...publicTokens])
        assert.equal(text.includes(secret), false, 'a log line carries a secret, token or row text')
    assert.ok(publicTokens.length >= 8)
})
