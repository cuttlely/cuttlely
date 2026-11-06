import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { catalog, materialize, openDashStore, validateDefinition, validateSnapshot } from './dashflows.mjs'
import { compilePinned } from './runtime/pinned-query.mjs'

// Synthetic contract fixture. This is not a Supreme export or a live database result.
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
const definition = { title: 'Synthetic source dashboard', harness: harness.name, intervalSeconds: 3600, cards: [card] }
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
    for (const patch of [
        { cards: [card, card] },
        { cards: [{ ...card, scope: '' }] },
        { cards: [{ ...card, x: Infinity }] },
        { intervalSeconds: 1 },
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
        assert.equal(store.due(Date.now() + 3601000).length, 1)
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
