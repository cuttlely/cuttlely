import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
    ANALYST_ROLE,
    ANALYST_ROW_CAP,
    ANALYST_ROW_CAP_MAX,
    ANALYST_STATEMENT_TIMEOUT_MS,
    ANALYST_STATEMENT_TIMEOUT_MAX_MS,
    ANALYST_PG_QUERY_BACKSTOP_MS,
    ANALYST_TIMEOUT_MESSAGE,
    analystCallLimits,
    analystConfiguredRowCap,
    analystConfiguredTimeoutMs,
    analystRowCap,
    analystStatementTimeoutMs,
    analystStatementTimeoutSetting,
    provisionAnalyst,
    resetAnalystLimitWarningsForTests,
    endAnalystRun,
    analystWorkspaceTag,
    ANALYST_SHARING_REFUSED,
    analystSqliteFile,
    applicationSqliteFile,
    assertAnalystSqlite,
    oneSqlStatement,
    analystSqlText,
    analystErrorOutcome,
    analystToolSpec,
    queryAnalyst,
    queryPostgres,
    probeAnalystCursor,
    openPlannedAnalystPage,
    continuePlannedAnalystPage,
    setAnalystPgClientForTests,
    queryAnalystUrl,
    pgPlaceholders,
    analystUrlToolSpec,
    withAnalystScope,
    resetAnalystStoreForTests,
    rowPageSummary
} from './analyst-store.mjs'
import { ANALYST_CURSOR_ERRORS, analystPageRequest, parseSimpleSelect, resultLengthSql } from './analyst-page.mjs'
import { analystHandoffLine, analystShownRows, presentAnalystToolResult } from '../packages/harness/context.mjs'
import { analystChipRows } from '../packages/harness/trace.mjs'
import { queryAnalyst as runtimeQueryAnalyst } from '../packages/harness/runtime/analyst-store.mjs'
import { analystPageRequest as runtimePageRequest } from '../packages/harness/runtime/analyst-page.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages/components/package.json'))
const CryptoJS = require('crypto-js')
const { Client } = require('pg')

const STORE_URL = pathToFileURL(path.join(ROOT, 'packages/harness/runtime/analyst-store.mjs')).href

// Several processes provision at the same moment. Each reports whether it could read the legacy row.
function claimLegacyTogether(dir, workspaces) {
    const go = path.join(dir, 'go')
    const legacy = new DatabaseSync(path.join(dir, 'analyst.db'))
    legacy.exec('CREATE TABLE legacy_notes (body text)')
    legacy.exec("INSERT INTO legacy_notes (body) VALUES ('kept')")
    legacy.close()
    const script = `
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { provisionAnalyst } from ${JSON.stringify(STORE_URL)}
const workspace = process.env.CLAIM_WORKSPACE
const dir = process.env.CLAIM_DIR
const go = process.env.CLAIM_GO
const env = {
    DATABASE_TYPE: 'sqlite',
    DATABASE_PATH: dir,
    SECRETKEY_PATH: dir + '/secrets',
    CUTTLELY_ANALYST: 'auto',
    FLOWISE_SECRETKEY_OVERWRITE: 'analyst-test-key'
}
process.stdout.write('READY\\n')
const started = Date.now()
while (!fs.existsSync(go)) {
    if (Date.now() - started > 20000) throw new Error('timed out waiting to start')
    await new Promise((resolve) => setTimeout(resolve, 5))
}
const store = await provisionAnalyst(env, { workspace })
const db = new DatabaseSync(store.file)
let rows = []
let legacyError = ''
try {
    rows = db.prepare('SELECT body FROM legacy_notes').all().map((row) => row.body)
} catch (error) {
    legacyError = error.message
}
db.exec('CREATE TABLE marks (body text)')
db.prepare('INSERT INTO marks (body) VALUES (?)').run(workspace)
const marks = db.prepare('SELECT body FROM marks').all().map((row) => row.body)
db.close()
process.stdout.write('RESULT ' + JSON.stringify({ workspace, file: store.file, legacy: rows, legacyError, marks }) + '\\n')
`
    const children = workspaces.map((workspace) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, CLAIM_WORKSPACE: workspace, CLAIM_DIR: dir, CLAIM_GO: go },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let out = ''
        let err = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            out += chunk
        })
        child.stderr.on('data', (chunk) => {
            err += chunk
        })
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`claim child ${workspace} did not start: ${err}`)), 20000)
            child.stdout.on('data', () => {
                if (out.includes('READY')) {
                    clearTimeout(timer)
                    resolve()
                }
            })
            child.on('exit', (code) => {
                if (!out.includes('READY')) reject(new Error(`claim child ${workspace} exited ${code} before ready: ${err}\n${out}`))
            })
        })
        const done = new Promise((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`claim child ${workspace} exited ${code}: ${err}\n${out}`))
                    return
                }
                const line = out.split('\n').find((item) => item.startsWith('RESULT '))
                if (!line) {
                    reject(new Error(`claim child ${workspace} returned no result: ${err}\n${out}`))
                    return
                }
                resolve(JSON.parse(line.slice('RESULT '.length)))
            })
        })
        return { ready, done }
    })
    return Promise.all(children.map((child) => child.ready)).then(() => {
        fs.writeFileSync(go, '1')
        return Promise.all(children.map((child) => child.done))
    })
}

function mulberry32(seed) {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
}

function noteWidthForWindow(start, shown) {
    let lo = 1
    let hi = 12000
    let found = 0
    while (lo <= hi) {
        const width = (lo + hi) >> 1
        const rows = []
        for (let i = 0; i < shown; i += 1) rows.push({ n: start + i + 1, note: 'x'.repeat(width) })
        rows.push({ n: start + shown + 1, note: '' })
        const got = analystShownRows(rows).length
        if (got === shown) {
            found = width
            break
        }
        if (got > shown) lo = width + 1
        else hi = width - 1
    }
    return found
}

async function assertWideTailStaysInOrder(query, sql) {
    const first = await query(sql)
    assert.equal(first.rows.length, 250)
    assert.equal(first.rows[0].n, 1)
    assert.equal(first.rows.at(-1).n, 250)
    assert.match(first.summary, /^rows 1-250 of 600 \(more rows available, say "show more" for the next page\)$/)
    assert.equal(/page \d+/.test(first.summary), false)
    await assert.rejects(query({ cursor: first.cursor, page: 3 }), (error) => {
        assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
        return true
    })
    const restarted = await query({ cursor: first.cursor, page: 1 })
    assert.equal(restarted.rows[0].n, 1)
    const seen = []
    let page = restarted
    let guard = 0
    while (page) {
        guard += 1
        assert.ok(guard < 40, `stopped after ${seen.length} rows`)
        assert.equal(/page \d+/.test(String(page.summary || '')), false)
        for (const row of page.rows) seen.push(row.n)
        if (!page.cursor || String(page.summary || '').includes('last page')) break
        const next = await query({ cursor: page.cursor })
        assert.equal(next.rows[0].n, seen.at(-1) + 1)
        page = next
    }
    assert.deepEqual(
        seen,
        Array.from({ length: 600 }, (_, index) => index + 1)
    )
}

