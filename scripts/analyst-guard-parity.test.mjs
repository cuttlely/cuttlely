import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import {
    checkStatementScope,
    parseAllowedFunctions,
    resetRiskyDomainCacheForTests
} from '../packages/harness/runtime/analyst-relations.mjs'
import {
    queryAnalystUrl,
    setGuardLegacyRoundTripsForTests,
    withAnalystScope,
    setGuardBatchHookForTests,
    setGuardReadHookForTests,
    GUARD_BATCH_MESSAGE,
    postgresRunner
} from '../packages/harness/runtime/analyst-store.mjs'

const baseline = process.env.CUTTLELY_TEST_GUARD_BASELINE_STORE
    ? await import(pathToFileURL(process.env.CUTTLELY_TEST_GUARD_BASELINE_STORE).href)
    : null

const { Client } = createRequire(new URL('../packages/components/package.json', import.meta.url))('pg')
const schema = '"ZZ-TEST-guard"'
const etl = '"ZZ-TEST-etl"'
const selection = ['orders', 'customers', 'items', 'audit_log', 'order_summary', 'region_totals', 'guarded'].map(
    (name) => `${schema}.${name}`
)
const allowlist = [`${schema}._etl_safe_date(text)`, `${schema}._etl_safe_round(numeric)`, `${schema}._etl_safe_pct(*)`].join('\n')
const configurations = [
    { name: 'unselected', allowedFunctions: allowlist },
    { name: 'selected', relations: selection, allowedFunctions: allowlist },
    { name: 'unlisted' }
]

function adminConfig(database = 'postgres') {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || '',
        database,
        connectionTimeoutMillis: 1000
    }
}

function fixture(shadow = false, empty = false) {
    const suffix = randomBytes(6).toString('hex')
    const database = `guard_${suffix}`
    const writer = `writer_${suffix}`
    const password = randomBytes(18).toString('base64url')
    let admin
    let owner
    const state = { url: '', writer, owner: null }
    before(async () => {
        admin = new Client(adminConfig())
        try {
            await admin.connect()
        } catch (error) {
            await admin.end().catch(() => {})
            admin = null
            if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1') throw error
            return
        }
        await admin.query(`CREATE DATABASE "${database}"`)
        await admin.query(`CREATE ROLE "${writer}" LOGIN PASSWORD '${password}'`)
        owner = new Client(adminConfig(database))
        await owner.connect()
        state.owner = owner
        if (!empty)
            await owner.query(`
            CREATE SCHEMA ${schema};
            CREATE SCHEMA ${etl} AUTHORIZATION "${writer}";
            CREATE TABLE ${schema}.orders(id int PRIMARY KEY, customer_id int, placed_at timestamptz, total numeric, status text);
            CREATE TABLE ${schema}.customers(id int, name text, region text);
            CREATE TABLE ${schema}.items(order_id int, sku text, qty int, price numeric);
            CREATE TABLE ${schema}.audit_log(msg text);
            INSERT INTO ${schema}.orders VALUES (1, 1, '2020-01-01', 10, 'paid'), (2, 2, '2020-02-01', 20, 'open');
            INSERT INTO ${schema}.customers VALUES (1, 'Ada', 'north'), (2, 'Lin', 'south');
            INSERT INTO ${schema}.items VALUES (1, 'a', 2, 5), (2, 'b', 1, 20);
            CREATE VIEW ${schema}.order_summary AS SELECT o.id, c.name, o.total FROM ${schema}.orders o JOIN ${schema}.customers c ON c.id = o.customer_id;
            CREATE MATERIALIZED VIEW ${schema}.region_totals AS SELECT c.region, sum(o.total) AS total FROM ${schema}.orders o JOIN ${schema}.customers c ON c.id = o.customer_id GROUP BY c.region;
            CREATE SEQUENCE ${schema}.order_seq;
            CREATE FUNCTION ${schema}._etl_safe_date(text) RETURNS date IMMUTABLE LANGUAGE sql AS 'SELECT $1::date';
            CREATE FUNCTION ${schema}._etl_safe_round(numeric) RETURNS numeric IMMUTABLE LANGUAGE sql AS 'SELECT round($1)';
            CREATE FUNCTION ${schema}._etl_safe_pct(numeric, numeric) RETURNS numeric STABLE LANGUAGE sql AS 'SELECT $1 / $2 * 100';
            CREATE FUNCTION ${schema}.write_audit(text) RETURNS text VOLATILE LANGUAGE plpgsql AS 'BEGIN INSERT INTO ${schema}.audit_log VALUES ($1); RETURN $1; END';
            CREATE FUNCTION ${schema}.bump() RETURNS bigint VOLATILE LANGUAGE sql AS 'SELECT nextval(''${schema}.order_seq'')';
            CREATE FUNCTION ${schema}.definer_fn() RETURNS int SECURITY DEFINER LANGUAGE sql AS 'SELECT 1';
            CREATE FUNCTION ${schema}.configured_fn() RETURNS int LANGUAGE sql SET search_path = public AS 'SELECT 1';
            CREATE FUNCTION ${schema}.reads_table() RETURNS bigint STABLE LANGUAGE sql AS 'SELECT count(*) FROM ${schema}.orders';
            CREATE PROCEDURE ${schema}.log_proc() LANGUAGE sql AS 'INSERT INTO ${schema}.audit_log VALUES (''procedure'')';
            CREATE FUNCTION ${schema}.op_fn(int, int) RETURNS int LANGUAGE sql AS 'SELECT $1 + $2';
            CREATE OPERATOR ${schema}.### (LEFTARG = int, RIGHTARG = int, FUNCTION = ${schema}.op_fn);
            CREATE TYPE ${schema}.mood AS ENUM ('ok');
            CREATE FUNCTION ${schema}.cast_fn(int) RETURNS ${schema}.mood LANGUAGE sql AS 'SELECT ''ok''::${schema}.mood';
            CREATE CAST (int AS ${schema}.mood) WITH FUNCTION ${schema}.cast_fn(int);
            CREATE VIEW ${schema}.volatile_view AS SELECT ${schema}.write_audit('v');
            CREATE FUNCTION ${schema}.policy_fn() RETURNS boolean VOLATILE LANGUAGE sql AS 'SELECT true';
            CREATE TABLE ${schema}.guarded(id int);
            INSERT INTO ${schema}.guarded VALUES (1);
            ALTER TABLE ${schema}.guarded ENABLE ROW LEVEL SECURITY;
            CREATE POLICY guard_policy ON ${schema}.guarded USING (${schema}.policy_fn());
            GRANT USAGE ON SCHEMA ${schema} TO "${writer}";
            GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${schema} TO "${writer}";
            GRANT USAGE ON SEQUENCE ${schema}.order_seq TO "${writer}";
            GRANT TEMP ON DATABASE "${database}" TO "${writer}";
            SET ROLE "${writer}";
            CREATE FUNCTION ${etl}.auto_ok(int) RETURNS int IMMUTABLE LANGUAGE sql RETURN $1;
            CREATE FUNCTION ${etl}.auto_reads() RETURNS bigint STABLE LANGUAGE sql AS 'SELECT count(*) FROM ${schema}.orders';
            CREATE FUNCTION ${etl}.auto_volatile() RETURNS int VOLATILE LANGUAGE sql AS 'SELECT 1';
            CREATE FUNCTION ${etl}.write_probe() RETURNS text VOLATILE LANGUAGE plpgsql AS 'BEGIN INSERT INTO ${schema}.audit_log VALUES (''probe''); RETURN ''probe''; END';
            RESET ROLE;
            ALTER ROLE "${writer}" IN DATABASE "${database}" SET search_path = ${schema}, ${etl}, public
        `)
        if (!empty) {
            try {
                await owner.query('CREATE EXTENSION IF NOT EXISTS dblink')
                // Its foreign data wrapper globally refuses reads. Keep the callable functions for the corpus.
                await owner.query('ALTER EXTENSION dblink DROP FOREIGN DATA WRAPPER dblink_fdw')
                await owner.query('DROP FOREIGN DATA WRAPPER dblink_fdw')
            } catch {
                // Missing dblink must still fail closed in both modes.
            }
        }
        if (shadow)
            await owner.query(`
            SET ROLE "${writer}";
            CREATE FUNCTION ${etl}.lower(text) RETURNS text IMMUTABLE LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION ${etl}.add_int(int, int) RETURNS int IMMUTABLE LANGUAGE sql AS 'SELECT $1';
            CREATE OPERATOR ${etl}.+ (LEFTARG = int, RIGHTARG = int, FUNCTION = ${etl}.add_int);
            RESET ROLE;
            CREATE FUNCTION public.upper(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION public.lower(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION public.text_eq(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
            CREATE OPERATOR public.= (LEFTARG = text, RIGHTARG = text, FUNCTION = public.text_eq);
            SET allow_system_table_mods = on;
            CREATE SCHEMA pg_catalog_shadow;
            CREATE FUNCTION pg_catalog_shadow.now() RETURNS timestamptz LANGUAGE sql AS 'SELECT pg_catalog.now()';
            GRANT USAGE ON SCHEMA pg_catalog_shadow TO "${writer}";
            ALTER ROLE "${writer}" IN DATABASE "${database}" SET search_path = ${etl}, pg_catalog_shadow, public
        `)
        const { host, port } = adminConfig()
        const url = new URL(`postgresql://${host}:${port}/${database}`)
        url.username = writer
        url.password = password
        state.url = url.toString()
    })
    after(async () => {
        setGuardLegacyRoundTripsForTests(false)
        await owner?.end()
        if (!admin) return
        try {
            await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
            await admin.query(`DROP ROLE IF EXISTS "${writer}"`)
        } finally {
            await admin.end()
        }
    })
    return state
}

