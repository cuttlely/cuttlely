import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { DataSource, QueryRunner } from 'typeorm'

// The server build targets CommonJS, and tsc rewrites import() into require().
// require() cannot load the ESM harness package, so keep a real dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

type Log = { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }
export type AppStoreSource = {
    dialect: string
    query: (sql: string, params?: unknown[]) => Promise<any[]>
    transaction: <T>(work: (tx: { query: (sql: string, params?: unknown[]) => Promise<any[]> }) => Promise<T>) => Promise<T>
}

async function rows(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<any[]> {
    const result = await runner.query(sql, params as any[], true)
    return result.records || []
}

// Harness stores that follow the application database (#516) use the app's own pool and SSL settings.
export function makeAppStoreSource(dataSource: DataSource): AppStoreSource {
    const dialect = String(process.env.DATABASE_TYPE || 'sqlite')
        .trim()
        .toLowerCase()
    return {
        dialect,
        async query(sql, params = []) {
            const runner = dataSource.createQueryRunner()
            try {
                return await rows(runner, sql, params)
            } finally {
                await runner.release()
            }
        },
        async transaction(work) {
            const runner = dataSource.createQueryRunner()
            await runner.connect()
            try {
                await runner.startTransaction()
                const result = await work({ query: (sql, params = []) => rows(runner, sql, params) })
                await runner.commitTransaction()
                return result
            } catch (error) {
                if (runner.isTransactionActive) await runner.rollbackTransaction()
                throw error
            } finally {
                await runner.release()
            }
        }
    }
}

async function loadDashStoreModule() {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [
            path.join(dir, 'packages', 'harness', 'dashflows-postgres.mjs'),
            path.join(dir, 'harness', 'dashflows-postgres.mjs')
        ]
        const candidate = candidates.find((item) => fs.existsSync(item))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error('Harness module dashflows-postgres.mjs was not found.')
}

// Runs in initDatabase, before the server listens and before the Dash Flows scheduler starts.
// With CUTTLELY_APP_DATABASE_STORES off and nothing moved, it changes nothing and never queries the database.
export async function registerAppStoreSource(dataSource: DataSource, log: Log, loadModule = loadDashStoreModule): Promise<unknown> {
    try {
        const { initDashStore } = await loadModule()
        return await initDashStore({ source: makeAppStoreSource(dataSource), log })
    } catch (error) {
        log.warn(
            `Dash Flows storage check failed (${
                (error as any)?.code || 'error'
            }). Dash Flows serves dashflows.sqlite if it is present; while only dashflows.sqlite.migrated is present, its requests answer 503.`
        )
        return undefined
    }
}
