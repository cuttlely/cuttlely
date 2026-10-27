import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    compilePinned,
    validateArgs,
    statementHash,
    stampPayload,
    computeStamp,
    verifyStamp,
    pinnedToolDefinition,
    sqlTraceFields,
    isPinnedToolName,
    pinnedQueriesEnabled,
    suggestParamTypes
} from './pinned-query.mjs'
const entry = (sql = 'SELECT :Value AS v LIMIT 5', params = [{ name: 'Value', type: 'text', required: true }]) => ({
    name: 'pq_demo',
    sql,
    params
})
test('ZZ-TEST- compiler preserves casts, quotes, comments, dollar quotes and JSON operators', () => {
    const c = compilePinned(
        entry(
            `SELECT (:Value)::text, ':ignored', E'\\\':ignored', ":column", $$:ignored$$, $tag$:ignored$tag$, doc ? 'key' /* :ignored /* :ignored */ */ -- :ignored\n FROM demo_sales WHERE name = :Value LIMIT 5`
        )
    )
    assert.deepEqual(c.order, ['Value'])
    assert.equal((c.runText.match(/\$1::pg_catalog.text/g) || []).length, 2)
    assert.match(c.runText, /doc \? 'key'/)
    assert.match(c.checkText, /NULL::pg_catalog.text\)::text/)
    assert.equal(
        c.statementHash,
        statementHash(
            entry(
                `SELECT (:Value)::text, ':ignored', E'\\\':ignored', ":column", $$:ignored$$, $tag$:ignored$tag$, doc ? 'key' /* :ignored /* :ignored */ */ -- :ignored\n FROM demo_sales WHERE name = :Value LIMIT 5`
            )
        )
    )
})
test('ZZ-TEST- compile refuses invalid SQL and parameter specs', () => {
    for (const e of [
        entry('SELECT $1 LIMIT 5'),
        entry('SELECT :Missing LIMIT 5'),
        entry('SELECT 1 LIMIT 5'),
        entry('SELECT :Value'),
        entry('SELECT 1 LIMIT :Value'),
        entry('SELECT 1 LIMIT 5 OFFSET :Value'),
        entry('SELECT :Value LIMIT 5;'),
        entry(undefined, [{ name: 'Value', type: 'money' }]),
        entry(undefined, [{ name: 'query', type: 'text' }]),
        entry(undefined, [
            { name: 'Value', type: 'text' },
            { name: 'Value', type: 'text' }
        ])
    ])
        assert.throws(
            () => compilePinned(e),
            (e) => !!e.code
        )
    assert.doesNotThrow(() => compilePinned(entry('SELECT :Value LIMIT /* comment */ 5')))
})
test('ZZ-TEST- validation returns canonical strings in first-use order', () => {
    const e = entry('SELECT :b, :a, :b LIMIT 1', [
        { name: 'a', type: 'int8', required: true, min: '1', max: '9223372036854775807' },
        { name: 'b', type: 'bool', default: false }
    ])
    assert.deepEqual(validateArgs(e, { a: '00012' }), ['false', '12'])
    for (const args of [{ a: '1; DROP TABLE demo_sales' }, { a: 1.2 }, { a: '9223372036854775808' }, { a: 0 }, { a: 1, extra: 2 }, {}])
        assert.throws(() => validateArgs(e, args), /Expected parameters: a, b/)
    assert.deepEqual(validateArgs(entry(), { Value: "'; DROP TABLE demo_sales" }), ["'; DROP TABLE demo_sales"])
})
test('ZZ-TEST- type parsing rejects ambiguous dates, nonfinite numbers and coercion', () => {
    for (const [type, good, bad] of [
        ['numeric', '1.25', 'NaN'],
        ['date', '2024-02-29', '2023-02-29'],
        ['timestamp', '2024-01-01T23:59:59.123456', '2024-01-01T24:00:00'],
        ['timestamptz', '2024-01-01T12:00:00+02:00', '2024-01-01T12:00:00'],
        ['text', 'hi', 42],
        ['bool', true, 1]
    ]) {
        const e = entry(undefined, [{ name: 'Value', type, required: true }])
        assert.equal(typeof validateArgs(e, { Value: good })[0], 'string')
        assert.throws(() => validateArgs(e, { Value: bad }))
    }
    assert.throws(() => validateArgs(entry(undefined, [{ name: 'Value', type: 'text', allowedValues: ['one'] }]), { Value: 'two' }))
})
test('ZZ-TEST- stamps are canonical, scoped and timing-safe', () => {
    const args = {
        workspaceId: 'ZZ-TEST',
        cred: 'demo',
        statementHash: 'abc',
        params: [],
        tables: ['b', 'a'],
        functions: [],
        testedColumns: []
    }
    const p = stampPayload(args),
        key = Buffer.alloc(32, 7),
        stamp = computeStamp(key, p)
    assert.equal(p, stampPayload({ ...args, tables: ['a', 'b'] }))
    assert.ok(verifyStamp(key, p, stamp))
    assert.ok(!verifyStamp(key, p + 'x', stamp))
    assert.ok(!verifyStamp(key, p, 'a'))
})
test('ZZ-TEST- tool schema and strict flag', () => {
    assert.equal(pinnedToolDefinition(entry()).inputSchema.additionalProperties, false)
    assert.deepEqual(pinnedToolDefinition(entry()).inputSchema.required, ['Value'])
    assert.throws(() => pinnedToolDefinition({ ...entry(), name: 'demo' }))
    for (const value of ['true', '1']) assert.ok(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: value }))
    for (const value of [undefined, 'TRUE', '0', 'false', ' true ', true])
        assert.ok(!pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: value }))
    for (const name of ['pq_demo', 'node__pq_demo']) assert.ok(isPinnedToolName(name))
    for (const name of ['pq_', 'pq_Demo', 'query', 'xpq_demo']) assert.ok(!isPinnedToolName(name))
})
test('ZZ-TEST- trace full hash and UTF-8 safe cap', () => {
    assert.equal(sqlTraceFields(' SELECT 1; ', {}).sqlHash, sqlTraceFields('SELECT 1', {}).sqlHash)
    assert.equal(sqlTraceFields('select 1', {}).sql, undefined)
    const r = sqlTraceFields('a'.repeat(4095) + '😀', { preview: true })
    assert.equal(Buffer.byteLength(r.sql), 4095)
    assert.equal(r.sqlTruncated, true)
    assert.ok(!r.sql.includes('�'))
})

