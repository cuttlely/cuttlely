// A database login whose role sets default_transaction_read_only=on is a normal deployment. The guard's check creates
// a temporary view in its own short transaction, which it opens READ WRITE and always rolls back; the query itself
// still runs in BEGIN TRANSACTION READ ONLY. These tests run against a local disposable Postgres.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import * as guard from '../packages/harness/runtime/analyst-relations.mjs'
import {
    describeAnalystUrlRelation,
    postgresRunner,
    queryAnalystUrl,
    setGuardLegacyRoundTripsForTests
} from '../packages/harness/runtime/analyst-store.mjs'

const { Client } = pg

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

function urlFor(user, password, database) {
    const { host, port } = adminConfig()
    return ['postgresql://', encodeURIComponent(user), ':', encodeURIComponent(password), '@', host, ':', port, '/', database].join('')
}

const TABLE = '"ZZ-TEST-sales"'
const SELECTED = [`public.${TABLE}`]
const MARK = 'zz_test_user_mark'
const env = { ...process.env, CUTTLELY_PINNED_QUERIES: '1' }
const pinEntry = {
    id: 'ZZ-TEST-ro-pin',
    name: 'pq_ro_sales',
    version: 1,
    sql: `SELECT id, region AS ${MARK} FROM ${TABLE} WHERE region=:r ORDER BY id LIMIT 20`,
    params: [{ name: 'r', type: 'text', required: true }]
}
const pinned = (args = { r: 'EU' }) => ({ entry: pinEntry, args, tool: pinEntry.name })

function callText(args) {
    return typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
}
function parts(text) {
    return text.split(text.includes('\n;\n') ? '\n;\n' : /; /)
}

// Records every query and the last transaction status each connection reported before end().
function recordQueries() {
    const originalQuery = Client.prototype.query
    const originalEnd = Client.prototype.end
    const calls = []
    const closes = []
    Client.prototype.query = function (...args) {
        if (!this.__zzWatched && this.connection) {
            this.__zzWatched = true
            this.connection.on('readyForQuery', (message) => {
                this.__zzStatus = message.status
            })
        }
        calls.push({
            client: this,
            text: callText(args),
            named: typeof args[0] === 'object' && args[0] !== null && Boolean(args[0].name),
            values: Array.isArray(args[1]) ? args[1] : args[0]?.values || []
        })
        return originalQuery.apply(this, args)
    }
    Client.prototype.end = async function (...args) {
        if (this.__zzWatched) {
            let tempViews = null
            try {
                const result = await originalQuery.call(
                    this,
                    "SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relname = 'cuttlely_scope_check' AND relpersistence = 't'"
                )
                tempViews = result.rows[0].n
            } catch {
                tempViews = 'error'
            }
            closes.push({ status: this.__zzStatus, tempViews })
        }
        return originalEnd.apply(this, args)
    }
    return {
        calls,
        closes,
        restore() {
            Client.prototype.query = originalQuery
            Client.prototype.end = originalEnd
        }
    }
}

// Splits recorded calls into the check (READ WRITE) and query (READ ONLY) transactions, in order.
function windows(calls) {
    let mode = 'none'
    const out = []
    for (const call of calls) {
        let first = true
        for (const part of parts(call.text)) {
            const p = part.trim()
            if (/^BEGIN TRANSACTION READ ONLY/.test(p)) mode = 'read-only'
            else if (/^BEGIN/.test(p)) mode = p.startsWith('BEGIN TRANSACTION READ WRITE') ? 'read-write' : 'plain'
            else if (/^(ROLLBACK|COMMIT|END)\b/.test(p) && !/^ROLLBACK TO/.test(p)) mode = 'none'
            if (first) out.push({ ...call, mode })
            first = false
        }
    }
    return out
}

