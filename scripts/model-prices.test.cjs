// Model price overrides and estimated usage cost. Jest mocks typeorm, so this uses node:test and sqlite.
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { after, describe, it } = require('node:test')

const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const { DataSource } = serverRequire('typeorm')
const { AddModelPriceOverride1792000000000: SqlitePrice } = serverRequire(
    './src/database/migrations/sqlite/1792000000000-AddModelPriceOverride.ts'
)
const { AddTokenUsageDay1791900000000: SqliteUsage } = serverRequire('./src/database/migrations/sqlite/1791900000000-AddTokenUsageDay.ts')
const { AddModelPriceOverride1792000000000: PostgresPrice } = serverRequire(
    './src/database/migrations/postgres/1792000000000-AddModelPriceOverride.ts'
)
const { deleteOverride, loadOverrides, priceBook, priceBookForWorkspace, queryTokenUsage, recordCompletedRun, writeOverride } =
    serverRequire('./src/services/usage/index.ts')

const PG_PASSWORD = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
const dirs = []

after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const modelList = {
    chat: [{ models: [{ name: 'gpt-4.1-mini', input_cost: 0.0000004, output_cost: 0.0000016 }] }],
    llm: [],
    embedding: []
}

const oneRun = {
    text: 'Two croissants are $8.',
    harnessPayload: {
        trace: {
            route: { model: 'gpt-4.1-mini', tokens: { prompt: 1000, completion: 500 } },
            specialists: [],
            handoff: { status: 'skipped', tokens: null }
        }
    }
}

async function openSqlite(migrations) {
    const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-prices-'))
    dirs.push(dir)
    const dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(dir, 'database.sqlite'),
        synchronize: false,
        migrations
    })
    await dataSource.initialize()
    await dataSource.runMigrations()
    return dataSource
}

describe('model price overrides', () => {
    it('stores an override, lets it win, and clears it back to the default', async () => {
        const dataSource = await openSqlite([SqlitePrice])
        try {
            await dataSource.query(`CREATE TABLE workspace (id varchar(36), organizationId varchar(36))`)
            await dataSource.query(`INSERT INTO workspace (id, organizationId) VALUES ('ws-a', 'org-a'), ('ws-b', 'org-b')`)
            await writeOverride(dataSource, 'org-a', 'gpt-4.1-mini', 1, 2)
            await writeOverride(dataSource, 'org-a', 'gpt-4.1-mini', 3, 4)
            const saved = await loadOverrides(dataSource, 'org-a')
            assert.equal(saved.size, 1)
            assert.deepEqual(saved.get('gpt-4.1-mini'), { inputUsdPerMillion: 3, outputUsdPerMillion: 4 })

            const priced = await priceBookForWorkspace(dataSource, 'ws-a', modelList)
            const other = await priceBookForWorkspace(dataSource, 'ws-b', modelList)
            assert.deepEqual(priced.rateFor('gpt-4.1-mini'), { inputUsdPerMillion: 3, outputUsdPerMillion: 4 })
            assert.deepEqual(other.rateFor('gpt-4.1-mini'), { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 })
            assert.equal(other.rateFor('custom-bakery'), null)

            await deleteOverride(dataSource, 'org-a', 'gpt-4.1-mini')
            const cleared = await priceBookForWorkspace(dataSource, 'ws-a', modelList)
            assert.deepEqual(cleared.rateFor('gpt-4.1-mini'), { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 })
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
        }
    })

    it('estimates usage cost for one workspace and leaves the other workspace out', async () => {
        const dataSource = await openSqlite([SqliteUsage, SqlitePrice])
        try {
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-bakery',
                result: oneRun,
                at: new Date('2026-10-12T12:00:00.000Z')
            })
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-bakery',
                result: {
                    agentFlowExecutedData: [
                        {
                            data: {
                                input: { llmModelConfig: { modelName: 'custom-bakery' } },
                                output: { usageMetadata: { input_tokens: 10, output_tokens: 4 } }
                            }
                        }
                    ]
                },
                at: new Date('2026-10-12T13:00:00.000Z')
            })
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-b',
                flowId: 'flow-bakery',
                result: oneRun,
                at: new Date('2026-10-12T12:00:00.000Z')
            })
            const book = priceBook(new Map([['gpt-4.1-mini', { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 }]]), new Map())
            const report = await queryTokenUsage(dataSource, { workspaceId: 'ws-a', startDate: '2026-10-12', endDate: '2026-10-12' }, book)
            // 1000 * 0.40 / 1_000_000 + 500 * 1.60 / 1_000_000 = 0.0012. custom-bakery is not added as zero.
            assert.equal(report.estimates, true)
            assert.equal(report.totals.inputTokens, 1010)
            assert.equal(report.totals.outputTokens, 504)
            assert.equal(report.totals.estimatedCostUsd, 0.0012)
            assert.equal(report.totals.price, 'partial')
            assert.deepEqual(report.totals.unpricedModels, ['custom-bakery'])
            const custom = report.models.find((row) => row.model === 'custom-bakery')
            assert.equal(custom.estimatedCostUsd, null)
            assert.equal(custom.price, 'no price')
            assert.equal(report.days[0].estimatedCostUsd, 0.0012)
            assert.equal(report.days[0].price, 'partial')
            assert.equal(report.flows[0].price, 'partial')

            const other = await queryTokenUsage(dataSource, { workspaceId: 'ws-b', startDate: '2026-10-12', endDate: '2026-10-12' }, book)
            assert.equal(other.totals.inputTokens, 1000)
            assert.equal(other.totals.outputTokens, 500)
            assert.equal(other.totals.estimatedCostUsd, 0.0012)
            assert.equal(other.totals.price, 'known')
            assert.deepEqual(other.totals.unpricedModels, [])
            assert.equal(
                other.days.reduce((sum, day) => sum + day.inputTokens, 0),
                1000
            )
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
        }
    })

    it('migrates postgres when a server is available', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres price migration: PGPASSWORD is unset')
            return
        }
        let pg
        try {
            pg = serverRequire('pg')
        } catch {
            t.skip('postgres price migration: pg is not installed')
            return
        }
        const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
        try {
            await admin.connect()
        } catch {
            t.skip('postgres price migration: the server is not reachable')
            return
        }
        const name = `cuttlely_prices_${process.pid}`
        await admin.query(`DROP DATABASE IF EXISTS ${name}`)
        await admin.query(`CREATE DATABASE ${name}`)
        await admin.end()
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            port: 5432,
            username: 'postgres',
            password: PG_PASSWORD,
            database: name,
            synchronize: false,
            migrations: [PostgresPrice]
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                ['AddModelPriceOverride1792000000000']
            )
            await writeOverride(dataSource, 'org-a', 'gpt-4.1-mini', 0.4, 1.6)
            const saved = await loadOverrides(dataSource, 'org-a')
            assert.deepEqual(saved.get('gpt-4.1-mini'), { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 })
            await deleteOverride(dataSource, 'org-a', 'gpt-4.1-mini')
            assert.equal((await loadOverrides(dataSource, 'org-a')).size, 0)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })
})