test('ZZ-TEST- identifier adjacency and ten positional sites', () => {
    assert.throws(() => compilePinned(entry('SELECT amount>x:Value LIMIT 1')), /separated/)
    const params = Array.from({ length: 12 }, (_, i) => ({ name: `p${i + 1}`, type: 'int8' }))
    const c = compilePinned(entry(`SELECT ${params.map((p) => ':' + p.name).join(', ')} LIMIT 1`, params))
    assert.equal((c.checkText.match(/NULL::pg_catalog.int8/g) || []).length, 12)
    assert.ok(!c.checkText.includes('$'))
    assert.match(c.runText, /\$12::pg_catalog.int8/)
})
test('ZZ-TEST- bool inputs accept only JSON booleans', () => {
    const e = entry(undefined, [{ name: 'Value', type: 'bool' }])
    for (const Value of ['true', 'false', 'yes', 'on', '1', 't', 1]) assert.throws(() => validateArgs(e, { Value }))
})

test('ZZ-TEST- strict adversarial parameter values and exact numeric bounds', () => {
    const check = (type, value) => validateArgs(entry(undefined, [{ name: 'Value', type, required: true }]), { Value: value })
    for (const v of ['1e3', ' 42', '0x10', '42abc', '9223372036854775808', 1.5, 9007199254740993]) assert.throws(() => check('int8', v))
    for (const v of ['NaN', 'Infinity', '1,000']) assert.throws(() => check('numeric', v))
    for (const v of ['2026-02-30', 'today', 'now', 'epoch', 'infinity', '26-10-2026']) assert.throws(() => check('date', v))
    for (const v of [['EU'], { a: 1 }, 42, true, null]) assert.throws(() => check('text', v))
    for (const k of ['sql', 'statement', 'query', 'cursor', 'page', 'binds', '__proto__', 'constructor'])
        assert.throws(() => validateArgs(entry(), JSON.parse(`{"Value":"ok","${k}":"x"}`)))
    assert.deepEqual(check('numeric', '-0'), ['0'])
    assert.deepEqual(check('numeric', '00125.00'), ['125'])
    const bounded = entry(undefined, [{ name: 'Value', type: 'numeric', min: '9007199254740993.01', max: '9007199254740993.09' }])
    assert.deepEqual(validateArgs(bounded, { Value: '9007199254740993.05' }), ['9007199254740993.05'])
    assert.throws(() => validateArgs(bounded, { Value: '9007199254740993.001' }))
    assert.throws(() => validateArgs(bounded, { Value: '9007199254740993.099' }))
    assert.throws(() => validateArgs(entry(undefined, [{ name: 'Value', type: 'text', allowedValues: ['EU'] }]), { Value: 'eu' }))
})
test('ZZ-TEST- comments end at carriage returns and nested comment parameter discovery agrees', () => {
    assert.deepEqual(compilePinned(entry('SELECT 1 -- ignored\r, :Value LIMIT 1')).order, ['Value'])
    assert.throws(() => compilePinned({ sql: 'SELECT 1 /* /* */ */ :p LIMIT 1' }), /Missing specification/)
    assert.throws(() => compilePinned({ sql: 'SELECT (ARRAY[1,2,3])[1:hi] LIMIT 1' }))
})

