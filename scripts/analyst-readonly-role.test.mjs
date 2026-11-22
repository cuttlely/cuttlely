// A database login whose role sets default_transaction_read_only=on is a normal deployment. The guard prepares the
// statement without running it in its own read-only transaction; the query itself also runs in BEGIN READ ONLY.
// These tests run against a local disposable Postgres.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import * as guard from '../packages/harness/runtime/analyst-relations.mjs'
import {
    describeAnalystUrlRelation,
    postgresRunner,
    queryAnalystUrl,
    setGuardLegacyRoundTripsForTests
} from '../packages/harness/runtime/analyst-store.mjs'

const { Client } = pg
const require = createRequire(new URL('../packages/components/package.json', import.meta.url))
const CryptoJS = require('crypto-js')

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

// Splits recorded calls into transactions, in order.
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
                assert.ok(described.values, 'describe samples run for a default-read-only login')
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

        it(`sends the check as one named PREPARE and performs no DDL (${mode})`, async (t) => {
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
            const begins = rec.calls.flatMap((call) => parts(call.text)).filter((p) => /^BEGIN/.test(p))
            assert.equal(begins.length, 6, 'one check and one query transaction per call')
            for (const p of begins) assert.ok(p.startsWith('BEGIN TRANSACTION READ ONLY'), p)
            const user = seen.filter((call) => call.text.includes(MARK))
            const prepared = user.filter((call) => /^PREPARE cuttlely_scope_check_\d+ AS /.test(call.text))
            assert.equal(prepared.length, 3, 'exactly one prepared check per call')
            for (const call of prepared) {
                assert.equal(call.mode, 'read-only')
                assert.ok(call.named, 'sent as a named statement over the extended protocol')
                assert.equal(call.values.length, 0)
            }
            for (const call of seen)
                for (const statement of parts(call.text))
                    assert.doesNotMatch(statement, /^\s*(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|REINDEX)\b/i)
            for (const call of prepared) assert.doesNotMatch(call.text, /\b(EXPLAIN|analyst_n|analyst_page|pg_typeof)\b/)
            // The statement itself runs in the read-only transaction, with the pin's value as a bind.
            assert.ok(user.some((call) => call.mode === 'read-only' && !call.text.startsWith('PREPARE ')))
            const pinCheck = prepared.find((call) => call.text.includes('NULL::pg_catalog.text'))
            assert.ok(pinCheck, 'the pin is checked through its NULL::type check text')
            assert.ok(!pinCheck.text.includes('EU'))
            assert.ok(seen.some((call) => call.mode === 'read-only' && call.values.includes('EU')))
        })

        it(`leaves malformed FROM clause keywords to one PREPARE (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            const rec = recordQueries()
            try {
                for (const readOnlySql of [false, true]) {
                    const start = rec.calls.length
                    await assert.rejects(
                        queryAnalystUrl(url, 'SELECT FROM WHERE LIMIT 1', { readOnlySql, relations: SELECTED, env }),
                        /syntax error/
                    )
                    const prepares = rec.calls.slice(start).filter((call) => /^PREPARE /.test(call.text))
                    assert.equal(prepares.length, 1)
                    assert.match(prepares[0].text, /^PREPARE cuttlely_scope_check_\d+ AS SELECT FROM WHERE LIMIT 1$/)
                    assert.equal(prepares[0].named, true)
                }
            } finally {
                rec.restore()
                setGuardLegacyRoundTripsForTests(false)
            }
        })

        it(`resolves column and expression casts with exactly one PREPARE per check (${mode})`, async (t) => {
            if (skipped(t)) return
            setGuardLegacyRoundTripsForTests(legacy)
            const rec = recordQueries()
            try {
                for (const expression of ['id::numeric', '(id + 0)::numeric', 'CAST(id + 0 AS numeric)']) {
                    await queryAnalystUrl(url, `SELECT ${expression} AS ${MARK} FROM ${TABLE} LIMIT 1`, {
                        readOnlySql: true,
                        relations: SELECTED,
                        env
                    })
                }
            } finally {
                rec.restore()
                setGuardLegacyRoundTripsForTests(false)
            }
            const statements = rec.calls.flatMap((call) => parts(call.text))
            assert.equal(statements.filter((sql) => /^PREPARE /.test(sql)).length, 3, 'one PREPARE per call, including all probes')
            assert.equal(statements.filter((sql) => /^PREPARE cuttlely_scope_check_\d+ AS /.test(sql)).length, 3)
            for (const sql of statements) assert.doesNotMatch(sql, /^\s*(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|REINDEX)\b/i)
        })

        it(`ends every transaction with ROLLBACK, never COMMIT, and closes an idle connection (${mode})`, async (t) => {
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
                if (p.startsWith('BEGIN TRANSACTION READ ONLY')) {
                    assert.equal(open, false, 'the preceding transaction was rolled back')
                    open = true
                } else if (/^ROLLBACK$/.test(p)) open = false
            }
            assert.equal(open, false, 'each transaction is rolled back')
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
        // The check itself, called directly in a read-only transaction: the extended protocol refuses a second command.
        const client = new Client({ connectionString: url })
        await client.connect()
        try {
            const runner = postgresRunner(client, { transaction: true })
            for (const sql of attempts) {
                await client.query('BEGIN TRANSACTION READ ONLY')
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

    it('runs queries and describe samples without TEMP privilege', async (t) => {
        if (skipped(t)) return
        const scoped = await queryAnalystUrl(noTempUrl, `SELECT id FROM ${TABLE}`, { relations: SELECTED, env })
        assert.deepEqual(scoped.rows, [{ id: '1' }])
        const unscoped = await queryAnalystUrl(noTempUrl, `SELECT id FROM ${TABLE} LIMIT 1`, { readOnlySql: true, env })
        assert.deepEqual(unscoped.rows, [{ id: '1' }])
        const described = await describeAnalystUrlRelation(noTempUrl, { name: 'ZZ-TEST-sales' }, SELECTED, { readOnlySql: true })
        assert.ok(described.values)
    })
})

// Separate module instances give each simulated server its own in-process store cache.
let instanceNumber = 0
const SECRET_TABLE = 'cuttlely_analyst_admin.role_secret'
const TEST_KEY = 'zz-test-analyst-credential-key'
const ident = (name) => `"${name.replace(/"/g, '""')}"`
const literal = (value) => `'${value.replace(/'/g, "''")}'`
const encrypted = (record, key = TEST_KEY) => CryptoJS.AES.encrypt(JSON.stringify(record), key).toString()
const decrypted = (ciphertext) => JSON.parse(CryptoJS.AES.decrypt(ciphertext, TEST_KEY).toString(CryptoJS.enc.Utf8))

