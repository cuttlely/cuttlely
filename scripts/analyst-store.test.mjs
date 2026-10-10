import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
    ANALYST_ROLE,
    ANALYST_ROW_CAP,
    ANALYST_STATEMENT_TIMEOUT_MS,
    ANALYST_TIMEOUT_MESSAGE,
    analystStatementTimeoutMs,
    endAnalystRun,
    analystWorkspaceTag,
    ANALYST_SHARING_REFUSED,
    analystSqliteFile,
    applicationSqliteFile,
    assertAnalystSqlite,
    oneSqlStatement,
    provisionAnalyst,
    analystSqlText,
    analystErrorOutcome,
    analystToolSpec,
    queryAnalyst,
    queryAnalystUrl,
    pgPlaceholders,
    analystUrlToolSpec,
    withAnalystScope,
    resetAnalystStoreForTests,
    rowPageSummary
} from './analyst-store.mjs'
import { analystPageRequest, parseSimpleSelect } from './analyst-page.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages/components/package.json'))
const CryptoJS = require('crypto-js')
const { Client } = require('pg')

function digest(value) {
    return createHash('sha256').update(String(value)).digest('hex')
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-analyst-'))
}

function sqliteEnv(dir) {
    return {
        DATABASE_TYPE: 'sqlite',
        DATABASE_PATH: dir,
        SECRETKEY_PATH: path.join(dir, 'secrets'),
        CUTTLELY_ANALYST: 'auto',
        FLOWISE_SECRETKEY_OVERWRITE: 'analyst-test-key'
    }
}

describe('analyst tool input', () => {
    it('accepts statement and query as sql, and names the dialect', () => {
        assert.equal(analystSqlText({ statement: 'SELECT 1' }), 'SELECT 1')
        assert.equal(analystSqlText({ query: 'SELECT 2' }), 'SELECT 2')
        assert.equal(analystSqlText({ sql: 'SELECT 3', statement: 'SELECT 9' }), 'SELECT 3')
        assert.equal(analystSqlText('SELECT 4'), 'SELECT 4')
        const sqlite = analystToolSpec('sqlite')
        assert.equal(sqlite.schema.required, undefined)
        assert.equal(typeof sqlite.schema.properties.statement.type, 'string')
        assert.equal(typeof sqlite.schema.properties.query.type, 'string')
        assert.equal(typeof sqlite.schema.properties.cursor.type, 'string')
        assert.equal(sqlite.schema.properties.page.type, 'integer')
        assert.match(sqlite.description, /SQLite/)
        assert.match(sqlite.description, /INTEGER PRIMARY KEY/)
        assert.match(sqlite.description, /Run one SQL statement in the isolated analyst store/)
        assert.match(sqlite.description, /including a statement you expect to be refused or to fail/)
        assert.match(sqlite.description, /Do not predict, simulate, or paraphrase/)
        const postgres = analystToolSpec('postgres')
        assert.match(postgres.description, /PostgreSQL/)
        assert.equal(postgres.description.includes('SERIAL'), false)
    })
})

describe('analyst sql', () => {
    it('accepts one statement and rejects a second', () => {
        assert.equal(oneSqlStatement("SELECT ';';"), "SELECT ';'")
        assert.equal(oneSqlStatement('SELECT 1;'), 'SELECT 1')
        assert.throws(() => oneSqlStatement('SELECT 1; SELECT 2'), /one statement/)
        assert.throws(() => oneSqlStatement('   '), /empty/)
    })
})