test('ZZ-TEST- suggestions require completed checks and clean up both prepared statements on failure', async () => {
    const queries = []
    const client = {
        query: async (arg) => {
            queries.push(arg)
            if (typeof arg === 'object') throw new Error('could not determine data type')
            return { rows: [] }
        }
    }
    await assert.rejects(suggestParamTypes(client, {}, 'SELECT $1 LIMIT 1'), /checks first/)
    assert.equal(queries.length, 0)
    const runner = { pinnedChecksComplete: true, checkedRunSql: 'SELECT $1::pg_catalog.text LIMIT 1' }
    await assert.rejects(suggestParamTypes(client, runner, 'SELECT id FROM other_table WHERE id=$1 LIMIT 1'), /checks first/)
    assert.equal(queries.length, 0)
    assert.equal(await suggestParamTypes(client, runner, 'SELECT $1 LIMIT 1'), null)
    assert.equal(queries[0], 'SAVEPOINT cuttlely_pinned_types')
    assert.match(queries[1].name, /^cuttlely_pinned_types_\d+_parse$/)
    assert.equal(queries[2], 'ROLLBACK TO SAVEPOINT cuttlely_pinned_types')
    assert.ok(queries.some((q) => typeof q === 'string' && /^DEALLOCATE cuttlely_pinned_types_\d+$/.test(q)))
    assert.ok(queries.some((q) => typeof q === 'string' && /^DEALLOCATE cuttlely_pinned_types_\d+_parse$/.test(q)))
    assert.equal(queries.at(-1), 'RELEASE SAVEPOINT cuttlely_pinned_types')
})

test('ZZ-TEST- T1 generated compiler pairs preserve all bytes outside typed spans', async () => {
    const { assertCheckRunPair, PARAM_TYPES } = await import('./pinned-query.mjs')
    const templates = [
        'SELECT :v AS v LIMIT 5',
        'SELECT 1 AS v WHERE :v IS NOT NULL LIMIT 5',
        'WITH c AS (SELECT :v AS v) SELECT v FROM c LIMIT 5',
        'SELECT count(*) AS n HAVING :v IS NOT NULL LIMIT 5',
        'SELECT CASE WHEN :v IS NULL THEN :v ELSE :v END AS v LIMIT 5',
        'SELECT 1 AS n WHERE :v = ANY(ARRAY[:v]) LIMIT 5',
        'SELECT 1 AS n WHERE :v BETWEEN :v AND :v LIMIT 5'
    ]
    for (const type of PARAM_TYPES)
        for (const template of templates) {
            const sql = template.replace(' LIMIT', ' /* :fake $99 */ -- :fake\n LIMIT')
            const e = { sql, params: [{ name: 'v', type }] }
            const c = compilePinned(e)
            assert.equal(c.binds, null)
            const spans = [],
                run = `$1::pg_catalog.${type}`,
                check = `NULL::pg_catalog.${type}`
            let r = 0,
                k = 0
            for (let i = 0; i < (sql.match(/:v\b/g) || []).length; i++) {
                r = c.runText.indexOf(run, r)
                k = c.checkText.indexOf(check, k)
                spans.push({ runStart: r, checkStart: k, index: 1, type })
                r += run.length
                k += check.length
            }
            assert.ok(assertCheckRunPair(c.runText, c.checkText, spans))
            assert.throws(() => assertCheckRunPair(c.runText, c.checkText + ' ', spans))
        }
    for (const site of ['$1', '$12::text', 'a:v', ':v::text', ':v$tail', ':v:other', 'é:v'])
        assert.throws(() => compilePinned({ sql: `SELECT ${site} LIMIT 1`, params: [{ name: 'v', type: 'text' }] }))
    assert.doesNotThrow(() => compilePinned({ sql: "SELECT '$1::text :v' AS v, $$:v$$ AS q LIMIT 1" }))
    assert.throws(() => assertCheckRunPair('SELECT $1', 'SELECT $1', []))
    assert.throws(() => compilePinned({ sql: 'SELECT :v LIMIT 1', params: [{ name: 'v', type: 'text(10)' }] }))
    assert.deepEqual(compilePinned(entry(), { Value: 'demo' }).binds, ['demo'])
})
