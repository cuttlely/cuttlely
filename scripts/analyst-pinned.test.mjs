import '../packages/harness/runtime/pinned-query.test.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import pg from 'pg'
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { checkPinnedEquivalence } from '../packages/harness/runtime/pinned-query-equivalence.mjs'
import { compilePinned } from '../packages/harness/runtime/pinned-query.mjs'
import {
    queryAnalystUrl,
    withAnalystScope,
    setCheckGapHookForTests,
    pgPlaceholders,
    queryUrlPostgres
} from '../packages/harness/runtime/analyst-store.mjs'

const config = (database = 'postgres') => ({
    host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
    port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
    user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || '',
    database,
    connectionTimeoutMillis: 1000
})

test('ZZ-TEST- pinned placeholder offsets preserve JSONB operators', () => {
    const sql = "SELECT tags ? 'vip', tags ?| array['vip'], tags ?& array['vip'] WHERE region=$1 LIMIT ? OFFSET ?"
    assert.equal(pgPlaceholders(sql, [101, 0], 1).sql, sql.replace('LIMIT ? OFFSET ?', 'LIMIT $2 OFFSET $3'))
    assert.equal(pgPlaceholders(sql, [], 1).sql, sql)
})

test('ZZ-TEST- pinned PostgreSQL runtime', async (t) => {
    const admin = new pg.Client(config())
    try {
        await admin.connect()
    } catch (e) {
        await admin.end().catch(() => {})
        if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1') throw e
        t.skip('local disposable PostgreSQL unavailable')
        return
    }
    const database = `zz_test_rt_${process.pid}_${Date.now()}`
    const deniedRole = `zz_test_rt_denied_${process.pid}_${Date.now()}`
    let setup,
        madeRole = false
    try {
        await admin.query(`CREATE DATABASE "${database}"`)
        setup = new pg.Client(config(database))
        await setup.connect()
        await setup.query(`CREATE TABLE demo_sales(id int8, region text, month date, amount numeric, tags jsonb, active bool, tag_list text[], created_at timestamptz);
            INSERT INTO demo_sales SELECT g, 'EU', '2026-01-01'::date, g, '{"vip":true}'::jsonb, true, ARRAY['EU'], '2026-01-01'::timestamptz FROM generate_series(1,300) g;
            CREATE TABLE other_table(id int);
            CREATE TABLE zz_test_utilization(product_family text, month_end date, utilization_pct numeric, account_id int8, mom_change_pp numeric);
            INSERT INTO zz_test_utilization VALUES ('demo', '2026-01-31', 50, 1, 3);
            CREATE FUNCTION public.zz_test_ov(int4) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT ''int4''::text';
            CREATE FUNCTION public.zz_test_ov(numeric) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT ''numeric''::text';
            CREATE FUNCTION public.zz_test_ov(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT ''text''::text';
            CREATE FUNCTION public.date_trunc(text, date) RETURNS timestamp LANGUAGE sql IMMUTABLE AS 'SELECT pg_catalog.date_trunc($1,$2::timestamp)';
            CREATE FUNCTION public.zz_test_rt_eq(text, bigint) RETURNS bool LANGUAGE sql IMMUTABLE AS 'SELECT length($1)::bigint=$2';
            CREATE OPERATOR public.= (LEFTARG=text, RIGHTARG=bigint, FUNCTION=public.zz_test_rt_eq);`)
        await t.test('check copy and bound run resolve the same objects', (st) => checkPinnedEquivalence(st, setup))
        await setup.query(
            'DROP OPERATOR public.= (text,bigint); DROP FUNCTION public.zz_test_rt_eq(text,bigint); DROP FUNCTION public.date_trunc(text,date)'
        )
        const c = config(database)
        const target = new URL(`postgresql://${c.host}:${c.port}/${database}`)
        target.username = c.user
        target.password = c.password
        const url = target.href
        const options = {
            readOnlySql: true,
            relations: ['public.demo_sales'],
            rowCap: 100,
            scope: 'ZZ-TEST-runtime',
            env: { ...process.env, CUTTLELY_PINNED_QUERIES: '1' }
        }
        const entry = {
            id: 'ZZ-TEST-pin',
            name: 'pq_sales',
            version: 1,
            sql: `SELECT id, region FROM demo_sales WHERE tags ? 'vip' AND tags ?| array['vip'] AND tags ?& array['vip'] AND region=:r ORDER BY id LIMIT 300`,
            params: [{ name: 'r', type: 'text', required: true }]
        }
        const compiled = compilePinned(entry)
        const pin = { id: entry.id, version: 1, statementHash: compiled.statementHash, tool: entry.name }
        const bound = { ...options, pinned: { entry, args: { r: 'EU' }, tool: entry.name } }
        await t.test('exported PostgreSQL store compiles the entry internally', async () => {
            const result = await queryUrlPostgres(
                url,
                'SELECT * FROM other_table LIMIT 1',
                null,
                undefined,
                options.env,
                options.relations,
                bound
            )
            assert.equal(result.rows.length, 100)
            assert.equal(result.rows[0].region, 'EU')
        })
        await t.test("possiblyTruncated compares the statement's own LIMIT", async () => {
            for (const limit of [300, 100]) {
                const e = { ...entry, sql: `SELECT id FROM demo_sales WHERE region=:r AND id <= 200 ORDER BY id LIMIT ${limit}` }
                const pinned = { entry: e, args: { r: 'EU' }, tool: e.name }
                const first = await queryAnalystUrl(url, null, { ...options, pinned })
                const expectedPin = { id: e.id, version: e.version, statementHash: compilePinned(e).statementHash, tool: e.name }
                assert.equal(first.rows.length, 100)
                assert.equal(first.possiblyTruncated, limit === 100)
                assert.deepEqual(first.pinned, expectedPin)
                assert.equal(first.truncated, limit === 300)
                if (limit === 300) {
                    assert.ok(first.cursor)
                    const second = await queryAnalystUrl(url, { cursor: first.cursor }, { ...options, pinned })
                    assert.equal(second.rows[0].id, '101')
                    assert.equal(second.possiblyTruncated, false)
                    assert.deepEqual(second.pinned, expectedPin)
                }
            }
            const free = await queryAnalystUrl(url, 'SELECT id FROM demo_sales LIMIT 100', options)
            assert.ok(!Object.hasOwn(free, 'possiblyTruncated'))
            assert.ok(!Object.hasOwn(free, 'pinned'))
        })
        await t.test('pinned call without readOnlySql is refused', async () => {
            for (const extra of [{ pinned: pin }, { binds: ['EU'] }, { checkText: compiled.checkText }]) {
                await assert.rejects(queryAnalystUrl(url, compiled.runText, extra), /readOnlySql/)
                await assert.rejects(queryUrlPostgres(url, compiled.runText, null, undefined, process.env, [], extra), /readOnlySql/)
            }
        })
        await t.test('caller binds on replay are refused', async () => {
            await assert.rejects(
                queryUrlPostgres(
                    url,
                    compiled.runText,
                    { plan: { statement: compiled.runText, binds: ['EU'] }, paging: {} },
                    undefined,
                    process.env,
                    [],
                    { readOnlySql: true, binds: ['EU'] }
                ),
                /Caller-supplied/
            )
        })
        await t.test('check copy and bound run are separate on first call and replay; binds never reach begin()', async () => {
            const original = pg.Client.prototype.query,
                sent = [],
                probes = [],
                lengths = []
            pg.Client.prototype.query = function (...args) {
                sent.push(args)
                const pending = original.apply(this, args)
                const text = typeof args[0] === 'string' ? args[0] : args[0].text
                if (text.includes('pg_typeof')) pending.then((r) => probes.push(r.rows[0]))
                if (text.includes('analyst_line_len')) pending.then((r) => lengths.push(r.rows.length))
                return pending
            }
            try {
                const first = await queryAnalystUrl(url, null, { ...options, pinned: { entry, args: { r: 'EU' }, tool: entry.name } })
                await queryAnalystUrl(url, { cursor: first.cursor }, { ...options, pinned: { entry, args: { r: 'US' }, tool: entry.name } })
                const calls = sent.map(([q, values]) => ({ text: typeof q === 'string' ? q : q.text, values: values ?? q.values ?? [] }))
                assert.ok(probes.length > 0)
                for (const row of probes) assert.ok(Object.values(row).every((type) => type != null))
                assert.ok(lengths.includes(300))
                const pages = calls.filter((q) => q.text.includes('AS analyst_page'))
                assert.equal(pages.length, 2)
                assert.deepEqual(pages[0].values, ['EU', 101, 0])
                assert.deepEqual(pages[1].values, ['EU', 101, 100])
                for (const q of calls.filter((q) => /CREATE TEMP.*VIEW/i.test(q.text))) {
                    assert.ok(!q.text.includes('$1::pg_catalog.text'))
                    assert.equal(q.values.length, 0)
                }
                for (const q of calls.filter((q) => /^BEGIN/.test(q.text))) {
                    assert.equal(q.values.length, 0)
                    assert.ok(!q.text.includes('EU'))
                }
                const boundCalls = calls.filter((q) => q.text.includes('$1::pg_catalog.text'))
                assert.ok(boundCalls.some((q) => q.text.includes('COUNT(*) AS analyst_n')))
                assert.ok(boundCalls.some((q) => q.text.includes('pg_typeof')))
                assert.ok(boundCalls.some((q) => q.text.includes('analyst_line_len')))
                for (const q of boundCalls) {
                    assert.equal(q.values[0], 'EU')
                    for (const op of ["tags ? 'vip'", "tags ?| array['vip']", "tags ?& array['vip']"]) assert.ok(q.text.includes(op))
                }
            } finally {
                pg.Client.prototype.query = original
            }
        })
        await t.test('cursor-only replay of a pin with a required parameter reuses its binds', async () => {
            const pinned = { entry, tool: entry.name }
            const first = await queryAnalystUrl(url, null, { ...options, pinned: { ...pinned, args: { r: 'EU' } } })
            assert.ok(first.cursor)
            for (const changed of [
                { entry: { ...entry, id: 'other' } },
                { entry: { ...entry, version: 2 } },
                { entry: { ...entry, sql: entry.sql.replace('LIMIT 300', 'LIMIT 299') } },
                { tool: 'pq_other' }
            ])
                await assert.rejects(
                    queryAnalystUrl(url, { cursor: first.cursor }, { ...options, pinned: { ...pinned, ...changed } }),
                    /changed|another tool/
                )
            const second = await queryAnalystUrl(url, { cursor: first.cursor }, { ...options, pinned })
            assert.equal(second.rows.length, 100)
            assert.equal(second.rows[0].id, '101')
            assert.ok(second.rows.every((row) => row.region === 'EU'))
            assert.match(second.summary, /of 300.*page 2 of 3/)
        })
        await t.test('check-copy parse error is refused', async () => {
            await assert.rejects(
                queryAnalystUrl(url, null, { ...options, pinned: { entry: { sql: 'SELECT FROM WHERE LIMIT 1' } } }),
                /syntax error/
            )
        })
        await t.test('CASE branch reading an unticked relation is refused', async () => {
            const e = {
                sql: 'SELECT CASE WHEN :flag THEN (SELECT id FROM other_table LIMIT 1) ELSE 0 END AS v LIMIT 1',
                params: [{ name: 'flag', type: 'bool' }]
            }
            await assert.rejects(
                queryAnalystUrl(url, null, { ...options, pinned: { entry: e, args: { flag: false }, tool: 'pq_case' } }),
                /selected|allowed|outside|table/i
            )
        })
        await t.test('hostile operator is refused by routine checks', async () => {
            const e = { sql: 'SELECT id FROM demo_sales WHERE region=:n LIMIT 1', params: [{ name: 'n', type: 'int8' }] }
            await setup.query(
                "CREATE FUNCTION public.zz_test_eq(text,bigint) RETURNS bool LANGUAGE sql IMMUTABLE AS 'SELECT true'; CREATE OPERATOR public.= (LEFTARG=text,RIGHTARG=bigint,FUNCTION=public.zz_test_eq)"
            )
            try {
                await assert.rejects(
                    queryAnalystUrl(url, null, { ...options, pinned: { entry: e, args: { n: '1' }, tool: 'pq_op' } }),
                    /operator public\.= \(named like a built-in\)/
                )
            } finally {
                await setup.query('DROP OPERATOR public.= (text,bigint); DROP FUNCTION public.zz_test_eq(text,bigint)')
            }
        })
        await t.test('binds reach page, count, type probe and length pass (300 rows)', async () => {
            const times = []
            const first = await withAnalystScope('ZZ-TEST-runtime', () => queryAnalystUrl(url, compiled.runText, bound), { timings: times })
            assert.equal(first.rows.length, 100)
            assert.equal(first.truncated, true)
            assert.match(first.summary, /of 300.*page 1 of 3/)
            assert.ok(first.cursor)
            const second = await queryAnalystUrl(url, { cursor: first.cursor }, bound)
            assert.equal(second.rows[0].id, '101')
            assert.match(second.summary, /page 2 of 3/)
            const third = await queryAnalystUrl(url, { cursor: first.cursor }, bound)
            assert.equal(third.rows[0].id, '201')
            assert.match(third.summary, /page 3 of 3/)
            for (const field of ['dbMs', 'guardMs', 'roundTrips']) assert.equal(typeof times[0][field], 'number')
            const freeTimes = []
            await withAnalystScope(
                'ZZ-TEST-runtime',
                () => queryAnalystUrl(url, entry.sql.replace(':r', "'EU'::pg_catalog.text"), options),
                { timings: freeTimes }
            )
            assert.equal(times[0].roundTrips, freeTimes[0].roundTrips)
        })
        await t.test('free SQL page, count, probe, length and replay match the ae8394e7 golden', async () => {
            // Generated from the unmodified ae8394e7 runner, including SQL bytes and values.
            // Only disposable relation/view OIDs and the prepared statement sequence vary per run.
            const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/pinned/free-sql-ae8394e7.json', import.meta.url)))
            const oid = (await setup.query("SELECT 'demo_sales'::regclass::oid AS oid")).rows[0].oid
            const original = pg.Client.prototype.query
            let sent = []
            pg.Client.prototype.query = function (...args) {
                sent.push(args)
                return original.apply(this, args)
            }
            const digest = () => {
                const normalized = JSON.stringify(
                    sent.map(([q, values]) =>
                        typeof q === 'string'
                            ? [q, q.includes('WHERE r.ev_class = $1::oid') ? ['SCOPE_VIEW_OID'] : values ?? []]
                            : [{ ...q, values: undefined }, q.values ?? values ?? []]
                    )
                )
                    .replace(/cuttlely_scope_check_\d+/g, 'cuttlely_scope_check_SEQ')
                    .replaceAll(String(oid), 'FIXTURE_OID')
                return createHash('sha256').update(normalized).digest('hex')
            }
            try {
                const opts = options
                await queryAnalystUrl(url, 'SELECT id FROM demo_sales WHERE id=1 LIMIT 1', opts)
                assert.equal(digest(), golden.small)
                sent = []
                const first = await queryAnalystUrl(url, 'SELECT id, region FROM demo_sales ORDER BY id LIMIT 300', opts)
                assert.equal(digest(), golden.paged)
                sent = []
                await queryAnalystUrl(url, { cursor: first.cursor }, opts)
                assert.equal(digest(), golden.replay)
            } finally {
                pg.Client.prototype.query = original
            }
        })
        await t.test('free SQL sends byte-identical statements', async () => {
            const original = pg.Client.prototype.query
            let sent = []
            pg.Client.prototype.query = function (...args) {
                sent.push(structuredClone(args))
                return original.apply(this, args)
            }
            try {
                const input = 'SELECT id FROM demo_sales WHERE id=1 LIMIT 1'
                const stable = (calls) =>
                    JSON.stringify(calls.map((args) => (typeof args[0] === 'string' ? args[0] : args[0].text))).replace(
                        /cuttlely_scope_check_\d+/g,
                        'cuttlely_scope_check_SEQ'
                    )
                const first = await queryAnalystUrl(url, input, { ...options, env: {} }),
                    before = sent
                sent = []
                const second = await queryAnalystUrl(url, input, { ...options, env: { ...process.env, CUTTLELY_PINNED_QUERIES: 'true' } })
                assert.equal(JSON.stringify(first), JSON.stringify(second))
                const afterFlag = sent
                sent = []
                const third = await queryAnalystUrl(url, input, { ...options, env: {}, binds: [], checkText: null })
                assert.equal(JSON.stringify(third), JSON.stringify(first))
                const emptyBinds = sent
                // Without readOnlySql too: binds: [] keeps the plain free-SQL call, on both exported stores.
                const { readOnlySql: _readOnly, ...plain } = options
                // Without readOnlySql the scope check is cached per store; warm it so both measured calls start alike.
                sent = []
                await queryAnalystUrl(url, input, { ...plain, env: {} })
                sent = []
                const plainFirst = await queryAnalystUrl(url, input, { ...plain, env: {} }),
                    plainSent = sent
                sent = []
                assert.equal(
                    JSON.stringify(await queryAnalystUrl(url, input, { ...plain, env: {}, binds: [] })),
                    JSON.stringify(plainFirst)
                )
                assert.equal(stable(sent), stable(plainSent))
                sent = []
                const direct = await queryUrlPostgres(url, input, null, undefined, {}, plain.relations, {}),
                    directSent = sent
                sent = []
                assert.equal(
                    JSON.stringify(await queryUrlPostgres(url, input, null, undefined, {}, plain.relations, { binds: [] })),
                    JSON.stringify(direct)
                )
                assert.equal(stable(sent), stable(directSent))
                sent = afterFlag
                assert.equal(stable(sent), stable(before))
                assert.equal(stable(emptyBinds), stable(before))
            } finally {
                pg.Client.prototype.query = original
            }
        })
        await t.test('cursor from another pq_ tool is refused', async () => {
            const first = await queryAnalystUrl(url, compiled.runText, bound)
            for (const pinned of [
                { ...bound.pinned, entry: { ...entry, version: 2 } },
                { ...bound.pinned, entry: { ...entry, sql: entry.sql.replace('300', '299') } },
                { ...bound.pinned, tool: 'pq_other' },
                undefined
            ]) {
                await assert.rejects(queryAnalystUrl(url, { cursor: first.cursor }, { ...bound, pinned }), /changed|another tool/)
            }
        })
        await t.test('text injection remains a value and tables stay intact', async () => {
            const result = await queryAnalystUrl(url, compiled.runText, {
                ...bound,
                pinned: { ...bound.pinned, args: { r: "'; DROP TABLE demo_sales; --" } }
            })
            assert.deepEqual(result.rows, [])
            assert.equal((await setup.query('SELECT count(*) FROM demo_sales')).rows[0].count, '300')
        })
        await t.test('unticked relations and risky casts are refused', async () => {
            for (const sql of [
                'SELECT id FROM other_table WHERE id=:n LIMIT 1',
                'SELECT :n::regclass LIMIT 1',
                'SELECT id FROM demo_sales WHERE id::oid=:n LIMIT 1'
            ]) {
                const e = { sql, params: [{ name: 'n', type: 'int8' }] }
                await assert.rejects(
                    async () => {
                        compilePinned(e)
                        await queryAnalystUrl(url, null, { ...options, pinned: { entry: e, args: { n: '1' } } })
                    },
                    undefined,
                    sql
                )
            }
        })
        await t.test('catalog change after the check is refused', async () => {
            setCheckGapHookForTests(async () => {
                await setup.query("CREATE FUNCTION public.zz_test_rt_fn(int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1'")
            })
            try {
                await assert.rejects(queryAnalystUrl(url, compiled.runText, bound), /changed/)
            } finally {
                setCheckGapHookForTests(null)
                await setup.query('DROP FUNCTION IF EXISTS public.zz_test_rt_fn(int)')
            }
        })
        await t.test('type suggestions run after checks and map supported scalar types', async () => {
            const e = {
                sql: 'SELECT id FROM demo_sales WHERE region=:r AND amount>:a AND month>:d AND active=:b LIMIT 1',
                params: [
                    { name: 'r', type: 'text' },
                    { name: 'a', type: 'numeric' },
                    { name: 'd', type: 'date' },
                    { name: 'b', type: 'bool' }
                ]
            }
            const result = await queryAnalystUrl(url, null, {
                ...options,
                pinned: { entry: e },
                suggestTypesSql: 'SELECT id FROM demo_sales WHERE region=($1) AND amount>($2) AND month>($3) AND active=($4) LIMIT 1'
            })
            assert.deepEqual(result.paramTypes, ['text', 'numeric', 'date', 'bool'])
            // The editor sends temporary text parameters; typed comparisons still get their real types.
            const fromText = await queryAnalystUrl(url, null, {
                ...options,
                pinned: { entry: { ...e, params: e.params.map(({ name }) => ({ name, type: 'text' })) } },
                suggestTypesSql: 'SELECT id FROM demo_sales WHERE region=($1) AND amount>($2) AND month>($3) AND active=($4) LIMIT 1'
            })
            assert.deepEqual(fromText.paramTypes, ['text', 'numeric', 'date', 'bool'])
            const ambiguous = await queryAnalystUrl(url, null, {
                ...options,
                pinned: {
                    entry: { sql: 'SELECT id FROM demo_sales WHERE :r IS NULL OR region=:r LIMIT 1', params: [{ name: 'r', type: 'text' }] }
                },
                suggestTypesSql: 'SELECT id FROM demo_sales WHERE ($1) IS NULL OR region=($1) LIMIT 1'
            })
            assert.equal(ambiguous.paramTypes, null)
            const required = await queryAnalystUrl(url, null, {
                ...options,
                pinned: {
                    entry: {
                        sql: 'SELECT id FROM demo_sales WHERE region=:r LIMIT 1',
                        params: [{ name: 'r', type: 'text', required: true }]
                    }
                },
                suggestTypesSql: 'SELECT id FROM demo_sales WHERE region=($1) LIMIT 1'
            })
            assert.deepEqual(required.paramTypes, ['text'])
            await assert.rejects(
                queryAnalystUrl(url, 'SELECT id FROM other_table LIMIT 1', {
                    ...options,
                    suggestTypesSql: 'SELECT id FROM other_table WHERE id=$1 LIMIT 1'
                })
            )
        })
        await t.test('suggestions cannot bypass the login table grants', async () => {
            // CI servers use password auth, so the throwaway role gets a random one.
            const deniedSecret = randomBytes(18).toString('hex')
            await admin.query(`CREATE ROLE "${deniedRole}" LOGIN PASSWORD '${deniedSecret}'`)
            madeRole = true
            const deniedUrl = new URL(url)
            deniedUrl.username = deniedRole
            deniedUrl.password = deniedSecret
            await assert.rejects(
                queryAnalystUrl(deniedUrl.toString(), compiled.runText, { ...bound, suggestTypesSql: entry.sql.replaceAll(':r', '($1)') }),
                /selected|read|permission|no longer/i
            )
        })
        await t.test('adversarial stored SQL is refused by the compiler or ordinary node guard', async () => {
            for (const sql of [
                'SELECT * FROM demo_sales WHERE region=:r LIMIT 100; DROP TABLE demo_sales',
                'WITH d AS (DELETE FROM demo_sales RETURNING *) SELECT * FROM d LIMIT 1',
                'WITH u AS (UPDATE demo_sales SET amount=0 WHERE region=:r RETURNING id) SELECT * FROM u LIMIT 1',
                'SET search_path=evil',
                'RESET ALL',
                "SELECT set_config('search_path','evil',false) LIMIT 1",
                'DO $$BEGIN DELETE FROM demo_sales; END$$',
                'SELECT pg_advisory_lock(1) LIMIT 1',
                'SELECT pg_try_advisory_lock(:n) LIMIT 1',
                "SELECT nextval('demo_sales_id_seq') LIMIT 1",
                'SELECT pg_sleep(30) LIMIT 1',
                "SELECT pg_notify('c',:r) LIMIT 1",
                "SELECT query_to_xml('delete from demo_sales',true,true,'') LIMIT 1",
                "SELECT dblink('x','x') LIMIT 1",
                "SELECT lo_import('/etc/passwd') LIMIT 1",
                "SELECT pg_read_file('x') LIMIT 1",
                'SELECT * FROM pg_authid LIMIT 1',
                'SELECT public.audit_touch(:r) LIMIT 1',
                'SELECT * FROM demo_sales WHERE id=$1 LIMIT 5',
                'SELECT * FROM demo_sales LIMIT :n',
                'SELECT * FROM demo_sales LIMIT 10 OFFSET :n',
                'SELECT * FROM demo_sales WHERE region=:r',
                'PREPARE x AS SELECT 1',
                'EXECUTE x',
                'DEALLOCATE ALL',
                'SELECT 1 AS x LIMIT 1;',
                'SELECT 1 AS x LIMIT 1；'
            ]) {
                const params = []
                if (sql.includes(':r')) params.push({ name: 'r', type: 'text' })
                if (sql.includes(':n')) params.push({ name: 'n', type: 'int8' })
                await assert.rejects(
                    async () => {
                        await queryAnalystUrl(url, null, {
                            ...options,
                            pinned: {
                                entry: { sql, params },
                                args: Object.fromEntries(params.map((p) => [p.name, p.type === 'text' ? 'EU' : '1']))
                            }
                        })
                    },
                    undefined,
                    sql
                )
            }
        })
        await t.test('inert comments and dollar strings stay inert', async () => {
            for (const sql of [
                'SELECT 1 AS x LIMIT 1 /* ; DELETE FROM demo_sales */',
                'SELECT 1 AS x /* /* */ ; */ LIMIT 1',
                'SELECT 1 AS x -- :p\nLIMIT 1',
                "SELECT ':r' AS a, $$:r$$ AS b, $q$ :r $q$ AS c LIMIT 1"
            ]) {
                const q = compilePinned({ sql })
                assert.equal((await queryAnalystUrl(url, q.runText, { ...options, pinned: { entry: { sql } } })).rows.length, 1)
            }
        })
        await t.test('NUL text becomes an expected error', async () => {
            await assert.rejects(
                queryAnalystUrl(url, compiled.runText, { ...bound, pinned: { ...bound.pinned, args: { r: 'a\u0000b' } } }),
                (e) => e.cuttlelyOutcome === 'expected'
            )
        })
        await t.test('bound query honours timeout', async () => {
            const e = { sql: 'SELECT sum(g) AS total FROM generate_series(1, :n) g LIMIT 1', params: [{ name: 'n', type: 'int8' }] },
                q = compilePinned(e)
            await assert.rejects(
                queryAnalystUrl(url, q.runText, {
                    ...options,
                    relations: [],
                    pinned: { entry: e, args: { n: '100000000' } },
                    statementTimeoutMs: 1000
                }),
                /timeout/
            )
        })
    } finally {
        setCheckGapHookForTests(null)
        if (setup) await setup.end()
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        if (madeRole) await admin.query(`DROP ROLE "${deniedRole}"`)
        await admin.end()
    }
})