async function secretFixture(t, admin) {
    const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`
    const database = `zz_test_secret_${suffix}`
    const appRole = `zz_test_app_${suffix}`
    const appPassword = randomBytes(18).toString('base64url')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-analyst-secret-'))
    const instances = []
    const roles = new Set()
    let owner
    t.after(async () => {
        for (const instance of instances) instance.runtime.resetAnalystStoreForTests()
        if (owner) {
            const found = await owner.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^analyst(_[0-9a-f]{10})?$'")
            for (const row of found.rows) roles.add(row.nspname.replace(/^analyst/, 'analyst_reader'))
            await owner.end()
        }
        await admin.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`)
        for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${ident(role)}`)
        await admin.query(`DROP ROLE IF EXISTS ${ident(appRole)}`)
        fs.rmSync(dir, { recursive: true, force: true })
    })
    await admin.query(`CREATE ROLE ${ident(appRole)} LOGIN CREATEROLE PASSWORD ${literal(appPassword)}`)
    await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(appRole)}`)
    owner = new Client(adminConfig(database))
    await owner.connect()
    await owner.query(`ALTER SCHEMA public OWNER TO ${ident(appRole)}`)
    const instance = async () => {
        const runtime = await import(`../packages/harness/runtime/analyst-store.mjs?secret-instance=${++instanceNumber}`)
        const secretDir = path.join(dir, `instance-${instanceNumber}`)
        fs.mkdirSync(secretDir)
        const value = {
            runtime,
            env: {
                DATABASE_TYPE: 'postgres',
                DATABASE_HOST: adminConfig().host,
                DATABASE_PORT: String(adminConfig().port),
                DATABASE_NAME: database,
                DATABASE_USER: appRole,
                DATABASE_PASSWORD: appPassword,
                SECRETKEY_PATH: secretDir,
                CUTTLELY_SECRETKEY_OVERWRITE: TEST_KEY
            }
        }
        instances.push(value)
        return value
    }
    const connect = async (store) => {
        const client = new Client({ ...adminConfig(database), user: store.user, password: store.password })
        await client.connect()
        try {
            assert.equal((await client.query('SELECT current_user AS u')).rows[0].u, store.user)
        } finally {
            await client.end()
        }
    }
    const passwordHash = async (role) =>
        (await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [role])).rows[0].rolpassword
    return { instance, owner, connect, passwordHash, roles, database, appRole, appPassword, dir }
}

