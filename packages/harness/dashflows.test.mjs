import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    catalog,
    materializeCached,
    pipelinePeriods,
    materialize,
    openDashStore,
    validateDefinition,
    validateSnapshot
} from './dashflows.mjs'
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
function storeTest(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashflow-'))
    const file = path.join(dir, 'dash.sqlite')
    const store = openDashStore(file)
    try {
        fn(store, file)
    } finally {
        store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
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
test('durable team isolation, optimistic saves, overlap leases and last-good snapshots', () =>
    storeTest((store, file) => {
        const saved = store.save(null, 'team-a', 'owner', definition)
        assert.throws(() => store.get(saved.id, 'team-b'), /not found/)
        assert.throws(() => store.save(saved.id, 'team-b', 'owner', definition, 1), /not found/)
        assert.throws(() => store.list(''), /Workspace/)
        const claim = store.claim(saved.id, 'team-a')
        assert.throws(() => store.claim(saved.id, 'team-a'), /already running/)
        assert.throws(() => store.save(saved.id, 'team-a', 'owner', definition, 1), /refreshing/)
        store.settle(saved.id, 'team-a', claim, { id: 'good', cards: [result()] }, null)
        assert.equal(store.due(Date.now() + 604801000).length, 1)
        const failed = store.claim(saved.id, 'team-a')
        store.settle(saved.id, 'team-a', failed, null, 'Source unavailable')
        assert.equal(store.get(saved.id, 'team-a').snapshot.id, 'good')
        assert.equal(store.get(saved.id, 'team-a').error, 'Source unavailable')
        const reopened = openDashStore(file)
        assert.equal(reopened.get(saved.id, 'team-a').snapshot.id, 'good')
        reopened.close()
        assert.throws(() => store.save(saved.id, 'team-a', 'owner', definition, 5), /changed/)
    }))
test('publish freezes definition and data, passive reads do not execute, and revocation is immediate', () =>
    storeTest((store) => {
        const saved = store.save(null, 'team-a', 'owner', definition)
        assert.throws(() => store.published(saved.id, 'team-a'), /not published/)
        assert.throws(() => store.publish(saved.id, 'team-a', 1), /Refresh/)
        store.settle(saved.id, 'team-a', store.claim(saved.id, 'team-a'), { id: 'published-data' }, null)
        store.publish(saved.id, 'team-a', 1)
        assert.throws(() => store.published(saved.id, 'team-b'), /not found/)
        store.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Draft edits' }, 1)
        assert.equal(store.published(saved.id, 'team-a').definition.title, definition.title)
        assert.equal(store.published(saved.id, 'team-a').snapshot.id, 'published-data')
        assert.equal(store.get(saved.id, 'team-a').snapshot, null)
        store.unpublish(saved.id, 'team-a')
        assert.throws(() => store.published(saved.id, 'team-a'), /not published/)
    }))

test('saved non-weekly intervals stay stored but are not returned as due work', () =>
    storeTest((store, file) => {
        const saved = store.save(null, 'team-a', 'owner', definition)
        const db = new DatabaseSync(file)
        db.prepare('UPDATE dash_flow SET definition=?,next_refresh=1 WHERE id=?').run(
            JSON.stringify({ ...definition, intervalSeconds: 3600 }),
            saved.id
        )
        db.close()
        assert.equal(store.get(saved.id, 'team-a').definition.intervalSeconds, 3600)
        assert.deepEqual(store.due(Date.now()), [])
    }))

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
    storeTest((store, file) => {
        const saved = store.save(null, 'team-a', 'owner', definition)
        const claim = attemptBetweenReadAndWrite(
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
        store.settle(saved.id, 'team-a', claim, { id: 'first' }, null)
        assert.equal(store.get(saved.id, 'team-a').refreshing, false)
        const peer = openDashStore(file)
        try {
            const next = peer.save(saved.id, 'team-a', 'owner', { ...definition, title: 'New draft' }, saved.revision)
            const nextClaim = store.claim(saved.id, 'team-a')
            assert.equal(nextClaim.revision, next.revision)
            assert.equal(nextClaim.definition.title, 'New draft')
            store.settle(saved.id, 'team-a', nextClaim, { id: 'second' }, null)
            assert.equal(peer.get(saved.id, 'team-a').refreshing, false)
        } finally {
            peer.close()
        }
    }))

for (const mutation of ['save', 'unpublish']) {
    test(`publication locks its read against a competing ${mutation}, and later revocation wins`, (t) =>
        storeTest((store, file) => {
            const saved = store.save(null, 'team-a', 'owner', definition)
            store.settle(saved.id, 'team-a', store.claim(saved.id, 'team-a'), { id: 'materialized' }, null)
            store.publish(saved.id, 'team-a', saved.revision)
            const publication = attemptBetweenReadAndWrite(
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
            const peer = openDashStore(file)
            try {
                peer.save(saved.id, 'team-a', 'owner', { ...definition, title: 'Later draft' }, saved.revision)
                assert.throws(() => store.publish(saved.id, 'team-a', saved.revision), /Refresh/)
                assert.equal(store.published(saved.id, 'team-a').definition.title, definition.title)
                peer.unpublish(saved.id, 'team-a')
                assert.throws(() => store.published(saved.id, 'team-a'), /not published/)
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
test('durable query cache isolates workspaces/dashboards, expires from original fetch time and survives reopen', () => {
    storeTest((store, file) => {
        const row = store.save(null, 'team-a', 'owner', definition)
        const second = store.save(null, 'team-a', 'owner', definition)
        const cache = store.queryCache(row.id, 'team-a')
        cache.put('one', { raw: result(), fetchedAt: new Date().toISOString() })
        assert.equal(store.queryCache(second.id, 'team-a').get('one'), null)
        assert.throws(() => store.queryCache(row.id, 'team-b'), /not found/)
        const reopened = openDashStore(file)
        assert.ok(reopened.queryCache(row.id, 'team-a').get('one'))
        reopened.close()
        cache.put('expired', { raw: result(), fetchedAt: new Date(Date.now() - 7 * 3600000).toISOString() })
        assert.equal(cache.get('expired'), null)
    })
})
test('pipeline preset periods use UTC boundaries including next-year quarters', () => {
    const periods = pipelinePeriods(new Date('2026-12-31T23:59:00Z'))
    assert.equal(periods.length, 5)
    assert.deepEqual(periods[0], { start_date: '2026-12-31', end_date: '2027-01-30' })
    assert.deepEqual(periods[4], { start_date: '2027-01-01', end_date: '2027-04-01' })
})
test('explicit refresh prepares five pipeline ranges once; cached selection performs no source execution', async () => {
    const rangePin = {
        ...pin,
        id: queryName('pipeline_window'),
        name: queryName('pipeline_window'),
        sql: 'SELECT region, amount FROM demo_totals WHERE month >= :start_date AND month < :end_date LIMIT 100',
        params: [
            { name: 'start_date', type: 'date', required: true },
            { name: 'end_date', type: 'date', required: true }
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
        params: pipelinePeriods()[0]
    }
    const def = { ...definition, cards: [rangedCard] }
    const values = new Map()
    const cache = { get: (key) => values.get(key), put: (key, value) => values.set(key, value) }
    let calls = 0
    const execute = async () => {
        calls++
        return { ...result(), pinned: { id: rangePin.id, name: rangePin.name, version: 1, hash: rangedCard.hash } }
    }
    await materializeCached(def, record, execute, cache)
    assert.equal(calls, 5)
    assert.equal(values.size, 5)
    await materializeCached({ ...def, cards: [{ ...rangedCard, params: pipelinePeriods()[2] }] }, record, execute, cache, true)
    assert.equal(calls, 5)
    const partial = await materializeCached(
        def,
        record,
        async (item, args) => {
            if (args.end_date === pipelinePeriods()[1].end_date) throw new Error('Source unavailable')
            return execute(item, args)
        },
        cache
    )
    assert.ok(partial.cards.length)
    assert.match(partial.rangeCacheWarning, /not ready/)
})
test('public publishing is opt-in, frozen, revocable, and does not revive an old token', () => {
    storeTest((store) => {
        const row = store.save(null, 'team-a', 'owner', definition)
        const claim = store.claim(row.id, 'team-a')
        store.settle(row.id, 'team-a', claim, { cards: [{ cardId: card.id, rows: [{ account_name: 'Synthetic' }] }] }, null)
        assert.equal(store.publish(row.id, 'team-a', row.revision).publicToken, null)
        const publicView = store.publish(row.id, 'team-a', row.revision, true)
        assert.ok(publicView.publicToken)
        assert.equal(store.publicView(publicView.publicToken).workspace, 'team-a')
        assert.throws(() => store.publicView(row.id), /not found/)
        const slot = store.reservePublicReport(publicView.publicToken)
        store.attachPublicReport(slot, 'run-one')
        assert.ok(store.hasPublicReport(publicView.publicToken, 'run-one'))
        assert.equal(store.hasPublicReport('other-token', 'run-one'), false)
        for (let i = 1; i < 10; i++) store.reservePublicReport(publicView.publicToken)
        assert.throws(() => store.reservePublicReport(publicView.publicToken), /hourly report limit/)
        store.unpublish(row.id, 'team-a')
        assert.throws(() => store.publicView(publicView.publicToken), /not found/)
        const newView = store.publish(row.id, 'team-a', row.revision, true)
        assert.notEqual(newView.publicToken, publicView.publicToken)
        store.publish(row.id, 'team-a', row.revision, false)
        assert.throws(() => store.publicView(newView.publicToken), /not found/)
    })
})
