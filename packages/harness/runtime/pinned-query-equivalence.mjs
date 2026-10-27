import assert from 'node:assert/strict'
import { compilePinned, validateArgs } from './pinned-query.mjs'

// Constructs from the pinned-query equivalence spike, exercised on the CI PG matrix.
const CASES = [
    ['placeholder followed by cast', 'SELECT id FROM demo_sales WHERE id = :id::int4 LIMIT 1', { id: 'int8' }, { id: '1' }],
    [
        'V07 fixture shape',
        "WITH p AS (SELECT lower(product_family) AS pf, MAX(month_end) AS m FROM zz_test_utilization WHERE utilization_pct IS NOT NULL GROUP BY 1),\nr AS (SELECT p.pf, u.account_id, u.mom_change_pp FROM zz_test_utilization u JOIN p ON lower(u.product_family) = p.pf AND u.month_end = p.m WHERE u.utilization_pct IS NOT NULL AND u.mom_change_pp IS NOT NULL),\na AS (SELECT pf, account_id, MAX(mom_change_pp) AS mx, MIN(mom_change_pp) AS mn, BOOL_AND(mom_change_pp = 0) AS flat FROM r GROUP BY 1,2)\nSELECT p.pf AS product_family, p.m AS latest_month, (p.m - INTERVAL '1 month')::date AS prior_month, :threshold_pp AS threshold_pp, COUNT(a.account_id) AS accounts_with_change_value,\n  COUNT(*) FILTER (WHERE a.mx > :threshold_pp) AS accounts_up_over_threshold, COUNT(*) FILTER (WHERE a.mn < -:threshold_pp) AS accounts_down_over_threshold, COUNT(*) FILTER (WHERE a.flat) AS accounts_no_change, CASE WHEN COUNT(a.account_id) = 0 THEN 'no month-over-month data' ELSE '' END AS mom_data_note FROM p LEFT JOIN a ON a.pf = p.pf GROUP BY p.pf, p.m ORDER BY p.pf LIMIT 20",
        { threshold_pp: 'numeric' },
        { threshold_pp: '50' }
    ],
    ['overload int4 numeric text', 'SELECT public.zz_test_ov(:v) AS v LIMIT 1', { v: 'int8' }, { v: '1' }],
    ['literal positional text', "SELECT '$1::text' AS literal, :v AS v LIMIT 1", { v: 'text' }, { v: 'demo' }],
    ['varchar unknown literal', "SELECT region::varchar = :v AS eq FROM demo_sales WHERE :v='EU' LIMIT 1", { v: 'text' }, { v: 'EU' }],
    [
        'CTE HAVING SELECT',
        'WITH c AS (SELECT :v AS v) SELECT :v AS v, count(*) AS n FROM c HAVING count(*)>:n LIMIT 1',
        { v: 'text', n: 'int8' },
        { v: 'EU', n: '0' }
    ],
    [
        'unticked CASE branch',
        'SELECT CASE WHEN :v THEN (SELECT id FROM other_table LIMIT 1) ELSE 0 END AS v LIMIT 1',
        { v: 'bool' },
        { v: false }
    ],

    [
        'eq date + group',
        `SELECT region, sum(amount) AS total FROM demo_sales WHERE month = :month GROUP BY region LIMIT 100`,
        { month: 'date' },
        { month: '2026-03-01' }
    ],
    [
        'numeric arith',
        `SELECT id FROM demo_sales WHERE amount > :min * 1.5 AND amount - :min < 1000 LIMIT 100`,
        { min: 'numeric' },
        { min: '10' }
    ],
    [
        'polymorphic coalesce/greatest/nullif',
        `SELECT coalesce(:fallback, amount) AS a, greatest(:floor, amount) AS g, nullif(region, :blank) AS r FROM demo_sales LIMIT 100`,
        { fallback: 'numeric', floor: 'numeric', blank: 'text' },
        { fallback: '1', floor: '50', blank: 'east' }
    ],
    [
        'polymorphic arrays',
        `SELECT array_position(ARRAY['east','west'], :region) AS p, ARRAY[:region, region] AS arr, cardinality(array_remove(ARRAY[region], :region)) AS c FROM demo_sales LIMIT 100`,
        { region: 'text' },
        { region: 'west' }
    ],
    [
        'ANY array ctor + column',
        `SELECT id FROM demo_sales WHERE region = ANY(ARRAY[:r1, :r2]) OR :r1 = ANY(tag_list) LIMIT 100`,
        { r1: 'text', r2: 'text' },
        { r1: 'east', r2: 'north' }
    ],
    [
        'IN list mixed literal',
        `SELECT id FROM demo_sales WHERE region IN (:r1, :r2, 'north') AND id NOT IN (:x, 3) LIMIT 100`,
        { r1: 'text', r2: 'text', x: 'int8' },
        { r1: 'east', r2: 'west', x: '7' }
    ],
    [
        'CASE searched + simple',
        `SELECT CASE WHEN amount > :t THEN 'hi' ELSE 'lo' END AS band, CASE :mode WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END AS m FROM demo_sales LIMIT 100`,
        { t: 'numeric', mode: 'text' },
        { t: '100', mode: 'b' }
    ],
    [
        'unknown-literal compares',
        `SELECT id, :label || '-suffix' AS l, :n + 1 AS n1 FROM demo_sales WHERE :region = 'east' OR '2026-01-01' <= :d LIMIT 100`,
        { label: 'text', n: 'int8', region: 'text', d: 'date' },
        { label: 'x', n: '4', region: 'east', d: '2026-02-01' }
    ],
    [
        'timestamp vs timestamptz col',
        `SELECT id, date_trunc('month', :ts) AS m, :ts AT TIME ZONE 'UTC' AS z FROM demo_sales WHERE created_at >= :since AND created_at < :until LIMIT 100`,
        { ts: 'timestamptz', since: 'timestamp', until: 'timestamptz' },
        { ts: '2026-03-04T10:00:00Z', since: '2026-01-01 00:00:00', until: '2027-01-01T00:00:00Z' }
    ],
    [
        'date vs timestamp mix',
        `SELECT id FROM demo_sales WHERE month >= :d - interval '1 month' AND month + (:days * interval '1 day') > :d LIMIT 100`,
        { d: 'date', days: 'int8' },
        { d: '2026-04-01', days: '3' }
    ],
    [
        'bool',
        `SELECT id FROM demo_sales WHERE active = :flag OR (:flag AND region = 'x') OR (active IS DISTINCT FROM :flag) LIMIT 100`,
        { flag: 'bool' },
        { flag: true }
    ],
    [
        'patterns',
        `SELECT id FROM demo_sales WHERE region LIKE :pat OR region ILIKE :pat OR region ~ :re OR region SIMILAR TO :pat LIMIT 100`,
        { pat: 'text', re: 'text' },
        { pat: 'ea%', re: '^w' }
    ],
    [
        'jsonb ? ?| ?& ->> @>',
        `SELECT id, tags ->> :key AS v FROM demo_sales WHERE tags ? :key OR tags ?| ARRAY[:key, 'vip'] OR tags ?& ARRAY['vip'] OR tags @> jsonb_build_object('tier', :v) OR to_jsonb(:v) IS NULL LIMIT 100`,
        { key: 'text', v: 'text' },
        { key: 'tier', v: 'gold' }
    ],
    [
        'variadic any',
        `SELECT format('%s-%s', :a, region) AS f, concat(:a, amount, :n) AS c, concat_ws(',', :a, region) AS w FROM demo_sales LIMIT 100`,
        { a: 'text', n: 'int8' },
        { a: 'Z', n: '9' }
    ],
    [
        'aggregates filter + ordered-set',
        `SELECT region, sum(amount) FILTER (WHERE amount > :min) AS s, percentile_cont(:p) WITHIN GROUP (ORDER BY amount) AS pc, count(*) FILTER (WHERE region = :r) AS c FROM demo_sales GROUP BY region LIMIT 100`,
        { min: 'numeric', p: 'numeric', r: 'text' },
        { min: '5', p: '0.5', r: 'east' }
    ],
    [
        'window + rank filter',
        `SELECT * FROM (SELECT region, amount, rank() OVER (PARTITION BY region ORDER BY amount DESC) AS rnk, sum(amount) OVER (PARTITION BY region) AS s FROM demo_sales WHERE amount > :min) t WHERE rnk <= :n LIMIT 20`,
        { min: 'numeric', n: 'int8' },
        { min: '0', n: '3' }
    ],
    [
        'subqueries + CTE + LATERAL + EXISTS',
        `WITH f AS (SELECT * FROM demo_sales WHERE region = :r) SELECT f.id, (SELECT max(amount) FROM demo_sales d WHERE d.region = :r) AS mx, l.c FROM f, LATERAL (SELECT count(*) AS c FROM demo_sales d2 WHERE d2.amount > f.amount - :delta) l WHERE EXISTS (SELECT 1 FROM demo_sales e WHERE e.id = f.id AND e.month >= :d) AND f.id IN (SELECT id FROM demo_sales WHERE amount > :delta) LIMIT 100`,
        { r: 'text', delta: 'numeric', d: 'date' },
        { r: 'east', delta: '10', d: '2026-01-01' }
    ],
    [
        'UNION type resolution',
        `SELECT :label AS region, :n AS amount UNION ALL SELECT region, amount FROM demo_sales LIMIT 100`,
        { label: 'text', n: 'numeric' },
        { label: 'TOTAL', n: '0' }
    ],
    ['UNION int8 vs numeric', `SELECT :n AS v UNION ALL SELECT amount FROM demo_sales LIMIT 100`, { n: 'int8' }, { n: '5' }],
    [
        'BETWEEN / SYMMETRIC / IS NULL',
        `SELECT id FROM demo_sales WHERE amount BETWEEN :lo AND :hi OR amount BETWEEN SYMMETRIC :hi AND :lo OR :lo IS NULL LIMIT 100`,
        { lo: 'numeric', hi: 'numeric' },
        { lo: '1', hi: '50' }
    ],
    [
        'generate_series SRF in FROM',
        `SELECT g::date AS m, (SELECT sum(amount) FROM demo_sales WHERE month = g::date) AS s FROM generate_series(:start, :stop, interval '1 month') AS g LIMIT 100`,
        { start: 'timestamp', stop: 'timestamp' },
        { start: '2026-01-01 00:00:00', stop: '2026-06-01 00:00:00' }
    ],
    [
        'repeated param',
        `SELECT id FROM demo_sales WHERE region = :r OR upper(region) = upper(:r) OR :r = '' LIMIT 100`,
        { r: 'text' },
        { r: 'east' }
    ],
    [
        'user cast after param',
        `SELECT id FROM demo_sales WHERE id = :id::int4 OR month = :s::date LIMIT 5`,
        { id: 'int8', s: 'text' },
        { id: '3', s: '2026-03-01' }
    ],
    [
        'VALUES + row compare',
        `SELECT v.a, v.b FROM (VALUES (:a, :b), ('z', 2)) AS v(a, b) WHERE (v.a, v.b) > (:a, 0) LIMIT 10`,
        { a: 'text', b: 'int8' },
        { a: 'm', b: '1' }
    ],
    [
        'ORDER BY expr + DISTINCT ON',
        `SELECT DISTINCT ON (region = :r) region, amount FROM demo_sales ORDER BY region = :r, abs(amount - :target) LIMIT 100`,
        { r: 'text', target: 'numeric' },
        { r: 'east', target: '42' }
    ],
    [
        'NULL-tolerant optional filter',
        `SELECT id FROM demo_sales WHERE (:r IS NULL OR region = :r) AND (:since IS NULL OR month >= :since) LIMIT 100`,
        { r: 'text', since: 'date' },
        { r: null, since: '2026-02-01' }
    ],
    [
        '10+ params',
        `SELECT id FROM demo_sales WHERE amount IN (:p1,:p2,:p3,:p4,:p5,:p6,:p7,:p8,:p9,:p10,:p11) LIMIT 100`,
        Object.fromEntries(Array.from({ length: 11 }, (_, k) => [`p${k + 1}`, 'numeric'])),
        Object.fromEntries(Array.from({ length: 11 }, (_, k) => [`p${k + 1}`, String(k * 10)]))
    ],
    [
        'hostile public overload date_trunc(text,date)',
        `SELECT date_trunc('month', :d) AS m FROM demo_sales LIMIT 5`,
        { d: 'date' },
        { d: '2026-03-15' }
    ],
    ['hostile public overload for text = int8 operator', `SELECT id FROM demo_sales WHERE region = :n LIMIT 5`, { n: 'int8' }, { n: '1' }],
    [
        'GROUP BY distinct params (equal() trap)',
        `SELECT amount + :a AS x, count(*) AS c FROM demo_sales GROUP BY amount + :b LIMIT 100`,
        { a: 'numeric', b: 'numeric' },
        { a: '1', b: '1' }
    ],
    [
        'GROUP BY same param',
        `SELECT amount + :a AS x, count(*) AS c FROM demo_sales GROUP BY amount + :a LIMIT 100`,
        { a: 'numeric' },
        { a: '1' }
    ],
    ['int8 into int4-only function', `SELECT make_date(:y, 1, 1) AS d FROM demo_sales LIMIT 1`, { y: 'int8' }, { y: '2026' }],
    [
        'numeric into float8 function',
        `SELECT round(power(amount, :e), 2) AS p, sqrt(:e) AS s FROM demo_sales LIMIT 5`,
        { e: 'numeric' },
        { e: '2' }
    ],
    [
        'comments, literals, dollar quotes, nested comment',
        `SELECT ':r' AS a, $$:r$$ AS b, $q$ :r $q$ AS c, ":r"::text AS d /* :r /* :r */ :r */ FROM (SELECT 'x' AS ":r") s WHERE 'x' = :real -- :r\nLIMIT 5`,
        { real: 'text' },
        { real: 'x' }
    ]
]

