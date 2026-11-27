import { runsInProgress, setStorageJobsStopped } from '../settings/runs'
import { applicationStorageDependencies } from '../settings/storageDependencies'
import fs from 'fs'
import { SettingsError } from '../settings/service'
import type { NextFunction, Request, Response } from 'express'
import path from 'path'
import { pathToFileURL } from 'url'
import { DataSource, QueryRunner } from 'typeorm'
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver'

// The server build targets CommonJS, and tsc rewrites import() into require().
// require() cannot load the ESM harness package, so keep a real dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

type Log = { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }
export type AppStoreSource = {
    dialect: string
    session: () => Promise<{
        execute: (
            sql: string,
            params?: unknown[]
        ) => Promise<{ rows: any[]; fields: { name: string; dataTypeID: number }[]; affected: number }>
        onLost: (listener: () => void) => void
        release: (error?: Error) => void
    }>
    query: (sql: string, params?: unknown[]) => Promise<any[]>
    transaction: <T>(work: (tx: { query: (sql: string, params?: unknown[]) => Promise<any[]> }) => Promise<T>) => Promise<T>
}

async function rows(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<any[]> {
    const result = await runner.query(sql, params as any[], true)
    return result.records || []
}

// Harness stores that follow the application database (#516) use the app's own pool and SSL settings.
export function makeAppStoreSource(dataSource: DataSource): AppStoreSource {
    const dialect = String(dataSource.options?.type || process.env.DATABASE_TYPE || 'sqlite')
        .trim()
        .toLowerCase()
    return {
        dialect,
        async session() {
            if (dialect !== 'postgres') throw new Error('ETL sessions require PostgreSQL.')
            const driver = dataSource.driver as PostgresDriver
            const [client, release] = await driver.obtainMasterConnection()
            let lost: Error | undefined
            let notify: (() => void) | undefined
            const onError = (error: Error) => {
                lost = error
                notify?.()
            }
            client.on('error', onError)
            return {
                onLost: (listener) => {
                    notify = listener
                    if (lost) listener()
                },
                async execute(sql, params = []) {
                    const result = await client.query(sql, params)
                    return { rows: result.rows, fields: result.fields, affected: result.rowCount ?? 0 }
                },
                release: (error) => {
                    client.removeListener('error', onError)
                    release(error || lost)
                }
            }
        },
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

export async function loadStoreModule(pkg: string, file: string) {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', pkg, file), path.join(dir, pkg, file)]
        const candidate = candidates.find((item) => fs.existsSync(item))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error('Storage module could not be loaded.')
}

// Runs in initDatabase, before the server listens and before the Dash Flows scheduler starts.
// PostgreSQL members check durable upgrade state before selecting their side stores.
export async function registerAppStoreSource<FileStore = unknown>(
    dataSource: DataSource,
    log: Log,
    loadModule = loadStoreModule,
    options: {
        versionHistory?: {
            inspect(): Promise<{ head: string; bytes: number } | null>
            copy(source: AppStoreSource, expected: string | null): Promise<void>
            select(source: AppStoreSource | null): Promise<void>
        }
        pausePredictions?: (paused: boolean) => void
        worker?: boolean
        newPostgresApplication?: boolean
        fileRoots?: { blobs: string; uploads: string }
        selectFiles?: (store: FileStore | null) => void
    } = {}
): Promise<unknown> {
    const source = makeAppStoreSource(dataSource)
    if (source.dialect === 'postgres') {
        try {
            const { startStorageUpgrade } = await loadModule('etl', 'storage-upgrade.mjs')
            coordinator = await startStorageUpgrade({
                source,
                log,
                ...options,
                onJobsStopped: (stopped: boolean) => {
                    setStorageJobsStopped(stopped)
                    options.pausePredictions?.(stopped)
                },
                inspectDependencies: (etl: Parameters<typeof applicationStorageDependencies>[1]) =>
                    applicationStorageDependencies((sql) => source.query(sql), etl)
            })
            return
        } catch (error) {
            if (error instanceof Error && (error as Error & { status?: number }).status === 409)
                throw Object.assign(error, { code: 'STORAGE_START_FAILED' })
            throw Object.assign(new Error('Storage selection failed. Restore PostgreSQL connectivity and restart.'), {
                code: 'STORAGE_START_FAILED'
            })
        }
    }
    try {
        const { initDashStore } = await loadModule('harness', 'dashflows-postgres.mjs')
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

type CoordinatorFailure = { code: string; message: string }
type Coordinator = {
    jobsPaused: () => boolean
    paused: () => boolean
    failure: () => CoordinatorFailure | null
    progress: () => { activity: { action: string; message: string; startedAt: number } | null; failure: CoordinatorFailure | null }
    status: () => Promise<unknown>
    close: () => Promise<void>
    transition: (
        action: string,
        options: { availableBytes?: number; confirm?: string; drain: () => void; jobsBusy: () => boolean }
    ) => Promise<unknown>
}
let coordinator: Coordinator | undefined
let admitted = 0

export const storageCoordinatorFailure = () => coordinator?.failure()

export function sideStoreAdmission(req: Request, res: Response, next: NextFunction) {
    const failure = storageCoordinatorFailure()
    if (req.method === 'GET' && req.path === '/api/v1/ping/storage-upgrade')
        return res.json({ paused: coordinator?.paused() || false, ...(failure && { reason: failure.code }) })
    if (req.method === 'GET' && req.path === '/api/v1/server-settings') return next()
    if (
        !coordinator ||
        !req.path.startsWith('/api/') ||
        /^\/api\/v1\/(?:server-settings\/storage(?:\/|$)|auth(?:\/|$)|ping(?:\/|$))/.test(req.path)
    )
        return next()
    if (!failure && coordinator.jobsPaused() && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return res.status(503).json({ code: 'jobs_paused', message: 'Jobs are paused for the storage upgrade.' })
    }
    if (failure || coordinator.paused()) {
        res.setHeader('Retry-After', '30')
        return res.status(503).json(failure || { code: 'store_moving', message: 'Storage upgrade in progress. Try again in 30 seconds.' })
    }
    admitted++
    res.once('close', () => {
        admitted--
    })
    next()
}

export const storageProgress = () => coordinator?.progress() || { activity: null, failure: null }
export const storageStatus = () => coordinator?.status() || { available: false }
export async function changeSideStores(
    action: 'upgrade' | 'rollback' | 'stop-jobs' | 'check-stop' | 'resume-jobs',
    body: { availableBytes?: number; confirm?: string } = {}
) {
    if (!coordinator) throw new SettingsError(409, 'STORAGE_UPGRADE', 'Storage upgrades require a PostgreSQL application database.')
    try {
        return await coordinator.transition(action, {
            availableBytes: body?.availableBytes,
            confirm: body?.confirm,
            jobsBusy: () => admitted > 0 || runsInProgress() > 0,
            drain: () => {
                if (admitted) throw Object.assign(new Error('Wait for current application requests to finish and retry.'), { status: 409 })
            }
        })
    } catch (error) {
        const failure = storageCoordinatorFailure()
        if (failure) throw new SettingsError(503, failure.code, failure.message)
        if (error instanceof Error && (error as Error & { status?: number }).status === 409)
            throw new SettingsError(409, 'STORAGE_UPGRADE', error.message)
        throw new SettingsError(
            503,
            'STORAGE_UPGRADE',
            'The storage operation could not finish. Check the database connection, schema and backup disk, then resume from Server Settings.'
        )
    }
}
export async function closeSideStores() {
    await coordinator?.close()
    coordinator = undefined
}
