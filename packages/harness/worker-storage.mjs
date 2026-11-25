// Standalone workers register with the same migration lock as web instances.
import { createRequire } from 'node:module'
import { harnessPgConfig } from './side-store-identity.mjs'
import { startStorageUpgrade } from '../etl/storage-upgrade.mjs'

export async function startWorkerStorage() {
    if (process.env.DATABASE_TYPE?.toLowerCase() !== 'postgres') return
    const { Pool } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
    const config = harnessPgConfig()
    const pool = new Pool(config)
    pool.on('error', () => {})
    const session = async () => {
        const c = await pool.connect()
        let failed
        let notify
        const onError = (error) => {
            failed = error
            notify?.()
        }
        c.on('error', onError)
        return {
            execute: async (sql, params = []) => {
                const r = await c.query(sql, params)
                return { rows: r.rows, fields: r.fields, affected: r.rowCount }
            },
            onLost: (fn) => {
                notify = fn
                if (failed) fn()
            },
            release: (err) => {
                c.off('error', onError)
                c.release(err || failed)
            }
        }
    }
    const source = {
        dialect: 'postgres',
        session,
        query: async (sql, args) => (await pool.query(sql, args)).rows,
        transaction: async (work) => {
            const c = await session()
            try {
                await c.execute('BEGIN')
                const v = await work({ query: async (sql, args) => (await c.execute(sql, args)).rows })
                await c.execute('COMMIT')
                return v
            } finally {
                c.release(true)
            }
        }
    }
    let member
    try {
        member = await startStorageUpgrade({ source, config, worker: true })
        if (member.paused()) throw new Error('Storage upgrade in progress. Restart this worker after it completes.')
        return async () => {
            await member.close()
            await pool.end()
        }
    } catch (error) {
        await member?.close()
        await pool.end()
        throw error
    }
}