// Test-only BEGIN ATOMIC oracle; no logging or production parsing dependency.
export const oracleIds = (tree) =>
    [
        ...new Set(
            [
                ...String(tree).matchAll(
                    /:(relid|funcid|aggfnoid|winfnoid|opno|opfuncid|consttype|paramtype|constcollid|paramcollid|vartype|resulttype)\s+(\d+)/g
                )
            ].map((m) => `${m[1].replace(/^param/, 'const')}:${m[2]}`)
        )
    ].sort()

export async function provePair(client, compiled, types, binds) {
    let prepared = false
    await client.query('BEGIN')
    try {
        await client.query(`CREATE TEMP VIEW zz_test_equivalence AS ${compiled.checkText}`)
        const expected = (
            await client.query(
                "SELECT atttypid::int AS oid FROM pg_attribute WHERE attrelid='pg_temp.zz_test_equivalence'::regclass AND attnum>0 ORDER BY attnum"
            )
        ).rows.map((r) => r.oid)
        await client.query(`PREPARE zz_test_pair AS ${compiled.runText}`)
        prepared = true
        const inferred = (
            await client.query(
                "SELECT t::oid::int AS oid FROM pg_prepared_statements p, unnest(p.parameter_types) WITH ORDINALITY a(t,n) WHERE p.name='zz_test_pair' ORDER BY n"
            )
        ).rows.map((r) => r.oid)
        const declared = []
        for (const type of types)
            declared.push((await client.query('SELECT $1::regtype::oid::int AS oid', [`pg_catalog.${type}`])).rows[0].oid)
        assert.deepEqual(inferred, declared, 'T2 inferred parameter types')
        // Older supported versions lack result_types; use the server RowDescription.
        const metadata = (
            await client.query("SELECT to_jsonb(p)->'result_types' AS types FROM pg_prepared_statements p WHERE name='zz_test_pair'")
        ).rows[0]
        if (metadata.types) {
            const oids = []
            for (const type of metadata.types) oids.push((await client.query('SELECT $1::regtype::oid::int AS oid', [type])).rows[0].oid)
            assert.deepEqual(oids, expected, 'T2 prepared result_types')
        }
        const result = await client.query(compiled.runText, binds)
        assert.deepEqual(
            result.fields.map((f) => f.dataTypeID),
            expected,
            'T2 result descriptor'
        )
        await client.query('DROP VIEW zz_test_equivalence')
        const wrap = (text) => `SELECT 1 FROM (\n${text}\n) q`
        await client.query(`CREATE TEMP VIEW zz_test_equivalence AS ${wrap(compiled.checkText)}`)
        await client.query(
            `CREATE FUNCTION pg_temp.zz_test_oracle(${types
                .map((t) => 'pg_catalog.' + t)
                .join(',')}) RETURNS SETOF integer LANGUAGE sql BEGIN ATOMIC ${wrap(compiled.runText)}; END`
        )
        const view = (
            await client.query("SELECT ev_action::text AS tree FROM pg_rewrite WHERE ev_class='pg_temp.zz_test_equivalence'::regclass")
        ).rows[0].tree
        const fn = (
            await client.query(
                "SELECT prosqlbody::text AS tree FROM pg_proc WHERE oid=('pg_temp.zz_test_oracle(' || $1 || ')')::regprocedure",
                [types.map((t) => 'pg_catalog.' + t).join(',')]
            )
        ).rows[0].tree
        assert.deepEqual(oracleIds(fn), oracleIds(view), 'T3 stored tree OIDs and types')
    } finally {
        await client.query('ROLLBACK')
        if (prepared) await client.query('DEALLOCATE zz_test_pair')
    }
}

