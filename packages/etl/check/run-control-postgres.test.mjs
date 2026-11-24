// A test-only Postgres store for the real runner. This does not select a production ETL backend or migrate its schema.
// Uses a disposable database when PGPASSWORD (or CUTTLELY_TEST_PG_PASSWORD) is set, or a temporary initdb cluster
// when initdb and pg_ctl are on PATH (or PG_BINDIR). Skips with a clear message when neither is available, unless
// CUTTLELY_TEST_PG_REQUIRED=1, which fails instead of skipping.
// Run with Node 24 --experimental-test-module-mocks --test --test-concurrency=1.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { mock, test } from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const require = createRequire(new URL('../../server/package.json', import.meta.url))

const pgRequired = process.env.CUTTLELY_TEST_PG_REQUIRED === '1'
const password = () => process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
const useService = Boolean(password() || pgRequired)
const binary = (name) => (process.env.PG_BINDIR ? path.join(process.env.PG_BINDIR, name) : name)
const canSpawn = (name) => spawnSync(binary(name), ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0
const canInitdb = !useService && canSpawn('initdb') && canSpawn('pg_ctl')
const skipReason =
    useService || canInitdb
        ? false
        : 'no Postgres available (set PGPASSWORD for a test server, or install initdb/pg_ctl; CI sets CUTTLELY_TEST_PG_REQUIRED=1)'

async function unusedPort() {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    // Never connect to the neighboring fixture, even if that port happens to be free.
    return port === 55426 ? unusedPort() : port
}

function statements(client) {
    const query = (sql, params = []) => {
        let index = 0
        const text = sql.replace(/\?/g, () => `$${++index}`)
        assert.equal(index, params.length, 'The test adapter binds every placeholder.')
        return client.query(text, params)
    }
    return {
        all: async (sql, params) => (await query(sql, params)).rows,
        get: async (sql, params) => (await query(sql, params)).rows[0],
        // Return rowCount, not a fabricated changes value, to exercise the Postgres affected-row contract.
        run: query,
        exec: (sql) => client.query(sql)
    }
}

function serviceConfig(database) {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: password(),
        database,
        connectionTimeoutMillis: 3000,
        statement_timeout: 5000,
        lock_timeout: 2000
    }
}

test('run control: real Postgres READ COMMITTED races', { timeout: 90000, skip: skipReason }, async (t) => {
    const { Pool, Client } = require('pg')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-pg-races-'))
    process.env.HOME = path.join(root, 'home')
    process.env.DATABASE_PATH = path.join(root, 'database')
    process.env.CUTTLELY_DATA_DIR = path.join(root, 'data')
    process.env.ETL_CHECK = '1'
    for (const dir of ['home', 'database', 'data']) fs.mkdirSync(path.join(root, dir))

    let pool
    let writer
    let mocked
    let dropDatabase
    let stopCluster
    t.after(async () => {
        try {
            mocked?.restore()
            await writer?.end()
            await pool?.end()
            if (dropDatabase) await dropDatabase()
        } finally {
            // Only stop a cluster this test created; never stop a service discovered on an existing port.
            if (stopCluster) await stopCluster()
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    let connection
    if (useService) {
        const admin = new Client(serviceConfig('postgres'))
        try {
            await admin.connect()
        } catch (error) {
            await admin.end().catch(() => {})
            throw new Error(
                `Postgres was required but could not be reached at ${serviceConfig('postgres').host}:${serviceConfig('postgres').port}: ${
                    error.message
                }`
            )
        }
        const name = `etl_check_races_${randomBytes(4).toString('hex')}`
        await admin.query(`CREATE DATABASE ${name}`)
        await admin.end()
        dropDatabase = async () => {
            const closer = new Client(serviceConfig('postgres'))
            await closer.connect()
            try {
                await closer.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
            } finally {
                await closer.end()
            }
        }
        connection = serviceConfig(name)
    } else {
        const cluster = path.join(root, 'pg')
        const socket = path.join(root, 'socket')
        fs.mkdirSync(socket)
        const pgctl = (args) => exec(binary('pg_ctl'), ['-D', cluster, ...args], { timeout: 20000 })
        await exec(binary('initdb'), ['-D', cluster, '-U', 'etl_check', '--auth=trust', '--no-locale', '--encoding=UTF8'], {
            timeout: 20000
        })
        const port = await unusedPort()
        await pgctl([
            '-w',
            '-t',
            '15',
            '-l',
            path.join(root, 'postgres.log'),
            '-o',
            `-h 127.0.0.1 -p ${port} -k ${socket} -c max_connections=6 -c shared_buffers=16MB -c fsync=off -c full_page_writes=off`,
            'start'
        ])
        stopCluster = async () => {
            if (fs.existsSync(path.join(cluster, 'postmaster.pid'))) await pgctl(['-m', 'immediate', '-w', 'stop'])
        }
        connection = {
            host: '127.0.0.1',
            port,
            user: 'etl_check',
            password: '',
            database: 'postgres',
            connectionTimeoutMillis: 3000,
            statement_timeout: 5000,
            lock_timeout: 2000
        }
    }

    pool = new Pool({ ...connection, max: 2 })
    writer = new Client(connection)
    await writer.connect()

    const { BASE_SCHEMA } = await import('../db.mjs')
    // These cases stop before executeRun. Reuse just its run/event/pipeline columns, plus the migrated summary field.
    for (const name of ['pipelines', 'runs', 'run_events']) {
        const ddl = BASE_SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))?.[0]
        assert.ok(ddl, `The base schema defines ${name}.`)
        await pool.query(ddl.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'))
    }
    await pool.query('ALTER TABLE runs ADD COLUMN summary TEXT')

    const inTransaction = async (client, fn) => {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try {
            assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed')
            const value = await fn(statements(client))
            await client.query('COMMIT')
            return value
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }
    }
    // Keep SQLite's real pipeline lock, but replace SQL access only. Register before importing runner/runs or the cases.
    const sqliteStore = await import('../store.mjs')
    mocked = mock.module(new URL('../store.mjs', import.meta.url).href, {
        namedExports: {
            ...sqliteStore,
            ...statements(pool),
            tx: async (fn) => {
                const client = await pool.connect()
                try {
                    return await inTransaction(client, fn)
                } finally {
                    client.release()
                }
            }
        }
    })
    let checks = 0
    let externalCommits = 0
    const { checkRunControlRaces } = await import('./run-control-races.mjs')
    await checkRunControlRaces({
        check: (name, ok, detail) => {
            assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`)
            checks += 1
        },
        writeDuringRead: async (reader, write) => {
            const readerPid = (await reader.get('SELECT pg_backend_pid() AS pid')).pid
            const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
            assert.notEqual(readerPid, writerPid, 'The stop commits on a separate connection while the runner transaction is open.')
            await inTransaction(writer, write)
            externalCommits += 1
        }
    })
    assert.equal(
        externalCommits,
        15,
        'Six recovery stops, four launch stops and five run-control stops commit between the runner read and write.'
    )
    t.diagnostic(`${checks} shared checks passed with ${externalCommits} independent stop commits.`)
})
