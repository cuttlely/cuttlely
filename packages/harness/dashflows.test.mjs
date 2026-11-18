import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import {
    catalog,
    materializeCached,
    pipelinePeriods,
    materialize,
    openDashStore,
    openSqliteDashStore,
    validateDefinition,
    validateSnapshot
} from './dashflows.mjs'
import { openPostgresDashStore } from './dashflows-postgres.mjs'
import { freshDatabase, pgSkip, poolSource } from './test/dashflows-pg.mjs'
import { compilePinned } from './runtime/pinned-query.mjs'

// Synthetic contract fixture. This is not a Supreme export or a live database result.
const queryName = (slug) => ['pq', slug].join('_')
const pin = {
    id: 'sample-pin',
    name: queryName('monthly'),
    version: 1,
    sql: 'SELECT region, amount FROM demo_totals WHERE month = :month LIMIT 100',
    params: [{ name: 'month', type: 'date', required: true }],
    testedStamp: 'synthetic-test-stamp',
    testedColumns: [
        { name: 'region', type: 'text' },
        { name: 'amount', type: 'numeric' }
    ]
}
const harness = {
    name: 'synthetic-contract',
    specialists: [{ name: 'analyst', modules: [{ nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [pin] } }] }]
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
const definition = { title: 'Synthetic source dashboard', harness: harness.name, intervalSeconds: 604800, cards: [card] }
const result = () => ({
    rows: [
        { region: 'North', amount: '123456789.0123456789' },
        { region: 'South', amount: null }
    ],
    truncated: false,
    pinned: { id: pin.id, name: pin.name, version: pin.version, hash: card.hash }
})
// The store suite runs on both backends: dashflows.sqlite and the application database's Postgres.
const BACKENDS = ['sqlite', 'postgres']
const skipFor = (backend) => (backend === 'postgres' ? pgSkip : false)
let pgDatabase
let pg
before(async () => {
    if (pgSkip) return
    pgDatabase = await freshDatabase('zz_dashflows_store')
    pg = poolSource(pgDatabase.config)
})
after(async () => {
    await pg?.end()
    await pgDatabase?.drop()
})
async function storeTest(backend, fn) {
    if (backend === 'postgres') {
        await pg.source.query('DROP SCHEMA IF EXISTS cuttlely_dashflows CASCADE')
        const store = await openPostgresDashStore(pg.source)
        const set = (sql, params) => pg.source.query(`UPDATE cuttlely_dashflows.dash_flow SET ${sql}`, params)
        return fn(store, {
            open: () => openPostgresDashStore(pg.source),
            expire: (id) => set('lease_until=0 WHERE id=$1', [id]),
            leaseUntil: async (id) =>
                Number((await pg.source.query('SELECT lease_until FROM cuttlely_dashflows.dash_flow WHERE id=$1', [id]))[0].lease_until),
            setInterval: (id, intervalSeconds) =>
                set('definition=$1,next_refresh=1 WHERE id=$2', [JSON.stringify({ ...definition, intervalSeconds }), id])
        })
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashflow-'))
    const file = path.join(dir, 'dash.sqlite')
    const store = await openDashStore(file)
    const run = (sql, ...params) => {
        const db = new DatabaseSync(file)
        try {
            return db.prepare(sql).run(...params)
        } finally {
            db.close()
        }
    }
    try {
        await fn(store, {
            file,
            open: () => openDashStore(file),
            expire: (id) => run('UPDATE dash_flow SET lease_until=0 WHERE id=?', id),
            leaseUntil: (id) => {
                const db = new DatabaseSync(file)
                try {
                    return db.prepare('SELECT lease_until FROM dash_flow WHERE id=?').get(id).lease_until
                } finally {
                    db.close()
                }
            },
            setInterval: (id, intervalSeconds) =>
                run('UPDATE dash_flow SET definition=?,next_refresh=1 WHERE id=?', JSON.stringify({ ...definition, intervalSeconds }), id)
        })
    } finally {
        store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
}
const backendTest = (name, fn) => {
    for (const backend of BACKENDS) test(`[${backend}] ${name}`, { skip: skipFor(backend) }, () => storeTest(backend, fn))
}
test('catalog exposes tested source metadata, never SQL, credentials or secure parameters', () => {
    const record = structuredClone(harness)
    record.specialists[0].modules[0].credential = 'hidden-credential'
    assert.equal(catalog(record).length, 1)
    assert.ok(!JSON.stringify(catalog(record)).includes(pin.sql))
    assert.ok(!JSON.stringify(catalog(record)).includes('hidden-credential'))
    record.specialists[0].modules[0].inputs.pinnedQueries[0].params[0].secure = true
    assert.deepEqual(catalog(record), [])
})
test('materialization executes the named pin with exact parameters and retains decimal bytes and provenance', async () => {
    const calls = []
    const snapshot = await materialize(definition, harness, async (source, args) => {
        calls.push({ source, args })
        return JSON.stringify(result())
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, card.params)
    assert.equal(calls[0].source.name, pin.name)
    assert.deepEqual(snapshot.cards[0].rows, result().rows)
    assert.equal(snapshot.cards[0].source.hash, card.hash)
    assert.equal(snapshot.cards[0].source.harness, harness.name)
})
test('source change and invalid parameters refuse before execution', async () => {
    let calls = 0
    const execute = async () => {
        calls++
        return result()
    }
    await assert.rejects(materialize({ ...definition, cards: [{ ...card, hash: 'a'.repeat(64) }] }, harness, execute), /source changed/)
    await assert.rejects(materialize({ ...definition, cards: [{ ...card, params: { month: 'not-a-date' } }] }, harness, execute))
    assert.equal(calls, 0)
})
for (const [name, patch] of Object.entries({
    truncated: { truncated: true },
    unknown: { truncated: undefined },
    capped: { possiblyTruncated: true },
    paged: { cursor: { token: 'next' } },
    drift: { columnsChanged: true },
    error: { error: 'source error' },
    wrongPin: { pinned: { ...result().pinned, hash: 'b'.repeat(64) } }
})) {
    test(`refuses ${name} results`, () => assert.throws(() => validateSnapshot({ ...result(), ...patch }, pin, card)))
}
test('LIMIT equality, invalid numerics and multirow metrics cannot masquerade as complete values', () => {
    const limited = { ...pin, sql: pin.sql.replace('LIMIT 100', 'LIMIT 2') }
    const limitedCard = { ...card, hash: compilePinned(limited).statementHash }
    assert.throws(
        () => validateSnapshot({ ...result(), pinned: { ...result().pinned, hash: limitedCard.hash } }, limited, limitedCard),
        /capped/
    )
    assert.throws(() => validateSnapshot(result(), pin, { ...card, kind: 'metric' }), /one source row/)
    assert.throws(() => validateSnapshot({ ...result(), rows: [{ region: 'North', amount: 'unknown' }] }, pin, card), /not numeric/)
    assert.deepEqual(validateSnapshot({ ...result(), rows: [] }, pin, card).rows, [])
})
test('definition bounds, unique identities and explicit scope are enforced', () => {
    assert.deepEqual(validateDefinition(definition), definition)
    assert.equal(validateDefinition({ ...definition, intervalSeconds: 0 }).intervalSeconds, 0)
    for (const intervalSeconds of [1, 3600, 86400])
        assert.throws(() => validateDefinition({ ...definition, intervalSeconds }), /on-demand or weekly/)
    for (const patch of [
        { cards: [card, card] },
        { cards: [{ ...card, scope: '' }] },
        { cards: [{ ...card, x: Infinity }] },
        { cards: [{ ...card, valueField: '__proto__' }] }
    ])
        assert.throws(() => validateDefinition({ ...definition, ...patch }))
})
backendTest('durable team isolation, optimistic saves, overlap leases and last-good snapshots', async (store, ctx) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    await assert.rejects(store.get(saved.id, 'team-b'), /not found/)
    await assert.rejects(store.save(saved.id, 'team-b', 'owner', definition, 1), /not found/)
    await assert.rejects(store.list(''), /Workspace/)
    const claim = await store.claim(saved.id, 'team-a')
    await assert.rejects(store.claim(saved.id, 'team-a'), /already running/)
    await assert.rejects(store.save(saved.id, 'team-a', 'owner', definition, 1), /refreshing/)
    await store.settle(saved.id, 'team-a', claim, { id: 'good', cards: [result()] }, null)
    assert.equal((await store.due(Date.now() + 604801000)).length, 1)
    const failed = await store.claim(saved.id, 'team-a')
    await store.settle(saved.id, 'team-a', failed, null, 'Source unavailable')
    assert.equal((await store.get(saved.id, 'team-a')).snapshot.id, 'good')
    assert.equal((await store.get(saved.id, 'team-a')).error, 'Source unavailable')
    const reopened = await ctx.open()
    assert.equal((await reopened.get(saved.id, 'team-a')).snapshot.id, 'good')
    reopened.close()
    await assert.rejects(store.save(saved.id, 'team-a', 'owner', definition, 5), /changed/)
})
backendTest('publish freezes definition and data, passive reads do not execute, and revocation is immediate', async (store) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    await assert.rejects(store.published(saved.id, 'team-a'), /not published/)
    await assert.rejects(store.publish(saved.id, 'team-a', 1), /Refresh/)
    await store.settle(saved.id, 'team-a', await store.claim(saved.id, 'team-a'), { id: 'published-data' }, null)
    await store.publish(saved.id, 'team-a', 1)
    await assert.rejects(store.published(saved.id, 'team-b'), /not found/)
    await store.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Draft edits' }, 1)
    assert.equal((await store.published(saved.id, 'team-a')).definition.title, definition.title)
    assert.equal((await store.published(saved.id, 'team-a')).snapshot.id, 'published-data')
    assert.equal((await store.get(saved.id, 'team-a')).snapshot, null)
    await store.unpublish(saved.id, 'team-a')
    await assert.rejects(store.published(saved.id, 'team-a'), /not published/)
})

backendTest('saved non-weekly intervals stay stored but are not returned as due work', async (store, ctx) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    await ctx.setInterval(saved.id, 3600)
    assert.equal((await store.get(saved.id, 'team-a')).definition.intervalSeconds, 3600)
    assert.deepEqual(await store.due(Date.now()), [])
})
backendTest('list keeps newest-first order', async (store) => {
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await store.save(null, 'team-a', 'owner', { ...definition, title: `Board ${i}` })).id)
    assert.deepEqual(
        (await store.list('team-a')).map((row) => row.id),
        ids.reverse()
    )
})