export async function checkPinnedEquivalence(t, client) {
    await client.query('SET search_path = pg_catalog, public')
    try {
        for (const [name, sql, spec, args] of CASES)
            await t.test(name, async () => {
                const entry = { sql, params: Object.entries(spec).map(([name, type]) => ({ name, type })) }
                const c = compilePinned(entry, args),
                    types = c.order.map((n) => spec[n])
                if (name === 'GROUP BY distinct params (equal() trap)') {
                    await assert.rejects(provePair(client, c, types, c.binds), (e) => e.code === '42803')
                } else if (name === 'int8 into int4-only function') {
                    await assert.rejects(provePair(client, c, types, c.binds), (e) => e.code === '42883')
                } else await provePair(client, c, types, c.binds)
            })
        await t.test('T4 uncast run differs from the declared type', async () => {
            const c = compilePinned({ sql: 'SELECT public.zz_test_ov(:v) AS v LIMIT 1', params: [{ name: 'v', type: 'int8' }] }, { v: '1' })
            await assert.rejects(
                provePair(client, { ...c, runText: 'SELECT public.zz_test_ov($1) AS v LIMIT 1' }, ['int8'], ['1']),
                /T2 inferred/
            )
            await assert.rejects(provePair(client, { ...c, checkText: 'SELECT 1 AS v LIMIT 1' }, ['int8'], ['1']), /T2 .*result/)
        })
    } finally {
        await client.query('RESET search_path')
    }
}