const corpus = []
function cases(category, expected, statements, volatileRows = false) {
    for (let sql of statements) {
        // The guard requires a top-level LIMIT even for scalar expressions.
        if (/^(SELECT|WITH|\/\*)/i.test(sql) && !/\bLIMIT\b/i.test(sql)) sql += '\nLIMIT 50'
        // Bare VALUES is harmless but the guard only accepts SELECT or WITH.
        const tag = sql.startsWith('VALUES') ? 'refuse' : expected
        corpus.push({ category, expected: tag, sql, volatileRows })
    }
}

cases('plain reads and expressions', 'allow', [
    'SELECT 1',
    'SELECT 1 + 2',
    'SELECT NULL',
    'SELECT true',
    'SELECT * FROM orders ORDER BY id',
    'SELECT id, total FROM orders ORDER BY id',
    "SELECT * FROM orders WHERE status = 'paid'",
    'SELECT * FROM customers ORDER BY id',
    'SELECT * FROM items ORDER BY order_id',
    'SELECT * FROM audit_log',
    'SELECT DISTINCT status FROM orders ORDER BY status',
    'SELECT total * 2 FROM orders ORDER BY id',
    'SELECT * FROM orders LIMIT 1',
    'SELECT * FROM orders ORDER BY id LIMIT 1 OFFSET 1',
    'SELECT * FROM orders WHERE total BETWEEN 1 AND 30 ORDER BY id',
    'SELECT * FROM orders WHERE id IN (1, 2) ORDER BY id',
    'SELECT * FROM orders WHERE total IS NOT NULL ORDER BY id',
    "SELECT CASE WHEN total > 15 THEN 'large' ELSE 'small' END FROM orders ORDER BY id",
    "SELECT coalesce(NULL, 'fallback')",
    'SELECT nullif(1, 2)',
    'SELECT greatest(1, 2), least(1, 2)',
    "SELECT 'nextval(''order_seq'')' AS text",
    "SELECT $$INSERT INTO audit_log VALUES ('x');$$",
    "SELECT E'line\\nvalue'",
    '/* INSERT INTO audit_log */ SELECT 2',
    'SELECT 3 -- DELETE FROM orders',
    'SELECT 4 /* ; DROP TABLE orders; */',
    'VALUES (1), (2)',
    'VALUES (1, 2), (3, 4)',
    'SELECT * FROM order_summary ORDER BY id',
    'SELECT * FROM region_totals ORDER BY region',
    `SELECT ${etl}.auto_ok(2)`,
    'SELECT auto_ok(3)',
    'SELECT auto_ok(auto_ok(1))'
])
cases('joins and aggregates', 'allow', [
    'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id LIMIT 50',
    'SELECT o.id, i.sku FROM orders o LEFT JOIN items i ON i.order_id = o.id ORDER BY o.id LIMIT 50',
    'SELECT count(*) FROM orders',
    'SELECT sum(total), avg(total), min(total), max(total) FROM orders',
    'SELECT status, count(*) FROM orders GROUP BY status ORDER BY status',
    'SELECT customer_id, sum(total) FROM orders GROUP BY customer_id HAVING sum(total) > 5 ORDER BY customer_id',
    'SELECT count(DISTINCT customer_id) FROM orders',
    "SELECT string_agg(name, ',' ORDER BY id) FROM customers",
    'SELECT array_agg(id ORDER BY id) FROM orders',
    'SELECT json_agg(id ORDER BY id) FROM orders',
    'SELECT id, row_number() OVER (ORDER BY id) FROM orders ORDER BY id',
    'SELECT id, sum(total) OVER (ORDER BY id) FROM orders ORDER BY id',
    'SELECT id, lag(total) OVER (ORDER BY id) FROM orders ORDER BY id',
    'SELECT id, rank() OVER (ORDER BY total) FROM orders ORDER BY id',
    'SELECT * FROM orders CROSS JOIN LATERAL (SELECT 1 AS n) x ORDER BY id',
    'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id) ORDER BY id',
    'SELECT * FROM (SELECT id FROM orders) s ORDER BY id',
    'SELECT (SELECT count(*) FROM orders)',
    'SELECT id FROM orders UNION SELECT id FROM customers ORDER BY id',
    'SELECT id FROM orders INTERSECT SELECT id FROM customers ORDER BY id',
    'SELECT id FROM orders EXCEPT SELECT id FROM customers ORDER BY id',
    'WITH x AS (SELECT * FROM orders) SELECT count(*) FROM x',
    'WITH x AS (SELECT id FROM orders), y AS (SELECT * FROM x) SELECT * FROM y ORDER BY id',
    'WITH RECURSIVE x(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM x WHERE n < 3) SELECT * FROM x ORDER BY n',
    'SELECT * FROM generate_series(1, 3)',
    'SELECT * FROM unnest(ARRAY[1, 2])'
])
cases('builtins', 'allow', [
    "SELECT date_trunc('month', '2020-01-02'::timestamptz)",
    "SELECT upper('abc'), lower('ABC')",
    "SELECT length('abc'), trim(' x ')",
    "SELECT substring('abcd' FROM 2 FOR 2)",
    "SELECT replace('abc', 'a', 'z')",
    "SELECT concat('a', 'b')",
    "SELECT split_part('a,b', ',', 1)",
    "SELECT json_build_object('a', 1)",
    'SELECT jsonb_build_array(1, 2)',
    "SELECT '{\"a\":1}'::jsonb ->> 'a'",
    'SELECT abs(-1), round(1.5), ceil(1.2), floor(1.9)',
    'SELECT power(2, 3)',
    "SELECT to_char(12, 'FM99')",
    "SELECT extract(year FROM date '2020-01-01')"
])
cases('allowlisted helpers', 'allow', [
    "SELECT _etl_safe_date('2020-01-01')",
    'SELECT _etl_safe_round(1.5)',
    'SELECT _etl_safe_pct(1, 2)',
    'SELECT _etl_safe_round(total) FROM orders ORDER BY id',
    "SELECT _etl_safe_date('2020-02-01') IS NOT NULL",
    'SELECT _etl_safe_pct(2, 4)'
])
cases('writes and writable CTEs', 'refuse', [
    "INSERT INTO audit_log VALUES ('x')",
    "UPDATE orders SET status = 'x'",
    'DELETE FROM orders',
    'TRUNCATE orders',
    "INSERT INTO orders VALUES (1, 1, now(), 1, 'x') ON CONFLICT (id) DO UPDATE SET total = 1",
    'MERGE INTO orders o USING (VALUES (1)) s(id) ON o.id = s.id WHEN MATCHED THEN UPDATE SET total = 0',
    "WITH x AS (INSERT INTO audit_log VALUES ('x') RETURNING *) SELECT * FROM x",
    'WITH x AS (UPDATE orders SET total = 0 RETURNING *) SELECT * FROM x',
    'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    "WITH x AS (WITH y AS (INSERT INTO audit_log VALUES ('x') RETURNING *) SELECT * FROM y) SELECT * FROM x",
    'SELECT * FROM (WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x) s',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT * FROM orders FOR SHARE',
    'SELECT * FROM orders FOR NO KEY UPDATE',
    'SELECT * FROM orders FOR KEY SHARE'
])
cases('dangerous builtins', 'refuse', [
    "SELECT nextval('order_seq')",
    "SELECT setval('order_seq', 10)",
    'SELECT lastval()',
    'SELECT setseed(0.5)',
    "SELECT set_config('search_path', 'public', false)",
    "SELECT set_config('search_path', 'public', true)",
    'SELECT pg_advisory_lock(42)',
    'SELECT pg_advisory_xact_lock(42)',
    'SELECT pg_try_advisory_lock(42)',
    "SELECT pg_notify('test', 'x')",
    'SELECT pg_sleep(0.01)',
    'SELECT pg_terminate_backend(0)',
    'SELECT pg_cancel_backend(0)',
    'SELECT pg_reload_conf()',
    "SELECT pg_read_file('/nonexistent')",
    "SELECT pg_ls_dir('.')",
    'SELECT lo_create(0)',
    "SELECT lo_import('/nonexistent')",
    'SELECT lo_unlink(123)',
    'SELECT txid_current()',
    'SELECT pg_export_snapshot()',
    "SELECT pg_logical_emit_message(false, 'test', 'x')",
    'SELECT pg_stat_reset()',
    "SELECT query_to_xml('INSERT INTO audit_log VALUES (''x'') RETURNING *', false, false, '')",
    "SELECT * FROM dblink('dbname=x', 'insert into audit_log values (''x'')') AS x(a text)",
    "SELECT dblink_exec('dbname=x', 'insert into audit_log values (''x'')')"
])
cases('commands', 'refuse', [
    'COPY orders TO STDOUT',
    'COPY orders FROM STDIN',
    "COPY orders TO PROGRAM 'true'",
    'COPY (SELECT * FROM orders) TO STDOUT',
    "DO $$BEGIN INSERT INTO audit_log VALUES ('x'); END$$",
    'CALL log_proc()',
    'CREATE TEMP TABLE scratch(id int)',
    'CREATE TEMP VIEW scratch AS SELECT 1',
    'CREATE TABLE scratch AS SELECT 1 AS id',
    'SELECT 1 INTO scratch',
    'DROP TABLE orders',
    'ALTER TABLE orders ADD COLUMN x int',
    'GRANT SELECT ON orders TO public',
    'REVOKE SELECT ON orders FROM public',
    "COMMENT ON TABLE orders IS 'x'",
    'VACUUM orders',
    'ANALYZE orders',
    'REFRESH MATERIALIZED VIEW region_totals',
    'LOCK TABLE orders',
    'SET search_path = public',
    'SET search_path = "ZZ-TEST-etl", pg_catalog; SELECT lower(\'ABC\')',
    'RESET ALL',
    'SET ROLE postgres',
    'PREPARE x AS SELECT 1',
    'EXECUTE x',
    'LISTEN test',
    "NOTIFY test, 'x'",
    'BEGIN',
    'COMMIT',
    'SAVEPOINT x',
    'DISCARD ALL',
    'CHECKPOINT',
    "CREATE FUNCTION scratch() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    'CREATE EXTENSION dblink',
    'SELECT 1; SELECT 2',
    "SELECT 1; /* hidden */ INSERT INTO audit_log VALUES ('x')",
    "EXPLAIN ANALYZE INSERT INTO audit_log VALUES ('x')"
])
cases('user code and name tricks', 'refuse', [
    "SELECT write_audit('direct')",
    "SELECT upper(write_audit('nested'))",
    "SELECT id FROM orders WHERE write_audit('where') = 'x'",
    "WITH x AS (SELECT write_audit('cte')) SELECT * FROM x",
    'SELECT * FROM volatile_view',
    'SELECT * FROM guarded',
    'SELECT bump()',
    'SELECT definer_fn()',
    'SELECT configured_fn()',
    'SELECT reads_table()',
    'SELECT auto_reads()',
    'SELECT auto_volatile()',
    `SELECT ${etl}.auto_reads()`,
    `SELECT ${etl}.auto_volatile()`,
    'SELECT 1 ### 2',
    'SELECT 1 OPERATOR(pg_catalog.+) (1 ### 2)',
    `SELECT 1::${schema}.mood`,
    "SELECT pg_temp.write_audit('x')",
    "SELECT \"SET_CONFIG\"('search_path', 'public', false)",
    'SELECT "Nextval"(\'order_seq\')',
    "SELECT pg_catalog.set_config('search_path', 'public', true)",
    'SELECT write_audit($$dollar; quoted$$)',
    "SELECT write_audit(E'escape\\nvalue')",
    `SELECT ${etl}.write_probe()`
])
cases('execution errors', 'error', ['SELECT 1 / 0', "SELECT currval('order_seq')"])

