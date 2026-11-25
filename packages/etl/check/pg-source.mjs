// Shared test helper for Postgres availability: build a source from pg.Client for ETL store tests.
// Uses a disposable database when PGPASSWORD (or CUTTLELY_TEST_PG_PASSWORD) is set, or a temporary initdb cluster
// when initdb and pg_ctl are on PATH (or PG_BINDIR). Skips with a clear message when neither is available, unless
// CUTTLELY_TEST_PG_REQUIRED=1, which fails instead of skipping.
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
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

export async function createTestDatabase() {
    const { Client } = require('pg')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-postgres-'))
    let dropDatabase
    let stopCluster
    async function cleanup() {
        try {
            if (dropDatabase) await dropDatabase()
            if (stopCluster) await stopCluster()
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    }
    try {
        let connection
        if (useService) {
            const admin = new Client(serviceConfig(process.env.CUTTLELY_TEST_PG_DATABASE || 'postgres'))
            try {
                await admin.connect()
            } catch (error) {
                await admin.end().catch(() => {})
                throw new Error(
                    `Postgres was required but could not be reached at ${
                        serviceConfig(process.env.CUTTLELY_TEST_PG_DATABASE || 'postgres').host
                    }:${serviceConfig(process.env.CUTTLELY_TEST_PG_DATABASE || 'postgres').port}: ${error.message}`
                )
            }
            const name = `etl_check_${randomBytes(4).toString('hex')}`
            try {
                await admin.query(`CREATE DATABASE ${name}`)
            } finally {
                await admin.end()
            }
            dropDatabase = async () => {
                const closer = new Client(serviceConfig(process.env.CUTTLELY_TEST_PG_DATABASE || 'postgres'))
                await closer.connect()
                try {
                    // Managed hosts briefly connect their own monitoring role. Stop new connections to this
                    // fixture and wait for existing ones to close without terminating another role's backend.
                    await closer.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`)
                    await closer.query('SET statement_timeout=20000')
                    await closer.query(`DROP DATABASE ${name}`)
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
            stopCluster = async () => {
                if (fs.existsSync(path.join(cluster, 'postmaster.pid'))) await pgctl(['-m', 'immediate', '-w', 'stop'])
            }
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
        return { connection, cleanup }
    } catch (error) {
        await cleanup()
        throw error
    }
}

export async function createTestSource() {
    const { Pool } = require('pg')
    const database = await createTestDatabase()
    const pool = new Pool({ ...database.connection, max: 4 })
    return {
        dialect: 'postgres',
        query: async (sql, params = []) => (await pool.query(sql, params)).rows,
        transaction: async (work) => {
            const client = await pool.connect()
            try {
                await client.query('BEGIN')
                const result = await work({ query: async (sql, params = []) => (await client.query(sql, params)).rows })
                await client.query('COMMIT')
                return result
            } finally {
                client.release(true)
            }
        },
        client: pool,
        connection: database.connection,
        session: async () => {
            const client = await pool.connect()
            return {
                execute: async (sql, params) => {
                    const result = await client.query(sql, params)
                    return { rows: result.rows, fields: result.fields, affected: result.rowCount ?? 0 }
                },
                release: (error) => client.release(error)
            }
        },
        cleanup: async () => {
            try {
                await pool.end()
            } finally {
                await database.cleanup()
            }
        }
    }
}
