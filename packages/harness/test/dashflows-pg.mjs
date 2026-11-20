// Disposable Postgres for the Dash Flows store tests. Local runs skip without a test password;
// CI sets CUTTLELY_TEST_PG_REQUIRED=1 so a missing service fails instead of skipping.
import { randomBytes } from 'node:crypto'
import pg from 'pg'

export const pgRequired = process.env.CUTTLELY_TEST_PG_REQUIRED === '1'
const password = () => process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
// false when the Postgres tests run; otherwise the skip reason.
export const pgSkip = password() || pgRequired ? false : 'no disposable Postgres (set PGPASSWORD, or CUTTLELY_TEST_PG_REQUIRED=1 in CI)'

export function adminConfig(database = 'postgres', overrides = {}) {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: password(),
        database,
        connectionTimeoutMillis: 3000,
        ...overrides
    }
}

// The same { dialect, query, transaction } shape the server builds from its DataSource.
export function poolSource(config) {
    const pool = new pg.Pool({ ...config, max: 20 })
    const calls = { query: 0, transaction: 0 }
    const source = {
        dialect: 'postgres',
        calls,
        async query(sql, params = []) {
            calls.query++
            return (await pool.query(sql, params)).rows
        },
        async transaction(work) {
            calls.transaction++
            const client = await pool.connect()
            try {
                await client.query('BEGIN')
                const result = await work({ query: async (sql, params = []) => (await client.query(sql, params)).rows })
                await client.query('COMMIT')
                return result
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {})
                throw error
            } finally {
                client.release()
            }
        }
    }
    return { source, end: () => pool.end() }
}

async function admin(sql) {
    const client = new pg.Client(adminConfig())
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

export async function freshDatabase(prefix) {
    const name = `${prefix}_${randomBytes(4).toString('hex')}`
    await admin(`CREATE DATABASE ${name}`)
    return { name, config: adminConfig(name), drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) }
}

export { admin as adminQuery }