describe('analyst: role secrets survive independent Postgres instances', () => {
    let admin
    before(async () => {
        const client = new Client(adminConfig())
        try {
            await client.connect()
            admin = client
        } catch {
            await client.end().catch(() => {})
            if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1')
                throw new Error('CUTTLELY_TEST_PG_REQUIRED is set and Postgres is not reachable.')
        }
    })
    after(async () => {
        await admin?.end()
    })
    const fixture = async (t) => {
        if (!admin) {
            t.skip('local disposable PostgreSQL unavailable')
            return null
        }
        return secretFixture(t, admin)
    }

    it('creates one encrypted row, writes no file, and keeps the password on a fresh disk', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const b = await f.instance()
        const workspace = `zz-test-fresh-${f.database}`
        const first = await a.runtime.ensureAnalystStore(a.env, { workspace })
        await f.connect(first)
        const row = (await f.owner.query(`SELECT * FROM ${SECRET_TABLE} WHERE role = $1`, [first.user])).rows[0]
        assert.equal(row.workspace_tag, a.runtime.analystWorkspaceTag(workspace))
        assert.ok(row.created_at && row.updated_at)
        assert.ok(decrypted(row.ciphertext).password === first.password, 'the encrypted row holds the working password')
        assert.ok(!row.ciphertext.includes(first.password), 'the stored password is encrypted')
        const hash = await f.passwordHash(first.user)
        const rec = recordQueries()
        let second
        try {
            second = await b.runtime.ensureAnalystStore(b.env, { workspace })
        } finally {
            rec.restore()
        }
        assert.ok(!rec.calls.some((call) => /^ALTER ROLE\b/.test(call.text)), 'an existing secret never alters the role')
        assert.ok((await f.passwordHash(first.user)) === hash, 'fresh disks keep the existing password hash')
        assert.ok(second.password === first.password, 'both instances use the same password')
        await f.connect(second)
        const cached = await a.runtime.queryAnalyst('SELECT 42 AS n', { env: a.env, workspace })
        assert.deepEqual(cached.rows, [{ n: 42 }])
        assert.deepEqual(fs.readdirSync(a.env.SECRETKEY_PATH), [])
        assert.deepEqual(fs.readdirSync(b.env.SECRETKEY_PATH), [])
        assert.equal((await f.owner.query(`SELECT count(*)::int AS n FROM ${SECRET_TABLE}`)).rows[0].n, 1)
    })

    it('serializes concurrent first provisions from separate disks into one working password', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const b = await f.instance()
        const workspace = `zz-test-race-${f.database}`
        const stores = await Promise.all([
            a.runtime.ensureAnalystStore(a.env, { workspace }),
            b.runtime.ensureAnalystStore(b.env, { workspace })
        ])
        assert.equal(stores[0].user, stores[1].user)
        assert.ok(stores[0].password === stores[1].password, 'concurrent callers use one password')
        await Promise.all(stores.map(f.connect))
        assert.equal((await f.owner.query(`SELECT count(*)::int AS n FROM ${SECRET_TABLE}`)).rows[0].n, 1)
        for (const instance of [a, b]) assert.deepEqual(fs.readdirSync(instance.env.SECRETKEY_PATH), [])
    })

    it('imports a workspace file unchanged without resetting the existing role', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-import-${f.database}`
        const tag = a.runtime.analystWorkspaceTag(workspace)
        const role = `analyst_reader_${tag}`
        const password = randomBytes(24).toString('base64url')
        f.roles.add(role)
        await f.owner.query(`SET ROLE ${ident(f.appRole)}; CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)}; RESET ROLE`)
        const file = path.join(a.env.SECRETKEY_PATH, `analyst-role-${tag}.enc`)
        const payload = encrypted({ role, password, workspace: tag })
        fs.writeFileSync(file, payload, { mode: 0o600 })
        const hash = await f.passwordHash(role)
        const store = await a.runtime.ensureAnalystStore(a.env, { workspace })
        const row = (await f.owner.query(`SELECT ciphertext FROM ${SECRET_TABLE} WHERE role = $1`, [role])).rows[0]
        assert.ok(row.ciphertext === payload, 'import preserves the existing ciphertext')
        assert.ok(store.password === password, 'import preserves the working password')
        assert.ok((await f.passwordHash(role)) === hash, 'import does not reset the role password')
        assert.ok(fs.readFileSync(file, 'utf8') === payload, 'the old file remains untouched')
        await f.connect(store)
    })

    it('keeps a tagged legacy mapping after its file is deleted', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-legacy-${f.database}`
        const tag = a.runtime.analystWorkspaceTag(workspace)
        const role = 'analyst_reader'
        const password = randomBytes(24).toString('base64url')
        f.roles.add(role)
        await f.owner.query(`SET ROLE ${ident(f.appRole)}; CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)}; RESET ROLE`)
        await f.owner.query(`SET ROLE ${ident(f.appRole)}; CREATE SCHEMA analyst; CREATE TABLE analyst.legacy_notes (body text);
            INSERT INTO analyst.legacy_notes VALUES ('kept'); RESET ROLE`)
        const file = path.join(a.env.SECRETKEY_PATH, 'analyst-role.enc')
        const payload = encrypted({ role, password, workspace: tag })
        fs.writeFileSync(file, payload)
        const first = await a.runtime.ensureAnalystStore(a.env, { workspace })
        assert.equal(first.user, role)
        const row = (await f.owner.query(`SELECT workspace_tag, ciphertext FROM ${SECRET_TABLE} WHERE role = $1`, [role])).rows[0]
        assert.equal(row.workspace_tag, tag)
        assert.ok(row.ciphertext === payload, 'legacy ciphertext is imported unchanged')
        assert.ok(fs.readFileSync(file, 'utf8') === payload, 'import leaves the legacy file untouched')
        fs.unlinkSync(file)
        const b = await f.instance()
        const second = await b.runtime.ensureAnalystStore(b.env, { workspace })
        assert.equal(second.user, role)
        const data = await b.runtime.queryAnalyst('SELECT body FROM legacy_notes', { env: b.env, workspace })
        assert.deepEqual(data.rows, [{ body: 'kept' }])
        await f.connect(second)
    })

    it('claims an untagged legacy row for exactly one concurrent workspace', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const seed = await f.instance()
        const legacy = await seed.runtime.ensureAnalystStore(seed.env)
        await seed.runtime.queryAnalyst("CREATE TABLE legacy_notes AS SELECT 'kept'::text AS body", { env: seed.env })
        const a = await f.instance()
        const b = await f.instance()
        const workspaces = [`zz-test-claim-a-${f.database}`, `zz-test-claim-b-${f.database}`]
        const stores = await Promise.all([
            a.runtime.ensureAnalystStore(a.env, { workspace: workspaces[0] }),
            b.runtime.ensureAnalystStore(b.env, { workspace: workspaces[1] })
        ])
        assert.equal(stores.filter((store) => store.user === legacy.user).length, 1)
        const winner = stores.findIndex((store) => store.user === legacy.user)
        const row = (await f.owner.query(`SELECT workspace_tag FROM ${SECRET_TABLE} WHERE role = $1`, [legacy.user])).rows[0]
        assert.equal(row.workspace_tag, a.runtime.analystWorkspaceTag(workspaces[winner]))
        assert.equal((await f.owner.query(`SELECT count(*)::int AS n FROM ${SECRET_TABLE}`)).rows[0].n, 2)
        await Promise.all(stores.map(f.connect))
        const c = await f.instance()
        const again = await c.runtime.ensureAnalystStore(c.env, { workspace: workspaces[winner] })
        assert.equal(again.user, legacy.user)
    })

    it('isolates the secret table and refuses a changed encryption key without ALTER ROLE or secret disclosure', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-isolation-${f.database}`
        const store = await a.runtime.ensureAnalystStore(a.env, { workspace })
        const hash = await f.passwordHash(store.user)
        const analyst = new Client({ ...adminConfig(f.database), user: store.user, password: store.password })
        await analyst.connect()
        try {
            await assert.rejects(analyst.query(`SELECT * FROM ${SECRET_TABLE}`), (error) => error.code === '42501')
        } finally {
            await analyst.end()
        }
        const b = await f.instance()
        b.env.CUTTLELY_SECRETKEY_OVERWRITE = 'zz-test-different-key'
        const rec = recordQueries()
        const logs = []
        const originalError = console.error
        const originalWarn = console.warn
        console.error = console.warn = (...args) => logs.push(args.map(String).join(' '))
        try {
            await assert.rejects(b.runtime.ensureAnalystStore(b.env, { workspace }), (error) => {
                assert.match(error.message, /could not read the stored role secret/)
                for (const secret of [store.password, f.appPassword, TEST_KEY, b.env.CUTTLELY_SECRETKEY_OVERWRITE])
                    assert.ok(!error.message.includes(secret), 'the secret error contains no credential')
                return true
            })
        } finally {
            console.error = originalError
            console.warn = originalWarn
            rec.restore()
        }
        assert.ok(!rec.calls.some((call) => /^ALTER ROLE\b/.test(call.text)), 'a key mismatch never alters the role')
        assert.ok((await f.passwordHash(store.user)) === hash, 'a key mismatch preserves the password')
        for (const secret of [store.password, f.appPassword, TEST_KEY, b.env.CUTTLELY_SECRETKEY_OVERWRITE])
            assert.ok(
                logs.every((line) => !line.includes(secret)),
                'logs contain no credential'
            )
        await f.connect(store)
    })

    for (const scope of ['', 'zz-test-reused-session']) {
        it(`evicts a stale cached password on 28P01 and retries once (${scope ? 'run session' : 'single query'})`, async (t) => {
            const f = await fixture(t)
            if (!f) return
            const a = await f.instance()
            const workspace = `zz-test-retry-${f.database}`
            const old = await a.runtime.ensureAnalystStore(a.env, { workspace })
            const password = randomBytes(24).toString('base64url')
            await f.owner.query('BEGIN')
            try {
                await f.owner.query(`ALTER ROLE ${ident(old.user)} PASSWORD ${literal(password)}`)
                await f.owner.query(`UPDATE ${SECRET_TABLE} SET ciphertext = $1, updated_at = now() WHERE role = $2`, [
                    encrypted({ role: old.user, password }),
                    old.user
                ])
                await f.owner.query('COMMIT')
            } catch (error) {
                await f.owner.query('ROLLBACK')
                throw error
            }
            const attempts = []
            const originalConnect = Client.prototype.connect
            Client.prototype.connect = function (...args) {
                if (this.user === old.user) attempts.push(this.connectionParameters.password)
                return originalConnect.apply(this, args)
            }
            const rec = recordQueries()
            try {
                const answer = await a.runtime.queryAnalyst('SELECT 17 AS n', { env: a.env, workspace, scope })
                assert.deepEqual(answer.rows, [{ n: 17 }])
            } finally {
                rec.restore()
                Client.prototype.connect = originalConnect
            }
            assert.equal(attempts.length, 2, 'one failed authentication and exactly one retry')
            assert.ok(attempts[0] === old.password && attempts[1] === password, 'retry reads the replacement password')
            assert.ok(!rec.calls.some((call) => /^ALTER ROLE\b/.test(call.text)), 'cache recovery never alters the role')
            const refreshed = await a.runtime.ensureAnalystStore(a.env, { workspace })
            assert.ok(refreshed.password === password, 'the cache contains the current database secret')
        })
    }

    it('stops after one retry if the role password disagrees with the stored row, without resetting either', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-retry-limit-${f.database}`
        const old = await a.runtime.ensureAnalystStore(a.env, { workspace })
        const password = randomBytes(24).toString('base64url')
        await f.owner.query(`ALTER ROLE ${ident(old.user)} PASSWORD ${literal(password)}`)
        const hash = await f.passwordHash(old.user)
        const row = (await f.owner.query(`SELECT ciphertext FROM ${SECRET_TABLE} WHERE role = $1`, [old.user])).rows[0]
        let attempts = 0
        const originalConnect = Client.prototype.connect
        Client.prototype.connect = function (...args) {
            if (this.user === old.user) attempts += 1
            return originalConnect.apply(this, args)
        }
        const rec = recordQueries()
        try {
            await assert.rejects(a.runtime.queryAnalyst('SELECT 23 AS n', { env: a.env, workspace }), (error) => {
                assert.match(error.message, /password authentication failed/)
                for (const secret of [old.password, password, f.appPassword, TEST_KEY])
                    assert.ok(!error.message.includes(secret), 'authentication failures contain no credential')
                return true
            })
        } finally {
            rec.restore()
            Client.prototype.connect = originalConnect
        }
        assert.equal(attempts, 2, 'retry is bounded even when the row has not changed')
        assert.ok(!rec.calls.some((call) => /^ALTER ROLE\b/.test(call.text)), 'failed recovery never resets the role')
        assert.ok((await f.passwordHash(old.user)) === hash, 'failed recovery preserves the role password')
        const current = (await f.owner.query(`SELECT ciphertext FROM ${SECRET_TABLE} WHERE role = $1`, [old.user])).rows[0]
        assert.ok(current.ciphertext === row.ciphertext, 'failed recovery preserves the row')
        await f.connect({ user: old.user, password })
    })

    it('does not retry a statement that raises SQLSTATE 28P01 after connecting', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-statement-code-${f.database}`
        const store = await a.runtime.ensureAnalystStore(a.env, { workspace })
        await a.runtime.queryAnalyst(
            `CREATE FUNCTION statement_auth_code() RETURNS integer LANGUAGE plpgsql AS $$
                BEGIN RAISE SQLSTATE '28P01' USING MESSAGE = 'zz-test-statement-auth-code'; END $$`,
            { env: a.env, workspace }
        )
        for (const scope of ['', 'zz-test-statement-session']) {
            const rec = recordQueries()
            try {
                await assert.rejects(
                    a.runtime.queryAnalyst('SELECT statement_auth_code() AS n', { env: a.env, workspace, scope }),
                    /zz-test-statement-auth-code/
                )
            } finally {
                rec.restore()
            }
            assert.ok(!rec.calls.some((call) => call.client.user === f.appRole), 'statement failures never reread or provision secrets')
            assert.ok((await a.runtime.ensureAnalystStore(a.env, { workspace })) === store, 'statement failures retain the cached store')
        }
    })

    it('rolls back role password changes and the secret row together on a provisioning failure', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-rollback-${f.database}`
        const role = `analyst_reader_${a.runtime.analystWorkspaceTag(workspace)}`
        f.roles.add(role)
        const password = randomBytes(24).toString('base64url')
        await f.owner.query(`SET ROLE ${ident(f.appRole)}; CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)}; RESET ROLE`)
        const hash = await f.passwordHash(role)
        const originalQuery = Client.prototype.query
        let reachedIsolation = false
        Client.prototype.query = function (...args) {
            if (this.user === f.appRole && /^GRANT USAGE, CREATE ON SCHEMA/.test(callText(args))) {
                reachedIsolation = true
                return Promise.reject(new Error('zz-test-isolation-failure'))
            }
            return originalQuery.apply(this, args)
        }
        try {
            await assert.rejects(a.runtime.ensureAnalystStore(a.env, { workspace }), /zz-test-isolation-failure/)
        } finally {
            Client.prototype.query = originalQuery
        }
        assert.equal(reachedIsolation, true, 'failure is injected after the password DDL')
        assert.ok((await f.passwordHash(role)) === hash, 'a failed transaction preserves the old role password')
        const namespace = (await f.owner.query("SELECT to_regnamespace('cuttlely_analyst_admin') AS n")).rows[0].n
        if (namespace) assert.equal((await f.owner.query(`SELECT count(*)::int AS n FROM ${SECRET_TABLE}`)).rows[0].n, 0)
        await f.connect({ user: role, password })
    })

    it('uses public.role_secret only when CREATE SCHEMA is refused and keeps it private', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-fallback-${f.database}`
        const schema = `analyst_${a.runtime.analystWorkspaceTag(workspace)}`
        await f.owner.query(`CREATE SCHEMA ${ident(schema)} AUTHORIZATION ${ident(f.appRole)};
            ALTER DATABASE ${ident(f.database)} OWNER TO ${ident(adminConfig().user)};
            REVOKE CREATE ON DATABASE ${ident(f.database)} FROM PUBLIC, ${ident(f.appRole)};
            GRANT CONNECT, TEMPORARY ON DATABASE ${ident(f.database)} TO ${ident(f.appRole)} WITH GRANT OPTION`)
        const store = await a.runtime.ensureAnalystStore(a.env, { workspace })
        assert.equal((await f.owner.query("SELECT to_regnamespace('cuttlely_analyst_admin') AS n")).rows[0].n, null)
        assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM public.role_secret')).rows[0].n, 1)
        const client = new Client({ ...adminConfig(f.database), user: store.user, password: store.password })
        await client.connect()
        try {
            await assert.rejects(client.query('SELECT * FROM public.role_secret'), (error) => error.code === '42501')
        } finally {
            await client.end()
        }
        const b = await f.instance()
        const second = await b.runtime.ensureAnalystStore(b.env, { workspace })
        assert.ok(second.password === store.password, 'the fallback row survives a fresh disk')
        await f.connect(second)
        await f.owner.query(`GRANT CREATE ON DATABASE ${ident(f.database)} TO ${ident(f.appRole)}`)
        const c = await f.instance()
        const rec = recordQueries()
        let third
        try {
            third = await c.runtime.ensureAnalystStore(c.env, { workspace })
        } finally {
            rec.restore()
        }
        assert.ok(third.password === store.password, 'granting schema creation preserves the fallback secret')
        assert.ok(!rec.calls.some((call) => /^ALTER ROLE\b/.test(call.text)), 'granting schema creation never resets the role')
        await f.connect(third)
    })

    it('names the missing grants when neither the private schema nor public can hold the secret', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const workspace = `zz-test-nogrant-${f.database}`
        const role = `analyst_reader_${a.runtime.analystWorkspaceTag(workspace)}`
        f.roles.add(role)
        const admin = ident(adminConfig().user)
        // No fixture grant: undo the shared fixture's public ownership. PostgreSQL 15+ leaves public owned by
        // pg_database_owner with CREATE for the owner only; earlier versions get the same rights explicitly.
        const modern = Number((await f.owner.query('SHOW server_version_num')).rows[0].server_version_num) >= 150000
        await f.owner.query(`ALTER DATABASE ${ident(f.database)} OWNER TO ${admin};
            ALTER SCHEMA public OWNER TO ${modern ? 'pg_database_owner' : admin};
            REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${ident(f.appRole)};
            REVOKE CREATE ON DATABASE ${ident(f.database)} FROM PUBLIC, ${ident(f.appRole)};
            GRANT CONNECT, TEMPORARY ON DATABASE ${ident(f.database)} TO ${ident(f.appRole)}`)
        const rights = (
            await f.owner.query(
                `SELECT has_database_privilege($1, current_database(), 'CREATE') AS db,
                    has_schema_privilege($1, 'public', 'CREATE') AS pub,
                    pg_get_userbyid(d.datdba) = $1 AS owns
                 FROM pg_database d WHERE d.datname = current_database()`,
                [f.appRole]
            )
        ).rows[0]
        assert.deepEqual(rights, { db: false, pub: false, owns: false }, 'the app login can create neither schema')
        if (modern) {
            const owner = (await f.owner.query("SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'public'")).rows[0]
            assert.equal(owner.o, 'pg_database_owner')
        }
        const refused = (error) => {
            assert.equal(error.code, '42501')
            assert.match(error.message, /CREATE on the database \(GRANT CREATE ON DATABASE\)/)
            assert.match(error.message, /CREATE on schema public/)
            assert.match(error.message, /CUTTLELY_POSTGRES_URL/)
            assert.doesNotMatch(error.message, /^permission denied/)
            assert.ok(!error.message.includes(f.appPassword), 'the error carries no password')
            assert.doesNotMatch(error.message, /postgres(ql)?:\/\//, 'the error carries no connection string')
            return true
        }
        await assert.rejects(a.runtime.ensureAnalystStore(a.env, { workspace }), refused)
        await assert.rejects(a.runtime.queryAnalyst('SELECT 1', { env: a.env, workspace }), refused)
        const left = (
            await f.owner.query(
                `SELECT to_regclass('public.role_secret') AS fallback, to_regnamespace('cuttlely_analyst_admin') AS own,
                    (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS roles`,
                [role]
            )
        ).rows[0]
        assert.deepEqual(left, { fallback: null, own: null, roles: 0 }, 'the refused provisioning leaves no table, schema or role')
        const files = fs.readdirSync(a.env.SECRETKEY_PATH).filter((name) => name.endsWith('.enc'))
        assert.deepEqual(files, [], 'no .enc file is written')
    })

    it('leaves SQLite and URL queries outside role-secret provisioning', async (t) => {
        const f = await fixture(t)
        if (!f) return
        const a = await f.instance()
        const sqliteEnv = { ...a.env, DATABASE_TYPE: 'sqlite', DATABASE_PATH: f.dir }
        const store = await a.runtime.provisionAnalyst(sqliteEnv)
        assert.equal(store.engine, 'sqlite')
        assert.deepEqual(fs.readdirSync(a.env.SECRETKEY_PATH), [])
        const result = await a.runtime.queryAnalystUrl(urlFor(f.appRole, f.appPassword, f.database), 'SELECT 5 AS n')
        assert.deepEqual(result.rows, [{ n: 5 }])
        assert.equal((await f.owner.query("SELECT to_regnamespace('cuttlely_analyst_admin') AS n")).rows[0].n, null)
        assert.equal((await f.owner.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'analyst_reader%'")).rows[0].n, 0)
    })
})