test('explicit source completeness permits a LIMIT 1 aggregate envelope and typed nested projection', async () => {
    const aggregatePin = { ...pin, sql: pin.sql.replace('LIMIT 100', 'LIMIT 1') }
    const aggregateHarness = structuredClone(harness)
    aggregateHarness.specialists[0].modules[0].inputs.pinnedQueries = [aggregatePin]
    const hash = compilePinned(aggregatePin).statementHash
    const aggregateCard = { ...card, hash, completePath: 'payload.complete', rowsPath: 'payload.patterns' }
    const raw = {
        ...result(),
        possiblyTruncated: true,
        pinned: { ...result().pinned, hash },
        rows: [
            {
                count: 2,
                payload: JSON.stringify({ complete: true, patterns: result().rows, coverage: 'Overlapping categories; do not sum.' })
            }
        ]
    }
    const snapshot = validateSnapshot(raw, aggregatePin, aggregateCard)
    assert.deepEqual(snapshot.rows, result().rows)
    assert.deepEqual(snapshot.evidenceRows, raw.rows)
    assert.equal(snapshot.source.completenessPath, 'payload.complete')
    assert.throws(() => validateSnapshot(raw, aggregatePin, { ...aggregateCard, completePath: undefined }), /capped/)
    for (const complete of [false, 'true', 1, undefined])
        assert.throws(() => validateSnapshot({ ...raw, rows: [{ payload: { complete, patterns: [] } }] }, aggregatePin, aggregateCard))
    assert.throws(() => validateSnapshot({ ...raw, truncated: true }, aggregatePin, aggregateCard))
    assert.throws(() => validateSnapshot(raw, aggregatePin, { ...aggregateCard, rowsPath: '__proto__.patterns' }))
    let calls = 0
    const definition2 = { ...definition, cards: [aggregateCard, { ...aggregateCard, id: 'second' }] }
    await materialize(definition2, aggregateHarness, async () => {
        calls++
        return raw
    })
    assert.equal(calls, 1, 'cards sharing a source and exact parameters use the same execution')
})

