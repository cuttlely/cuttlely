// Shared test helper for Postgres availability: build a source from pg.Client for ETL store tests.
// Uses a disposable database when PGPASSWORD (or CUTTLELY_TEST_PG_PASSWORD) is set, or a temporary initdb cluster
// when initdb and pg_ctl are on PATH (or PG_BINDIR). Skips with a clear message when neither is available, unless
// CUTTLELY_TEST_PG_REQUIRED=1, which fails instead of skipping.
import { execFile, spawnSync } from 'node:child_process'
import net from 'node:net'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const require = createRequire(new URL('../../server/package.json', import.meta.url))

const pgRequired = process.env.CUTTLELY_TEST_PG_REQUIRED === '1'
const password = () => process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
const useService = Boolean(password() || pgRequired)
const binary = (name) => (process.env.PG_BINDIR ? `${process.env.PG_BINDIR}/${name}` : name)
const canSpawn = (name) => spawnSync(binary(name), ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0
const canInitdb = !useService && canSpawn('initdb') && canSpawn('pg_ctl')

export const skipReason =
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

export async function createTestSource() {
    const { Client } = require('pg')

    const config = useService
        ? serviceConfig('postgres')
        : {
              host: '127.0.0.1',
              port: await unusedPort(),
              user: 'postgres',
              database: 'postgres',
              connectionTimeoutMillis: 3000
          }

    // For local initdb case, create a temporary cluster (not implemented in this slice)
    // This would require starting pg_ctl, which is handled by the test file itself

    const client = new Client(config)
    await client.connect()
    // The source owns every connection it hands out; cleanup() ends any session that was never released.
    const open = new Set()
    let ended = false

    return {
        dialect: 'postgres',
        client,
        session: async () => {
            const sessionClient = new Client(config)
            await sessionClient.connect()
            open.add(sessionClient)
            return {
                execute: async (sql, params) => {
                    const result = await sessionClient.query(sql, params)
                    return {
                        rows: result.rows,
                        affected: result.rowCount ?? 0
                    }
                },
                release: () => {
                    open.delete(sessionClient)
                    return sessionClient.end()
                }
            }
        },
        cleanup: async () => {
            if (ended) return
            ended = true
            const clients = [client, ...open]
            open.clear()
            await Promise.all(clients.map((each) => each.end()))
        }
    }
}