cases('allowed today: xid assignment (no data change)', 'allow', ['SELECT pg_current_xact_id()'], true)
cases(
    'volatile reads',
    'allow',
    [
        'SELECT now()',
        'SELECT clock_timestamp()',
        'SELECT statement_timestamp()',
        'SELECT random()',
        'SELECT gen_random_uuid()',
        'SELECT pg_backend_pid()'
    ],
    true
)

async function decision(url, sql, config, legacy, useBaseline = false) {
    if (!(useBaseline && baseline)) setGuardLegacyRoundTripsForTests(legacy)
    try {
        const result = await (useBaseline && baseline ? baseline.queryAnalystUrl : queryAnalystUrl)(url, sql, {
            readOnlySql: true,
            ...config,
            rowCap: 50
        })
        return { ok: true, rows: JSON.stringify(result.rows) }
    } catch (error) {
        return { ok: false, message: error.message }
    } finally {
        setGuardLegacyRoundTripsForTests(false)
    }
}

async function noEffects(state) {
    const { owner, writer } = state
    assert.deepEqual(
        (
            await owner.query(
                `SELECT
        (SELECT count(*)::int FROM ${schema}.audit_log) AS audit,
        (SELECT count(*)::int FROM ${schema}.orders) AS orders,
        (SELECT count(*)::int FROM ${schema}.customers) AS customers,
        (SELECT count(*)::int FROM ${schema}.items) AS items,
        (SELECT count(*)::int FROM ${schema}.guarded) AS guarded,
        (SELECT is_called FROM ${schema}.order_seq) AS advanced,
        (SELECT count(*)::int FROM pg_largeobject_metadata) AS objects,
        (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = $1) AS owned,
        (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND a.usename = $1) AS locks
    `,
                [writer]
            )
        ).rows[0],
        { audit: 0, orders: 2, customers: 2, items: 2, guarded: 1, advanced: false, objects: 0, owned: 0, locks: 0 }
    )
}

async function differential(state, statements, configs, t, shadow = false) {
    if (!state.url) return t.skip('Local Postgres admin is unavailable')
    const diffs = []
    const expectations = []
    let count = 0
    for (const config of configs) {
        for (const entry of statements) {
            const old = await decision(state.url, entry.sql, config, true, !shadow)
            const current = await decision(state.url, entry.sql, config, false)
            count++
            if (old.ok !== current.ok || old.message !== current.message || (!entry.volatileRows && old.rows !== current.rows))
                diffs.push({ config: config.name, sql: entry.sql, old, current })
            const expected = shadow || (entry.category === 'allowlisted helpers' && config.name === 'unlisted') ? 'refuse' : entry.expected
            for (const [mode, result] of [
                ['legacy', old],
                ['new', current]
            ]) {
                if (expected === 'refuse' && result.ok) {
                    const finding = { config: config.name, sql: entry.sql, mode, result }
                    t.diagnostic(`STOP: expected refusal was allowed: ${JSON.stringify(finding)}`)
                    assert.fail(`STOP: expected refusal was allowed: ${JSON.stringify(finding)}`)
                }
                if (result.ok !== (expected === 'allow')) expectations.push({ config: config.name, sql: entry.sql, expected, mode, result })
            }
        }
        await noEffects(state)
    }
    t.diagnostic(`comparisons=${count} differences=${diffs.length}`)
    assert.ok(count >= (shadow ? 48 : 400))
    assert.equal(diffs.length, 0, JSON.stringify(diffs.slice(0, 8), null, 2))
    assert.equal(expectations.length, 0, JSON.stringify(expectations.slice(0, 15), null, 2))
}

describe('analyst guard differential corpus', () => {
    const state = fixture()
    it('agrees on every statement and preserves the writable fixture', async (t) => {
        assert.ok(new Set(corpus.map((entry) => entry.sql)).size >= 160)
        await differential(state, corpus, configurations, t)
    })
    it('reduces round trips in every configuration', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        for (const config of configurations) {
            const trips = []
            const guardMs = []
            try {
                for (const legacy of [true, false]) {
                    setGuardLegacyRoundTripsForTests(legacy)
                    const timings = []
                    await withAnalystScope(
                        'guard-parity',
                        () =>
                            queryAnalystUrl(
                                state.url,
                                'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id LIMIT 50',
                                { readOnlySql: true, ...config, rowCap: 50 }
                            ),
                        { timings }
                    )
                    assert.equal(timings.length, 1)
                    trips.push(timings[0].roundTrips)
                    guardMs.push(timings[0].guardMs)
                }
            } finally {
                setGuardLegacyRoundTripsForTests(false)
            }
            t.diagnostic(`${config.name}: legacy=${trips[0]} new=${trips[1]} guard ms: legacy=${guardMs[0]} new=${guardMs[1]}`)
            assert.ok(trips[1] < trips[0])
        }
    })
})

describe('analyst guard shadow catalog', () => {
    const state = fixture(true)
    it('refuses every query in both modes', async (t) => {
        await differential(state, corpus.slice(0, 24), configurations.slice(0, 2), t, true)
    })
})