async function assertPagesStayContiguous(query, sql, total, pageSizes) {
    const first = await query(sql)
    assert.equal(/page \d+/.test(String(first.summary || '')), false, first.summary)
    await assert.rejects(query({ cursor: first.cursor, page: 3 }), (error) => {
        assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
        return true
    })
    const seen = []
    let page = first
    let index = 0
    while (page) {
        assert.equal(page.rows.length, pageSizes[index], page.summary)
        assert.equal(/page \d+/.test(String(page.summary || '')), false)
        for (const row of page.rows) seen.push(row.n)
        index += 1
        if (!page.cursor || String(page.summary || '').includes('last page')) break
        const next = await query({ cursor: page.cursor })
        assert.equal(next.rows[0].n, seen.at(-1) + 1)
        page = next
    }
    assert.equal(index, pageSizes.length)
    assert.deepEqual(
        seen,
        Array.from({ length: total }, (_, item) => item + 1)
    )
}

async function assertNoPageCountAndNoSkips(query, sql, total, cap) {
    const first = await query(sql)
    assert.equal(first.rows.length, cap)
    assert.equal(first.rows[0].n, 1)
    assert.equal(/page \d+/.test(String(first.summary || '')), false, first.summary)
    await assert.rejects(query({ cursor: first.cursor, page: 3 }), (error) => {
        assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
        return true
    })
    const seen = []
    let page = first
    let guard = 0
    while (page) {
        guard += 1
        assert.ok(guard < 40)
        assert.equal(/page \d+/.test(String(page.summary || '')), false)
        for (const row of page.rows) seen.push(row.n)
        if (!page.cursor || String(page.summary || '').includes('last page')) break
        const next = await query({ cursor: page.cursor })
        assert.equal(next.rows[0].n, seen.at(-1) + 1)
        page = next
    }
    assert.deepEqual(
        seen,
        Array.from({ length: total }, (_, item) => item + 1)
    )
}

async function assertCountAgreesWithShowMore(query, sql, total) {
    const opened = await query(sql)
    const summary = String(opened.summary || '')
    const stated = summary.match(/page \d+ of (\d+)/)
    const fresh = await query(sql)
    const walked = []
    let page = fresh
    let guard = 0
    while (page) {
        guard += 1
        assert.ok(guard < 200)
        walked.push(page.rows.map((row) => row.n))
        if (!page.cursor || String(page.summary || '').includes('last page')) break
        page = await query({ cursor: page.cursor })
    }
    const flat = walked.flat()
    assert.deepEqual(
        flat,
        Array.from({ length: total }, (_, item) => item + 1)
    )
    if (!stated) {
        assert.equal(/page \d+/.test(summary), false, summary)
        await assert.rejects(query({ cursor: opened.cursor, page: 3 }), (error) => {
            assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
            return true
        })
        return
    }
    assert.equal(walked.length, Number(stated[1]), summary)
    for (let n = 1; n <= walked.length; n += 1) {
        const jumped = await query({ cursor: opened.cursor, page: n })
        assert.deepEqual(
            jumped.rows.map((row) => row.n),
            walked[n - 1],
            `${sql} page ${n}`
        )
    }
}

async function assertNamedCountMatchesWalk(query, sql) {
    const opened = await query(sql)
    const summary = String(opened.summary || '')
    const stated = summary.match(/page \d+ of (\d+)/)
    assert.ok(stated, summary)
    const count = Number(stated[1])
    const fresh = await query(sql)
    const walked = []
    let page = fresh
    let guard = 0
    while (page) {
        guard += 1
        assert.ok(guard < 40)
        walked.push(page.rows.map((row) => row.n))
        if (!page.cursor || String(page.summary || '').includes('last page')) break
        page = await query({ cursor: page.cursor })
    }
    assert.equal(walked.length, count, summary)
    for (let n = 1; n <= count; n += 1) {
        const jumped = await query({ cursor: opened.cursor, page: n })
        assert.deepEqual(
            jumped.rows.map((row) => row.n),
            walked[n - 1],
            `${sql} page ${n}`
        )
    }
}

async function assertExactPageCount(query, sql, total, cap) {
    const pages = Math.ceil(total / cap)
    const first = await query(sql)
    assert.equal(first.rows.length, Math.min(cap, total))
    assert.match(
        first.summary,
        new RegExp(`^rows 1-${Math.min(cap, total)} of ${total} \\(page 1 of ${pages}, say "show more" for the next page\\)$`)
    )
    const lastStart = (pages - 1) * cap + 1
    const jumped = await query({ cursor: first.cursor, page: pages })
    assert.equal(jumped.rows[0].n, lastStart)
    assert.equal(jumped.rows.at(-1).n, total)
    assert.equal(jumped.rows.length, total - lastStart + 1)
}

function walkedPageBounds(rows, cap) {
    const bounds = []
    let offset = 0
    while (offset < rows.length && bounds.length <= rows.length) {
        const shown = analystShownRows(rows.slice(offset, offset + cap))
        const count = Math.max(1, shown.length)
        bounds.push({ start: rows[offset].n, end: rows[offset + count - 1].n })
        offset += count
    }
    return bounds
}

function rowsWithRandomCuts(total, cap, rand) {
    const rows = []
    let offset = 0
    while (offset < total) {
        const remaining = total - offset
        const canCut = remaining > 1 && cap > 1 && rand() < 0.45
        if (canCut) {
            const shown = 1 + Math.floor(rand() * Math.min(cap - 1, remaining - 1))
            const width = noteWidthForWindow(offset, shown)
            if (width) {
                for (let i = 0; i < shown; i += 1) rows.push({ n: offset + i + 1, note: 'x'.repeat(width) })
                offset += shown
                continue
            }
        }
        const take = Math.min(cap, remaining)
        for (let i = 0; i < take; i += 1) rows.push({ n: offset + i + 1, note: '' })
        offset += take
    }
    return rows
}

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