describe('analyst sqlite storage', () => {
    it('creates analyst.db and does not open the application file', async () => {
        const dir = tempDir()
        const env = sqliteEnv(dir)
        const appFile = applicationSqliteFile(env)
        const analystFile = analystSqliteFile(env)
        assert.throws(() => assertAnalystSqlite(appFile, env), /application SQLite/)
        const app = new DatabaseSync(appFile)
        app.exec("CREATE TABLE users (email TEXT); INSERT INTO users VALUES ('hidden@example.com')")
        app.close()
        const before = fs.readFileSync(appFile)
        const opened = []
        const sqliteOpen = (file) => {
            const resolved = path.resolve(file)
            opened.push(resolved)
            if (resolved === path.resolve(appFile)) throw new Error('opened the application database')
            return new DatabaseSync(file)
        }
        if (typeof process.getuid === 'function' && process.getuid() !== 0) fs.chmodSync(appFile, 0)
        try {
            const created = await queryAnalyst('CREATE TABLE notes (body TEXT)', { env, sqliteOpen })
            assert.equal(created.rowCount, 0)
            await queryAnalyst("INSERT INTO notes (body) VALUES ('ok')", { env, sqliteOpen })
            const rows = await queryAnalyst('SELECT body FROM notes', { env, sqliteOpen })
            assert.deepEqual(rows.rows, [{ body: 'ok' }])
            assert.equal(rows.truncated, false)
            await assert.rejects(queryAnalyst('SELECT email FROM users', { env, sqliteOpen }), (error) => {
                assert.match(error.message, /no such table/)
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
            await assert.rejects(queryAnalyst('SELEC 1', { env, sqliteOpen }), (error) => {
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
            assert.equal(fs.existsSync(analystFile), true)
            assert.equal(fs.existsSync(path.join(env.SECRETKEY_PATH, 'analyst-role.enc')), false)
            assert.ok(opened.length >= 2)
            assert.ok(opened.every((file) => file === path.resolve(analystFile)))
        } finally {
            if (typeof process.getuid === 'function' && process.getuid() !== 0) fs.chmodSync(appFile, 0o600)
            resetAnalystStoreForTests()
        }
        assert.deepEqual(fs.readFileSync(appFile), before)
        await assert.rejects(
            queryAnalyst('CREATE TABLE nums (n INTEGER); INSERT INTO nums (n) SELECT 1', { env, sqliteOpen }),
            /one statement/
        )
        await queryAnalyst('CREATE TABLE nums (n INTEGER)', { env, sqliteOpen })
        const upper = ANALYST_ROW_CAP + 1
        await queryAnalyst(
            `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${upper}) INSERT INTO nums (n) SELECT n FROM c`,
            { env, sqliteOpen }
        )
        const capped = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen })
        assert.equal(capped.rows.length, ANALYST_ROW_CAP)
        assert.equal(capped.truncated, true)
        assert.equal(capped.summary, rowPageSummary({ start: 1, end: ANALYST_ROW_CAP, total: upper, page: 1, pages: 2, more: true }))
        assert.equal(typeof capped.cursor, 'string')
        assert.deepEqual(fs.readFileSync(appFile), before)
        await provisionAnalyst(env, { sqliteOpen })
        resetAnalystStoreForTests()

        const quote = (file) => `'${file.replaceAll("'", "''")}'`
        const outside = path.join(dir, 'outside.db')
        const vacuumTarget = path.join(dir, 'vacuum-copy.db')
        await assert.rejects(queryAnalyst(`ATTACH DATABASE ${quote(outside)} AS otherdb`, { env, sqliteOpen }), (error) => {
            assert.match(error.message, /refused ATTACH or VACUUM/)
            assert.equal(error.cuttlelyOutcome, 'expected')
            return true
        })
        await assert.rejects(queryAnalyst('DETACH otherdb', { env, sqliteOpen }), /refused DETACH/)
        await assert.rejects(queryAnalyst('VACUUM', { env, sqliteOpen }), /refused ATTACH or VACUUM/)
        await assert.rejects(queryAnalyst(`VACUUM INTO ${quote(vacuumTarget)}`, { env, sqliteOpen }), /refused ATTACH or VACUUM/)
        await assert.rejects(
            queryAnalyst(`SELECT load_extension(${quote('/tmp/cuttlely-analyst-no-such.so')})`, { env, sqliteOpen }),
            /refused load_extension/
        )
        await assert.rejects(queryAnalyst('PRAGMA writable_schema = ON', { env, sqliteOpen }), /refused that PRAGMA/)
        await queryAnalyst('PRAGMA busy_timeout = 1000', { env, sqliteOpen })
        await queryAnalyst('UPDATE notes SET body = body', { env, sqliteOpen })
        await queryAnalyst('DROP TABLE nums', { env, sqliteOpen })
        const after = await queryAnalyst('SELECT body FROM notes', { env, sqliteOpen })
        assert.deepEqual(after.rows, [{ body: 'ok' }])
        assert.equal(fs.existsSync(outside), false)
        assert.equal(fs.existsSync(vacuumTarget), false)
        assert.deepEqual(fs.readFileSync(appFile), before)
        resetAnalystStoreForTests()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stops a statement at the timeout without blocking the server, rolls it back, and keeps working', async () => {
        const dir = tempDir()
        const env = sqliteEnv(dir)
        try {
            await queryAnalyst('CREATE TABLE t (n integer)', { env })
            await queryAnalyst('INSERT INTO t (n) VALUES (1), (2), (3)', { env })
            let ticks = 0
            const ticker = setInterval(() => {
                ticks += 1
            }, 50)
            const started = Date.now()
            try {
                await assert.rejects(
                    queryAnalyst('INSERT INTO t (n) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c', {
                        env,
                        statementTimeoutMs: 800
                    }),
                    (error) => {
                        assert.equal(error.message, ANALYST_TIMEOUT_MESSAGE)
                        assert.equal(analystErrorOutcome(error), 'expected')
                        return true
                    }
                )
            } finally {
                clearInterval(ticker)
            }
            const elapsed = Date.now() - started
            assert.equal(elapsed >= 700 && elapsed < 5000, true, `stopped after ${elapsed} ms`)
            // node:sqlite would hold the thread for the whole statement. The timer kept running.
            assert.equal(ticks >= 8, true, `the event loop ran ${ticks} ticks`)
            const count = await queryAnalyst('SELECT count(*) AS n FROM t', { env })
            assert.equal(count.rows[0].n, 3)
            await assert.rejects(
                queryAnalyst('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c', {
                    env,
                    statementTimeoutMs: 400
                }),
                (error) => error.message === ANALYST_TIMEOUT_MESSAGE
            )
            const after = await queryAnalyst('SELECT max(n) AS top FROM t', { env })
            assert.equal(after.rows[0].top, 3)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('keeps TEMP tables for one harness run, apart from other runs, and drops them when the run ends', async () => {
        const dir = tempDir()
        const env = sqliteEnv(dir)
        const runA = 'harness-a:chat-a'
        const runB = 'harness-a:chat-b'
        try {
            await queryAnalyst('CREATE TABLE sales (region text, amount integer)', { env })
            await queryAnalyst("INSERT INTO sales (region, amount) VALUES ('west', 10), ('east', 20), ('west', 5)", { env })
            await withAnalystScope(runA, async () => {
                await queryAnalyst("CREATE TEMP TABLE picks AS SELECT 'west' AS region", { env })
                const joined = await queryAnalyst(
                    'SELECT s.region, sum(s.amount) AS total FROM sales s JOIN picks p ON p.region = s.region GROUP BY s.region',
                    { env }
                )
                assert.deepEqual(joined.rows, [{ region: 'west', total: 15 }])
                // BEGIN does not hold a transaction open across calls.
                await queryAnalyst('BEGIN', { env })
                await queryAnalyst("INSERT INTO sales (region, amount) VALUES ('north', 1)", { env })
            })
            await withAnalystScope(runB, async () => {
                await assert.rejects(queryAnalyst('SELECT region FROM picks', { env }), /no such table: picks/)
                await assert.rejects(
                    queryAnalyst('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c', {
                        env,
                        statementTimeoutMs: 400
                    }),
                    (error) => error.message === ANALYST_TIMEOUT_MESSAGE
                )
            })
            await withAnalystScope(runA, async () => {
                const still = await queryAnalyst('SELECT region FROM picks', { env })
                assert.deepEqual(still.rows, [{ region: 'west' }])
            })
            await endAnalystRun(runA)
            await withAnalystScope(runA, async () => {
                await assert.rejects(queryAnalyst('SELECT region FROM picks', { env }), /no such table: picks/)
            })
            await endAnalystRun(runA)
            const north = await queryAnalyst("SELECT count(*) AS n FROM sales WHERE region = 'north'", { env })
            assert.equal(north.rows[0].n, 1)
            // Outside a harness run, every call has its own connection, as before.
            await queryAnalyst('CREATE TEMP TABLE once AS SELECT 1 AS n', { env })
            await assert.rejects(queryAnalyst('SELECT n FROM once', { env }), /no such table: once/)
            const tables = await queryAnalyst("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", { env })
            assert.deepEqual(
                tables.rows.map((row) => row.name),
                ['sales']
            )
        } finally {
            await endAnalystRun(runA)
            await endAnalystRun(runB)
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('gives each workspace its own analyst.db, and the first workspace keeps the older store', async () => {
        const dir = tempDir()
        const env = sqliteEnv(dir)
        const tagA = analystWorkspaceTag('workspace-a')
        const tagB = analystWorkspaceTag('workspace-b')
        try {
            assert.match(tagA, /^[0-9a-f]{10}$/)
            // A store from before workspaces: one analyst.db.
            await queryAnalyst('CREATE TABLE legacy_notes (body text)', { env })
            await queryAnalyst("INSERT INTO legacy_notes (body) VALUES ('kept')", { env })
            const first = await queryAnalyst('SELECT body FROM legacy_notes', { env, workspace: 'workspace-a' })
            assert.deepEqual(first.rows, [{ body: 'kept' }])
            assert.equal(fs.readFileSync(path.join(dir, 'analyst.db.workspace'), 'utf8'), tagA)
            await withAnalystScope(
                'harness-b:chat-1',
                async () => {
                    await assert.rejects(queryAnalyst('SELECT body FROM legacy_notes', { env }), /no such table: legacy_notes/)
                    await queryAnalyst('CREATE TABLE b_only (n integer)', { env })
                    await queryAnalyst(
                        `INSERT INTO b_only (n) SELECT value FROM json_each('${JSON.stringify(
                            Array.from({ length: 150 }, (_, i) => i + 1)
                        )}')`,
                        { env }
                    )
                },
                { workspace: 'workspace-b' }
            )
            await endAnalystRun('harness-b:chat-1')
            assert.equal(fs.existsSync(path.join(dir, `analyst-${tagB}.db`)), true)
            assert.equal(fs.existsSync(path.join(dir, `analyst-${tagA}.db`)), false)
            await assert.rejects(queryAnalyst('SELECT n FROM b_only', { env, workspace: 'workspace-a' }), /no such table: b_only/)
            await assert.rejects(queryAnalyst('SELECT n FROM b_only', { env }), /no such table: b_only/)
            // A page cursor from one workspace does not read another workspace's store.
            const paged = await queryAnalyst('SELECT n FROM b_only ORDER BY n', { env, workspace: 'workspace-b', scope: 'shared-chat' })
            assert.equal(typeof paged.cursor, 'string')
            await assert.rejects(
                queryAnalyst({ cursor: paged.cursor }, { env, workspace: 'workspace-a', scope: 'shared-chat' }),
                /This page cursor is not valid/
            )
            const next = await queryAnalyst({ cursor: paged.cursor }, { env, workspace: 'workspace-b', scope: 'shared-chat' })
            assert.equal(next.rows.length, 50)
            // A third workspace gets a new file; the older store stays with workspace-a.
            const tagC = analystWorkspaceTag('workspace-c')
            await queryAnalyst('CREATE TABLE c_only (n integer)', { env, workspace: 'workspace-c' })
            assert.equal(fs.existsSync(path.join(dir, `analyst-${tagC}.db`)), true)
            resetAnalystStoreForTests()
            const again = await queryAnalyst('SELECT body FROM legacy_notes', { env, workspace: 'workspace-a' })
            assert.deepEqual(again.rows, [{ body: 'kept' }])
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('caps the timeout at 15 seconds', () => {
        assert.equal(ANALYST_STATEMENT_TIMEOUT_MS, 15000)
        assert.equal(analystStatementTimeoutMs(undefined), 15000)
        assert.equal(analystStatementTimeoutMs(0), 15000)
        assert.equal(analystStatementTimeoutMs('abc'), 15000)
        assert.equal(analystStatementTimeoutMs(500), 500)
        assert.equal(analystStatementTimeoutMs(60000), 15000)
        assert.equal(analystStatementTimeoutMs(600000), 15000)
    })

    it('does not create sqlite storage for another database type', async () => {
        const dir = tempDir()
        const env = {
            DATABASE_TYPE: 'mysql',
            DATABASE_PATH: dir,
            CUTTLELY_ANALYST: 'auto'
        }
        await assert.rejects(provisionAnalyst(env), /separate database/)
        assert.equal(fs.existsSync(path.join(dir, 'analyst.db')), false)
        fs.rmSync(dir, { recursive: true, force: true })
    })
})

describe('analyst page request matcher', () => {
    it('matches only a bare paging phrase', () => {
        assert.deepEqual(analystPageRequest('show more'), { kind: 'next' })
        assert.deepEqual(analystPageRequest('  Show More. '), { kind: 'next' })
        assert.deepEqual(analystPageRequest('next page'), { kind: 'next' })
        assert.deepEqual(analystPageRequest('Next page!'), { kind: 'next' })
        assert.deepEqual(analystPageRequest('page 2'), { kind: 'page', page: 2 })
        assert.deepEqual(analystPageRequest('Page  2?'), { kind: 'page', page: 2 })
        assert.equal(analystPageRequest('tell me more about churn'), null)
        assert.equal(analystPageRequest('show more about churn'), null)
        assert.equal(analystPageRequest('show me more'), null)
        assert.equal(analystPageRequest('more'), null)
        assert.equal(analystPageRequest('next'), null)
        assert.equal(analystPageRequest('page'), null)
        assert.equal(analystPageRequest('page two'), null)
        assert.equal(analystPageRequest('page 2 please'), null)
        assert.equal(analystPageRequest('page 0'), null)
        assert.equal(analystPageRequest('page 100001'), null)
    })
})

describe('analyst page cursors', () => {
    it('pages a keyset, an offset, and a 101-row result, and rejects a bad cursor', async () => {
        const dir = tempDir()
        const env = sqliteEnv(dir)
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'chat-a'
        const now = 1_000_000
        const fill = async (table, count) => {
            await queryAnalyst(`CREATE TABLE ${table} (n INTEGER)`, { env, sqliteOpen, scope, now })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${count}) INSERT INTO ${table} (n) SELECT n FROM c`,
                { env, sqliteOpen, scope, now }
            )
        }
        try {
            await fill('keyed', 150)
            const page1 = await queryAnalyst('SELECT n FROM keyed ORDER BY n', { env, sqliteOpen, scope, now })
            assert.equal(page1.rows.length, ANALYST_ROW_CAP)
            assert.equal(page1.rows[0].n, 1)
            assert.equal(page1.rows.at(-1).n, ANALYST_ROW_CAP)
            assert.equal(page1.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            await queryAnalyst('INSERT INTO keyed (n) VALUES (0)', { env, sqliteOpen, scope, now })
            const page2 = await queryAnalyst({ cursor: page1.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(page2.rows[0].n, 101)
            assert.equal(page2.rows.at(-1).n, 150)
            assert.equal(
                page2.rows.some((row) => row.n === 100 || row.n === 0),
                false
            )
            assert.equal(page2.truncated, false)
            assert.equal(page2.summary, rowPageSummary({ start: 101, end: 150, total: 150, page: 2, pages: 2, more: false }))

            await fill('loose', 150)
            const offset1 = await queryAnalyst('SELECT DISTINCT n AS n FROM loose ORDER BY n', { env, sqliteOpen, scope, now })
            await queryAnalyst('INSERT INTO loose (n) VALUES (0)', { env, sqliteOpen, scope, now })
            const offset2 = await queryAnalyst({ cursor: offset1.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(offset2.rows[0].n, 100)
            assert.equal(offset1.rows.at(-1).n, 100)

            await fill('small', ANALYST_ROW_CAP + 1)
            const first = await queryAnalyst({ statement: 'SELECT n FROM small ORDER BY n' }, { env, sqliteOpen, scope, now })
            assert.equal(first.rows.length, ANALYST_ROW_CAP)
            assert.equal(first.summary, rowPageSummary({ start: 1, end: 100, total: 101, page: 1, pages: 2, more: true }))
            const second = await queryAnalyst(
                { cursor: first.cursor, query: 'SELECT n FROM small ORDER BY n', page: 2 },
                { env, sqliteOpen, scope, now: now + 1 }
            )
            assert.deepEqual(second.rows, [{ n: 101 }])
            assert.equal(second.truncated, false)
            assert.equal(second.summary, rowPageSummary({ start: 101, end: 101, total: 101, page: 2, pages: 2, more: false }))

            const shortLived = await queryAnalyst('SELECT n FROM small ORDER BY n', {
                env,
                sqliteOpen,
                scope,
                now: 5_000,
                cursorTtlMs: 1_000
            })
            await assert.rejects(
                queryAnalyst({ cursor: shortLived.cursor }, { env, sqliteOpen, scope, now: 6_000, cursorTtlMs: 1_000 }),
                (error) => {
                    assert.match(error.message, /expired/)
                    assert.match(error.message, /Re-run the query/)
                    assert.equal(error.cuttlelyOutcome, 'expected')
                    return true
                }
            )
            await assert.rejects(queryAnalyst({ cursor: 'tampered-cursor' }, { env, sqliteOpen, scope, now }), (error) => {
                assert.match(error.message, /not valid/)
                assert.match(error.message, /Re-run the query/)
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
            await assert.rejects(
                queryAnalyst({ cursor: page1.cursor, sql: 'SELECT n FROM loose' }, { env, sqliteOpen, scope, now: now + 2 }),
                (error) => {
                    assert.match(error.message, /original query/)
                    assert.equal(error.cuttlelyOutcome, 'expected')
                    return true
                }
            )
            const still = await queryAnalyst({ cursor: page1.cursor, page: 2 }, { env, sqliteOpen, scope, now: now + 3 })
            // An explicit page uses the ordered offset. A row inserted ahead of this window shifts it.
            // The keyset follow-up above stayed on 101.
            assert.equal(still.rows[0].n, 100)
            assert.equal(still.rows.at(-1).n, 150)
            assert.equal(
                still.rows.some((row) => row.n === 0),
                false
            )
            await assert.rejects(queryAnalyst({ cursor: page1.cursor }, { env, sqliteOpen, scope: 'chat-b', now: now + 4 }), (error) => {
                assert.match(error.message, /another chat/)
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
            resetAnalystStoreForTests()
            await assert.rejects(queryAnalyst({ cursor: page1.cursor }, { env, sqliteOpen, scope, now: now + 5 }), (error) => {
                assert.match(error.message, /not valid/)
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('does not page aggregates, and pages grouped and distinct results by their own rows', async () => {
        assert.equal(parseSimpleSelect('SELECT COUNT(*) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT COUNT (*) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT SUM(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT AVG(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT MIN(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT MAX(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT TOTAL(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT GROUP_CONCAT(n) FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT DISTINCT n FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT n FROM items150 GROUP BY n'), null)
        assert.equal(parseSimpleSelect('SELECT n FROM items150 HAVING n > 1'), null)
        assert.equal(parseSimpleSelect('SELECT n, SUM(n) OVER () AS s FROM items150'), null)
        assert.equal(parseSimpleSelect('SELECT n, row_number() OVER (ORDER BY n) AS rn FROM items150'), null)
        assert.ok(parseSimpleSelect('SELECT * FROM items150'))
        assert.ok(parseSimpleSelect('SELECT count FROM items150 ORDER BY count'))
        assert.ok(parseSimpleSelect("SELECT 'COUNT(*)' AS label FROM items150"))
        assert.ok(parseSimpleSelect('SELECT n FROM items150 WHERE n <= (SELECT COUNT(*) FROM items150)'))

        const dir = tempDir()
        const env = sqliteEnv(dir)
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'agg'
        const now = 2_000_000
        const fill = async (table, count) => {
            await queryAnalyst(`CREATE TABLE ${table} (n INTEGER)`, { env, sqliteOpen, scope, now })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${count}) INSERT INTO ${table} (n) SELECT n FROM c`,
                { env, sqliteOpen, scope, now }
            )
        }
        const oneRow = (result, value) => {
            assert.equal(result.rows.length, 1)
            assert.equal(Number(Object.values(result.rows[0])[0]), value)
            assert.equal(result.summary, undefined)
            assert.equal(result.cursor, undefined)
            assert.equal(result.truncated, false)
        }
        try {
            await fill('items150', 150)
            await fill('items101', ANALYST_ROW_CAP + 1)
            await fill('grouped', 150)
            await queryAnalyst(
                'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 150) INSERT INTO grouped (n) SELECT n FROM c',
                { env, sqliteOpen, scope, now }
            )

            oneRow(await queryAnalyst('SELECT COUNT(*) FROM items150', { env, sqliteOpen, scope, now }), 150)
            oneRow(await queryAnalyst('SELECT SUM(n) FROM items150', { env, sqliteOpen, scope, now }), 11325)
            oneRow(await queryAnalyst('SELECT MAX(n) FROM items150', { env, sqliteOpen, scope, now }), 150)
            oneRow(await queryAnalyst('SELECT COUNT(*) FROM items150 WHERE n <= 20', { env, sqliteOpen, scope, now }), 20)

            const groupedPage = await queryAnalyst('SELECT n, COUNT(*) AS c FROM grouped GROUP BY n ORDER BY n', {
                env,
                sqliteOpen,
                scope,
                now
            })
            assert.equal(groupedPage.rows.length, ANALYST_ROW_CAP)
            assert.equal(groupedPage.rows[0].n, 1)
            assert.equal(groupedPage.rows[0].c, 2)
            assert.equal(groupedPage.rows.at(-1).n, ANALYST_ROW_CAP)
            assert.equal(groupedPage.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            assert.equal(typeof groupedPage.cursor, 'string')
            const groupedNext = await queryAnalyst({ cursor: groupedPage.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(groupedNext.rows.length, 50)
            assert.equal(groupedNext.rows[0].n, 101)
            assert.equal(groupedNext.rows[0].c, 2)
            assert.equal(groupedNext.rows.at(-1).n, 150)
            assert.equal(groupedNext.truncated, false)
            assert.equal(groupedNext.summary, rowPageSummary({ start: 101, end: 150, total: 150, page: 2, pages: 2, more: false }))

            const distinctPage = await queryAnalyst('SELECT DISTINCT n AS n FROM grouped ORDER BY n', {
                env,
                sqliteOpen,
                scope,
                now
            })
            assert.equal(distinctPage.rows.length, ANALYST_ROW_CAP)
            assert.equal(distinctPage.rows[0].n, 1)
            assert.equal(distinctPage.rows.at(-1).n, ANALYST_ROW_CAP)
            assert.equal(distinctPage.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            const distinctNext = await queryAnalyst({ cursor: distinctPage.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(distinctNext.rows[0].n, 101)
            assert.equal(distinctNext.rows.at(-1).n, 150)
            assert.equal(distinctNext.rows.length, 50)
            assert.equal(distinctNext.summary, rowPageSummary({ start: 101, end: 150, total: 150, page: 2, pages: 2, more: false }))

            const allPage = await queryAnalyst('SELECT * FROM items150', { env, sqliteOpen, scope, now })
            assert.equal(allPage.rows.length, ANALYST_ROW_CAP)
            assert.equal(allPage.rows[0].n, 1)
            assert.equal(allPage.rows.at(-1).n, ANALYST_ROW_CAP)
            assert.equal(allPage.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            assert.equal(typeof allPage.cursor, 'string')
            const allNext = await queryAnalyst({ cursor: allPage.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(allNext.rows[0].n, 101)
            assert.equal(allNext.rows.at(-1).n, 150)
            assert.equal(allNext.rows.length, 50)
            assert.equal(allNext.truncated, false)
            assert.equal(allNext.summary, rowPageSummary({ start: 101, end: 150, total: 150, page: 2, pages: 2, more: false }))

            const limitPage = await queryAnalyst('SELECT * FROM items101', { env, sqliteOpen, scope, now })
            assert.equal(limitPage.rows.length, ANALYST_ROW_CAP)
            assert.equal(limitPage.summary, rowPageSummary({ start: 1, end: 100, total: 101, page: 1, pages: 2, more: true }))
            const limitNext = await queryAnalyst({ cursor: limitPage.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.deepEqual(limitNext.rows, [{ n: 101 }])
            assert.equal(limitNext.truncated, false)
            assert.equal(limitNext.summary, rowPageSummary({ start: 101, end: 101, total: 101, page: 2, pages: 2, more: false }))

            const windowPage = await queryAnalyst('SELECT n, SUM(n) OVER () AS s FROM items150 ORDER BY n', {
                env,
                sqliteOpen,
                scope,
                now
            })
            assert.equal(windowPage.rows.length, ANALYST_ROW_CAP)
            assert.equal(Number(windowPage.rows[0].s), 11325)
            assert.equal(windowPage.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            const windowNext = await queryAnalyst({ cursor: windowPage.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(windowNext.rows[0].n, 101)
            assert.equal(Number(windowNext.rows[0].s), 11325)
            assert.equal(windowNext.rows.at(-1).n, 150)

            const nested = await queryAnalyst('SELECT n FROM items150 WHERE n <= (SELECT COUNT(*) FROM items150) ORDER BY n', {
                env,
                sqliteOpen,
                scope,
                now
            })
            assert.equal(nested.rows.at(-1).n, 100)
            assert.equal(nested.summary, rowPageSummary({ start: 1, end: 100, total: 150, page: 1, pages: 2, more: true }))
            await queryAnalyst('INSERT INTO items150 (n) VALUES (0)', { env, sqliteOpen, scope, now })
            const nestedNext = await queryAnalyst({ cursor: nested.cursor }, { env, sqliteOpen, scope, now: now + 1 })
            assert.equal(nestedNext.rows[0].n, 101)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

function adminConfig() {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || '',
        database: 'postgres',
        connectionTimeoutMillis: 1000
    }
}

async function postgresAdmin() {
    const client = new Client(adminConfig())
    try {
        await client.connect()
        return client
    } catch {
        await client.end().catch(() => {})
        return null
    }
}

describe('analyst postgres role', () => {
    it('cannot read an application table, can use the analyst schema, and repeats cleanly', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('postgres analyst role: local postgres admin is not reachable')
            return
        }
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_${suffix}`
        const appRole = `app_${suffix}`
        const limitedRole = `limited_${suffix}`
        const appPassword = randomBytes(18).toString('base64url')
        const limitedPassword = randomBytes(18).toString('base64url')
        const dir = tempDir()
        const key = 'analyst-test-key'
        const env = {
            DATABASE_TYPE: 'postgres',
            DATABASE_HOST: adminConfig().host,
            DATABASE_PORT: String(adminConfig().port),
            DATABASE_NAME: dbName,
            DATABASE_USER: appRole,
            DATABASE_PASSWORD: appPassword,
            CUTTLELY_ANALYST: 'auto',
            SECRETKEY_PATH: dir,
            FLOWISE_SECRETKEY_OVERWRITE: key
        }
        const ident = (value) => `"${value}"`
        try {
            await admin.query(
                `CREATE ROLE ${ident(limitedRole)} LOGIN PASSWORD '${limitedPassword.replace(/'/g, "''")}' NOSUPERUSER NOCREATEROLE`
            )
            await admin.query(`CREATE ROLE ${ident(appRole)} LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}' NOSUPERUSER CREATEROLE`)
            await admin.query(`CREATE DATABASE ${ident(dbName)} OWNER ${ident(appRole)}`)
            await admin.query(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(limitedRole)}`)
            const owner = new Client({ ...adminConfig(), database: dbName })
            await owner.connect()
            await owner.query(`ALTER SCHEMA public OWNER TO ${ident(appRole)}`)
            await owner.end()

            const limitedDir = path.join(dir, 'limited')
            await assert.rejects(
                provisionAnalyst({
                    ...env,
                    DATABASE_USER: limitedRole,
                    DATABASE_PASSWORD: limitedPassword,
                    SECRETKEY_PATH: limitedDir
                }),
                (error) => {
                    assert.equal(error instanceof Error, true)
                    assert.match(error.message, /create roles/)
                    assert.equal(error.message.includes(limitedPassword), false)
                    assert.equal(error.message.includes(appPassword), false)
                    return true
                }
            )
            assert.equal(fs.existsSync(path.join(limitedDir, 'analyst-role.enc')), false)
            const absent = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ANALYST_ROLE])
            assert.equal(absent.rowCount, 0)

            const app = new Client({ ...adminConfig(), database: dbName, user: appRole, password: appPassword })
            await app.connect()
            await app.query('CREATE TABLE public.app_users (email text)')
            await app.query("INSERT INTO public.app_users (email) VALUES ('hidden@example.com')")
            await app.end()

            await provisionAnalyst(env)
            const secretFile = path.join(dir, 'analyst-role.enc')
            const secretBytes = fs.readFileSync(secretFile)
            assert.equal((fs.statSync(secretFile).mode & 0o777) === 0o600, true)
            const stored = JSON.parse(CryptoJS.AES.decrypt(secretBytes.toString('utf8'), key).toString(CryptoJS.enc.Utf8))
            assert.equal(stored.role, ANALYST_ROLE)
            assert.equal(secretBytes.includes(stored.password), false)
            const passwordHash = digest(stored.password)

            const who = await queryAnalyst('SELECT current_user AS user_name', { env })
            assert.equal(who.rows[0].user_name, ANALYST_ROLE)
            const searchPath = await queryAnalyst('SHOW search_path', { env })
            assert.match(JSON.stringify(searchPath.rows), /analyst/)
            const timeout = await queryAnalyst('SHOW statement_timeout', { env })
            assert.match(JSON.stringify(timeout.rows), /15s|15000/)

            // The analyst login may change its own role defaults. The timeout and search_path are set on each
            // connection, so they still hold.
            await queryAnalyst(`ALTER ROLE ${ANALYST_ROLE} SET statement_timeout TO 0`, { env })
            await queryAnalyst(`ALTER ROLE ${ANALYST_ROLE} SET search_path TO public`, { env })
            const held = await queryAnalyst('SHOW statement_timeout', { env })
            assert.match(JSON.stringify(held.rows), /15s|15000/)
            const heldPath = await queryAnalyst('SHOW search_path', { env })
            assert.equal(heldPath.rows[0].search_path, 'analyst')
            await assert.rejects(
                queryAnalyst("SELECT set_config('statement_timeout', '0', false), pg_sleep(2)", { env, statementTimeoutMs: 500 }),
                (error) => {
                    assert.equal(error.message, ANALYST_TIMEOUT_MESSAGE)
                    assert.equal(analystErrorOutcome(error), 'expected')
                    return true
                }
            )
            // A per-query value wins over a lower role default too. This is the per-query raise the cap waits on.
            await admin.query(`ALTER ROLE ${ident(ANALYST_ROLE)} SET statement_timeout TO '200ms'`)
            const raised = await queryAnalyst('SELECT 1 AS slept FROM pg_sleep(0.6)', { env })
            assert.deepEqual(raised.rows, [{ slept: 1 }])
            const over = await queryAnalyst('SHOW statement_timeout', { env, statementTimeoutMs: 600000 })
            assert.match(JSON.stringify(over.rows), /15s|15000/)

            // A harness run keeps one connection: its TEMP tables last for the run, other runs cannot see them,
            // and a SET from one call does not carry into the next.
            const pgRunA = 'harness-pg:chat-a'
            await withAnalystScope(pgRunA, async () => {
                await queryAnalyst("CREATE TEMP TABLE picks AS SELECT 'west'::text AS region", { env })
                const picked = await queryAnalyst('SELECT region FROM picks', { env })
                assert.deepEqual(picked.rows, [{ region: 'west' }])
                await queryAnalyst('SET statement_timeout = 0', { env })
                await assert.rejects(queryAnalyst('SELECT pg_sleep(2)', { env, statementTimeoutMs: 400 }), (error) => {
                    assert.equal(error.message, ANALYST_TIMEOUT_MESSAGE)
                    return true
                })
                const afterTimeout = await queryAnalyst('SELECT count(*)::int AS n FROM picks', { env })
                assert.equal(afterTimeout.rows[0].n, 1)
                await queryAnalyst('BEGIN', { env })
                await queryAnalyst('CREATE TABLE kept (n integer)', { env })
            })
            await withAnalystScope('harness-pg:chat-b', async () => {
                await assert.rejects(queryAnalyst('SELECT region FROM picks', { env }), /does not exist/)
            })
            await endAnalystRun('harness-pg:chat-b')
            await endAnalystRun(pgRunA)
            await withAnalystScope(pgRunA, async () => {
                await assert.rejects(queryAnalyst('SELECT region FROM picks', { env }), /does not exist/)
                const kept = await queryAnalyst('SELECT count(*)::int AS n FROM kept', { env })
                assert.equal(kept.rows[0].n, 0)
            })
            await endAnalystRun(pgRunA)
            await queryAnalyst('DROP TABLE kept', { env })

            await queryAnalyst('CREATE TABLE notes (body text)', { env })
            await queryAnalyst("INSERT INTO notes (body) VALUES ('ok')", { env })
            const notes = await queryAnalyst('SELECT body FROM notes', { env })
            assert.deepEqual(notes.rows, [{ body: 'ok' }])
            await assert.rejects(queryAnalyst('SELECT email FROM public.app_users', { env }), (error) => {
                assert.equal(error instanceof Error, true)
                assert.match(error.message, /permission denied/)
                assert.equal(error.message.includes('hidden@example.com'), false)
                assert.equal(error.message.includes(stored.password), false)
                return true
            })
            await assert.rejects(queryAnalyst('SELECT email FROM app_users', { env }), /does not exist|permission denied/)

            const again = new Client({ ...adminConfig(), database: dbName, user: appRole, password: appPassword })
            await again.connect()
            await again.query('CREATE TABLE public.later_users (email text)')
            await again.query("INSERT INTO public.later_users (email) VALUES ('later@example.com')")
            await again.end()
            await assert.rejects(queryAnalyst('SELECT email FROM public.later_users', { env }), (error) => {
                assert.match(error.message, /permission denied/)
                assert.equal(error.message.includes('later@example.com'), false)
                return true
            })

            const flags = await queryAnalyst(
                `SELECT rolsuper, rolcreaterole, rolcreatedb,
                    pg_has_role(current_user, 'pg_read_server_files', 'member') AS read_files,
                    pg_has_role(current_user, 'pg_write_server_files', 'member') AS write_files,
                    pg_has_role(current_user, 'pg_execute_server_program', 'member') AS exec_program
                 FROM pg_roles WHERE rolname = current_user`,
                { env }
            )
            assert.equal(flags.rows[0].rolsuper, false)
            assert.equal(flags.rows[0].rolcreaterole, false)
            assert.equal(flags.rows[0].rolcreatedb, false)
            assert.equal(flags.rows[0].read_files, false)
            assert.equal(flags.rows[0].write_files, false)
            assert.equal(flags.rows[0].exec_program, false)
            await assert.rejects(queryAnalyst(`COPY (SELECT 1) TO PROGRAM 'true'`, { env }), /permission denied|superuser|not allowed/i)
            await assert.rejects(queryAnalyst(`SELECT pg_read_file('postgresql.conf')`, { env }), /permission denied|superuser/i)
            await assert.rejects(queryAnalyst(`SELECT lo_export(0, '/tmp/cuttlely-analyst-lo')`, { env }), /permission denied|superuser/i)

            const upper = ANALYST_ROW_CAP + 1
            await queryAnalyst('CREATE TABLE nums (n integer)', { env })
            await queryAnalyst(`INSERT INTO nums (n) SELECT generate_series(1, ${upper})`, { env })
            const capped = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env })
            assert.equal(capped.rows.length, ANALYST_ROW_CAP)
            assert.equal(capped.truncated, true)
            assert.equal(capped.summary, rowPageSummary({ start: 1, end: ANALYST_ROW_CAP, total: upper, page: 1, pages: 2, more: true }))
            assert.equal(typeof capped.cursor, 'string')
            assert.equal(capped.rows[0].n, 1)

            resetAnalystStoreForTests()
            await provisionAnalyst(env)
            assert.deepEqual(fs.readFileSync(secretFile), secretBytes)
            const storedAgain = JSON.parse(CryptoJS.AES.decrypt(fs.readFileSync(secretFile, 'utf8'), key).toString(CryptoJS.enc.Utf8))
            assert.equal(digest(storedAgain.password), passwordHash)
            const still = await queryAnalyst('SELECT count(*)::int AS n FROM notes', { env })
            assert.equal(still.rows[0].n, 1)
            const roleCount = await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [ANALYST_ROLE])
            assert.equal(roleCount.rows[0].n, 1)

            // Each workspace has its own login and schema. The first workspace keeps the older login.
            const pgTagB = analystWorkspaceTag('workspace-pg-b')
            const legacyWorkspace = await queryAnalyst('SELECT current_user AS user_name, count(*)::int AS n FROM notes', {
                env,
                workspace: 'workspace-pg-a'
            })
            assert.deepEqual(legacyWorkspace.rows, [{ user_name: ANALYST_ROLE, n: 1 }])
            const other = await queryAnalyst('SELECT current_user AS user_name, current_schema() AS schema_name', {
                env,
                workspace: 'workspace-pg-b'
            })
            assert.deepEqual(other.rows, [{ user_name: `${ANALYST_ROLE}_${pgTagB}`, schema_name: `analyst_${pgTagB}` }])
            await assert.rejects(queryAnalyst('SELECT body FROM analyst.notes', { env, workspace: 'workspace-pg-b' }), /permission denied/)
            await assert.rejects(
                queryAnalyst('SELECT email FROM public.app_users', { env, workspace: 'workspace-pg-b' }),
                /permission denied/
            )
            await queryAnalyst('CREATE TABLE b_notes (body text)', { env, workspace: 'workspace-pg-b' })
            await assert.rejects(
                queryAnalyst(`SELECT body FROM analyst_${pgTagB}.b_notes`, { env, workspace: 'workspace-pg-a' }),
                /permission denied/
            )
            for (const statement of [
                `GRANT SELECT ON b_notes TO PUBLIC`,
                `/* share */ grant usage on schema analyst_${pgTagB} to public`,
                `DO $$ BEGIN EXECUTE 'GRANT SELECT ON b_notes TO PUBLIC'; END $$`,
                `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC`,
                `CREATE FUNCTION share_it() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`
            ]) {
                await assert.rejects(queryAnalyst(statement, { env, workspace: 'workspace-pg-b' }), (error) => {
                    assert.equal(error.message, ANALYST_SHARING_REFUSED)
                    assert.equal(analystErrorOutcome(error), 'expected')
                    return true
                })
            }
            assert.equal(fs.existsSync(path.join(dir, `analyst-role-${pgTagB}.enc`)), true)
        } finally {
            resetAnalystStoreForTests()
            await admin.query(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${ident(ANALYST_ROLE)}`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${ident(`${ANALYST_ROLE}_${analystWorkspaceTag('workspace-pg-b')}`)}`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${ident(appRole)}`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${ident(limitedRole)}`).catch(() => {})
            await admin.end().catch(() => {})
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('classifies transport failures separately from SQL results', () => {
        assert.equal(analystErrorOutcome({ errcode: 1, message: 'no such table: t' }), 'expected')
        assert.equal(analystErrorOutcome({ errcode: 14, message: 'unable to open' }), 'transport')
        assert.equal(analystErrorOutcome({ code: '42P01', message: 'relation does not exist' }), 'expected')
        assert.equal(analystErrorOutcome({ code: '42601', message: 'syntax error' }), 'expected')
        assert.equal(analystErrorOutcome({ code: '08006', message: 'connection failure' }), 'transport')
        assert.equal(analystErrorOutcome({ code: '57014', message: 'canceling statement due to statement timeout' }), 'expected')
        assert.equal(analystErrorOutcome({ code: '57P01', message: 'terminating connection due to administrator command' }), 'transport')
        assert.equal(analystErrorOutcome({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), 'transport')
    })
})

// Built with URL so no connection string with a password sits in the source.
function postgresUrl({ user, password, host, port, database }) {
    const url = new URL('postgres://localhost')
    url.username = user
    url.password = password
    url.hostname = host
    url.port = String(port)
    url.pathname = `/${database}`
    return url.toString()
}

describe('analyst URL path', () => {
    it('turns only the paging placeholders into numbered parameters', () => {
        assert.deepEqual(pgPlaceholders("SELECT payload ? 'a' FROM t LIMIT ? OFFSET ?", [101, 0]), {
            sql: "SELECT payload ? 'a' FROM t LIMIT $1 OFFSET $2",
            params: [101, 0]
        })
        assert.deepEqual(pgPlaceholders("SELECT 'why?' AS q", []), { sql: "SELECT 'why?' AS q", params: [] })
    })

    it('is read only, capped like the isolated store, and never echoes the URL password', async () => {
        const spec = analystUrlToolSpec()
        assert.match(spec.description, /^Run a read-only SQL query \(PostgreSQL\)\./)
        assert.match(spec.description, /capped at 100 rows/)
        assert.equal(typeof spec.schema.properties.cursor.type, 'string')
        const password = `demo-${randomBytes(6).toString('hex')}`
        await assert.rejects(
            queryAnalystUrl(
                postgresUrl({ user: 'demo_reader', password, host: '127.0.0.1', port: 1, database: 'demo_bakery' }),
                'SELECT 1'
            ),
            (error) => {
                assert.equal(error.cuttlelyOutcome, 'transport')
                assert.equal(String(error.message).includes(password), false)
                return true
            }
        )
    })

    it('pages a long result with a cursor, refuses writes, and keeps the cursor to its chat', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('analyst URL path: local postgres admin is not reachable')
            return
        }
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_url_${suffix}`
        const role = `writer_${suffix}`
        const password = randomBytes(18).toString('base64url')
        try {
            await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
            await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`)
            const cfg = adminConfig()
            const url = postgresUrl({ user: role, password, host: cfg.host, port: cfg.port, database: dbName })
            const owner = new Client({ connectionString: url })
            await owner.connect()
            await owner.query('CREATE TABLE tickets (id integer PRIMARY KEY, title text NOT NULL)')
            await owner.query(`INSERT INTO tickets SELECT g, 'Demo ticket ' || g FROM generate_series(1, 150) g`)
            await owner.query('CREATE TABLE events (id integer PRIMARY KEY, payload jsonb NOT NULL)')
            await owner.query(
                `INSERT INTO events SELECT g, CASE WHEN g % 2 = 0 THEN '{"status":"done"}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1, 120) g`
            )
            await owner.end()
            const first = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { sql: 'SELECT * FROM tickets ORDER BY id' }))
            assert.equal(first.rows.length, ANALYST_ROW_CAP)
            assert.equal(first.truncated, true)
            assert.match(first.summary, /^rows 1-100 of 150/)
            assert.equal(typeof first.cursor, 'string')
            const second = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { cursor: first.cursor }))
            assert.equal(second.rows.length, 50)
            assert.equal(second.rows[0].id, 101)
            await assert.rejects(
                withAnalystScope('demo:chat-2', () => queryAnalystUrl(url, { cursor: first.cursor })),
                (error) => error.cuttlelyOutcome === 'expected'
            )
            await assert.rejects(queryAnalystUrl(url, `INSERT INTO tickets VALUES (151, 'Demo ticket 151')`), (error) => {
                assert.match(error.message, /read-only transaction/)
                assert.equal(error.cuttlelyOutcome, 'expected')
                return true
            })
            // No TEMP table in a read-only source, inside a harness run or not.
            for (const scope of ['', 'harness-url:chat-a']) {
                await withAnalystScope(scope, () =>
                    assert.rejects(queryAnalystUrl(url, 'CREATE TEMP TABLE picks AS SELECT 1 AS n'), (error) => {
                        assert.match(error.message, /read-only transaction/)
                        return true
                    })
                )
            }
            const count = await queryAnalystUrl(url, 'SELECT count(*)::int AS n FROM tickets')
            assert.equal(count.rows[0].n, 150)
            const timeout = await queryAnalystUrl(url, 'SHOW statement_timeout')
            assert.equal(timeout.rows[0].statement_timeout, '15s')
            // A question mark in the user's SQL, here the JSONB ? operator, is left alone while paging.
            const jsonFirst = await withAnalystScope('demo:chat-1', () =>
                queryAnalystUrl(
                    url,
                    "SELECT id, payload ? 'status' AS has_status FROM events WHERE payload ? 'status' OR id > 0 ORDER BY id"
                )
            )
            assert.equal(jsonFirst.rows.length, ANALYST_ROW_CAP)
            assert.equal(jsonFirst.rows[1].has_status, true)
            const jsonNext = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { cursor: jsonFirst.cursor }))
            assert.equal(jsonNext.rows.length, 20)
            assert.equal(jsonNext.rows[0].id, 101)
            const marked = await queryAnalystUrl(url, "SELECT count(*)::int AS n FROM events WHERE payload ? 'status' AND 'why?' <> ''")
            assert.equal(marked.rows[0].n, 60)
            // The statement runs inside the read-only transaction that holds the timeout.
            const inTx = await queryAnalystUrl(
                url,
                "SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout"
            )
            assert.deepEqual(inTx.rows[0], { ro: 'on', timeout: '15s' })
            // A statement that already ends in OFFSET or FETCH FIRST is paged around, not appended to.
            const skipped = await withAnalystScope('demo:chat-1', () =>
                queryAnalystUrl(url, 'SELECT id FROM tickets ORDER BY id OFFSET 10')
            )
            assert.equal(skipped.rows.length, ANALYST_ROW_CAP)
            assert.equal(skipped.rows[0].id, 11)
            const skippedNext = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { cursor: skipped.cursor }))
            assert.deepEqual([skippedNext.rows.length, skippedNext.rows[0].id], [40, 111])
            const fetched = await withAnalystScope('demo:chat-1', () =>
                queryAnalystUrl(url, 'SELECT id FROM tickets ORDER BY id FETCH FIRST 120 ROWS ONLY')
            )
            assert.equal(fetched.rows.length, ANALYST_ROW_CAP)
            const fetchedNext = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { cursor: fetched.cursor }))
            assert.deepEqual([fetchedNext.rows.length, fetchedNext.rows[0].id], [20, 101])
            // SHOW ALL has more than 100 rows; the second page comes from its cursor.
            const settings = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, 'SHOW ALL'))
            assert.equal(settings.rows.length, ANALYST_ROW_CAP)
            assert.equal(typeof settings.cursor, 'string')
            const moreSettings = await withAnalystScope('demo:chat-1', () => queryAnalystUrl(url, { cursor: settings.cursor }))
            assert.equal(moreSettings.rows.length > 0, true)
            assert.notDeepEqual(moreSettings.rows[0], settings.rows[0])
        } finally {
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
            await admin.end()
        }
    })
})