for (const empty of [true, false]) {
    describe(`analyst guard allowlist evaluation (${empty ? 'no user functions' : 'normal fixture'})`, () => {
        const state = fixture(false, empty)
        before(async () => {
            if (!empty || !state.url) return
            const result = await state.owner.query(`SELECT p.oid FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`)
            assert.deepEqual(result.rows, [], 'The database has no candidate user functions')
        })
        const valid = [`${schema}._etl_safe_date(text)`, `${schema}._etl_safe_pct(*)`]
        const missingType = 'public.helper(missing_type)'
        const badSignature = 'public.helper("unterminated)'
        const otherBadSignature = 'public.helper(text))'
        const badNames = ['"unterminated(*)', 'a.b.c(*)']
        const lists = [
            { name: 'missing argument type', entries: [missingType] },
            { name: 'bad signature syntax', entries: [badSignature] },
            { name: 'valid entries before a missing type', entries: [...valid, missingType] },
            { name: 'valid entries after a missing type', entries: [missingType, ...valid] },
            { name: 'valid entries before bad syntax', entries: [...valid, badSignature] },
            { name: 'valid entries after bad syntax', entries: [badSignature, ...valid] },
            { name: 'first signature error wins', entries: [badSignature, ...valid, otherBadSignature] },
            { name: 'reversed signature errors', entries: [otherBadSignature, ...valid, badSignature] },
            ...badNames.flatMap((entry) => [
                { name: `parser rejects ${entry}`, entries: [entry], parsed: [], ok: true },
                { name: `valid entries with rejected ${entry}`, entries: [valid[0], entry, valid[1]], parsed: valid, ok: true }
            ])
        ]
        for (const config of lists) {
            it(config.name, async (t) => {
                const allowedFunctions = config.entries.join('\n')
                // name(*) requires exactly two valid identifiers; malformed names never reach parse_ident.
                if (config.parsed) assert.deepEqual(parseAllowedFunctions(allowedFunctions), parseAllowedFunctions(config.parsed))
                else assert.equal(parseAllowedFunctions(allowedFunctions).length, config.entries.length)
                if (!state.url) return t.skip('Local Postgres admin is unavailable')
                // Use a built-in function so routine checking resolves the allowlist even in the empty database.
                const sql = 'SELECT pg_catalog.abs(1) LIMIT 50'
                const old = await decision(state.url, sql, { allowedFunctions }, true)
                const current = await decision(state.url, sql, { allowedFunctions }, false)
                assert.deepEqual(current, old, 'Allow/refuse decisions and error messages must agree')
                // Signature errors (missing type or bad syntax) raise on PG 14/15 and resolve to NULL on PG 16+; legacy is the oracle.
                if (config.ok !== undefined) assert.equal(old.ok, config.ok, old.message)
            })
            it(`${config.name} without routine calls`, async (t) => {
                if (!state.url) return t.skip('Local Postgres admin is unavailable')
                const allowedFunctions = config.entries.join('\n')
                const statements = [
                    { sql: 'SELECT 1 LIMIT 50' },
                    ...(!empty ? [{ sql: `SELECT id FROM ${schema}.orders LIMIT 50`, relations: [selection[0]] }] : [])
                ]
                for (const { sql, relations } of statements) {
                    const options = { allowedFunctions, ...(relations ? { relations } : {}) }
                    const old = await decision(state.url, sql, options, true)
                    const current = await decision(state.url, sql, options, false)
                    // Legacy decides whether this path resolves the allowlist, including version-dependent lookup errors.
                    assert.deepEqual(current, old, `${sql}: allow/refuse decisions and error messages must agree`)
                }
            })
        }
    })
}

describe('analyst guard fails closed on failed or incomplete catalog reads', () => {
    const state = fixture()
    const statement = `SELECT ${schema}._etl_safe_round(total), ${schema}._etl_safe_pct(total, 2) FROM ${schema}.orders JOIN ${schema}.customers USING (id) ORDER BY id LIMIT 50`
    const options = { readOnlySql: true, relations: selection, allowedFunctions: allowlist, rowCap: 50 }
    let unusedFunctionOid
    const injections = [
        { name: 'failed allowlist read', match: /to_regprocedure/, throws: true },
        { name: 'empty allowlist read', match: /to_regprocedure/, alter: (r) => ({ ...r, rows: [] }) },
        { name: 'empty allowlist lookup', match: /to_regprocedure/, params: /_etl_safe_round/, alter: (r) => ({ ...r, rows: [] }) },
        { name: 'failed allowlist lookup', match: /to_regprocedure/, params: /_etl_safe_round/, throws: true },
        {
            name: 'empty allowlist lookup for an unused entry',
            match: /to_regprocedure/,
            params: /_etl_safe_date/,
            allowed: true,
            prepare: async () => {
                const result = await state.owner.query(`SELECT '${schema}._etl_safe_date(text)'::regprocedure::oid::int8 AS oid`)
                unusedFunctionOid = Number(result.rows[0].oid)
            },
            alter: (r) => ({ ...r, rows: r.rows.filter((row) => Number(row.oid) !== unusedFunctionOid) })
        },
        { name: 'failed check backend pid read', match: /^SELECT pg_backend_pid\(\)/, checkTransaction: true, throws: true },
        { name: 'failed query backend pid read', match: /^SELECT pg_backend_pid\(\)/, queryTransaction: true, throws: true },
        {
            name: 'writable query transaction',
            match: /^SHOW transaction_read_only$/,
            alter: (r) => ({ ...r, rows: [{ transaction_read_only: 'off' }] }),
            message: /read-only transaction/
        },
        { name: 'failed search path read', match: /^SELECT pg_catalog.current_setting\('search_path'\)/, throws: true },
        { name: 'failed risky types lookup', match: /SELECT DISTINCT format_type/, throws: true },
        { name: 'failed routine stamp', match: /AS stamp FROM/, throws: true },
        { name: 'short routine lookup', match: /prosqlbody.*AS probody/s, alter: (r) => ({ ...r, rows: r.rows.slice(1) }) },
        {
            name: 'short relation bodies in query transaction',
            match: /pg_policy p WHERE p.polrelid/,
            queryTransaction: true,
            alter: (r) => ({ ...r, rows: r.rows.slice(1) })
        },
        { name: 'failed domain checks', match: /SELECT c.contypid::int8 AS domain_oid/, throws: true },
        { name: 'failed lock batch after the first relation', match: /\bLOCK TABLE ONLY\b.*,/s, throws: true },
        { name: 'failed single LOCK', match: /\bLOCK TABLE ONLY/, throws: true },
        {
            name: 'changed post-statement stamp',
            match: /AS stamp FROM/,
            postStatement: true,
            alter: (r) => ({ ...r, rows: [{ stamp: 'injected-change' }] }),
            message: /changed while it was being checked/
        },
        {
            name: 'failed post-statement stamp',
            match: /AS stamp FROM/,
            postStatement: true,
            throws: true,
            message: /changed while it was being checked/
        }
    ]
    it('normally allows the statement used for injections', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        assert.equal((await decision(state.url, statement, options, false)).ok, true)
        const auto = await decision(state.url, `SELECT ${etl}.auto_ok(2) LIMIT 50`, {}, false)
        assert.equal(auto.ok, true, auto.message)
        // A writer-owned write function is refused even when explicitly listed.
        await assert.rejects(
            queryAnalystUrl(state.url, `SELECT ${etl}.write_probe() LIMIT 50`, { ...options, allowedFunctions: `${etl}.write_probe()` })
        )
        await noEffects(state)
    })
    for (const fault of injections) {
        it(fault.name, async (t) => {
            if (!state.url) return t.skip('Local Postgres admin is unavailable')
            await fault.prepare?.()
            const uninjected = fault.allowed ? await queryAnalystUrl(state.url, statement, options) : undefined
            const original = Client.prototype.query
            const sent = []
            let begins = 0
            let hit = false
            let userSent = false
            setGuardLegacyRoundTripsForTests(false)
            Client.prototype.query = async function (...args) {
                const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                if (/^BEGIN/.test(text)) begins++
                // CREATE TEMP VIEW parses the statement without executing it during the check transaction.
                const user = !/^CREATE TEMP VIEW/.test(text) && text.includes(statement)
                const parts = text.split('\n;\n')
                const index = parts.findIndex(
                    (part) => fault.match.test(part) && (!fault.params || fault.params.test(JSON.stringify(args[1] ?? []) + part))
                )
                const matches =
                    !hit &&
                    index >= 0 &&
                    (!fault.checkTransaction || begins === 1) &&
                    (!fault.queryTransaction || begins === 2) &&
                    (!fault.postStatement || userSent)
                if (matches && fault.throws) {
                    hit = true
                    throw new Error(`Injected ${fault.name}`)
                }
                sent.push(text)
                userSent ||= user
                const result = await original.apply(this, args)
                if (!matches) return result
                hit = true
                const entry = Array.isArray(result) ? result[index] : result
                const altered = fault.alter(entry)
                if (/^(empty|short) /.test(fault.name))
                    assert.ok(altered.rows.length < entry.rows.length, 'Short-result injection must remove a real row')
                if (Array.isArray(result)) {
                    result[index] = altered
                    return result
                }
                return altered
            }
            try {
                if (fault.allowed) {
                    const result = await queryAnalystUrl(state.url, statement, options)
                    assert.deepEqual(result.rows, uninjected.rows, 'An unused allowlist entry does not affect the allowed statement')
                } else {
                    await assert.rejects(queryAnalystUrl(state.url, statement, options), fault.message).catch((error) => {
                        if (hit && error.code === 'ERR_ASSERTION') t.diagnostic(`STOP: fail-open injection: ${fault.name}`)
                        throw error
                    })
                }
                assert.ok(hit, 'The intended guard query was intercepted')
                if (fault.postStatement) assert.equal(userSent, true, 'The post-statement stamp follows the user query')
                if (!fault.postStatement && !fault.allowed)
                    assert.equal(
                        sent.some((text) => !/^CREATE TEMP VIEW/.test(text) && text.includes(statement)),
                        false,
                        'Failure precedes sending the user statement'
                    )
            } finally {
                Client.prototype.query = original
                setGuardLegacyRoundTripsForTests(false)
            }
            await noEffects(state)
        })
    }
})