describe('analyst: a login whose role defaults to read-only transactions', () => {
    const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`
    const dbName = `zz_test_rorole_${suffix}`
    const noTempDb = `zz_test_rorole_notemp_${suffix}`
    const reader = `zz_test_ro_${suffix}`
    const noTemp = `zz_test_notemp_${suffix}`
    const password = randomBytes(18).toString('base64url')
    let admin = null
    let owner = null
    let url = ''
    let noTempUrl = ''

    before(async () => {
        const client = new Client(adminConfig())
        try {
            await client.connect()
        } catch (error) {
            await client.end().catch(() => {})
            if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1')
                throw new Error(`CUTTLELY_TEST_PG_REQUIRED is set and Postgres is not reachable: ${error.message}`)
            return
        }
        admin = client
        await admin.query(`CREATE DATABASE "${dbName}"`)
        await admin.query(`CREATE DATABASE "${noTempDb}"`)
        await admin.query(`CREATE ROLE "${reader}" LOGIN PASSWORD '${password}'`)
        await admin.query(`ALTER ROLE "${reader}" SET default_transaction_read_only = on`)
        await admin.query(`CREATE ROLE "${noTemp}" LOGIN PASSWORD '${password}'`)
        owner = new Client(adminConfig(dbName))
        await owner.connect()
        await owner.query(`CREATE TABLE public.${TABLE} (id int8 PRIMARY KEY, region text);
            INSERT INTO public.${TABLE} SELECT g, CASE WHEN g % 2 = 0 THEN 'EU' ELSE 'US' END FROM generate_series(1, 30) g;
            CREATE TABLE public."ZZ-TEST-other" (id int);
            CREATE SEQUENCE public.zz_test_seq;
            GRANT SELECT ON public.${TABLE}, public."ZZ-TEST-other" TO "${reader}";
            GRANT USAGE ON SEQUENCE public.zz_test_seq TO "${reader}"`)
        const temp = await owner.query(`SELECT has_database_privilege($1, current_database(), 'TEMP') AS t`, [reader])
        assert.equal(temp.rows[0].t, true, 'TEMP comes from PUBLIC')
        const other = new Client(adminConfig(noTempDb))
        await other.connect()
        await other.query(`CREATE TABLE public.${TABLE} (id int8 PRIMARY KEY, region text);
            INSERT INTO public.${TABLE} VALUES (1, 'EU');
            GRANT SELECT ON public.${TABLE} TO "${noTemp}";
            REVOKE TEMPORARY ON DATABASE "${noTempDb}" FROM PUBLIC`)
        await other.end()
        url = urlFor(reader, password, dbName)
        noTempUrl = urlFor(noTemp, password, noTempDb)
    })

    after(async () => {
        setGuardLegacyRoundTripsForTests(false)
        await owner?.end().catch(() => {})
        if (!admin) return
        for (const db of [dbName, noTempDb]) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {})
        for (const role of [reader, noTemp]) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
        await admin.end().catch(() => {})
    })

    const skipped = (t) => {
        if (admin) return false
        t.skip('local disposable PostgreSQL unavailable')
        return true
    }
    const state = async () => {
        const rows = (await owner.query(`SELECT count(*)::int AS n FROM public.${TABLE}`)).rows[0].n
        const seq = (await owner.query('SELECT last_value::text AS v, is_called FROM public.zz_test_seq')).rows[0]
        return { rows, seq: `${seq.v}:${seq.is_called}` }
    }

    for (const legacy of [false, true]) {
        const mode = legacy ? 'old round trips' : 'batched round trips'

        it(`runs a free query, a selection query, a node query, a pin with its next page, and a describe (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            try {
                const free = await queryAnalystUrl(url, `SELECT id FROM ${TABLE} ORDER BY id LIMIT 3`, { env })
                assert.deepEqual(
                    free.rows.map((row) => String(row.id)),
                    ['1', '2', '3']
                )
                const scoped = await queryAnalystUrl(url, `SELECT id FROM ${TABLE} ORDER BY id LIMIT 3`, { relations: SELECTED, env })
                assert.equal(scoped.rows.length, 3)
                const node = await queryAnalystUrl(url, `SELECT id FROM ${TABLE} ORDER BY id LIMIT 3`, { readOnlySql: true, env })
                assert.equal(node.rows.length, 3)
                for (const relations of [SELECTED, undefined]) {
                    const options = { readOnlySql: true, env, rowCap: 10, scope: `ZZ-TEST-ro-${legacy}`, pinned: pinned() }
                    if (relations) options.relations = relations
                    const first = await queryAnalystUrl(url, null, options)
                    assert.equal(first.rows.length, 10)
                    assert.ok(first.rows.every((row) => row[MARK] === 'EU'))
                    assert.ok(first.cursor, 'a pin with more rows returns a cursor')
                    const second = await queryAnalystUrl(url, { cursor: first.cursor }, options)
                    assert.equal(second.rows.length, 5)
                    assert.ok(second.rows.every((row) => row[MARK] === 'EU'))
                }
                const described = await describeAnalystUrlRelation(url, { name: 'ZZ-TEST-sales' }, SELECTED)
                assert.ok(described.values, 'describe samples need the temporary view and run for this login')
            } finally {
                setGuardLegacyRoundTripsForTests(false)
            }
        })

        it(`still runs every query read only, so a write in the query fails (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            try {
                const show = `SELECT current_setting('transaction_read_only') AS ro FROM ${TABLE} LIMIT 1`
                for (const options of [{ env }, { relations: SELECTED, env }, { readOnlySql: true, env }]) {
                    const result = await queryAnalystUrl(url, show, options)
                    assert.equal(result.rows[0].ro, 'on')
                }
                const before = await state()
                await assert.rejects(queryAnalystUrl(url, "SELECT nextval('public.zz_test_seq') AS n", { env }), /read-only transaction/)
                await assert.rejects(
                    queryAnalystUrl(url, `WITH d AS (DELETE FROM public.${TABLE} RETURNING id) SELECT id FROM d`, { env }),
                    /read-only transaction/
                )
                await assert.rejects(
                    queryAnalystUrl(url, `WITH d AS (DELETE FROM public.${TABLE} RETURNING id) SELECT id FROM d`, {
                        relations: SELECTED,
                        env
                    })
                )
                assert.deepEqual(await state(), before)
            } finally {
                setGuardLegacyRoundTripsForTests(false)
            }
        })

        it(`sends the user text in the read-write check only as one named CREATE TEMP VIEW (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            const rec = recordQueries()
            try {
                await queryAnalystUrl(url, `SELECT id AS ${MARK} FROM ${TABLE} ORDER BY id LIMIT 3`, { relations: SELECTED, env })
                await queryAnalystUrl(url, `SELECT id AS ${MARK} FROM ${TABLE} ORDER BY id LIMIT 3`, { readOnlySql: true, env })
                await queryAnalystUrl(url, null, { readOnlySql: true, relations: SELECTED, env, pinned: pinned() })
            } finally {
                rec.restore()
                setGuardLegacyRoundTripsForTests(false)
            }
            const seen = windows(rec.calls)
            const checkBegins = rec.calls
                .flatMap((call) => parts(call.text))
                .filter((p) => /^BEGIN/.test(p) && !/^BEGIN TRANSACTION READ ONLY/.test(p))
            assert.equal(checkBegins.length, 3, 'one check transaction per call')
            for (const p of checkBegins) assert.ok(p.startsWith('BEGIN TRANSACTION READ WRITE'), p)
            const user = seen.filter((call) => call.text.includes(MARK))
            const inCheck = user.filter((call) => call.mode !== 'read-only')
            assert.equal(inCheck.length, 3, 'exactly one statement with user text per check')
            for (const call of inCheck) {
                assert.equal(call.mode, 'read-write')
                assert.ok(call.named, 'sent as a named statement over the extended protocol')
                assert.match(call.text, /^CREATE TEMP VIEW cuttlely_scope_check AS SELECT 1 FROM \(\n/)
                assert.equal(call.values.length, 0)
            }
            for (const call of seen.filter((c) => c.mode === 'read-write'))
                assert.doesNotMatch(call.text, /\b(EXPLAIN|PREPARE|analyst_n|analyst_page|pg_typeof)\b/)
            // The statement itself runs in the read-only transaction, with the pin's value as a bind.
            assert.ok(user.some((call) => call.mode === 'read-only' && !call.text.startsWith('CREATE TEMP VIEW')))
            const pinCheck = inCheck.find((call) => call.text.includes('NULL::pg_catalog.text'))
            assert.ok(pinCheck, 'the pin is checked through its NULL::type check text')
            assert.ok(!pinCheck.text.includes('EU'))
            assert.ok(seen.some((call) => call.mode === 'read-only' && call.values.includes('EU')))
        })

        it(`ends every check with ROLLBACK, never COMMIT, and closes an idle connection with no view left (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            const rec = recordQueries()
            try {
                await queryAnalystUrl(url, `SELECT id FROM ${TABLE} LIMIT 1`, { relations: SELECTED, env })
                await assert.rejects(
                    queryAnalystUrl(url, 'SELECT id FROM public."ZZ-TEST-other"', { relations: SELECTED, env }),
                    /does not include/
                )
                await assert.rejects(queryAnalystUrl(url, `SELECT nope FROM ${TABLE}`, { relations: SELECTED, env }), /nope/)
                await assert.rejects(
                    queryAnalystUrl(url, `SELECT 1 / (id - id) FROM ${TABLE}`, { relations: SELECTED, env }),
                    /division by zero/
                )
                await assert.rejects(queryAnalystUrl(url, `SELECT nope FROM ${TABLE} LIMIT 1`, { readOnlySql: true, env }), /nope/)
            } finally {
                rec.restore()
                setGuardLegacyRoundTripsForTests(false)
            }
            const all = rec.calls.flatMap((call) => parts(call.text).map((p) => p.trim()))
            assert.ok(!all.some((p) => /^(COMMIT|END)\b/i.test(p)), 'never COMMIT')
            let open = false
            for (const p of all) {
                if (p.startsWith('BEGIN TRANSACTION READ WRITE')) {
                    assert.equal(open, false)
                    open = true
                } else if (/^ROLLBACK$/.test(p)) open = false
            }
            assert.equal(open, false, 'each read-write check is rolled back')
            assert.equal(rec.closes.length, 5)
            for (const close of rec.closes) {
                assert.equal(close.status, 'I', 'idle, not in a transaction, before end()')
                assert.equal(close.tempViews, 0)
            }
        })
    }

    it('refuses stacked or break-out SQL in the check and leaves rows and the sequence unchanged', async (t) => {
        if (skipped(t)) return
        const attempts = [
            `SELECT id FROM ${TABLE}; DELETE FROM public.${TABLE}`,
            `SELECT 1) AS x; DELETE FROM public.${TABLE}; SELECT (1`,
            `SELECT 1) AS x; SELECT nextval('public.zz_test_seq'); SELECT (1`,
            `SELECT 1 /* */) x; INSERT INTO public.${TABLE} VALUES (999, 'X'); --`
        ]
        const before = await state()
        for (const sql of attempts) {
            await assert.rejects(queryAnalystUrl(url, sql, { relations: SELECTED, env }))
            await assert.rejects(queryAnalystUrl(url, sql, { readOnlySql: true, env }))
        }
        // The check itself, called directly in a read-write transaction: the extended protocol refuses a second command.
        const client = new Client({ connectionString: url })
        await client.connect()
        try {
            const runner = postgresRunner(client, { transaction: true })
            for (const sql of attempts) {
                await client.query('BEGIN TRANSACTION READ WRITE')
                try {
                    const relations = await guard.resolveRelations(runner, SELECTED)
                    await assert.rejects(
                        guard.checkStatementScope(client, runner, sql, relations, () => true, ''),
                        (error) => /multiple commands|syntax error/.test(error.message)
                    )
                } finally {
                    await client.query('ROLLBACK')
                }
            }
            const left = await client.query("SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relname = 'cuttlely_scope_check'")
            assert.equal(left.rows[0].n, 0)
        } finally {
            await client.end()
        }
        assert.deepEqual(await state(), before)
    })

    it('names a missing TEMP privilege plainly, and does not call it a standby', async (t) => {
        if (skipped(t)) return
        await assert.rejects(queryAnalystUrl(noTempUrl, `SELECT id FROM ${TABLE}`, { relations: SELECTED, env }), (error) => {
            assert.equal(error.message, guard.SCOPE_NO_TEMP)
            return true
        })
        await assert.rejects(queryAnalystUrl(noTempUrl, `SELECT id FROM ${TABLE} LIMIT 1`, { readOnlySql: true, env }), (error) => {
            assert.equal(error.message, guard.SCOPE_NO_TEMP_ANY)
            return true
        })
        assert.doesNotMatch(guard.SCOPE_NO_TEMP, /standby|replica/i)
        assert.doesNotMatch(guard.VALIDATION_STANDBY, /TEMP privilege/)
    })

    it('names a hot standby when the read-write check cannot start or its view is refused', async (t) => {
        if (skipped(t)) return
        const originalQuery = Client.prototype.query
        let failBegin = true
        Client.prototype.query = function (...args) {
            const text = callText(args)
            if (failBegin && parts(text).some((p) => p.startsWith('BEGIN TRANSACTION READ WRITE'))) {
                const error = new Error('cannot set transaction read-write mode during recovery')
                error.code = '0A000'
                // Leave the session in an aborted transaction, the worst state a failed BEGIN could leave, so the
                // fallback must clear it before it starts again.
                return originalQuery.call(this, 'BEGIN TRANSACTION READ WRITE; SELECT 1 / 0').then(
                    () => Promise.reject(error),
                    () => Promise.reject(error)
                )
            }
            if (text.includes('pg_is_in_recovery()')) return originalQuery.call(this, 'SELECT true AS r')
            if (!failBegin && text.startsWith('CREATE TEMP VIEW')) {
                const error = new Error('cannot execute CREATE VIEW in a read-only transaction')
                error.code = '25006'
                return Promise.reject(error)
            }
            return originalQuery.apply(this, args)
        }
        try {
            for (const options of [
                { relations: SELECTED },
                { readOnlySql: true },
                { readOnlySql: true, relations: SELECTED, pinned: pinned() }
            ]) {
                await assert.rejects(
                    queryAnalystUrl(url, options.pinned ? null : `SELECT id FROM ${TABLE} LIMIT 1`, { ...options, env }),
                    (error) => {
                        assert.equal(error.message, guard.VALIDATION_STANDBY)
                        return true
                    }
                )
            }
            // Describe still answers on a standby, without the samples that need the view.
            const described = await describeAnalystUrlRelation(url, { name: 'ZZ-TEST-sales' }, SELECTED)
            assert.equal(described.values, undefined)
            assert.ok(described.columns.length)
            failBegin = false
            for (const options of [{ relations: SELECTED }, { readOnlySql: true }]) {
                await assert.rejects(queryAnalystUrl(url, `SELECT id FROM ${TABLE} LIMIT 1`, { ...options, env }), (error) => {
                    assert.equal(error.message, guard.VALIDATION_STANDBY)
                    return true
                })
            }
        } finally {
            Client.prototype.query = originalQuery
        }
        // Without the standby, an unrelated failure to start the check keeps its own error.
        assert.equal(
            guard.validationFailure?.({ code: '0A000', message: 'cannot set transaction read-write mode during recovery' }),
            'standby'
        )
    })

    it('classifies standby and TEMP errors from SQLSTATE and recovery state', () => {
        const vf = guard.validationFailure
        assert.equal(typeof vf, 'function')
        assert.equal(vf({ code: '25006', message: 'cannot execute CREATE VIEW in a read-only transaction' }), 'standby')
        assert.equal(vf({ code: '0A000', message: 'cannot set transaction read-write mode during recovery' }), 'standby')
        assert.equal(vf({ code: '57P03', message: 'the database system is starting up' }, { inRecovery: true }), 'standby')
        assert.equal(vf({ code: '42501', message: 'permission denied to create temporary tables in database "x"' }), 'no-temp')
        assert.equal(vf({ code: '42501', message: 'permission denied for table t' }), '')
        assert.equal(vf({ code: '42P01', message: 'relation "t" does not exist' }), '')
        assert.equal(vf(new Error('boom')), '')
        assert.notEqual(guard.VALIDATION_STANDBY, guard.SCOPE_NO_TEMP)
        assert.notEqual(guard.VALIDATION_STANDBY, guard.SCOPE_UNCHECKABLE)
    })
})