test('selected opportunity tables disclose their subset and refuse inconsistent count contracts', () => {
    const selectedPin = { ...pin, sql: pin.sql.replace('LIMIT 100', 'LIMIT 1') }
    const hash = compilePinned(selectedPin).statementHash
    const selectedCard = {
        ...card,
        hash,
        kind: 'table',
        rowsPath: 'packet.rows',
        selectionCountPath: 'packet.returned',
        selectionTotalPath: 'packet.total'
    }
    const raw = {
        ...result(),
        possiblyTruncated: true,
        pinned: { ...result().pinned, hash },
        rows: [{ packet: { rows: [{ account_id: '001000000000000AAA', account_name: 'Synthetic account' }], returned: 1, total: 28 } }]
    }
    const snapshot = validateSnapshot(raw, selectedPin, selectedCard)
    assert.deepEqual(snapshot.source.selection, { shown: 1, total: 28 })
    assert.equal(snapshot.rows[0].account_id, '001000000000000AAA')
    assert.throws(() => validateSnapshot(raw, selectedPin, { ...selectedCard, kind: 'metric' }))
    assert.throws(() => validateSnapshot({ ...raw, rows: [{ packet: { rows: [], returned: 1, total: 28 } }] }, selectedPin, selectedCard))
    assert.throws(() => validateSnapshot({ ...raw, truncated: true }, selectedPin, selectedCard))
})