function isAllowlistLookup(text) {
    return /to_regprocedure|parse_ident/.test(text) && /\bpg_proc\b/.test(text)
}

function lockListElements(list) {
    const elements = []
    let quoted = false
    let start = 0
    for (let i = 0; i < list.length; i++) {
        if (list[i] === '"') {
            if (quoted && list[i + 1] === '"') i++
            else quoted = !quoted
        } else if (list[i] === ',' && !quoted) {
            elements.push(list.slice(start, i).trim())
            start = i + 1
        }
    }
    elements.push(list.slice(start).trim())
    return elements
}

function lockStatements(text) {
    const statements = text.split(/\n;\n|; /)
    if (!statements.every((part) => /^(LOCK TABLE .+ IN ACCESS SHARE MODE|SELECT 1 FROM ONLY .+ LIMIT 0)$/.test(part))) return [text]
    return statements.flatMap((part) => {
        const lock = /^LOCK TABLE (.+) IN ACCESS SHARE MODE$/.exec(part)
        // Preserve a missing ONLY so ordered parity with the legacy locks fails.
        return lock ? lockListElements(lock[1]).map((element) => `LOCK TABLE ${element} IN ACCESS SHARE MODE`) : [part]
    })
}

function catalogLookups(reads) {
    const normalized = []
    for (const { sql, params, transaction } of reads) {
        if (/^(SELECT pg_backend_pid|SHOW transaction_read_only|SELECT pg_catalog.current_setting)/.test(sql)) continue
        if (isAllowlistLookup(sql)) {
            const [signatures, names] = params.length === 4 ? params.slice(2) : params
            const entries = Array.isArray(params[0])
                ? [...signatures.map((s) => `signature:${s}`), ...names.map((s) => `name:${s}`)]
                : [`${sql.includes('to_regprocedure') ? 'signature' : 'name'}:${params[0]}`]
            let previous = normalized.at(-1)
            if (!previous?.allowlist || previous.transaction !== transaction) {
                previous = { transaction, allowlist: [] }
                normalized.push(previous)
            }
            previous.allowlist.push(...entries)
        } else if (/SELECT d.refobjid::int8 AS oid FROM pg_depend d JOIN pg_rewrite/.test(sql)) {
            // The view oid and view name resolve the same dependency rows.
            normalized.push({ transaction, sql: 'SCOPE DEPENDS' })
        } else normalized.push({ transaction, sql, params })
    }
    return normalized.map((entry) => JSON.stringify(entry.allowlist ? { ...entry, allowlist: entry.allowlist.sort() } : entry))
}

function captureReads(reads, getTransaction) {
    setGuardReadHookForTests((sql, params) => reads.push({ sql, params: structuredClone(params), transaction: getTransaction() }))
}

it('normalizes lock lists without hiding missing ONLY modifiers or splitting quoted identifiers', () => {
    const first = '"schema, ""quoted"""."plain, table"'
    const second = '"schema, ""quoted"""."parent, table"'
    const legacy = [`LOCK TABLE ONLY ${first} IN ACCESS SHARE MODE`, `LOCK TABLE ONLY ${second} IN ACCESS SHARE MODE`]
    assert.deepEqual(lockStatements(`LOCK TABLE ONLY ${first}, ONLY ${second} IN ACCESS SHARE MODE`), legacy)
    assert.deepEqual(lockStatements(legacy.join('\n;\n')), legacy)
    assert.deepEqual(lockStatements(legacy.join('; ')), legacy)
    const missingOnly = lockStatements(`LOCK TABLE ONLY ${first}, ${second} IN ACCESS SHARE MODE`)
    assert.deepEqual(missingOnly, [legacy[0], `LOCK TABLE ${second} IN ACCESS SHARE MODE`])
    assert.notDeepEqual(missingOnly, legacy)
})

describe('analyst guard sends every catalog lookup', () => {
    const state = fixture()
    it('batches relation locks and resolves the allowlist once', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        const config = configurations[1]
        const sql =
            'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id JOIN items i ON i.order_id = o.id ORDER BY o.id LIMIT 50'
        const original = Client.prototype.query
        const captures = []
        const logical = []
        try {
            for (const legacy of [true, false]) {
                const texts = []
                const reads = []
                let transaction = 0
                captureReads(reads, () => transaction)
                Client.prototype.query = function (...args) {
                    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                    if (text.startsWith('BEGIN')) transaction++
                    texts.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
                    return original.apply(this, args)
                }
                const result = await decision(state.url, sql, config, legacy)
                assert.equal(result.ok, true, result.message)
                captures.push(texts)
                logical.push(catalogLookups(reads))
            }
        } finally {
            Client.prototype.query = original
            setGuardReadHookForTests(null)
            setGuardLegacyRoundTripsForTests(false)
        }
        const batches = captures[1].filter((text) => text.split(/\n;\n|; /).some((part) => part.startsWith('LOCK TABLE ONLY')))
        assert.equal(batches.length, 1)
        for (const batch of batches) {
            for (const part of batch.split(/\n;\n|; /)) {
                const lock = /^LOCK TABLE (.+) IN ACCESS SHARE MODE$/.exec(part)
                if (lock) {
                    for (const element of lockListElements(lock[1])) assert.ok(element.startsWith('ONLY '), element)
                }
            }
        }
        const relationNames = (texts) =>
            texts
                .flatMap((text) => text.split(/\n;\n|; /))
                .flatMap(lockStatements)
                .flatMap((text) => {
                    const match = /^(?:LOCK TABLE ONLY (.+) IN ACCESS SHARE MODE|SELECT 1 FROM ONLY (.+) LIMIT 0)$/.exec(text)
                    return match ? [match[1] || match[2]] : []
                })
        const legacyNames = relationNames(captures[0])
        assert.ok(legacyNames.length > 1)
        assert.deepEqual(relationNames(batches), legacyNames)
        assert.equal(captures[1].filter(isAllowlistLookup).length, 1)
        assert.equal(captures[0].filter(isAllowlistLookup).length, parseAllowedFunctions(config.allowedFunctions).length)
        assert.deepEqual(logical[1], logical[0])
    })
    it('locks the selected plain table and partitioned parent without locking the partition', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        const plain = `${schema}.guard_lock_plain`
        const parent = `${schema}.guard_lock_parent`
        const partition = `${schema}.guard_lock_partition`
        const original = Client.prototype.query
        const captures = []
        try {
            await state.owner.query(`
                CREATE TABLE ${plain}(id int);
                CREATE TABLE ${parent}(id int) PARTITION BY RANGE (id);
                CREATE TABLE ${partition} PARTITION OF ${parent} FOR VALUES FROM (0) TO (10);
                GRANT SELECT ON ${plain}, ${parent}, ${partition} TO "${state.writer}"
            `)
            for (const legacy of [true, false]) {
                const snapshots = []
                Client.prototype.query = async function (...args) {
                    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                    const result = await original.apply(this, args)
                    // In legacy mode the parent is the second lock; in batched mode both locks just completed.
                    // Read on this client before any user statement could acquire its own relation locks.
                    if (text.split(/\n;\n|; /).some((part) => part.startsWith('LOCK TABLE ') && part.includes(parent))) {
                        // The batch restores the statement search_path, so qualify lock names explicitly.
                        const locks = await original.call(
                            this,
                            "SELECT pg_catalog.quote_ident(n.nspname) OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) pg_catalog.quote_ident(c.relname) AS r FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'relation'"
                        )
                        snapshots.push(
                            [...new Set(locks.rows.map((row) => row.r).filter((r) => [plain, parent, partition].includes(r)))].sort()
                        )
                    }
                    return result
                }
                // Selection order puts the partitioned parent after the plain table, exercising a later LOCK list entry.
                const result = await decision(state.url, 'SELECT 1 LIMIT 50', { relations: [plain, parent] }, legacy)
                assert.equal(result.ok, true, result.message)
                assert.equal(snapshots.length, 1, 'Captured the locks inside the query transaction')
                assert.deepEqual(snapshots[0], [plain, parent].sort(), 'The selected relations are locked, but their partition is not')
                captures.push(snapshots[0])
            }
            assert.deepEqual(captures[1], captures[0])
        } finally {
            Client.prototype.query = original
            setGuardLegacyRoundTripsForTests(false)
            await state.owner.query(`DROP TABLE IF EXISTS ${parent}, ${plain} CASCADE`)
        }
    })
    const entries = [
        { config: configurations[0], sql: 'SELECT id FROM orders ORDER BY id LIMIT 50' },
        { config: configurations[1], sql: 'SELECT id FROM orders ORDER BY id LIMIT 50' },
        { config: configurations[0], sql: 'SELECT _etl_safe_round(total) FROM orders ORDER BY id LIMIT 50' },
        { config: configurations[1], sql: 'SELECT _etl_safe_round(total) FROM order_summary ORDER BY id LIMIT 50' }
    ]
    for (const { config, sql } of entries)
        it(`${config.name}: ${sql}`, async (t) => {
            if (!state.url) return t.skip('Local Postgres admin is unavailable')
            const original = Client.prototype.query
            const captures = []
            try {
                for (const legacy of [true, false]) {
                    const texts = []
                    const reads = []
                    let transaction = 0
                    captureReads(reads, () => transaction)
                    Client.prototype.query = function (...args) {
                        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                        if (text.startsWith('BEGIN')) transaction++
                        texts.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
                        return original.apply(this, args)
                    }
                    const result = await decision(state.url, sql, config, legacy)
                    assert.equal(result.ok, true, result.message)
                    captures.push(catalogLookups(reads))
                }
            } finally {
                Client.prototype.query = original
                setGuardReadHookForTests(null)
                setGuardLegacyRoundTripsForTests(false)
            }
            assert.deepEqual(captures[1], captures[0])
        })
})