test('ZZ-TEST- exported stores refuse caller pairs before any query executes', async () => {
    const original = pg.Client.prototype.query
    let calls = 0
    pg.Client.prototype.query = function () {
        calls++
        throw new Error('unexpected query')
    }
    try {
        const options = { readOnlySql: true, binds: [], checkText: 'SELECT 1 LIMIT 1' }
        await assert.rejects(queryAnalystUrl('unused', 'SELECT * FROM other_table LIMIT 1', options), /Caller-supplied/)
        await assert.rejects(
            queryAnalystUrl('unused', 'SELECT * FROM other_table WHERE id=$1 LIMIT 1', { readOnlySql: true, binds: ['1'] }),
            /Caller-supplied/
        )
        await assert.rejects(
            queryUrlPostgres('unused', 'SELECT * FROM other_table LIMIT 1', null, undefined, process.env, [], options),
            /Caller-supplied/
        )
        await assert.rejects(
            queryUrlPostgres(
                'unused',
                'SELECT 1 LIMIT 1',
                { plan: { statement: 'SELECT * FROM other_table LIMIT 1', checkText: 'SELECT 1 LIMIT 1' } },
                undefined,
                process.env,
                [],
                { readOnlySql: true }
            ),
            /server-held cursor/
        )
        assert.equal(calls, 0)
    } finally {
        pg.Client.prototype.query = original
    }
})
test('ZZ-TEST- a pinned call without a saved entry fails closed before any query executes', async () => {
    const original = pg.Client.prototype.query
    let calls = 0
    pg.Client.prototype.query = function () {
        calls++
        throw new Error('unexpected query')
    }
    try {
        const env = { CUTTLELY_PINNED_QUERIES: '1' }
        for (const pinned of [true, { tool: 'pq_demo' }, { id: 'demo', version: 1, statementHash: 'a'.repeat(64), tool: 'pq_demo' }]) {
            await assert.rejects(queryAnalystUrl('unused', 'SELECT 1 LIMIT 1', { readOnlySql: true, env, pinned }), /pinned\.entry/)
            await assert.rejects(
                queryUrlPostgres('unused', 'SELECT 1 LIMIT 1', null, undefined, env, [], { readOnlySql: true, pinned }),
                /pinned\.entry/
            )
        }
        assert.equal(calls, 0)
    } finally {
        pg.Client.prototype.query = original
    }
})
test('ZZ-TEST- flag off refuses pins and suggestions before connecting', async () => {
    for (const value of [undefined, '0', 'TRUE', 'false', ' true '])
        for (const extra of [{ pinned: { entry: { sql: 'SELECT 1 LIMIT 1' } } }, { suggestTypesSql: 'SELECT $1 LIMIT 1' }])
            await assert.rejects(
                queryAnalystUrl('unused', null, { readOnlySql: true, env: { CUTTLELY_PINNED_QUERIES: value }, ...extra }),
                /Pinned queries are turned off on this server\./
            )
})
