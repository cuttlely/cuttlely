// Real profile compiler and keep-warm pass, with the server's boot and run admission latches.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-self-recovery-'))
Object.assign(process.env, {
    HOME: directory,
    DATABASE_PATH: directory,
    CUTTLELY_DATA_DIR: directory,
    CUTTLELY_HERMES_HOME: path.join(directory, 'hermes'),
    HERMES_HOME: path.join(directory, 'hermes'),
    LOG_PATH: directory,
    CUTTLELY_WARM_HERMES: 'true'
})
const require = createRequire(import.meta.url)

test('keep-warm recovers boot failures without a save and isolates a still-broken harness', async (t) => {
    const service = require('../packages/server/dist/services/harnesses')
    const { default: ping, composePing } = require('../packages/server/dist/controllers/ping')
    const { beginBootPass, finishBootPass, resetBootPass } = require('../packages/server/dist/services/harnesses/bootGate')
    const { setDatabaseHealth } = require('../packages/server/dist/startup/databaseHealth')
    const engine = await import('../packages/harness/run.mjs')
    const profile = await import('../packages/harness/profile.mjs')
    const store = await import('../packages/harness/store.mjs')
    const { harnessStoreDir, profileDir } = await import('../packages/harness/paths.mjs')
    t.after(() => {
        service.setHarnessModuleLoader(null)
        service.resetHarnessRuntimeForTests()
        resetBootPass()
        setDatabaseHealth(null)
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const record = (name) => ({
        name,
        chief: { model: { nodeName: 'fixtureChat', inputs: {} } },
        specialists: [{ name: 'worker', modules: [{ nodeName: 'fixtureTool', inputs: {} }] }]
    })
    fs.mkdirSync(harnessStoreDir(), { recursive: true })
    const write = (name, body) => fs.writeFileSync(path.join(harnessStoreDir(), `${name}.json`), JSON.stringify(body))
    write('boot-broken', { ...record('boot-broken'), chief: {} })
    write('still-broken', { ...record('still-broken'), chief: {} })
    write('healthy', record('healthy'))
    for (const name of ['boot-broken', 'still-broken']) fs.mkdirSync(profileDir(name), { recursive: true })
    fs.writeFileSync(path.join(harnessStoreDir(), 'unreadable.json'), '{')
    const gateway = { startGateway: async () => {}, holdGatewayHealth: () => () => {}, finishGatewayBoot() {} }
    service.setHarnessModuleLoader(async (file) => {
        if (file === 'run.mjs') return engine
        if (file === 'profile.mjs') return profile
        if (file === 'store.mjs') return store
        if (file === 'gateway.mjs') return gateway
        if (file === 'cleanup.mjs') return { sweepOrphanHarnessProfiles: async () => {} }
        throw new Error(`unexpected module ${file}`)
    })
    const serve = (name) =>
        engine.runHarness({
            name,
            input: 'Reply ready.',
            chatId: `recovery-${name}`,
            flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
            loadNode: async () =>
                class {
                    async init() {
                        return {
                            invoke: async (messages) => ({
                                content: String(messages[0]?.content).includes('You route work')
                                    ? JSON.stringify({ steps: [{ specialist: 'worker', task: 'Reply ready.' }] })
                                    : 'recovery ready'
                            })
                        }
                    }
                }
        })
    await service.default.warmHarnesses()
    assert.deepEqual(service.unavailableHarnessNames(), ['boot-broken', 'still-broken', 'unreadable'])
    for (const name of service.unavailableHarnessNames()) await assert.rejects(serve(name), { statusCode: 503 })
    await assert.doesNotReject(serve('healthy'))

    // Repair the underlying records directly: no save API, sync or process restart.
    write('boot-broken', record('boot-broken'))
    write('unreadable', record('unreadable'))
    // A pass for another harness must retry the unavailable names on this same tick.
    await service.default.warmHarnesses(['healthy'])
    assert.deepEqual(service.unavailableHarnessNames(), ['still-broken'])
    for (const name of ['boot-broken', 'unreadable', 'healthy']) await assert.doesNotReject(serve(name))
    await assert.rejects(serve('still-broken'), { statusCode: 503 })

    // A cap can latch an already-current profile; a cached compile must clear that refusal too.
    const gate = Promise.withResolvers()
    const finished = Promise.withResolvers()
    process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '0.03'
    service.setHarnessModuleLoader(async (file) => {
        if (file === 'profile.mjs')
            return {
                ...profile,
                recompileOutdatedProfiles: async (records) => {
                    await gate.promise
                    return profile.recompileOutdatedProfiles(records)
                },
                setAsideOutdatedConfigs: () => {
                    finished.resolve()
                    return []
                }
            }
        if (file === 'store.mjs') return { listHarnessNames: () => ['healthy'], getHarness: store.getHarness }
        throw new Error(`unexpected module ${file}`)
    })
    await service.recompileBeforeHermes(gateway)
    await assert.rejects(serve('healthy'), { statusCode: 503 })
    gate.resolve()
    await finished.promise
    delete process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS
    await assert.rejects(serve('healthy'), { statusCode: 503 })
    service.setHarnessModuleLoader(async (file) => {
        if (file === 'run.mjs') return engine
        throw new Error(`unexpected module ${file}`)
    })
    await service.default.warmHarnesses(['boot-broken'])
    await assert.doesNotReject(serve('healthy'))
    await assert.rejects(serve('still-broken'), { statusCode: 503 })

    const responseFor = async (handler) => {
        const res = {
            setHeader() {},
            status(code) {
                this.code = code
                return this
            },
            send(body) {
                this.body = body
                return this
            }
        }
        await handler({}, res, (error) => {
            throw error
        })
        return res
    }
    for (const [state, code] of [
        ['up', 200],
        ['restarting', 200],
        ['degraded', 200],
        ['down', 503],
        ['cooldown', 503],
        ['exhausted', 503]
    ]) {
        fs.writeFileSync(path.join(directory, 'hermes-supervisor.json'), JSON.stringify({ state, detail: 'private diagnostic omitted' }))
        const health = composePing(directory)
        assert.equal(health.code, code)
        assert.match(health.body, /unavailable harnesses: 1$/)
        if (['restarting', 'degraded'].includes(state)) assert.match(health.body, new RegExp(`hermes ${state}`))
        assert.doesNotMatch(health.body, /still-broken|private diagnostic|temporary|missing_model/)
        const strict = await responseFor(ping.getPing)
        assert.equal(strict.code, code)
        assert.equal(strict.body, health.body)
        const res = await responseFor(ping.getLive)
        assert.equal(res.code, 200)
        assert.equal(res.body, 'pong')
    }
    beginBootPass()
    assert.equal((await responseFor(ping.getPing)).code, 503)
    assert.match((await responseFor(ping.getPing)).body, /unavailable harnesses: 1$/)
    assert.equal((await responseFor(ping.getLive)).code, 503)
    assert.equal((await responseFor(ping.getLive)).body, 'boot recompile')
    process.env.CUTTLELY_STACK_RESTARTED = '1'
    assert.equal((await responseFor(ping.getLive)).code, 200)
    delete process.env.CUTTLELY_STACK_RESTARTED
    finishBootPass()
    setDatabaseHealth({ check: async () => ({ ok: false, reason: 'connection refused' }) })
    for (const handler of [ping.getPing, ping.getLive]) assert.equal((await responseFor(handler)).code, 503)
    assert.equal((await responseFor(ping.getLive)).body, 'database unreachable: connection refused')
    assert.match((await responseFor(ping.getPing)).body, /unavailable harnesses: 1$/)
})