describe('analyst guard batch transport (offline)', () => {
    function mockedRunner() {
        const calls = []
        const client = {
            escapeLiteral: Client.prototype.escapeLiteral,
            async query(text, params) {
                calls.push({ text, params })
                const results = text.split('\n;\n').map((sql) => ({ rows: [{ sql, params }] }))
                return results.length === 1 ? results[0] : results
            }
        }
        return { runner: postgresRunner(client), calls, client }
    }
    after(() => {
        setGuardBatchHookForTests(null)
        setGuardReadHookForTests(null)
    })
    it('inlines pg array text and scalars as inert literals at the same placeholder positions', async () => {
        const { runner, calls, client } = mockedRunner()
        const payload = "quote'\\'); DROP TABLE x; --"
        const params = [null, undefined, 1.25, true, false, payload, [payload, null, ['a', 'b']]]
        const { prepareValue } = createRequire(new URL('../packages/components/package.json', import.meta.url))('pg/lib/utils.js')
        await runner.prefetch([
            { sql: "SELECT '?' AS mark, ?, ?, ?, ?, ?, ?, ? -- comment", params },
            { exec: 'SET LOCAL standard_conforming_strings = on' }
        ])
        assert.equal(calls.length, 1)
        assert.equal(calls[0].params, undefined, 'The batch uses simple protocol')
        assert.equal(
            calls[0].text,
            `SELECT '?' AS mark, NULL, NULL, 1.25, TRUE, FALSE, ${client.escapeLiteral(payload)}, ${client.escapeLiteral(
                prepareValue(params[6])
            )} -- comment\n;\nSET LOCAL standard_conforming_strings = on`
        )
        for (const value of [NaN, Infinity, -Infinity, {}, new Date(), 1n, [Infinity], [{ bad: true }]])
            await assert.rejects(runner.prefetch([{ sql: 'SELECT ?', params: [value] }]), { message: GUARD_BATCH_MESSAGE })
        assert.equal(calls.length, 1, 'Invalid parameters are refused before sending')
    })
    it('consumes exact keys once, retains duplicate reads and clears all stored results', async () => {
        const { runner, calls } = mockedRunner()
        await runner.prefetch([
            { sql: 'SELECT ?', params: [1] },
            { sql: 'SELECT ?', params: [1] }
        ])
        await runner.all('SELECT ?', [1])
        await runner.get('SELECT ?', [1])
        assert.equal(calls.length, 1)
        await runner.all('SELECT ?', [2])
        await runner.all('SELECT ?', [1])
        assert.equal(calls.length, 3)
        assert.equal(calls[1].text, 'SELECT $1')
        await runner.prefetch([{ sql: 'SELECT 3' }])
        runner.clearPrefetch()
        await runner.all('SELECT 3')
        assert.equal(calls.length, 5)
    })
    it('normalizes a single result and refuses short or failed batches without publishing results', async () => {
        const { runner, calls } = mockedRunner()
        await runner.prefetch([{ sql: 'SELECT 1' }])
        assert.equal((await runner.all('SELECT 1')).length, 1)
        try {
            setGuardBatchHookForTests((text, results) => results.slice(0, -1))
            await assert.rejects(runner.prefetch([{ sql: 'SELECT 2' }, { sql: 'SELECT 3' }]), { message: GUARD_BATCH_MESSAGE })
            setGuardBatchHookForTests(() => {
                throw new Error('injected failure')
            })
            await assert.rejects(runner.prefetch([{ sql: 'SELECT 4' }]), /injected failure/)
        } finally {
            setGuardBatchHookForTests(null)
        }
        await runner.all('SELECT 2')
        await runner.all('SELECT 4')
        assert.equal(calls.length, 5)
    })
    it('keeps supersets call-local and drops only the empty lateral row', async () => {
        const { runner, client } = mockedRunner()
        client.query = async () => ({ rows: [{ requested: ['1', '2'], oid: null, code: null }] })
        await runner.prefetchSuperset([{ superset: 'KEY', sql: 'SELECT 1' }])
        assert.deepEqual(runner.takeSuperset('KEY'), { requested: new Set([1, 2]), rows: [] })
        assert.equal(runner.takeSuperset('KEY'), undefined)
        client.query = async () => ({ rows: [{ requested: ['1', '2'], oid: '2', code: null }] })
        await runner.prefetchSuperset([{ superset: 'KEY', sql: 'SELECT 1' }])
        assert.deepEqual(runner.takeSuperset('KEY').rows, [{ oid: '2', code: null }])
        await runner.prefetchSuperset([{ superset: 'KEY', sql: 'SELECT 1' }])
        runner.clearPrefetch()
        assert.equal(runner.takeSuperset('KEY'), undefined)
    })
    it('runs a prediction miss under pg_catalog and restores the statement path last', async () => {
        const { runner, calls } = mockedRunner()
        runner.batchedGuard = true
        runner.pathSetByBatch = true
        runner.statementPathSql = "SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true)"
        await runner.all('SELECT ?', [42])
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].text.split('\n;\n'), [
            "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
            'SELECT 42',
            runner.statementPathSql
        ])
        assert.equal(runner.pathSetByBatch, true)
    })
})