describe('analyst module path', () => {
    it('keeps one store and one page module for the old scripts paths', () => {
        assert.equal(queryAnalyst, runtimeQueryAnalyst)
        assert.equal(analystPageRequest, runtimePageRequest)
    })
})

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

    it('caps the timeout at 15 seconds unless the server setting raises it, and never past the hard maximum', () => {
        const none = {}
        assert.equal(ANALYST_STATEMENT_TIMEOUT_MS, 15000)
        assert.equal(ANALYST_STATEMENT_TIMEOUT_MAX_MS, 120000)
        assert.equal(analystStatementTimeoutSetting(15000), '15s')
        assert.equal(analystStatementTimeoutSetting(250), '250ms')
        assert.equal(analystConfiguredTimeoutMs(none), 15000)
        assert.equal(analystStatementTimeoutMs(undefined, none), 15000)
        assert.equal(analystStatementTimeoutMs(0, none), 15000)
        assert.equal(analystStatementTimeoutMs('abc', none), 15000)
        assert.equal(analystStatementTimeoutMs(500, none), 500)
        assert.equal(analystStatementTimeoutMs(60000, none), 15000)
        assert.equal(analystStatementTimeoutMs(600000, none), 15000)
        const raised = { CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '60000' }
        assert.equal(analystConfiguredTimeoutMs(raised), 60000)
        assert.equal(analystStatementTimeoutMs(undefined, raised), 60000)
        assert.equal(analystStatementTimeoutMs(500, raised), 500)
        assert.equal(analystStatementTimeoutMs(90000, raised), 60000)
        const over = { CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '999999999' }
        assert.equal(analystConfiguredTimeoutMs(over), ANALYST_STATEMENT_TIMEOUT_MAX_MS)
        assert.equal(analystStatementTimeoutMs(undefined, over), ANALYST_STATEMENT_TIMEOUT_MAX_MS)
        assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '0' }), 15000)
        assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: 'nope' }), 15000)
        assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '1' }), 1000)
        assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '999' }), 1000)
    })

    it('warns once when a host limit is unset-shaped, and raises a short timeout to one second', () => {
        resetAnalystLimitWarningsForTests()
        const warnings = []
        const original = console.warn
        console.warn = (message) => warnings.push(String(message))
        try {
            assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: '0' }), 100)
            assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: '0' }), 100)
            assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: '-4' }), 100)
            assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: 'nope' }), 100)
            assert.equal(analystConfiguredRowCap({}), 100)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '0' }), 15000)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '-8' }), 15000)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: 'abc' }), 15000)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '1' }), 1000)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '1' }), 1000)
            assert.equal(analystConfiguredTimeoutMs({ CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '999' }), 1000)
            assert.equal(analystConfiguredTimeoutMs({}), 15000)
        } finally {
            console.warn = original
        }
        const rowZero = warnings.filter((message) => message.includes('row cap') && message.includes('"0"'))
        assert.equal(rowZero.length, 1)
        assert.equal(warnings.filter((message) => message.includes('row cap') && message.includes('"-4"')).length, 1)
        assert.equal(warnings.filter((message) => message.includes('row cap') && message.includes('"nope"')).length, 1)
        assert.equal(warnings.filter((message) => message.includes('query timeout') && message.includes('"0"')).length, 1)
        assert.equal(warnings.filter((message) => message.includes('query timeout') && message.includes('"1"')).length, 1)
        assert.equal(
            warnings.some((message) => message.includes('below 1 second')),
            true
        )
        assert.equal(warnings.filter((message) => message.includes('""')).length, 0)
    })

    it('keeps a reused Postgres session past the first call timeout', async () => {
        const clients = []
        setAnalystPgClientForTests((config) => {
            const client = {
                config,
                statementMs: null,
                ended: false,
                connect() {
                    return Promise.resolve()
                },
                end() {
                    this.ended = true
                    return Promise.resolve()
                },
                query(sql) {
                    const text = typeof sql === 'string' ? sql : String(sql?.text || sql || '')
                    const setTimeoutSql = text.match(/^SET statement_timeout = (\d+)$/)
                    if (setTimeoutSql) {
                        this.statementMs = Number(setTimeoutSql[1])
                        return Promise.resolve({ rows: [], command: 'SET' })
                    }
                    if (text.startsWith('SET search_path') || text === 'ROLLBACK') return Promise.resolve({ rows: [], command: 'SET' })
                    const sleep = text.match(/pg_sleep\(([0-9.]+)\)/)
                    if (sleep) {
                        const ms = Number(sleep[1]) * 1000
                        if (this.statementMs && ms >= this.statementMs) {
                            const error = new Error('canceling statement due to statement timeout')
                            error.code = '57014'
                            return Promise.reject(error)
                        }
                        if (ms >= this.config.query_timeout) {
                            return Promise.reject(new Error('Query read timeout'))
                        }
                        return Promise.resolve({ rows: [{ slept: 1 }], command: 'SELECT', rowCount: 1 })
                    }
                    if (/analyst_n/i.test(text)) return Promise.resolve({ rows: [{ analyst_n: 1 }], command: 'SELECT' })
                    return Promise.resolve({ rows: [{ ok: 1 }], command: 'SELECT', rowCount: 1 })
                }
            }
            clients.push(client)
            return client
        })
        const store = {
            host: '127.0.0.1',
            port: 5432,
            database: 'analyst_demo',
            user: 'analyst_reader',
            schema: 'analyst',
            password: 'session-secret',
            ssl: undefined
        }
        const scope = 'turn-timeout'
        const paging = { scope, page: 1, rowCap: 100, statement: 'SELECT 1' }
        const env = { CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '120000' }
        try {
            await queryPostgres(store, 'SELECT 1', { paging }, 1000, env)
            const slept = await queryPostgres(
                store,
                'SELECT pg_sleep(7)',
                { paging: { ...paging, statement: 'SELECT pg_sleep(7)' } },
                60000,
                env
            )
            assert.equal(slept.rows[0].slept, 1)
            assert.equal(clients.length, 1)
            assert.equal(clients[0].config.query_timeout, ANALYST_PG_QUERY_BACKSTOP_MS)
            assert.equal(clients[0].statementMs, 60000)
            assert.equal(clients[0].ended, false)
            await assert.rejects(queryPostgres(store, 'SELECT pg_sleep(7)', { paging }, 2000, env), (error) => {
                assert.equal(error.message, ANALYST_TIMEOUT_MESSAGE)
                assert.equal(error.cuttlelyOutcome, 'expected')
                assert.equal(String(error.message).includes('Query read timeout'), false)
                return true
            })
            assert.equal(clients.length, 1)
            assert.equal(clients[0].ended, false)
        } finally {
            await endAnalystRun(scope)
            resetAnalystStoreForTests()
        }
    })

    it('caps rows at 100 unless the server setting changes it, and a node override cannot exceed that', () => {
        const none = {}
        assert.equal(ANALYST_ROW_CAP, 100)
        assert.equal(ANALYST_ROW_CAP_MAX, 1000)
        assert.equal(analystConfiguredRowCap(none), 100)
        assert.equal(analystRowCap(undefined, none), 100)
        assert.equal(analystRowCap(0, none), 100)
        assert.equal(analystRowCap(40, none), 40)
        assert.equal(analystRowCap(500, none), 100)
        const high = { CUTTLELY_ANALYST_ROW_CAP: '1000' }
        assert.equal(analystRowCap(0.5, high), 1)
        assert.equal(analystRowCap(0.9, high), 1)
        assert.equal(analystRowCap(1, high), 1)
        assert.equal(analystRowCap(1.2, high), 1)
        assert.equal(analystRowCap(40, high), 40)
        assert.equal(analystRowCap(0, high), 1000)
        const raised = { CUTTLELY_ANALYST_ROW_CAP: '250' }
        assert.equal(analystConfiguredRowCap(raised), 250)
        assert.equal(analystRowCap(undefined, raised), 250)
        assert.equal(analystRowCap(40, raised), 40)
        assert.equal(analystRowCap(400, raised), 250)
        assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: '5000' }), ANALYST_ROW_CAP_MAX)
        assert.equal(analystConfiguredRowCap({ CUTTLELY_ANALYST_ROW_CAP: '0' }), 100)
        assert.deepEqual(analystCallLimits({ rowCap: 40, statementTimeoutMs: 800 }, raised), { rowCap: 40, timeoutMs: 800 })
        assert.deepEqual(analystCallLimits({ rowCap: 900, statementTimeoutMs: 999999 }, raised), { rowCap: 250, timeoutMs: 15000 })
        assert.deepEqual(analystCallLimits({}, { CUTTLELY_ANALYST_ROW_CAP: '80', CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '4000' }), {
            rowCap: 80,
            timeoutMs: 4000
        })
        assert.match(analystToolSpec('sqlite', 25).description, /capped at 25 rows/)
        assert.match(analystUrlToolSpec(25).description, /capped at 25 rows/)
        assert.match(analystToolSpec('sqlite', undefined).description, /capped at 100 rows/)
    })

    it('pages at the server row cap, and a node override can only lower it', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '10' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        try {
            await queryAnalyst('CREATE TABLE nums (n integer)', { env, sqliteOpen })
            await queryAnalyst(
                'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 25) INSERT INTO nums (n) SELECT n FROM c',
                { env, sqliteOpen }
            )
            const serverPage = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen })
            assert.equal(serverPage.rows.length, 10)
            assert.equal(serverPage.rows.at(-1).n, 10)
            assert.match(serverPage.summary, /^rows 1-10 of 25 /)
            const tighter = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen, rowCap: 4 })
            assert.equal(tighter.rows.length, 4)
            assert.equal(tighter.rows.at(-1).n, 4)
            const next = await queryAnalyst({ cursor: tighter.cursor }, { env, sqliteOpen, rowCap: 4 })
            assert.equal(next.rows[0].n, 5)
            assert.equal(next.rows.length, 4)
            const over = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen, rowCap: 80 })
            assert.equal(over.rows.length, 10)
            assert.equal(over.rows.at(-1).n, 10)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('pages a 600-row table at a cap of 250 once each, and the run card count matches', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '250' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'cap-250'
        try {
            await queryAnalyst('CREATE TABLE nums (n INTEGER PRIMARY KEY)', { env, sqliteOpen, scope })
            await queryAnalyst(
                'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 600) INSERT INTO nums (n) SELECT n FROM c',
                { env, sqliteOpen, scope }
            )
            const seen = []
            const cardCounts = []
            let page = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen, scope })
            let guard = 0
            while (page) {
                guard += 1
                assert.ok(guard < 8)
                const lines = presentAnalystToolResult(page)
                    .split('\n')
                    .filter((line) => line.startsWith('n:'))
                const card = analystChipRows({
                    name: 'mcp__analyst__query',
                    status: 'done',
                    detail: JSON.stringify({ result: page })
                })
                assert.equal(lines.length, page.rows.length)
                assert.equal(card.rows.length, page.rows.length)
                cardCounts.push(card.rows.length)
                for (const row of page.rows) seen.push(row.n)
                const last = typeof page.summary === 'string' && page.summary.includes('last page')
                if (!page.cursor || last) break
                page = await queryAnalyst({ cursor: page.cursor }, { env, sqliteOpen, scope })
            }
            assert.deepEqual(
                seen,
                Array.from({ length: 600 }, (_, index) => index + 1)
            )
            assert.deepEqual(cardCounts, [250, 250, 100])
            const jump = await queryAnalyst('SELECT n FROM nums ORDER BY n', { env, sqliteOpen, scope: 'cap-250-jump' })
            assert.match(jump.summary, /^rows 1-250 of 600 \(page 1 of 3, say "show more" for the next page\)$/)
            const page3 = await queryAnalyst({ cursor: jump.cursor, page: 3 }, { env, sqliteOpen, scope: 'cap-250-jump' })
            assert.equal(page3.rows[0].n, 501)
            assert.equal(page3.rows.at(-1).n, 600)
            assert.equal(page3.rows.length, 100)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('refuses a page jump when later rows are wider, in keyset and offset', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '250' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const note = 'x'.repeat(400)
        const fill = async (table) => {
            await queryAnalyst(`CREATE TABLE ${table} (n INTEGER PRIMARY KEY, note TEXT)`, { env, sqliteOpen, scope: table })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 600) INSERT INTO ${table} (n, note) SELECT n, CASE WHEN n <= 250 THEN '' ELSE '${note}' END FROM c`,
                { env, sqliteOpen, scope: table }
            )
        }
        const query = (table, input) => queryAnalyst(input, { env, sqliteOpen, scope: table })
        try {
            await fill('keyed')
            await fill('loose')
            await assertWideTailStaysInOrder((input) => query('keyed', input), 'SELECT n, note FROM keyed ORDER BY n')
            await assertWideTailStaysInOrder((input) => query('loose', input), 'SELECT n, note FROM loose ORDER BY n LIMIT 100000')
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('refuses a page jump when later notes contain emoji', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '100' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'emoji-notes'
        const emoji = '😀'.repeat(80)
        try {
            await queryAnalyst('CREATE TABLE nums (n INTEGER PRIMARY KEY, note TEXT)', { env, sqliteOpen, scope })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 300) INSERT INTO nums (n, note) SELECT n, CASE WHEN n <= 100 THEN '' ELSE '${emoji}' END FROM c`,
                { env, sqliteOpen, scope }
            )
            const db = new DatabaseSync(analystSqliteFile(env))
            const lengthSql = resultLengthSql('SELECT n, note FROM nums ORDER BY n', ['n', 'note'], 'sqlite')
            const measured = db.prepare(lengthSql).all()
            const stored = db.prepare('SELECT n, note FROM nums ORDER BY n').all()
            assert.equal(measured.length, 300)
            for (let i = 0; i < stored.length; i += 1) {
                const js = `n: ${stored[i].n}, note: ${stored[i].note ?? 'null'}`.length
                assert.ok(measured[i].analyst_line_len >= js)
            }
            db.close()
            const query = (input) => queryAnalyst(input, { env, sqliteOpen, scope })
            const first = await query('SELECT n, note FROM nums ORDER BY n')
            assert.equal(first.rows.length, 100)
            assert.equal(first.rows.at(-1).n, 100)
            assert.match(first.summary, /^rows 1-100 of 300 \(more rows available, say "show more" for the next page\)$/)
            assert.equal(/page \d+/.test(first.summary), false)
            await assert.rejects(query({ cursor: first.cursor, page: 3 }), (error) => {
                assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
                return true
            })
            const seen = []
            let page = first
            let guard = 0
            while (page) {
                guard += 1
                assert.ok(guard < 20)
                for (const row of page.rows) seen.push(row.n)
                if (!page.cursor || String(page.summary || '').includes('last page')) break
                const next = await query({ cursor: page.cursor })
                assert.equal(next.rows[0].n, seen.at(-1) + 1)
                page = next
            }
            assert.deepEqual(
                seen,
                Array.from({ length: 300 }, (_, index) => index + 1)
            )
            const offset = await query('SELECT n, note FROM nums ORDER BY n LIMIT 100000')
            assert.equal(/page \d+/.test(String(offset.summary || '')), false)
            await assert.rejects(query({ cursor: offset.cursor, page: 3 }), (error) => {
                assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
                return true
            })
            const offsetSeen = []
            page = offset
            guard = 0
            while (page) {
                guard += 1
                assert.ok(guard < 20)
                for (const row of page.rows) offsetSeen.push(row.n)
                if (!page.cursor || String(page.summary || '').includes('last page')) break
                page = await query({ cursor: page.cursor })
            }
            assert.deepEqual(
                offsetSeen,
                Array.from({ length: 300 }, (_, index) => index + 1)
            )
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('pages wide notes in order, and refuses a page jump after a short page', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '250' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'wide-600'
        const note = 'n'.repeat(400)
        try {
            await queryAnalyst('CREATE TABLE wide (n INTEGER PRIMARY KEY, note TEXT)', { env, sqliteOpen, scope })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 600) INSERT INTO wide (n, note) SELECT n, '${note}' FROM c`,
                { env, sqliteOpen, scope }
            )
            const first = await queryAnalyst('SELECT n, note FROM wide ORDER BY n', { env, sqliteOpen, scope })
            assert.ok(first.rows.length < 250)
            assert.match(first.summary, /rows \d+-\d+ of 600 \(more rows available/)
            assert.equal(/page \d+/.test(first.summary), false)
            await assert.rejects(
                queryAnalyst({ cursor: first.cursor, page: 3 }, { env, sqliteOpen, scope }),
                (error) => error.message === ANALYST_CURSOR_ERRORS.page
            )
            const seen = first.rows.map((row) => row.n)
            let page = await queryAnalyst({ cursor: first.cursor }, { env, sqliteOpen, scope })
            assert.equal(page.rows[0].n, first.rows.at(-1).n + 1)
            let guard = 0
            while (page) {
                guard += 1
                assert.ok(guard < 40)
                const card = analystChipRows({
                    name: 'mcp__analyst__query',
                    status: 'done',
                    detail: JSON.stringify({ result: page })
                })
                const lines = presentAnalystToolResult(page)
                    .split('\n')
                    .filter((line) => line.startsWith('n:'))
                assert.equal(card.rows.length, page.rows.length)
                assert.equal(lines.length, page.rows.length)
                assert.equal(page.rows[0].n, seen.at(-1) + 1)
                for (const row of page.rows) seen.push(row.n)
                const last = typeof page.summary === 'string' && page.summary.includes('last page')
                if (!page.cursor || last) break
                page = await queryAnalyst({ cursor: page.cursor }, { env, sqliteOpen, scope })
            }
            assert.deepEqual(
                seen,
                Array.from({ length: 600 }, (_, index) => index + 1)
            )
            assert.match(analystToolSpec('sqlite', 250).description, /only while every page so far returned the full row cap/)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a full page after a short one names the rows and not a page count', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '250' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'short-then-full'
        const width = 1170
        try {
            const db = new DatabaseSync(analystSqliteFile(env))
            db.exec('CREATE TABLE nums (n INTEGER PRIMARY KEY, note TEXT)')
            const insert = db.prepare('INSERT INTO nums (n, note) VALUES (?, ?)')
            for (let n = 1; n <= 600; n += 1) insert.run(n, n <= 10 ? 'x'.repeat(width) : '')
            db.close()
            const first = await queryAnalyst('SELECT n, note FROM nums ORDER BY n', { env, sqliteOpen, scope })
            assert.equal(first.rows.length, 10)
            assert.equal(first.rows[0].n, 1)
            assert.match(first.summary, /^rows 1-10 of 600 \(more rows available, say "show more" for the next page\)$/)
            await assert.rejects(queryAnalyst({ cursor: first.cursor, page: 3 }, { env, sqliteOpen, scope }), (error) => {
                assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
                return true
            })
            const second = await queryAnalyst({ cursor: first.cursor }, { env, sqliteOpen, scope })
            assert.equal(second.rows.length, 250)
            assert.equal(second.rows[0].n, 11)
            assert.equal(second.rows.at(-1).n, 260)
            assert.match(second.summary, /^rows 11-260 of 600 \(more rows available, say "show more" for the next page\)$/)
            assert.equal(/page \d+/.test(second.summary), false)
            await assert.rejects(queryAnalyst({ cursor: second.cursor, page: 4 }, { env, sqliteOpen, scope }), (error) => {
                assert.equal(error.message, ANALYST_CURSOR_ERRORS.page)
                return true
            })
            const third = await queryAnalyst({ cursor: second.cursor, page: 3 }, { env, sqliteOpen, scope })
            assert.equal(third.rows[0].n, 261)
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('page lines stay true across thousands of random cut pages', async () => {
        const rand = mulberry32(20261013)
        const cases = 3000
        const fixedNow = 1_000_000
        const modes = ['buffer', 'keyset', 'offset']
        try {
            for (let index = 0; index < cases; index += 1) {
                const total = 1 + Math.floor(rand() * 36)
                const cap = 1 + Math.floor(rand() * 10)
                const mode = modes[Math.floor(rand() * modes.length)]
                const rows = rowsWithRandomCuts(total, cap, rand)
                assert.equal(rows.length, total)
                const bounds = walkedPageBounds(rows, cap)
                const unstable = mode !== 'buffer' && bounds.length !== Math.ceil(total / cap)
                const env = {
                    DATABASE_TYPE: 'sqlite',
                    DATABASE_PATH: 'paging-property',
                    SECRETKEY_PATH: 'paging-property',
                    CUTTLELY_ANALYST_ROW_CAP: String(cap)
                }
                const options = { env, scope: `prop-${index}`, now: fixedNow, cursorTtlMs: 60 * 60 * 1000, rowCap: cap, rows }
                let page = await openPlannedAnalystPage(rows, { ...options, mode })
                let cursor = page.cursor
                let prevEnd = page.rows.at(-1).n
                let pageNumberNow = 1
                let cut = false
                const chain = new Set()
                for (const row of page.rows) chain.add(row.n)
                for (let step = 0; step < 6 && page; step += 1) {
                    const summary = String(page.summary || '')
                    const lastPage = !page.cursor || summary.includes('last page')
                    const shortMore = page.rows.length < cap && !lastPage
                    if (pageNumberNow === 1) cut = shortMore || unstable
                    else if (shortMore || unstable) cut = true
                    const offered = [...summary.matchAll(/page (\d+)/g)].map((match) => Number(match[1]))
                    const stated = summary.match(/page \d+ of (\d+)/)
                    if (stated) {
                        const count = Number(stated[1])
                        assert.equal(count, bounds.length, summary)
                        offered.push(count)
                    }
                    if (cut) {
                        assert.equal(/page \d+/.test(summary), false, summary)
                        assert.equal(offered.length, 0)
                    }
                    for (const offeredPage of offered) {
                        try {
                            probeAnalystCursor(cursor, { page: offeredPage }, options)
                        } catch (error) {
                            assert.fail(`${summary} offered page ${offeredPage}: ${error.message}`)
                        }
                    }
                    const nums = page.rows.map((row) => row.n)
                    for (let i = 1; i < nums.length; i += 1) assert.equal(nums[i], nums[i - 1] + 1)
                    if (lastPage || !cursor) break
                    const roll = rand()
                    let requested = null
                    if (roll < 0.35) requested = null
                    else if (roll < 0.5) requested = 1
                    else if (roll < 0.7) requested = pageNumberNow + 1
                    else requested = 1 + Math.floor(rand() * (bounds.length + 3))
                    const input = requested == null ? {} : { page: requested }
                    let next
                    try {
                        next = await continuePlannedAnalystPage(cursor, input, options)
                    } catch (error) {
                        assert.equal(error.rows, undefined)
                        const invalid = error.message === ANALYST_CURSOR_ERRORS.page
                        const past = error.message === ANALYST_CURSOR_ERRORS.past
                        assert.equal(invalid || past, true, error.message)
                        if (invalid) assert.equal(cut, true, `${summary} refused page ${requested}`)
                        if (past) assert.equal(cut, false, summary)
                        const again = await continuePlannedAnalystPage(cursor, {}, options)
                        assert.equal(again.rows[0].n, prevEnd + 1)
                        for (const row of again.rows) {
                            assert.equal(chain.has(row.n), false)
                            chain.add(row.n)
                        }
                        page = again
                        cursor = again.cursor
                        prevEnd = again.rows.at(-1).n
                        pageNumberNow += 1
                        continue
                    }
                    assert.ok(next.rows.length > 0)
                    if (requested === 1) {
                        assert.equal(next.rows[0].n, 1)
                        pageNumberNow = 1
                        chain.clear()
                        for (const row of next.rows) chain.add(row.n)
                    } else if (requested == null || requested === pageNumberNow + 1) {
                        assert.equal(next.rows[0].n, prevEnd + 1)
                        pageNumberNow += 1
                        for (const row of next.rows) {
                            assert.equal(chain.has(row.n), false, `repeated row ${row.n}`)
                            chain.add(row.n)
                        }
                    } else {
                        assert.equal(next.rows[0].n, (requested - 1) * cap + 1)
                        pageNumberNow = requested
                        chain.clear()
                        for (const row of next.rows) chain.add(row.n)
                    }
                    prevEnd = next.rows.at(-1).n
                    page = next
                    cursor = next.cursor
                }
            }
        } finally {
            resetAnalystStoreForTests()
        }
    })

    it('advances the cursor only by the rows that fit the handoff budget', async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_ROW_CAP: '250' }
        const sqliteOpen = (file) => new DatabaseSync(file)
        const scope = 'wide-page'
        const note = 'n'.repeat(400)
        try {
            await queryAnalyst('CREATE TABLE wide (n INTEGER PRIMARY KEY, note TEXT)', { env, sqliteOpen, scope })
            await queryAnalyst(
                `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 40) INSERT INTO wide (n, note) SELECT n, '${note}' FROM c`,
                { env, sqliteOpen, scope }
            )
            const seen = []
            let page = await queryAnalyst('SELECT n, note FROM wide ORDER BY n', { env, sqliteOpen, scope })
            let guard = 0
            let previousEnd = 0
            while (page) {
                guard += 1
                assert.ok(guard < 8)
                assert.ok(page.rows.length < 250)
                const lines = presentAnalystToolResult(page)
                    .split('\n')
                    .filter((line) => line.startsWith('n:'))
                const card = analystChipRows({
                    name: 'mcp__analyst__query',
                    status: 'done',
                    detail: JSON.stringify({ result: page })
                })
                assert.equal(lines.length, page.rows.length)
                assert.equal(card.rows.length, page.rows.length)
                assert.equal(page.rows[0].n, previousEnd + 1)
                previousEnd = page.rows.at(-1).n
                for (const row of page.rows) seen.push(row.n)
                const last = typeof page.summary === 'string' && page.summary.includes('last page')
                if (!page.cursor || last) break
                page = await queryAnalyst({ cursor: page.cursor }, { env, sqliteOpen, scope })
            }
            assert.ok(seen.length === 40)
            assert.ok(guard > 1)
            assert.deepEqual(
                seen,
                Array.from({ length: 40 }, (_, index) => index + 1)
            )
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('stops a statement at the server timeout, including a request that asks for longer', { timeout: 20000 }, async () => {
        const dir = tempDir()
        const env = { ...sqliteEnv(dir), CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS: '1000' }
        const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c'
        try {
            await assert.rejects(queryAnalyst(sql, { env }), (error) => error.message === ANALYST_TIMEOUT_MESSAGE)
            await assert.rejects(
                queryAnalyst(sql, { env, statementTimeoutMs: 60000 }),
                (error) => error.message === ANALYST_TIMEOUT_MESSAGE
            )
        } finally {
            resetAnalystStoreForTests()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('gives a legacy analyst.db to exactly one workspace when several ask at once', { timeout: 120000 }, async () => {
        const rounds = 5
        const width = 6
        for (let round = 0; round < rounds; round += 1) {
            const dir = tempDir()
            const names = Array.from({ length: width }, (_, index) => `ws-${round}-${index}`)
            try {
                const results = await claimLegacyTogether(dir, names)
                const winners = results.filter((row) => row.legacy.includes('kept'))
                assert.equal(winners.length, 1, JSON.stringify(results))
                const winner = winners[0]
                assert.equal(path.basename(winner.file), 'analyst.db')
                assert.equal(fs.readFileSync(`${winner.file}.workspace`, 'utf8').trim(), analystWorkspaceTag(winner.workspace))
                assert.deepEqual(winner.marks, [winner.workspace])
                const files = new Set(results.map((row) => row.file))
                assert.equal(files.size, width)
                for (const row of results) {
                    if (row.workspace === winner.workspace) continue
                    assert.equal(row.legacy.includes('kept'), false)
                    assert.match(row.legacyError, /no such table/)
                    assert.deepEqual(row.marks, [row.workspace])
                    assert.equal(path.basename(row.file).startsWith('analyst-'), true)
                }
                const winnerDb = new DatabaseSync(winner.file)
                assert.deepEqual(
                    winnerDb
                        .prepare('SELECT body FROM marks')
                        .all()
                        .map((row) => row.body),
                    [winner.workspace]
                )
                winnerDb.close()
                for (const row of results) {
                    if (row.workspace === winner.workspace) continue
                    const loserDb = new DatabaseSync(row.file)
                    assert.equal(loserDb.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_notes'").get(), undefined)
                    assert.deepEqual(
                        loserDb
                            .prepare('SELECT body FROM marks')
                            .all()
                            .map((entry) => entry.body),
                        [row.workspace]
                    )
                    loserDb.close()
                }
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        }
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

    it('refuses a page jump when later rows are wider', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('analyst URL path: local postgres admin is not reachable')
            return
        }
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_wide_${suffix}`
        const role = `wide_${suffix}`
        const password = randomBytes(18).toString('base64url')
        const note = 'x'.repeat(400)
        const env = { CUTTLELY_ANALYST_ROW_CAP: '250' }
        try {
            await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
            await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`)
            const cfg = adminConfig()
            const url = postgresUrl({ user: role, password, host: cfg.host, port: cfg.port, database: dbName })
            const owner = new Client({ connectionString: url })
            await owner.connect()
            await owner.query('CREATE TABLE nums (n integer PRIMARY KEY, note text)')
            await owner.query(`INSERT INTO nums SELECT g, CASE WHEN g <= 250 THEN '' ELSE '${note}' END FROM generate_series(1, 600) g`)
            await owner.end()
            const run = (input) => withAnalystScope(`wide-${suffix}`, () => queryAnalystUrl(url, input, { env }))
            await assertWideTailStaysInOrder(run, 'SELECT n, note FROM nums ORDER BY n')
            resetAnalystStoreForTests()
            await assertWideTailStaysInOrder(run, 'SELECT n, note FROM nums ORDER BY n LIMIT 100000')
        } finally {
            resetAnalystStoreForTests()
            await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
            await admin.end().catch(() => {})
        }
    })

    it('refuses a page jump when later values are dates', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('analyst URL path: local postgres admin is not reachable')
            return
        }
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_dates_${suffix}`
        const role = `dates_${suffix}`
        const password = randomBytes(18).toString('base64url')
        const env = { CUTTLELY_ANALYST_ROW_CAP: '250' }
        try {
            await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
            await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`)
            const cfg = adminConfig()
            const url = postgresUrl({ user: role, password, host: cfg.host, port: cfg.port, database: dbName })
            const owner = new Client({ connectionString: url })
            await owner.connect()
            await owner.query('CREATE TABLE days (n integer PRIMARY KEY, noted date)')
            await owner.query(
                "INSERT INTO days SELECT g, CASE WHEN g <= 250 THEN NULL ELSE DATE '2026-10-13' END FROM generate_series(1, 600) g"
            )
            await owner.end()
            const run = (input) => withAnalystScope(`dates-${suffix}`, () => queryAnalystUrl(url, input, { env }))
            await assertWideTailStaysInOrder(run, 'SELECT n, noted FROM days ORDER BY n')
            resetAnalystStoreForTests()
            await assertWideTailStaysInOrder(run, 'SELECT n, noted FROM days ORDER BY n LIMIT 100000')
        } finally {
            resetAnalystStoreForTests()
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
            await admin.end().catch(() => {})
        }
    })

    it('names a page count for a json object or scalar, and not for an array', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('analyst URL path: local postgres admin is not reachable')
            return
        }
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_json_${suffix}`
        const role = `json_${suffix}`
        const password = randomBytes(18).toString('base64url')
        try {
            await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
            await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`)
            const cfg = adminConfig()
            const url = postgresUrl({ user: role, password, host: cfg.host, port: cfg.port, database: dbName })
            const owner = new Client({ connectionString: url })
            await owner.connect()
            await owner.query('CREATE TABLE pairs (n integer PRIMARY KEY, payload jsonb)')
            await owner.query(
                `INSERT INTO pairs SELECT g, CASE WHEN g <= 250 THEN NULL ELSE '[{"id": 1}, {"id": 2}]'::jsonb END FROM generate_series(1, 600) g`
            )
            await owner.query('CREATE TABLE seven (n integer PRIMARY KEY, payload jsonb)')
            await owner.query(
                `INSERT INTO seven SELECT g, CASE WHEN g <= 100 THEN NULL ELSE '[{"id":1},{"id":1},{"id":1},{"id":1},{"id":1},{"id":1},{"id":1}]'::jsonb END FROM generate_series(1, 300) g`
            )
            await owner.query('CREATE TABLE objects (n integer PRIMARY KEY, payload jsonb)')
            await owner.query(`INSERT INTO objects SELECT g, '{"id":1}'::jsonb FROM generate_series(1, 600) g`)
            await owner.query('CREATE TABLE scalars (n integer PRIMARY KEY, payload json)')
            await owner.query(`INSERT INTO scalars SELECT g, '1'::json FROM generate_series(1, 600) g`)
            await owner.end()
            const run = (cap, input) =>
                withAnalystScope(`json-${suffix}`, () => queryAnalystUrl(url, input, { env: { CUTTLELY_ANALYST_ROW_CAP: String(cap) } }))
            await assertPagesStayContiguous((input) => run(250, input), 'SELECT n, payload FROM pairs ORDER BY n', 600, [250, 241, 109])
            resetAnalystStoreForTests()
            await assertPagesStayContiguous(
                (input) => run(250, input),
                'SELECT n, payload FROM pairs ORDER BY n LIMIT 100000',
                600,
                [250, 241, 109]
            )
            resetAnalystStoreForTests()
            await assertPagesStayContiguous((input) => run(100, input), 'SELECT n, payload FROM seven ORDER BY n', 300, [100, 91, 91, 18])
            resetAnalystStoreForTests()
            await assertExactPageCount((input) => run(250, input), 'SELECT n, payload FROM objects ORDER BY n', 600, 250)
            resetAnalystStoreForTests()
            await assertExactPageCount((input) => run(250, input), 'SELECT n, payload FROM scalars ORDER BY n', 600, 250)
        } finally {
            resetAnalystStoreForTests()
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
            await admin.end().catch(() => {})
        }
    })

    it('keeps every postgres length bound at least as long as the handoff line', async (t) => {
        const admin = await postgresAdmin()
        if (!admin) {
            t.skip('analyst URL path: local postgres admin is not reachable')
            return
        }
        const seed = 20261013
        const rand = mulberry32(seed)
        const suffix = randomBytes(4).toString('hex')
        const dbName = `analyst_bounds_${suffix}`
        const role = `bounds_${suffix}`
        const password = randomBytes(18).toString('base64url')
        const jsonValues = [
            null,
            '1',
            '0',
            '-1',
            '1e+20',
            '-1e+20',
            '1e-20',
            '-1.7976931348623157e+308',
            'true',
            'false',
            '"hi"',
            '"😀"',
            '{"id":1}',
            '{"a":{"b":1}}',
            '[{"id": 1}, {"id": 2}]',
            '[1,2,3]',
            'null'
        ]
        const specs = [
            { key: 'smallint', ddl: 'smallint', values: [null, 0, 1, -1, 32767, -32768] },
            { key: 'integer', ddl: 'integer', values: [null, 0, 1, -1, 2147483647, -2147483648] },
            { key: 'bigint', ddl: 'bigint', values: [null, '0', '-1', '9223372036854775807', '-9223372036854775808'] },
            { key: 'boolean', ddl: 'boolean', values: [null, true, false] },
            {
                key: 'text',
                ddl: 'text',
                values: [null, '', 'x', ' '.repeat(20), 'x'.repeat(40), '😀'.repeat(6), '字'.repeat(8), 'a😀b字', 'line\nbreak']
            },
            {
                key: 'varchar',
                ddl: 'character varying(40)',
                values: [null, '', 'x', ' '.repeat(10), '😀'.repeat(4), '字', 'pad']
            },
            { key: 'character', ddl: 'character(200)', values: [null, '', 'x', 'hi', ' '.repeat(5)] },
            { key: 'character2500', ddl: 'character(2500)', values: [null, '', 'x', '😀'] },
            { key: 'character4000', ddl: 'character(4000)', values: [null, '', 'x', '😀'] },
            { key: 'name', ddl: 'name', values: [null, '', 'a', 'abc', 'a'.repeat(63), '字'] },
            { key: 'date', ddl: 'date', values: [null, '2026-10-13', '0001-01-01', '9999-12-31'] },
            {
                key: 'timestamp',
                ddl: 'timestamp',
                values: [null, '2026-10-13 00:00:00', '1970-01-01 00:00:00', '2026-10-13 23:59:59.999']
            },
            {
                key: 'timestamptz',
                ddl: 'timestamptz',
                values: [null, '2026-10-13 00:00:00+00', '1999-12-31 23:59:59-05', '1970-01-01 00:00:00+00']
            },
            { key: 'json', ddl: 'json', values: jsonValues },
            { key: 'jsonb', ddl: 'jsonb', values: jsonValues }
        ]
        const shuffles = specs.map((spec) => {
            const values = spec.values.slice()
            for (let i = values.length - 1; i > 0; i -= 1) {
                const j = Math.floor(rand() * (i + 1))
                ;[values[i], values[j]] = [values[j], values[i]]
            }
            return { ...spec, values }
        })
        try {
            await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
            await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`)
            const cfg = adminConfig()
            const url = postgresUrl({ user: role, password, host: cfg.host, port: cfg.port, database: dbName })
            const owner = new Client({ connectionString: url })
            await owner.connect()
            let boundRows = 0
            for (const spec of shuffles) {
                const table = `b_${spec.key}`
                await owner.query(`CREATE TABLE ${table} (n integer PRIMARY KEY, body ${spec.ddl})`)
                for (let i = 0; i < spec.values.length; i += 1) {
                    await owner.query(`INSERT INTO ${table} (n, body) VALUES ($1, $2::${spec.ddl})`, [i + 1, spec.values[i]])
                }
                const typed = await owner.query(`SELECT pg_typeof(n)::text AS n, pg_typeof(body)::text AS body FROM ${table} LIMIT 1`)
                const lengthSql = resultLengthSql(`SELECT n, body FROM ${table} ORDER BY n`, ['n', 'body'], 'postgres', typed.rows[0])
                if (spec.ddl.startsWith('character(') && Number(spec.ddl.slice('character('.length).replace(')', '')) >= 2500) {
                    assert.equal(lengthSql.includes('pg_column_size'), false, lengthSql)
                    assert.match(lengthSql, /octet_length\("body"\)/)
                    assert.equal(/octet_length\("body"\)::text/.test(lengthSql), false)
                }
                const measured = await owner.query(lengthSql)
                const got = await owner.query(`SELECT n, body FROM ${table} ORDER BY n`)
                assert.equal(measured.rows.length, got.rows.length)
                for (let i = 0; i < got.rows.length; i += 1) {
                    const line = analystHandoffLine(got.rows[i])
                    const bound = measured.rows[i].analyst_line_len
                    if (Array.isArray(got.rows[i].body)) {
                        assert.equal(bound, null, `${spec.key} array n=${got.rows[i].n}`)
                    } else {
                        assert.ok(bound != null, `${spec.key} n=${got.rows[i].n}`)
                        assert.ok(Number(bound) >= line.length, `${spec.key} n=${got.rows[i].n} bound=${bound} js=${line.length}`)
                    }
                    boundRows += 1
                }
            }
            const wide = [
                {
                    table: 'wide_char',
                    ddl: 'character(200)',
                    total: 300,
                    cap: 100,
                    nullUntil: 100,
                    value: 'x',
                    expectCount: false
                },
                {
                    table: 'wide_char4000',
                    ddl: 'character(4000)',
                    total: 300,
                    cap: 100,
                    nullUntil: 100,
                    value: 'x',
                    expectCount: 'agree'
                },
                {
                    table: 'wide_json',
                    ddl: 'json',
                    total: 1050,
                    cap: 350,
                    nullUntil: 350,
                    value: '1e+20',
                    expectCount: false
                },
                {
                    table: 'wide_json_array',
                    ddl: 'jsonb',
                    total: 40,
                    cap: 10,
                    nullUntil: 0,
                    value: '[{"id":1},{"id":2}]',
                    expectCount: false
                },
                { table: 'page_text', ddl: 'text', total: 30, cap: 10, nullUntil: 0, value: 'abc', expectCount: true },
                { table: 'page_varchar', ddl: 'character varying(20)', total: 30, cap: 10, nullUntil: 0, value: 'abc', expectCount: true },
                { table: 'page_char', ddl: 'character(8)', total: 30, cap: 10, nullUntil: 0, value: 'x', expectCount: true },
                { table: 'page_name', ddl: 'name', total: 30, cap: 10, nullUntil: 0, value: 'abc', expectCount: true },
                { table: 'page_date', ddl: 'date', total: 30, cap: 10, nullUntil: 0, value: '2026-10-13', expectCount: true },
                {
                    table: 'page_timestamp',
                    ddl: 'timestamp',
                    total: 30,
                    cap: 10,
                    nullUntil: 0,
                    value: '2026-10-13 00:00:00',
                    expectCount: true
                },
                {
                    table: 'page_timestamptz',
                    ddl: 'timestamptz',
                    total: 30,
                    cap: 10,
                    nullUntil: 0,
                    value: '2026-10-13 00:00:00+00',
                    expectCount: true
                },
                { table: 'page_smallint', ddl: 'smallint', total: 30, cap: 10, nullUntil: 0, value: 1, expectCount: true },
                { table: 'page_integer', ddl: 'integer', total: 30, cap: 10, nullUntil: 0, value: 1, expectCount: true },
                { table: 'page_bigint', ddl: 'bigint', total: 30, cap: 10, nullUntil: 0, value: '1', expectCount: true },
                { table: 'page_boolean', ddl: 'boolean', total: 30, cap: 10, nullUntil: 0, value: true, expectCount: true },
                { table: 'page_json', ddl: 'json', total: 600, cap: 250, nullUntil: 0, value: '1', expectCount: true },
                { table: 'page_jsonb', ddl: 'jsonb', total: 600, cap: 250, nullUntil: 0, value: '{"id":1}', expectCount: true }
            ]
            for (const spec of wide) {
                await owner.query(`CREATE TABLE ${spec.table} (n integer PRIMARY KEY, body ${spec.ddl})`)
                for (let n = 1; n <= spec.total; n += 1) {
                    const value = spec.nullUntil && n <= spec.nullUntil ? null : n % 7 === 0 ? null : spec.value
                    await owner.query(`INSERT INTO ${spec.table} (n, body) VALUES ($1, $2::${spec.ddl})`, [n, value])
                }
            }
            const padded = await owner.query('SELECT n, body, pg_column_size(body) AS sz FROM wide_char4000 WHERE n = 101')
            const oldBound = padded.rows[0].sz <= 127 ? padded.rows[0].sz - 1 : padded.rows[0].sz - 4
            assert.ok(oldBound < analystHandoffLine({ n: padded.rows[0].n, body: padded.rows[0].body }).length)
            await owner.end()
            assert.equal(String(-Number.MAX_VALUE).length, 24)
            assert.equal(shuffles.length, 15)
            assert.equal(
                boundRows,
                shuffles.reduce((sum, spec) => sum + spec.values.length, 0)
            )
            const run = (cap, input) =>
                withAnalystScope(`bounds-${suffix}`, () => queryAnalystUrl(url, input, { env: { CUTTLELY_ANALYST_ROW_CAP: String(cap) } }))
            let named = 0
            for (const spec of wide) {
                for (const sql of [
                    `SELECT n, body FROM ${spec.table} ORDER BY n`,
                    `SELECT n, body FROM ${spec.table} ORDER BY n LIMIT 100000`
                ]) {
                    resetAnalystStoreForTests()
                    if (spec.expectCount === true) {
                        await assertNamedCountMatchesWalk((input) => run(spec.cap, input), sql)
                        named += 1
                    } else if (spec.expectCount === 'agree') {
                        await assertCountAgreesWithShowMore((input) => run(spec.cap, input), sql, spec.total)
                    } else {
                        await assertNoPageCountAndNoSkips((input) => run(spec.cap, input), sql, spec.total, spec.cap)
                    }
                }
            }
            assert.equal(named, wide.filter((spec) => spec.expectCount === true).length * 2)
            assert.equal(wide.filter((spec) => spec.expectCount === false).length, 3)
        } finally {
            resetAnalystStoreForTests()
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
            await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
            await admin.end().catch(() => {})
        }
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