// Hash-bound aggregate exceptions cannot be borrowed by a different query or detail page.
test('reviewed aggregate contracts are exact and never certify paged deal details', async () => {
    const { reviewedAggregate } = await import('./dashflow-source-contracts.mjs')
    const hash = 'fab02ec5995ae0bdcdc4957457e07f1f09236181e92fe56871e5d49f31140597'
    assert.equal(reviewedAggregate(queryName('pipeline_window'), hash, { input_state: 'valid' }, 'full_cohort_type_summary'), true)
    assert.equal(reviewedAggregate(queryName('pipeline_window'), hash, { input_state: 'invalid_window' }), false)
    assert.equal(reviewedAggregate(queryName('pipeline_window'), hash, { input_state: 'valid' }, 'deal_details'), false)
    assert.equal(reviewedAggregate(queryName('pipeline_window'), 'a'.repeat(64), { input_state: 'valid' }), false)
    assert.equal(reviewedAggregate('unreviewed', hash, { input_state: 'valid' }), false)
})

// Pause precisely after the read using a test-only wrapper. A second real SQLite
// connection attempts the write that used to fit between SELECT and UPDATE.
// This is deterministic and exercises the shared-file lock, without sleeps.
function attemptBetweenReadAndWrite(t, file, mutation, action) {
    const other = new DatabaseSync(file)
    other.exec('PRAGMA busy_timeout=0')
    const prepare = DatabaseSync.prototype.prepare
    let attempted = false
    const stub = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
        const statement = prepare.call(this, sql)
        if (!sql.startsWith('SELECT * FROM dash_flow')) return statement
        return {
            get(...args) {
                const row = statement.get(...args)
                if (!attempted) {
                    attempted = true
                    assert.throws(() => mutation(other), /database is locked/)
                }
                return row
            }
        }
    })
    try {
        const result = action()
        assert.equal(attempted, true)
        return result
    } finally {
        stub.mock.restore()
        other.close()
    }
}

test('claim locks the selected revision before a competing save can change it', (t) =>
    storeTest('sqlite', async (store, { file }) => {
        const saved = await store.save(null, 'team-a', 'owner', definition)
        const claim = await attemptBetweenReadAndWrite(
            t,
            file,
            (db) =>
                db
                    .prepare('UPDATE dash_flow SET revision=revision+1,definition=? WHERE id=?')
                    .run(JSON.stringify({ ...definition, title: 'Competing draft' }), saved.id),
            () => store.claim(saved.id, 'team-a')
        )
        assert.equal(claim.revision, saved.revision)
        assert.equal(claim.definition.title, definition.title)
        await store.settle(saved.id, 'team-a', claim, { id: 'first' }, null)
        assert.equal((await store.get(saved.id, 'team-a')).refreshing, false)
        const peer = openSqliteDashStore(file)
        try {
            const next = await peer.save(saved.id, 'team-a', 'owner', { ...definition, title: 'New draft' }, saved.revision)
            const nextClaim = await store.claim(saved.id, 'team-a')
            assert.equal(nextClaim.revision, next.revision)
            assert.equal(nextClaim.definition.title, 'New draft')
            await store.settle(saved.id, 'team-a', nextClaim, { id: 'second' }, null)
            assert.equal((await peer.get(saved.id, 'team-a')).refreshing, false)
        } finally {
            peer.close()
        }
    }))