describe('analyst guard catalog batch failures', () => {
    const state = fixture()
    const statement = `SELECT o.id FROM ${schema}.orders o JOIN ${schema}.customers c ON c.id = o.customer_id ORDER BY o.id LIMIT 50`
    const options = { readOnlySql: true, relations: selection, allowedFunctions: allowlist, rowCap: 50 }
    const batches = [
        { name: 'B2', match: (text) => text.startsWith('SELECT DISTINCT format_type') },
        { name: 'B3', match: (text) => text.startsWith('SELECT c.oid::int8 AS oid, c.relkind AS kind') },
        { name: 'B4', match: (text) => text.startsWith('BEGIN TRANSACTION READ ONLY') },
        {
            name: 'B5',
            match: (text) => text.startsWith("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)\n;\nSELECT md5"),
            post: true
        }
    ]
    for (const batch of batches)
        for (const short of [false, true])
            it(`${batch.name} ${short ? 'short result' : 'failure'} refuses`, async (t) => {
                if (!state.url) return t.skip('Local Postgres admin is unavailable')
                let hit = false
                let userSent = false
                const original = Client.prototype.query
                Client.prototype.query = function (...args) {
                    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                    if (!text.startsWith('CREATE TEMP VIEW') && text.includes(statement)) userSent = true
                    return original.apply(this, args)
                }
                setGuardBatchHookForTests((text, results) => {
                    if (!hit && batch.match(text)) {
                        hit = true
                        if (short) return results.slice(0, -1)
                        throw new Error('Injected batch failure')
                    }
                })
                try {
                    await assert.rejects(queryAnalystUrl(state.url, statement, options), (error) => {
                        if (batch.post) assert.match(error.message, /changed while it was being checked/)
                        else if (short) assert.equal(error.message, GUARD_BATCH_MESSAGE)
                        return true
                    })
                    assert.ok(hit)
                    // B5 necessarily follows execution; its failure discards the page. Earlier failures never send it.
                    assert.equal(userSent, Boolean(batch.post))
                } finally {
                    setGuardBatchHookForTests(null)
                    Client.prototype.query = original
                }
                await noEffects(state)
            })
    it('falls through when domain superset coverage misses a needed id and still refuses risky CHECKs', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        await state.owner.query(`CREATE DOMAIN ${schema}.unsafe AS int CHECK (${schema}.bump() > 0)`)
        const legacy = await decision(state.url, statement, options, true)
        let misses = 0
        setGuardBatchHookForTests((text, results) =>
            results.map((result) => ({
                ...result,
                rows: result.rows.map((row) => {
                    if (!('requested' in row)) return row
                    misses++
                    return { ...row, requested: [] }
                })
            }))
        )
        try {
            const current = await decision(state.url, statement, options, false)
            assert.equal(current.ok, false)
            assert.deepEqual(current, legacy)
            assert.ok(misses > 0)
            await noEffects(state)
        } finally {
            setGuardBatchHookForTests(null)
            await state.owner.query(`DROP DOMAIN ${schema}.unsafe`)
        }
    })
    it('falls through when a view adds operator ids after the B3 prediction and still refuses its write function', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        await state.owner.query(
            `CREATE VIEW ${schema}.prediction_miss AS SELECT ${etl}.write_probe() AS id FROM ${schema}.orders WHERE id = 1; GRANT SELECT ON ${schema}.prediction_miss TO "${state.writer}"`
        )
        const sql = `SELECT v.id FROM ${schema}.prediction_miss v CROSS JOIN ${schema}.orders o WHERE o.id > 0 LIMIT 50`
        const config = { ...options, relations: [...selection, `${schema}.prediction_miss`] }
        const original = Client.prototype.query
        let fallback = false
        let userSent = false
        try {
            const legacy = await decision(state.url, sql, config, true)
            Client.prototype.query = function (...args) {
                const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
                if (text.startsWith('SELECT o.oprname AS name') && args[1]?.[0]?.length > 1) fallback = true
                if (!text.startsWith('CREATE TEMP VIEW') && text.includes(sql)) userSent = true
                return original.apply(this, args)
            }
            const current = await decision(state.url, sql, config, false)
            assert.equal(current.ok, false)
            assert.deepEqual(current, legacy)
            assert.equal(fallback, true)
            assert.equal(userSent, false)
        } finally {
            Client.prototype.query = original
            await state.owner.query(`DROP VIEW ${schema}.prediction_miss`)
        }
        await noEffects(state)
    })
    it('keeps quote, backslash and SQL-looking allowlist names and relation names inert', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        const name = `inert'\\'); DROP TABLE x; --`
        const quoted = '"' + name.replaceAll('"', '""') + '"'
        await state.owner.query(
            `CREATE TABLE ${schema}.${quoted}(id int); CREATE FUNCTION ${schema}.${quoted}(int) RETURNS int IMMUTABLE LANGUAGE sql AS 'SELECT $1'; GRANT SELECT ON ${schema}.${quoted} TO "${state.writer}"`
        )
        try {
            const sql = `SELECT ${schema}.${quoted}(1) FROM ${schema}.${quoted} LIMIT 50`
            const config = {
                relations: [...selection, `${schema}.${quoted}`],
                allowedFunctions: `${allowlist}\n${schema}.${quoted}(integer)`
            }
            const legacy = await decision(state.url, sql, config, true)
            const current = await decision(state.url, sql, config, false)
            assert.equal(legacy.ok, true, legacy.message)
            assert.deepEqual(current, legacy)
            await noEffects(state)
        } finally {
            await state.owner.query(`DROP TABLE ${schema}.${quoted}; DROP FUNCTION ${schema}.${quoted}(int)`)
        }
    })
})

describe('analyst guard benchmark catalog shape', () => {
    const state = fixture()
    it('uses at most 20 client queries with 19 selections and five CHECK domains', async (t) => {
        if (!state.url) return t.skip('Local Postgres admin is unavailable')
        const extra = Array.from({ length: 12 }, (_, i) => `${schema}.bench_${i}`)
        for (const name of extra) await state.owner.query(`CREATE TABLE ${name}(id int); GRANT SELECT ON ${name} TO "${state.writer}"`)
        for (let i = 0; i < 5; i++) await state.owner.query(`CREATE DOMAIN ${schema}.bench_domain_${i} AS int CHECK (VALUE >= ${i})`)
        const timings = []
        const original = Client.prototype.query
        const calls = []
        Client.prototype.query = function (...args) {
            calls.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
            return original.apply(this, args)
        }
        try {
            await withAnalystScope(
                'guard-benchmark',
                () =>
                    queryAnalystUrl(
                        state.url,
                        'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id LIMIT 50',
                        { readOnlySql: true, relations: [...selection, ...extra], allowedFunctions: allowlist, rowCap: 50 }
                    ),
                { timings }
            )
        } finally {
            Client.prototype.query = original
        }
        t.diagnostic(`19 selections, 5 CHECK domains: ${calls.length} round trips`)
        assert.equal(calls.length, timings[0].roundTrips)
        assert.ok(calls.length <= 20, calls.map((text, i) => `${i + 1}: ${text.slice(0, 100)}`).join('\n'))
        assert.equal(calls.at(-1), 'ROLLBACK', 'Final rollback remains a standalone query')
        const create = calls.find((text) => text.startsWith('CREATE TEMP VIEW'))
        assert.ok(create && !create.includes('\n;\n'))
        await noEffects(state)
    })
})

// Exercises transaction orchestration without a socket. Live tests above remain the SQL/decision oracle.
async function withCatalogClient(fn, { scoped = true, policy = false } = {}) {
    const saved = { query: Client.prototype.query, connect: Client.prototype.connect, end: Client.prototype.end }
    const calls = []
    const reads = []
    const names = [...selection, ...Array.from({ length: 12 }, (_, i) => `${schema}.bench_${i}`)]
    const selected = names.map((name, i) => ({ name, oid: String(101 + i), relkind: 'r', columns: 1, column_names: ['id'], comment: '' }))
    const tree = '{QUERY :relid 101 :relid 102 :opno 96 :opfuncid 65 :vartype 23}'
    const domainTree = '{OPEXPR :opno 96 :opfuncid 65 :opresulttype 16 :consttype 23}'
    let transaction = 0
    const rows = (sql, params) => {
        if (sql.startsWith('SELECT pg_catalog.current_setting')) return [{ p: schema }]
        if (sql.startsWith('SELECT pg_backend_pid')) return [{ pid: 777 }]
        if (sql === 'SHOW transaction_read_only') return [{ transaction_read_only: 'on' }]
        if (/^SELECT DISTINCT format_type/.test(sql)) return []
        if (sql.startsWith('SELECT md5')) return [{ stamp: 'stable' }]
        if (sql.startsWith('WITH req AS MATERIALIZED')) {
            const requested = ['96', '65', '16', '23']
            return /p.provolatile AS volatility/.test(sql)
                ? [{ requested, oid: '65', name: 'int4eq', schema: 'pg_catalog', volatility: 'i' }]
                : [{ requested, oid: '96', schema: 'pg_catalog', code: '65' }]
        }
        if (sql.startsWith('SELECT c.contypid'))
            return Array.from({ length: 5 }, (_, i) => ({
                domain_oid: String(500 + i),
                domain: `domain_${i}`,
                tree: domainTree,
                depends: ['65']
            }))
        if (/FROM unnest\(.*::text\[\]\) WITH ORDINALITY/s.test(sql)) return selected
        if (/^SELECT r.ev_class/.test(sql)) return [{ view: '999', tree }]
        if (/^SELECT d.refobjid.*pg_rewrite/.test(sql)) return [{ oid: '101' }, { oid: '102' }]
        if (sql.startsWith('SELECT c.relkind AS kind'))
            return [
                { kind: 'r', name: names[0] },
                { kind: 'r', name: names[1] }
            ]
        if (sql.startsWith('SELECT c.oid::int8 AS oid, c.relkind AS kind')) {
            const ids = params?.[0] || [...sql.matchAll(/"(\d+)"/g)].map((m) => Number(m[1]))
            return ids.map((oid) => ({
                oid: String(oid),
                kind: 'r',
                name: names[oid - 101],
                tree: null,
                policies: policy && Number(oid) === 101 ? ['{QUERY :relid 102}'] : []
            }))
        }
        if (sql.startsWith('SELECT o.oprname AS name')) return [{ name: '=', schema: 'pg_catalog', code: '65' }]
        if (sql.startsWith('SELECT o.oid::int8 AS oid')) return [{ oid: '96', schema: 'pg_catalog', code: '65' }]
        if (sql.startsWith('SELECT p.oid::int8 AS oid, p.proname AS name'))
            return [{ oid: '65', name: 'int4eq', schema: 'pg_catalog', volatility: 'i' }]
        if (/^WITH RECURSIVE t\(oid\)/.test(sql))
            return [{ oid: '23', name: 'integer', typname: 'int4', typtype: 'b', schema: 'pg_catalog', foreign_io: [] }]
        if (sql.startsWith("SELECT 'regconfig'")) return [{ regconfig: '3734', regdictionary: '3769' }]
        if (isAllowlistLookup(sql)) return [{ oid: '501' }]
        if (sql.startsWith('SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc')) return []
        if (sql.includes('guard_mock_user')) return [{ id: 1 }]
        if (
            /^(BEGIN|SET LOCAL|SELECT pg_catalog.set_config|DEALLOCATE|DROP VIEW|LOCK TABLE|CREATE TEMP VIEW|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK|SELECT 1 FROM ONLY)/.test(
                sql
            )
        )
            return []
        throw new Error(`Unmodelled catalog read: ${sql}`)
    }
    Client.prototype.connect = async function () {}
    Client.prototype.end = async function () {}
    Client.prototype.query = async function (query, params) {
        const text = typeof query === 'string' ? query : query.text
        calls.push({ text, named: typeof query === 'object' && Boolean(query.name) })
        if (text.startsWith('BEGIN')) transaction++
        const parts = text.split(text.includes('\n;\n') ? '\n;\n' : text.startsWith('BEGIN') ? '; ' : /$^/)
        const results = parts.map((sql) => ({ rows: rows(sql, params) }))
        return results.length === 1 ? results[0] : results
    }
    captureReads(reads, () => transaction)
    try {
        return await fn({
            calls,
            reads,
            options: { readOnlySql: true, ...(scoped ? { relations: names } : {}), allowedFunctions: allowlist, rowCap: 50 },
            statement: `SELECT o.id AS guard_mock_user FROM ${schema}.orders o JOIN ${schema}.customers c ON c.id = o.customer_id LIMIT 50`
        })
    } finally {
        Object.assign(Client.prototype, saved)
        setGuardReadHookForTests(null)
        setGuardBatchHookForTests(null)
        setGuardLegacyRoundTripsForTests(false)
    }
}

