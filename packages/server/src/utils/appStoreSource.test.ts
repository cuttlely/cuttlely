import { changeSideStores, closeSideStores, makeAppStoreSource, registerAppStoreSource, sideStoreAdmission } from './appStoreSource'

function fakeDataSource(fail = false) {
    const runners: any[] = []
    const dataSource = {
        createQueryRunner: jest.fn(() => {
            const runner = {
                isTransactionActive: false,
                connect: jest.fn(async () => undefined),
                startTransaction: jest.fn(async () => {
                    runner.isTransactionActive = true
                }),
                commitTransaction: jest.fn(async () => {
                    runner.isTransactionActive = false
                }),
                rollbackTransaction: jest.fn(async () => {
                    runner.isTransactionActive = false
                }),
                release: jest.fn(async () => undefined),
                query: jest.fn(async (sql: string, _params: unknown[], structured: boolean) => {
                    if (fail && sql.startsWith('INSERT')) throw new Error('write failed')
                    return structured ? { records: [{ sql }] } : [[{ sql }], 1]
                })
            }
            runners.push(runner)
            return runner
        })
    }
    return { dataSource: dataSource as any, runners }
}

const previousType = process.env.DATABASE_TYPE
afterEach(() => {
    if (previousType === undefined) delete process.env.DATABASE_TYPE
    else process.env.DATABASE_TYPE = previousType
})

it('reads rows through the app pool and releases every runner', async () => {
    process.env.DATABASE_TYPE = ' Postgres '
    const { dataSource, runners } = fakeDataSource()
    const source = makeAppStoreSource(dataSource)
    expect(source.dialect).toBe('postgres')
    expect(await source.query('UPDATE t SET a=$1 RETURNING id', [1])).toEqual([{ sql: 'UPDATE t SET a=$1 RETURNING id' }])
    expect(runners[0].query).toHaveBeenCalledWith('UPDATE t SET a=$1 RETURNING id', [1], true)
    expect(runners[0].release).toHaveBeenCalled()
})

it('commits a transaction on one connection, and rolls it back on an error', async () => {
    process.env.DATABASE_TYPE = 'postgres'
    const ok = fakeDataSource()
    const result = await makeAppStoreSource(ok.dataSource).transaction(async (tx) => {
        await tx.query('SELECT 1')
        return (await tx.query('SELECT 2'))[0]
    })
    expect(result).toEqual({ sql: 'SELECT 2' })
    expect(ok.runners).toHaveLength(1)
    expect(ok.runners[0].commitTransaction).toHaveBeenCalled()
    expect(ok.runners[0].release).toHaveBeenCalled()
    const failing = fakeDataSource(true)
    await expect(makeAppStoreSource(failing.dataSource).transaction((tx) => tx.query('INSERT INTO t VALUES (1)'))).rejects.toThrow(
        'write failed'
    )
    expect(failing.runners[0].rollbackTransaction).toHaveBeenCalled()
    expect(failing.runners[0].commitTransaction).not.toHaveBeenCalled()
    expect(failing.runners[0].release).toHaveBeenCalled()
})

it('hands the harness the app database dialect and a logger, and never fails the start', async () => {
    process.env.DATABASE_TYPE = 'mysql'
    const { dataSource } = fakeDataSource()
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const initDashStore = jest.fn(async (options: any) => ({ backend: 'sqlite', dialect: options.source.dialect, log: options.log }))
    expect(await registerAppStoreSource(dataSource, log, async () => ({ initDashStore }))).toEqual({
        backend: 'sqlite',
        dialect: 'mysql',
        log
    })
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled()
    const failed = await registerAppStoreSource(dataSource, log, async () => {
        throw Object.assign(new Error('connection detail that must not be logged'), { code: 'ENOENT' })
    })
    expect(failed).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
        'Dash Flows storage check failed (ENOENT). Dash Flows serves dashflows.sqlite if it is present; while only dashflows.sqlite.migrated is present, its requests answer 503.'
    )
})

it('distinguishes coordinator loss from storage maintenance in API responses', async () => {
    process.env.DATABASE_TYPE = 'postgres'
    const { dataSource } = fakeDataSource()
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const failure = { code: 'coordinator_connection_lost', message: 'The storage coordinator lost its PostgreSQL connection.' }
    const coordinator = {
        jobsPaused: jest.fn(() => false),
        paused: jest.fn(() => false),
        failure: jest.fn<null | typeof failure, []>(() => null),
        close: jest.fn(),
        transition: jest.fn().mockRejectedValue(new Error('restart required'))
    }
    const request = (path: string, method = 'GET') => {
        const response = {
            status: jest.fn().mockReturnThis(),
            setHeader: jest.fn(),
            json: jest.fn()
        }
        const next = jest.fn()
        sideStoreAdmission({ method, path } as any, response as any, next)
        return response
    }
    try {
        await registerAppStoreSource(dataSource, log, async () => ({ startStorageUpgrade: async () => coordinator }))
        coordinator.paused.mockReturnValue(true)
        expect(request('/api/v1/ping/storage-upgrade').json).toHaveBeenCalledWith({ paused: true })
        expect(request('/api/v1/chatflows').json).toHaveBeenCalledWith(expect.objectContaining({ code: 'store_moving' }))

        coordinator.paused.mockReturnValue(false)
        coordinator.jobsPaused.mockReturnValue(true)
        expect(request('/api/v1/chatflows', 'POST').json).toHaveBeenCalledWith(expect.objectContaining({ code: 'jobs_paused' }))

        coordinator.failure.mockReturnValue(failure)
        expect(request('/api/v1/ping/storage-upgrade').json).toHaveBeenCalledWith({ paused: false, reason: failure.code })
        for (const method of ['GET', 'POST']) {
            const ordinary = request('/api/v1/chatflows', method)
            expect(ordinary.status).toHaveBeenCalledWith(503)
            expect(ordinary.setHeader).toHaveBeenCalledWith('Retry-After', '30')
            expect(ordinary.json).toHaveBeenCalledWith(failure)
        }
        await expect(changeSideStores('upgrade')).rejects.toMatchObject({ status: 503, code: failure.code })
    } finally {
        await closeSideStores()
    }
})
