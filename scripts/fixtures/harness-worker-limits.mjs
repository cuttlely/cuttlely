// Exercise the worker context with real saved settings; server imports stay in this scripts adapter.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../packages/server/package.json', import.meta.url))
require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
    }
})
const { writeSettingsFile } = require('./src/settings/store.ts')
const keys = ['CUTTLELY_HARNESS_MODEL_CALL_TIMEOUT_MS', 'CUTTLELY_HARNESS_TURN_BUDGET_MS', 'CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS']
const KEY = 'worker-limit-fixture-key'
const saved = Object.fromEntries(keys.map((key) => [key, '90000']))

if (process.argv[2] === 'worker-fixture') {
    // Run the production built-server loader with source settings modules and inert service dependencies.
    const built = fileURLToPath(new URL('../../packages/server/dist/', import.meta.url))
    const stubs = new Map(
        Object.entries({
            'NodesPool.js': {
                NodesPool: class {
                    componentNodes = { fixture: {} }
                    async initialize() {}
                }
            },
            'DataSource.js': { getDataSource: () => ({ isInitialized: true }) },
            'CachePool.js': { CachePool: class {} },
            'utils/index.js': { databaseEntities: {} },
            'utils/nestedFlowCall.js': {},
            'utils/telemetry.js': { Telemetry: class {} },
            'UsageCacheManager.js': { UsageCacheManager: { getInstance: async () => ({}) } },
            'utils/SSEStreamer.js': { SSEStreamer: class {} }
        }).map(([file, value]) => [path.join(built, file), value])
    )
    const originalLoad = Module._load
    Module._load = function (file, ...args) {
        if (stubs.has(file)) return stubs.get(file)
        if (file === 'dotenv') return { config: () => ({}) }
        if (file === path.join(built, 'settings/bootstrap.js')) return require('./src/settings/bootstrap.ts')
        if (file === path.join(built, 'settings/limits.js')) return require('./src/settings/limits.ts')
        return originalLoad.call(this, file, ...args)
    }
    const exists = fs.existsSync
    fs.existsSync = (file) => stubs.has(file) || exists(file)
    const { bootHarnessNodePool } = await import('../../packages/harness/node-pool.mjs')
    const { turnBudgetMs, modelCallTimeoutMs } = await import('../../packages/harness/budget.mjs')
    const { analystCallLimits } = await import('../../packages/harness/runtime/analyst-store.mjs')
    const pool = await bootHarnessNodePool()
    assert.equal(pool.ready, true)
    process.on('message', async () => {
        const before = keys.map((key) => process.env[key] ?? null)
        await pool.contextFor({ workspaceId: 'fixture' })
        process.send({
            before,
            values: [modelCallTimeoutMs(), turnBudgetMs(), analystCallLimits().timeoutMs],
            restart: process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
        })
    })
    process.send('ready')
}

export async function workerLimits(t, host) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-limits-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const env = {
        ...process.env,
        HOME: dir,
        DATABASE_PATH: dir,
        CUTTLELY_DATA_DIR: dir,
        CUTTLELY_HARNESS_QUEUE: 'external',
        CUTTLELY_SECRETKEY_OVERWRITE: KEY,
        CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '60000'
    }
    for (const key of [
        ...keys,
        'FLOWISE_SECRETKEY_OVERWRITE',
        'CUTTLELY_SETTINGS_HOST_LIMITS',
        'CUTTLELY_SETTINGS_HOST_KEYS',
        'CUTTLELY_SETTINGS_APPLIED',
        'CUTTLELY_IGNORE_ADMIN_SETTINGS',
        'CUTTLELY_HARNESS_OFFLINE_MODEL'
    ])
        delete env[key]
    if (host) for (const key of keys) env[key] = '60000'
    const worker = fork(fileURLToPath(import.meta.url), ['worker-fixture'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    t.after(() => worker.kill())
    let errors = ''
    worker.stderr.on('data', (data) => {
        errors += data
    })
    const message = () =>
        Promise.race([
            once(worker, 'message').then(([value]) => value),
            once(worker, 'exit').then(([code]) => {
                throw new Error(`worker exited ${code}: ${errors}`)
            })
        ])
    assert.equal(await message(), 'ready')
    const run = async () => {
        const next = message()
        worker.send('run')
        return next
    }
    const defaults = [120000, 45000, 15000]
    assert.deepEqual((await run()).values, host ? [60000, 60000, 60000] : defaults)
    writeSettingsFile(path.join(dir, 'settings'), { ...saved, CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '90000' }, { key: KEY })
    const updated = await run()
    assert.deepEqual(updated.before, host ? ['60000', '60000', '60000'] : [null, null, null])
    assert.deepEqual(updated.values, [90000, 90000, 90000])
    assert.equal(updated.restart, '60000')
    writeSettingsFile(path.join(dir, 'settings'), {}, { key: KEY })
    const cleared = await run()
    assert.deepEqual(cleared.before, ['90000', '90000', '90000'])
    assert.deepEqual(cleared.values, host ? [60000, 60000, 60000] : defaults)
    assert.equal(cleared.restart, '60000')
}