describe('analyst guard transaction orchestration (offline)', () => {
    for (const scoped of [true, false])
        for (const policy of [false, true])
            it(`keeps logical read order with scoped=${scoped}, policy=${policy}`, async (t) => {
                const captures = []
                for (const legacy of [true, false])
                    await withCatalogClient(
                        async ({ calls, reads, options, statement }) => {
                            const result = await decision('postgresql://127.0.0.1:55440/mock', statement, options, legacy)
                            assert.equal(result.ok, true, result.message)
                            captures.push(catalogLookups(reads))
                            assert.equal(calls.at(-1).text, 'ROLLBACK')
                            const creates = calls.filter(({ text }) => text.startsWith('CREATE TEMP VIEW'))
                            assert.equal(creates.length, 1)
                            assert.equal(creates[0].named, true)
                            assert.ok(!creates[0].text.includes('\n;\n'))
                            if (!legacy) {
                                t.diagnostic(`mock 19 selections, 5 domains: ${calls.length} queries`)
                                assert.ok(calls.length <= 20)
                                const allowlistCalls = calls.filter(({ text }) => isAllowlistLookup(text))
                                assert.equal(allowlistCalls.length, 1)
                                assert.ok(!allowlistCalls[0].text.includes('\n;\n'), 'Allowlist resolution stays outside prefetch batches')
                                if (policy) {
                                    // Policy locks remain a separate error boundary before definition reads.
                                    const definitionBatch = calls.findIndex(
                                        ({ text }) =>
                                            text.startsWith('SELECT DISTINCT format_type') &&
                                            !text.includes('WITH ORDINALITY') &&
                                            !text.includes('regconfigin')
                                    )
                                    const policyLock = calls.findLastIndex(({ text }) => text.startsWith('LOCK TABLE'))
                                    assert.ok(policyLock >= 0 && policyLock < definitionBatch)
                                }
                            }
                        },
                        { scoped, policy }
                    )
                assert.deepEqual(captures[1], captures[0])
            })
})

describe('analyst guard broader callers (offline)', () => {
    it('keeps the separate parse queries for a runner without batchedGuard', async () => {
        const calls = []
        const client = {
            async query(query, params) {
                const text = typeof query === 'string' ? query : query.text
                calls.push({ query, text, params })
                return { rows: text.startsWith('SELECT r.ev_class') ? [{ view: '999', tree: '{QUERY}' }] : [] }
            }
        }
        const runner = postgresRunner(client)
        const reads = []
        runner.logicalRead = (sql, params) => reads.push({ sql, params })
        runner.statementSearchPath = 'pg_catalog, public'
        assert.equal(runner.batchedGuard, undefined)
        assert.equal(runner.legacyRoundTrips, undefined)
        await checkStatementScope(client, runner, 'SELECT 1', [{ oid: 101 }], () => true)
        const start = calls.findIndex(({ text }) => text.startsWith('CREATE TEMP VIEW'))
        const parse = calls.slice(start, start + 6)
        assert.equal(parse.length, 6)
        assert.ok(parse[0].query.name, 'CREATE TEMP VIEW uses a named statement')
        assert.equal(parse[1].text, `DEALLOCATE ${parse[0].query.name}`)
        assert.equal(parse[2].text, "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
        assert.match(parse[3].text, /^SELECT r.ev_class.*FROM pg_rewrite/)
        assert.match(parse[4].text, /^SELECT d.refobjid.*WHERE r.ev_class = \$1::oid/)
        assert.deepEqual(parse[4].params, ['999'])
        const depend = reads.find(({ sql }) => sql.startsWith('SELECT d.refobjid'))
        assert.match(depend.sql, /WHERE r.ev_class = \?::oid/)
        assert.deepEqual(depend.params, ['999'])
        assert.match(parse[5].text, /^DROP VIEW pg_temp\./)
        assert.ok(
            calls.every(({ text }) => !text.includes('\n;\n')),
            'no catalog queries are batched'
        )
    })
    for (const scoped of [true, false])
        it(`retains logical reads without readOnlySql, scoped=${scoped}`, async () => {
            const captures = []
            for (const legacy of [true, false])
                await withCatalogClient(
                    async ({ reads, options, statement }) => {
                        resetRiskyDomainCacheForTests()
                        const result = await decision(
                            'postgresql://127.0.0.1:55440/mock',
                            statement,
                            { ...options, readOnlySql: false },
                            legacy
                        )
                        assert.equal(result.ok, true, result.message)
                        captures.push(catalogLookups(reads))
                    },
                    { scoped }
                )
            assert.deepEqual(captures[1], captures[0])
        })
})

describe('analyst guard failure orchestration (offline)', () => {
    const batchMatchers = {
        B2: (text) => text.startsWith('SELECT DISTINCT format_type'),
        B3: (text) => text.startsWith('SELECT c.oid::int8 AS oid, c.relkind AS kind'),
        B4: (text) => text.startsWith('BEGIN TRANSACTION READ ONLY'),
        B5: (text) => text.startsWith("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)\n;\nSELECT md5")
    }
    for (const [batch, match] of Object.entries(batchMatchers))
        for (const short of [true, false])
            it(`${batch}: ${short ? 'short' : 'thrown'} batch refuses the page`, async () => {
                await withCatalogClient(async ({ calls, options, statement }) => {
                    let hit = false
                    setGuardBatchHookForTests((text, results) => {
                        if (hit || !match(text)) return
                        hit = true
                        if (short) return results.slice(0, -1)
                        throw new Error('Injected batch failure')
                    })
                    const result = await decision('postgresql://127.0.0.1:55440/mock', statement, options, false)
                    assert.equal(result.ok, false)
                    assert.ok(hit)
                    if (batch === 'B5') assert.match(result.message, /changed while it was being checked/)
                    else if (short) assert.equal(result.message, GUARD_BATCH_MESSAGE)
                    assert.equal(
                        calls.some(({ text }) => !text.startsWith('CREATE TEMP VIEW') && text.includes(statement)),
                        batch === 'B5'
                    )
                    assert.equal(calls.at(-1).text, 'ROLLBACK')
                })
            })
    it('retains POLICY_UNLOCKED for a failed policy lock', async () => {
        await withCatalogClient(
            async ({ calls, options, statement }) => {
                const original = Client.prototype.query
                Client.prototype.query = function (query, ...args) {
                    if (typeof query === 'string' && query.startsWith('LOCK TABLE')) throw new Error('policy lock failed')
                    return original.call(this, query, ...args)
                }
                const result = await decision('postgresql://127.0.0.1:55440/mock', statement, options, false)
                assert.equal(result.ok, false)
                assert.match(result.message, /row-security policy reads could not be locked/)
                assert.equal(
                    calls.some(({ text }) => !text.startsWith('CREATE TEMP VIEW') && text.includes(statement)),
                    false
                )
            },
            { policy: true }
        )
    })
})