for (const mutation of ['save', 'unpublish']) {
    test(`publication locks its read against a competing ${mutation}, and later revocation wins`, (t) =>
        storeTest('sqlite', async (store, { file }) => {
            const saved = await store.save(null, 'team-a', 'owner', definition)
            await store.settle(saved.id, 'team-a', await store.claim(saved.id, 'team-a'), { id: 'materialized' }, null)
            await store.publish(saved.id, 'team-a', saved.revision)
            const publication = await attemptBetweenReadAndWrite(
                t,
                file,
                (db) =>
                    db
                        .prepare(
                            mutation === 'save'
                                ? 'UPDATE dash_flow SET revision=revision+1,snapshot=NULL WHERE id=?'
                                : 'UPDATE dash_flow SET published=NULL WHERE id=?'
                        )
                        .run(saved.id),
                () => store.publish(saved.id, 'team-a', saved.revision)
            )
            assert.equal(publication.snapshot.id, 'materialized')
            const peer = openSqliteDashStore(file)
            try {
                await peer.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Later draft' }, saved.revision)
                await assert.rejects(store.publish(saved.id, 'team-a', saved.revision), /Refresh/)
                assert.equal((await store.published(saved.id, 'team-a')).definition.title, definition.title)
                await peer.unpublish(saved.id, 'team-a')
                await assert.rejects(store.published(saved.id, 'team-a'), /not published/)
            } finally {
                peer.close()
            }
        }))
}
test('cached refresh revalidates source receipts, preserves freshness and keys exact parameters', async () => {
    const values = new Map()
    const cache = { get: (key) => values.get(key), put: (key, value) => values.set(key, value) }
    let calls = 0
    const execute = async () => {
        calls++
        return result()
    }
    const first = await materializeCached(definition, harness, execute, cache)
    const second = await materializeCached(definition, harness, execute, cache, true)
    assert.equal(calls, 1)
    assert.equal(second.cards[0].fetchedAt, first.cards[0].fetchedAt)
    await materializeCached({ ...definition, cards: [{ ...card, params: { month: '2026-11-01' } }] }, harness, execute, cache, true)
    assert.equal(calls, 2)
    for (const value of values.values()) value.raw.pinned.hash = 'wrong'
    await assert.rejects(materializeCached(definition, harness, execute, cache, true))
    await materializeCached(definition, harness, execute, cache, false)
    assert.equal(calls, 3)
})
backendTest(
    'durable query cache isolates workspaces/dashboards, expires from original fetch time and survives reopen',
    async (store, ctx) => {
        const row = await store.save(null, 'team-a', 'owner', definition)
        const second = await store.save(null, 'team-a', 'owner', definition)
        const cache = await store.queryCache(row.id, 'team-a')
        await cache.put('one', { raw: result(), fetchedAt: new Date().toISOString() })
        assert.equal(await (await store.queryCache(second.id, 'team-a')).get('one'), null)
        await assert.rejects(store.queryCache(row.id, 'team-b'), /not found/)
        const reopened = await ctx.open()
        assert.ok(await (await reopened.queryCache(row.id, 'team-a')).get('one'))
        reopened.close()
        await cache.put('expired', { raw: result(), fetchedAt: new Date(Date.now() - 7 * 3600000).toISOString() })
        assert.equal(await cache.get('expired'), null)
    }
)
test('pipeline preset periods use UTC boundaries including next-year quarters', () => {
    const periods = pipelinePeriods(new Date('2026-12-31T23:59:00Z'))
    assert.equal(periods.length, 5)
    assert.deepEqual(periods[0], { start_date: '2026-12-31', end_date: '2027-01-30' })
    assert.deepEqual(periods[4], { start_date: '2027-01-01', end_date: '2027-04-01' })
})
test('refresh freezes all twenty period/region views and refuses incomplete generations', async () => {
    const rangePin = {
        ...pin,
        id: queryName('pipeline_window'),
        name: queryName('pipeline_window'),
        sql: 'SELECT region, amount FROM demo_totals WHERE month >= :start_date AND month < :end_date AND region = :region LIMIT 100',
        params: [
            { name: 'start_date', type: 'date', required: true },
            { name: 'end_date', type: 'date', required: true },
            { name: 'region', type: 'text', required: true }
        ]
    }
    const record = {
        ...harness,
        specialists: [{ name: 'analyst', modules: [{ nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [rangePin] } }] }]
    }
    const rangedCard = {
        ...card,
        source: `analyst:0:${rangePin.id}`,
        hash: compilePinned(rangePin).statementHash,
        params: { ...pipelinePeriods()[0], region: 'ALL' }
    }
    const def = { ...definition, cards: [rangedCard] }
    const values = new Map()
    const cache = { get: (key) => values.get(key), put: (key, value) => values.set(key, value) }
    let calls = 0
    let running = 0
    let maximum = 0
    const execute = async () => {
        calls++
        maximum = Math.max(maximum, ++running)
        await new Promise((resolve) => setImmediate(resolve))
        running--
        return { ...result(), pinned: { id: rangePin.id, name: rangePin.name, version: 1, hash: rangedCard.hash } }
    }
    const updates = []
    const frozen = await materializeCached(def, record, execute, cache, false, (progress) => updates.push(progress))
    assert.ok(updates.some((p) => p.phase === 'views' && p.completed === 20))
    assert.ok(updates.every((p) => p.active.length <= 1))
    assert.equal(updates.at(-1).phase, 'saving')
    assert.equal(calls, 20)
    assert.ok(maximum <= 1)
    assert.equal(values.size, 20)
    assert.equal(Object.keys(frozen.pipelineViews.views).length, 20)
    assert.equal(frozen.pipelineViews.views['EMEA:90'].cards[0].source.params.region, 'EMEA')
    assert.equal(frozen.pipelineViews.views['EMEA:90'].cards[0].rowsFromEvidence, true)
    assert.equal(frozen.pipelineViews.views['EMEA:90'].cards[0].rows, undefined)
    await storeTest('sqlite', async (store) => {
        const saved = await store.save(null, 'team-a', 'owner', def)
        await store.settle(saved.id, 'team-a', await store.claim(saved.id, 'team-a'), frozen, null)
        const published = await store.publish(saved.id, 'team-a', saved.revision, true)
        assert.equal(Object.keys((await store.publicView(published.publicToken)).publication.snapshot.pipelineViews.views).length, 20)
        const incomplete = structuredClone(frozen)
        delete incomplete.pipelineViews.views['APJ:90']
        await store.settle(saved.id, 'team-a', await store.claim(saved.id, 'team-a'), incomplete, null)
        await assert.rejects(store.publish(saved.id, 'team-a', saved.revision, true), /prepare every period and region/)
        assert.equal(Object.keys((await store.publicView(published.publicToken)).publication.snapshot.pipelineViews.views).length, 20)
    })
    await materializeCached(
        { ...def, cards: [{ ...rangedCard, params: { ...pipelinePeriods()[2], region: 'APJ' } }] },
        record,
        execute,
        cache,
        true
    )
    assert.equal(calls, 20)
    // Simulate losing the process after thirteen durable views: execute only the seven missing results.
    const resumeSince = [...values.values()].map((value) => value.fetchedAt).sort()[0]
    for (const key of [...values.keys()].slice(0, 7)) values.delete(key)
    const recovered = await materializeCached(def, record, execute, cache, false, () => {}, resumeSince)
    assert.equal(calls, 27)
    assert.equal(Object.keys(recovered.pipelineViews.views).length, 20)
    await assert.rejects(
        materializeCached(
            def,
            record,
            async (item, args) => {
                if (args.end_date === pipelinePeriods()[1].end_date) throw new Error('Source unavailable')
                return execute(item, args)
            },
            cache
        ),
        /period\/region snapshot is incomplete/
    )
})
backendTest('public publishing is opt-in, frozen, revocable, and does not revive an old token', async (store) => {
    const row = await store.save(null, 'team-a', 'owner', definition)
    const claim = await store.claim(row.id, 'team-a')
    await store.settle(row.id, 'team-a', claim, { cards: [{ cardId: card.id, rows: [{ account_name: 'Synthetic' }] }] }, null)
    assert.equal((await store.publish(row.id, 'team-a', row.revision)).publicToken, null)
    const publicView = await store.publish(row.id, 'team-a', row.revision, true)
    assert.ok(publicView.publicToken)
    assert.equal((await store.publicView(publicView.publicToken)).workspace, 'team-a')
    await assert.rejects(store.publicView(row.id), /not found/)
    const slot = await store.reservePublicReport(publicView.publicToken)
    await store.attachPublicReport(slot, 'run-one')
    assert.ok(await store.hasPublicReport(publicView.publicToken, 'run-one'))
    assert.equal(await store.hasPublicReport('other-token', 'run-one'), false)
    for (let i = 1; i < 10; i++) await store.reservePublicReport(publicView.publicToken)
    await assert.rejects(store.reservePublicReport(publicView.publicToken), /hourly report limit/)
    await store.unpublish(row.id, 'team-a')
    await assert.rejects(store.publicView(publicView.publicToken), /not found/)
    const newView = await store.publish(row.id, 'team-a', row.revision, true)
    assert.notEqual(newView.publicToken, publicView.publicToken)
    await store.publish(row.id, 'team-a', row.revision, false)
    await assert.rejects(store.publicView(newView.publicToken), /not found/)
})
backendTest(
    'refresh progress persists across connections, rejects stale workers and retains terminal failure details',
    async (store, ctx) => {
        const saved = await store.save(null, 'team-a', 'owner', definition)
        const claim = await store.claim(saved.id, 'team-a')
        await store.progress(saved.id, 'team-a', claim, { phase: 'views', completed: 12, total: 20, active: ['EMEA · Next 90 days'] })
        const peer = await ctx.open()
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.completed, 12)
        assert.equal((await peer.status(saved.id, 'team-a')).snapshot, undefined)
        await assert.rejects(peer.status(saved.id, 'team-b'), /not found/)
        await store.progress(saved.id, 'team-a', { ...claim, token: 'stale' }, { phase: 'saving', completed: 20 })
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.completed, 12)
        await store.settle(saved.id, 'team-a', claim, null, 'Source failed.')
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.status, 'failed')
        assert.deepEqual((await peer.status(saved.id, 'team-a')).refreshProgress.failedItems, ['EMEA · Next 90 days'])
        assert.ok((await peer.status(saved.id, 'team-a')).refreshProgress.finishedAt)
        const next = await store.claim(saved.id, 'team-a')
        await store.progress(saved.id, 'team-a', claim, { phase: 'old', completed: 20 })
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.phase, 'starting')
        await store.settle(saved.id, 'team-a', next, { cards: [] }, null)
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.status, 'completed')
        await store.claim(saved.id, 'team-a')
        await ctx.expire(saved.id)
        assert.equal((await peer.status(saved.id, 'team-a')).refreshProgress.status, 'interrupted')
        peer.close()
    }
)
backendTest('force cancel fences late snapshots, progress and cache writes, and permits an immediate restart', async (store) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    await store.settle(saved.id, 'team-a', await store.claim(saved.id, 'team-a'), { id: 'last-good', cards: [] }, null)
    await store.publish(saved.id, 'team-a', saved.revision)
    const old = await store.claim(saved.id, 'team-a')
    assert.equal((await store.status(saved.id, 'team-a')).refreshProgress.runId, old.token)
    await assert.rejects(store.cancel(saved.id, 'team-b', old.token), /not found/)
    await assert.rejects(store.cancel(saved.id, 'team-a', 'stale-token'), /refresh changed/)
    const cache = await store.queryCache(saved.id, 'team-a', old)
    await store.cancel(saved.id, 'team-a', old.token)
    assert.equal((await store.status(saved.id, 'team-a')).refreshProgress.status, 'cancelled')
    assert.ok((await store.get(saved.id, 'team-a')).nextRefresh > Date.now())
    assert.equal(await store.heartbeat(saved.id, 'team-a', old), false)
    const next = await store.claim(saved.id, 'team-a')
    await assert.rejects(store.assertActive(saved.id, 'team-a', old), /cancelled/)
    await assert.rejects(cache.put('old-result', { raw: result(), fetchedAt: new Date().toISOString() }), /cancelled/)
    await store.progress(saved.id, 'team-a', old, { phase: 'old-run' })
    await store.settle(saved.id, 'team-a', old, { id: 'stale', cards: [] }, null)
    assert.equal((await store.status(saved.id, 'team-a')).refreshProgress.runId, next.token)
    assert.equal((await store.get(saved.id, 'team-a')).snapshot.id, 'last-good')
    assert.equal((await store.published(saved.id, 'team-a')).snapshot.id, 'last-good')
    assert.equal(await store.heartbeat(saved.id, 'team-a', next), true)
    await store.settle(saved.id, 'team-a', next, { id: 'fresh', cards: [] }, null)
    assert.equal((await store.get(saved.id, 'team-a')).snapshot.id, 'fresh')
})
backendTest('a lost worker expires without waiting for the old long lease and cannot renew itself after expiry', async (store, ctx) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    const claim = await store.claim(saved.id, 'team-a')
    assert.ok((await ctx.leaseUntil(saved.id)) <= Date.now() + 90000)
    await ctx.expire(saved.id)
    assert.equal((await store.status(saved.id, 'team-a')).refreshProgress.status, 'interrupted')
    assert.equal(await store.heartbeat(saved.id, 'team-a', claim), false)
    await assert.rejects(store.assertActive(saved.id, 'team-a', claim), /interrupted/)
    const retry = await store.claim(saved.id, 'team-a')
    assert.notEqual(retry.token, claim.token)
    assert.equal(retry.resumeSince, claim.startedAt)
    await store.progress(saved.id, 'team-a', retry, { phase: 'views', completed: 4, total: 20 })
    await store.cancel(saved.id, 'team-a', retry.token, 'interrupted')
    const next = await store.claim(saved.id, 'team-a')
    assert.equal(next.resumeSince, claim.startedAt)
    await store.settle(saved.id, 'team-a', next, { id: 'complete', cards: [] }, null)
    assert.equal((await store.claim(saved.id, 'team-a')).resumeSince, null)
})
backendTest('race: two claims give one lease and one 409, and a stale-revision save is a 409', async (store) => {
    const saved = await store.save(null, 'team-a', 'owner', definition)
    const outcomes = await Promise.allSettled([store.claim(saved.id, 'team-a'), store.claim(saved.id, 'team-a')])
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1)
    const lost = outcomes.find((o) => o.status === 'rejected')
    assert.equal(lost.reason.status, 409)
    assert.match(lost.reason.message, /already running/)
    const won = outcomes.find((o) => o.status === 'fulfilled').value
    await store.settle(saved.id, 'team-a', won, { id: 'one', cards: [] }, null)
    await store.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Second' }, saved.revision)
    const stale = await store.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Stale' }, saved.revision).catch((error) => error)
    assert.equal(stale.status, 409)
})
backendTest('race: fifteen concurrent public report reservations give exactly ten', async (store) => {
    const row = await store.save(null, 'team-a', 'owner', definition)
    await store.settle(row.id, 'team-a', await store.claim(row.id, 'team-a'), { cards: [] }, null)
    const { publicToken } = await store.publish(row.id, 'team-a', row.revision, true)
    const outcomes = await Promise.allSettled(Array.from({ length: 15 }, () => store.reservePublicReport(publicToken)))
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 10)
    assert.ok(outcomes.filter((o) => o.status === 'rejected').every((o) => o.reason.status === 429))
})

test('restart recovery reuses only this refresh chain and revalidates cached receipts', async () => {
    const values = new Map()
    const cache = { get: (key) => values.get(key), put: (key, value) => values.set(key, value) }
    let calls = 0
    const execute = async () => {
        calls++
        return result()
    }
    const since = new Date().toISOString()
    await materializeCached(definition, harness, execute, cache)
    await materializeCached(definition, harness, execute, cache, false, () => {}, since)
    assert.equal(calls, 1)
    for (const value of values.values()) value.fetchedAt = '2000-01-01T00:00:00.000Z'
    await materializeCached(definition, harness, execute, cache, false, () => {}, since)
    assert.equal(calls, 2)
    for (const value of values.values()) value.raw = { ...result(), pinned: { ...result().pinned, hash: 'changed' } }
    await assert.rejects(materializeCached(definition, harness, execute, cache, false, () => {}, since))
    await materializeCached(definition, harness, execute, cache)
    assert.equal(calls, 3)
})
