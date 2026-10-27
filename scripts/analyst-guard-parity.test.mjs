import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import { queryAnalystUrl, setGuardLegacyRoundTripsForTests, withAnalystScope } from '../packages/harness/runtime/analyst-store.mjs'

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

function fixture(shadow = false) {
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
        try {
            await owner.query('CREATE EXTENSION IF NOT EXISTS dblink')
            // Its foreign data wrapper globally refuses reads. Keep the callable functions for the corpus.
            await owner.query('ALTER EXTENSION dblink DROP FOREIGN DATA WRAPPER dblink_fdw')
            await owner.query('DROP FOREIGN DATA WRAPPER dblink_fdw')
        } catch {
            // Missing dblink must still fail closed in both modes.
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
        state.url = `postgresql://${writer}:${password}@${host}:${port}/${database}`
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

describe('analyst guard fails closed on failed or incomplete catalog reads', () => {
    const state = fixture()
    const statement = `SELECT ${schema}._etl_safe_round(total), ${schema}._etl_safe_pct(total, 2) FROM ${schema}.orders JOIN ${schema}.customers USING (id) ORDER BY id LIMIT 50`
    const options = { readOnlySql: true, relations: selection, allowedFunctions: allowlist, rowCap: 50 }
    const injections = [
        { name: 'empty allowlist lookup', match: /to_regprocedure/, params: /_etl_safe_round/, alter: (r) => ({ ...r, rows: [] }) },
        { name: 'failed allowlist lookup', match: /to_regprocedure/, params: /_etl_safe_round/, throws: true },
        {
            name: 'empty allowlist lookup for an unused entry',
            match: /to_regprocedure/,
            params: /_etl_safe_date/,
            allowed: true,
            alter: (r) => ({ ...r, rows: [] })
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
        { name: 'failed single LOCK', match: /\bLOCK TABLE ONLY/, throws: true },
        {
            name: 'changed post-statement stamp',
            match: /AS stamp FROM/,
            postStatement: true,
            alter: (r) => ({ ...r, rows: [{ stamp: 'injected-change' }] }),
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
                const matches =
                    !hit &&
                    fault.match.test(text) &&
                    (!fault.params || fault.params.test(JSON.stringify(args[1] ?? []))) &&
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
                assert.ok(result.rows.length > 0, 'Short-result injection must remove a real row')
                return fault.alter(result)
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

function catalogLookups(texts) {
    return texts
        .filter((text) => !/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(text))
        .map((text) => text.replace(/cuttlely_scope_check_\d+/g, 'cuttlely_scope_check_N'))
}

describe('analyst guard sends every catalog lookup', () => {
    const state = fixture()
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
                    Client.prototype.query = function (...args) {
                        texts.push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
                        return original.apply(this, args)
                    }
                    const result = await decision(state.url, sql, config, legacy)
                    assert.equal(result.ok, true, result.message)
                    captures.push(catalogLookups(texts))
                }
            } finally {
                Client.prototype.query = original
                setGuardLegacyRoundTripsForTests(false)
            }
            assert.deepEqual(captures[1], captures[0])
        })
})
