// Daily token totals: migration, recording, aggregation, workspace isolation.
// Jest mocks typeorm, so this file uses node:test and the real driver.
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
const { AddTokenUsageDay1791900000000: SqliteMigration } = serverRequire(
    './src/database/migrations/sqlite/1791900000000-AddTokenUsageDay.ts'
)
const { AddTokenUsageDay1791900000000: PostgresMigration } = serverRequire(
    './src/database/migrations/postgres/1791900000000-AddTokenUsageDay.ts'
)
const { recordCompletedRun, queryTokenUsage } = serverRequire('./src/services/usage/index.ts')

const PG_PASSWORD = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
const dirs = []

after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const harnessRun = {
    text: 'Two croissants are $8.',
    harnessPayload: {
        trace: {
            route: { model: 'gpt-4.1-mini', tokens: { prompt: 20, completion: 8 } },
            specialists: [
                { model: 'gpt-4.1-mini', tokens: { prompt: 40, completion: 12 } },
                { model: 'claude', tokens: { prompt: 30, completion: 9 } }
            ],
            handoff: { status: 'done', model: 'gpt-4.1-mini', tokens: { prompt: 15, completion: 6 } }
        }
    }
}

const agentflowRun = {
    agentFlowExecutedData: [
        {
            data: {
                input: { llmModelConfig: { modelName: 'gpt-4.1-mini' } },
                output: { usageMetadata: { input_tokens: 11, output_tokens: 4 } }
            }
        }
    ]
}

async function openSqlite() {
    const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-usage-'))
    dirs.push(dir)
    const dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(dir, 'database.sqlite'),
        synchronize: false,
        migrations: [SqliteMigration]
    })
    await dataSource.initialize()
    return dataSource
}

describe('token usage storage', () => {
    it('migrates sqlite and aggregates runs by day, flow, and model', async () => {
        const dataSource = await openSqlite()
        try {
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                ['AddTokenUsageDay1791900000000']
            )
            const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_usage_day'`)
            assert.equal(tables.length, 1)
            assert.equal((await dataSource.runMigrations()).length, 0)

            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-bakery',
                result: harnessRun,
                at: new Date('2026-10-11T12:00:00.000Z')
            })
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-bakery',
                result: harnessRun,
                at: new Date('2026-10-12T01:00:00.000Z')
            })
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-orders',
                result: agentflowRun,
                at: new Date('2026-10-12T09:00:00.000Z')
            })
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-b',
                flowId: 'flow-bakery',
                result: harnessRun,
                at: new Date('2026-10-12T09:00:00.000Z')
            })

            const report = await queryTokenUsage(dataSource, {
                workspaceId: 'ws-a',
                startDate: '2026-10-11',
                endDate: '2026-10-12'
            })
            assert.deepEqual(report.days, [
                { day: '2026-10-11', inputTokens: 105, outputTokens: 35 },
                { day: '2026-10-12', inputTokens: 116, outputTokens: 39 }
            ])
            assert.deepEqual(report.flows, [
                { flowId: 'flow-bakery', inputTokens: 210, outputTokens: 70 },
                { flowId: 'flow-orders', inputTokens: 11, outputTokens: 4 }
            ])
            assert.deepEqual(report.models, [
                { model: 'claude', inputTokens: 60, outputTokens: 18 },
                { model: 'gpt-4.1-mini', inputTokens: 161, outputTokens: 56 }
            ])
            assert.deepEqual(report.totals, { inputTokens: 221, outputTokens: 74 })

            const oneModel = await queryTokenUsage(dataSource, {
                workspaceId: 'ws-a',
                startDate: '2026-10-11',
                endDate: '2026-10-12',
                flowId: 'flow-bakery',
                model: 'claude'
            })
            assert.deepEqual(oneModel.totals, { inputTokens: 60, outputTokens: 18 })
            assert.deepEqual(oneModel.flows, [{ flowId: 'flow-bakery', inputTokens: 60, outputTokens: 18 }])

            const otherWorkspace = await queryTokenUsage(dataSource, {
                workspaceId: 'ws-b',
                startDate: '2026-10-11',
                endDate: '2026-10-12'
            })
            assert.deepEqual(otherWorkspace.totals, { inputTokens: 105, outputTokens: 35 })
            assert.deepEqual(otherWorkspace.flows, [{ flowId: 'flow-bakery', inputTokens: 105, outputTokens: 35 }])
            assert.equal(
                otherWorkspace.days.reduce((sum, day) => sum + day.inputTokens, 0),
                105
            )
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
        }
    })

    it('still returns the run answer when the usage write fails', async () => {
        const errors = []
        const original = console.error
        console.error = (...args) => errors.push(args.map(String).join(' '))
        const failing = {
            options: { type: 'sqlite' },
            query: async () => {
                throw new Error('disk full')
            }
        }
        try {
            const finish = async () => {
                const answer = { text: 'Fresh bread at 7.' }
                const pending = recordCompletedRun(failing, {
                    workspaceId: 'ws-a',
                    flowId: 'flow-bakery',
                    result: harnessRun
                })
                return { answer, pending }
            }
            const { answer, pending } = await finish()
            assert.equal(answer.text, 'Fresh bread at 7.')
            await pending
            assert.equal(
                errors.some((line) => line.includes('token totals were not saved')),
                true
            )
            assert.equal(errors.join('\n').includes('disk full'), false)
        } finally {
            console.error = original
        }
    })

    it('migrates postgres when a server is available', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres usage migration: PGPASSWORD is unset')
            return
        }
        let pg
        try {
            pg = serverRequire('pg')
        } catch {
            t.skip('postgres usage migration: pg is not installed')
            return
        }
        const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
        try {
            await admin.connect()
        } catch {
            t.skip('postgres usage migration: the server is not reachable')
            return
        }
        const name = `cuttlely_usage_${process.pid}`
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
            migrations: [PostgresMigration]
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                ['AddTokenUsageDay1791900000000']
            )
            await recordCompletedRun(dataSource, {
                workspaceId: 'ws-a',
                flowId: 'flow-bakery',
                result: agentflowRun,
                at: new Date('2026-10-12T00:00:00.000Z')
            })
            const report = await queryTokenUsage(dataSource, {
                workspaceId: 'ws-a',
                startDate: '2026-10-12',
                endDate: '2026-10-12'
            })
            assert.deepEqual(report.totals, { inputTokens: 11, outputTokens: 4 })
            assert.deepEqual(report.days, [{ day: '2026-10-12', inputTokens: 11, outputTokens: 4 }])
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })
})
