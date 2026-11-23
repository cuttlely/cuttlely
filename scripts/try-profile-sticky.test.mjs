// Fake drafts and runtime hooks only; no Hermes boot or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-profile-sticky-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'hermes')
process.env.HERMES_HOME = process.env.CUTTLELY_HERMES_HOME
const profiles = path.join(process.env.HERMES_HOME, 'profiles')
const {
    compileProfile,
    compileTryProfile,
    discardTryProfile,
    readProfileEnv,
    removeTryProfileForFlow,
    tryIdForFlow,
    tryProfileName,
    tryRuntime,
    withTryProfile
} = await import('../packages/harness/profile.mjs')
const { bootHarnessGateway, sweepAbandonedTryProfiles, profileTokenKnown, stopGateway } = await import('../packages/harness/gateway.mjs')
const { noteLiveTry, tryLockIsLive } = await import('../packages/harness/try-live.mjs')
const { runHarness, runHooks } = await import('../packages/harness/run.mjs')
const { acquireTurn, releaseTurn, closeQueueDb } = await import('../packages/harness/lock.mjs')
const { closeSessions } = await import('../packages/harness/session.mjs')
after(async () => {
    await stopGateway()
    closeQueueDb()
    closeSessions()
    fs.rmSync(dir, { recursive: true, force: true })
})

const model = { nodeName: 'chatXAI', inputs: { modelName: 'fixture-model' } }
const draft = (chatflowId, revision = 'first') => ({
    name: 'fixture-team',
    chatflowId,
    chief: { model, instructions: `chief-${revision}` },
    specialists: [{ name: 'worker', model, instructions: `worker-${revision}`, shell: true, modules: [] }]
})
const homeFor = (flow) => tryProfileName(tryIdForFlow(flow))
const read = (name, file) => fs.readFileSync(path.join(profiles, name, file), 'utf8')
const immediate = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
    let resolve
    const promise = new Promise((done) => {
        resolve = done
    })
    return { promise, resolve }
}

// No live runtime is involved. Its close still sees deletion markers and all files before bridges stop.
tryRuntime.closeProfiles = async (names) => {
    for (const name of names) {
        assert.equal(read('.deleted', name), 'deleted\n')
        if (fs.existsSync(path.join(profiles, name))) assert.ok(fs.statSync(path.join(profiles, name)).isDirectory())
    }
}

test('N turns per flow retain one home and its specialists, replacing configuration in place', async () => {
    const flows = ['fixture-flow-a', 'fixture-flow-b', 'fixture-flow-c']
    const saved = compileProfile({ ...draft('published-flow'), name: 'published-fixture' })
    const published = read('published-fixture', 'config.yaml')
    const homesBefore = fs.readdirSync(profiles).filter((name) => /^try[a-f0-9]{16}$/.test(name))
    assert.equal(homesBefore.length, 0)
    for (const flow of flows) {
        const id = tryIdForFlow(flow)
        const home = homeFor(flow)
        assert.match(id, /^[a-f0-9]{16}$/)
        let inode
        let previousToken
        for (let turn = 0; turn < 5; turn += 1) {
            await withTryProfile(id, async (discard) => {
                noteLiveTry(home)
                const record = draft(flow, `turn-${turn}`)
                record.chief.model = { ...model, inputs: { modelName: `fixture-model-${turn}` } }
                if (turn) fs.appendFileSync(path.join(profiles, home, 'config.yaml'), 'stale_fixture: true\n')
                const compiled = compileTryProfile(record, id)
                assert.equal(compiled.dir, path.join(profiles, home))
                const state = path.join(profiles, home, 'state.db')
                if (!turn) fs.writeFileSync(state, 'fake state, never SQLite')
                inode ??= fs.statSync(state).ino
                assert.equal(fs.statSync(state).ino, inode, 'retained runtime files were replaced')
                assert.equal(read(home, 'config.yaml').includes('stale_fixture'), false)
                assert.ok(read(home, 'SOUL.md').includes(`chief-turn-${turn}`))
                assert.ok(read(`${home}--worker`, 'SOUL.md').includes(`worker-turn-${turn}`))
                assert.equal(JSON.parse(read(home, 'harness-roster.json')).chief.instructions, `chief-turn-${turn}`)
                assert.equal(fs.existsSync(path.join(profiles, '.deleted', home)), false)
                const token = readProfileEnv(`${home}--worker`).OPENAI_API_KEY
                assert.equal(profileTokenKnown(token), true)
                if (previousToken) assert.equal(profileTokenKnown(previousToken), false)
                await discard()
                previousToken = token
                assert.equal(profileTokenKnown(token), false)
                assert.equal(tryLockIsLive(home), false)
                for (const entry of [home, `${home}--worker`]) assert.ok(fs.statSync(path.join(profiles, entry)).isDirectory())
                assert.equal(read(home, 'harness-try-keep').trim(), home)
                assert.equal(fs.existsSync(path.join(profiles, home, 'try.lock')), false)
            })
        }
        await discardTryProfile(id)
    }
    const homes = fs.readdirSync(profiles).filter((name) => /^try[a-f0-9]{16}$/.test(name))
    assert.deepEqual(homes.sort(), flows.map(homeFor).sort())
    assert.equal(read('published-fixture', 'config.yaml'), published)
    assert.ok(fs.statSync(saved.dir).isDirectory())
    assert.equal(fs.existsSync(path.join(saved.dir, 'harness-try-keep')), false)
})

test('sweep retains sticky homes and children but removes old shells and abandoned temporary profiles', () => {
    const sticky = homeFor('fixture-flow-a')
    const old = 'try00001111'
    const abandoned = 'try00002222'
    const fresh = 'try00003333'
    for (const home of [old, fresh]) {
        fs.mkdirSync(path.join(profiles, home, 'logs'), { recursive: true })
        fs.writeFileSync(path.join(profiles, home, 'try.lock'), '{}')
    }
    const past = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(path.join(profiles, old), past, past)
    compileTryProfile(draft('temporary-flow'), abandoned.slice(3))
    const swept = sweepAbandonedTryProfiles()
    assert.equal(swept.has(sticky), false)
    assert.equal(swept.has(`${sticky}--worker`), false)
    assert.ok(fs.statSync(path.join(profiles, sticky)).isDirectory())
    assert.ok(fs.statSync(path.join(profiles, `${sticky}--worker`)).isDirectory())
    for (const name of [old, abandoned, `${abandoned}--worker`]) {
        assert.equal(swept.has(name), true)
        assert.equal(fs.existsSync(path.join(profiles, name)), false)
    }
    assert.equal(swept.has(fresh), false)
    assert.ok(fs.statSync(path.join(profiles, fresh)).isDirectory())
})

test('canvas and replay use the same id; waiting run and discard cannot close the first turn or release its chat lock', async () => {
    const flow = 'fixture-concurrent-flow'
    const id = tryIdForFlow(flow)
    const home = homeFor(flow)
    const entered = deferred()
    const finish = deferred()
    let compiles = 0
    let second
    let discard
    let closes = 0
    const oldClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async (names) => {
        closes += 1
        await oldClose(names)
    }
    runHooks.afterProfile = async (info) => {
        assert.equal(info.tryId, id)
        compiles += 1
        if (compiles === 1) {
            // Starting these inside the active hook must not inherit ownership of its teardown.
            second = assert.rejects(
                runHarness({ ...args, replay: true, record: { ...draft(flow, 'later'), tryId: 'abcdef01' } }),
                /fixture stops after compile/
            )
            discard = discardTryProfile(id)
            entered.resolve()
            await finish.promise
        }
        throw new Error('fixture stops after compile')
    }
    const record = { ...draft(flow), tryId: '12345678' }
    const args = {
        name: record.name,
        chatId: 'fixture-chat',
        input: 'fake question',
        record,
        flowOptions: { harnessCaller: { via: 'session' } }
    }
    const first = assert.rejects(runHarness(args), /fixture stops after compile/)
    await entered.promise
    try {
        await immediate()
        assert.equal(compiles, 1)
        assert.equal(closes, 0)
        assert.ok(tryLockIsLive(home))
        assert.throws(() => acquireTurn(record.name, args.chatId), { code: 'busy' })
        assert.ok(read(home, 'SOUL.md').includes('chief-first'))
        finish.resolve()
        await Promise.all([first, second, discard])
        assert.equal(compiles, 2)
        assert.equal(closes, 3)
        assert.ok(read(home, 'SOUL.md').includes('chief-later'))
        assert.equal(record.tryId, '12345678', 'the caller draft was mutated')
        assert.equal(tryLockIsLive(home), false)
        const lock = acquireTurn(record.name, args.chatId)
        releaseTurn(lock)
    } finally {
        finish.resolve()
        runHooks.afterProfile = null
        tryRuntime.closeProfiles = oldClose
    }
})

test('flow deletion waits for the active turn, then removes only that flow and its specialist workspaces', async () => {
    const flow = 'fixture-flow-b'
    const home = homeFor(flow)
    const entered = deferred()
    const finish = deferred()
    const turn = withTryProfile(tryIdForFlow(flow), async (discard) => {
        noteLiveTry(home)
        entered.resolve()
        await finish.promise
        await discard()
    })
    await entered.promise
    const deletion = removeTryProfileForFlow(flow)
    await immediate()
    assert.ok(tryLockIsLive(home))
    assert.ok(fs.existsSync(path.join(profiles, home)))
    finish.resolve()
    await Promise.all([turn, deletion])
    for (const entry of [home, `${home}--worker`]) {
        assert.equal(fs.existsSync(path.join(profiles, entry)), false)
        assert.equal(fs.existsSync(path.join(dir, 'workspaces', entry)), false)
    }
    assert.ok(fs.existsSync(path.join(profiles, homeFor('fixture-flow-a'))))
    assert.ok(fs.existsSync(path.join(profiles, 'published-fixture')))
    await removeTryProfileForFlow(flow)
})

test('workers in separate processes wait for ownership and recover a dead owner', { timeout: 10000 }, async () => {
    const fixture = path.join(dir, 'mutex-worker.mjs')
    fs.writeFileSync(
        fixture,
        `
        import { withTryProfile } from ${JSON.stringify(new URL('../packages/harness/profile.mjs', import.meta.url).href)}
        await withTryProfile('abcdf01234567890', async () => {
            process.send('held')
            await new Promise(resolve => process.once('message', resolve))
        })
        process.exit(0)
    `
    )
    for (const crash of [false, true]) {
        const worker = fork(fixture, [], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
        const exited = once(worker, 'exit')
        try {
            const ready = await Promise.race([
                once(worker, 'message').then(([message]) => message),
                exited.then(() => {
                    throw new Error('fixture worker exited before acquiring the mutex')
                })
            ])
            assert.equal(ready, 'held')
            let admitted = false
            const waiting = withTryProfile('abcdf01234567890', async () => {
                admitted = true
            })
            await new Promise((resolve) => setTimeout(resolve, 60))
            assert.equal(admitted, false)
            if (crash) worker.kill('SIGKILL')
            else worker.send('release')
            await exited
            await waiting
            assert.equal(admitted, true)
        } finally {
            worker.kill('SIGKILL')
        }
    }
})

test('a sticky runtime-close error still forgets tokens and deletion still removes the files', async () => {
    const flow = 'fixture-close-error'
    const id = tryIdForFlow(flow)
    const home = homeFor(flow)
    compileTryProfile(draft(flow), id)
    const token = readProfileEnv(`${home}--worker`).OPENAI_API_KEY
    const oldClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async () => {
        throw new Error('fixture close error')
    }
    try {
        await assert.rejects(discardTryProfile(id), /fixture close error/)
        assert.equal(profileTokenKnown(token), false)
        assert.ok(fs.statSync(path.join(profiles, home)).isDirectory())
        await assert.rejects(removeTryProfileForFlow(flow), /fixture close error/)
        assert.equal(fs.existsSync(path.join(profiles, home)), false)
        assert.equal(fs.existsSync(path.join(profiles, `${home}--worker`)), false)
    } finally {
        tryRuntime.closeProfiles = oldClose
    }
})

test('gateway token ingestion keeps idle sticky tokens revoked and permits an active turn', async () => {
    const flow = 'fixture-token-ingest'
    const id = tryIdForFlow(flow)
    const home = homeFor(flow)
    noteLiveTry(home)
    compileTryProfile(draft(flow), id)
    const chiefToken = readProfileEnv(home).OPENAI_API_KEY
    const workerToken = readProfileEnv(`${home}--worker`).OPENAI_API_KEY
    bootHarnessGateway()
    for (const token of [chiefToken, workerToken]) assert.equal(profileTokenKnown(token), true)
    await discardTryProfile(id)
    bootHarnessGateway()
    for (const token of [chiefToken, workerToken]) assert.equal(profileTokenKnown(token), false)
    assert.ok(fs.statSync(path.join(profiles, home)).isDirectory())
})

test('flow deletion preserves a legacy saved harness whose name matches the derived try id', async () => {
    const flow = 'fixture-legacy-published'
    const home = homeFor(flow)
    fs.mkdirSync(path.join(dir, 'harnesses'), { recursive: true })
    fs.mkdirSync(path.join(profiles, home), { recursive: true })
    fs.writeFileSync(path.join(dir, 'harnesses', `${home}.json`), JSON.stringify({ name: home, chief: { model }, specialists: [] }))
    fs.writeFileSync(path.join(profiles, home, 'config.yaml'), 'saved fixture')
    await removeTryProfileForFlow(flow)
    assert.equal(read(home, 'config.yaml'), 'saved fixture')
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', home)), false)
})

test('another gateway worker cannot retain access to a finished or replaced sticky turn', async () => {
    const flow = 'fixture-worker-token'
    const id = tryIdForFlow(flow)
    const home = homeFor(flow)
    noteLiveTry(home)
    compileTryProfile(draft(flow), id)
    const oldToken = readProfileEnv(`${home}--worker`).OPENAI_API_KEY
    // An independent module instance models a gateway worker's retained token map without opening a listener.
    const worker = await import('../packages/harness/gateway.mjs?sticky-token-worker')
    worker.bootHarnessGateway()
    assert.equal(worker.profileTokenKnown(oldToken), true)
    await discardTryProfile(id)
    assert.equal(worker.profileTokenKnown(oldToken), false)
    noteLiveTry(home)
    compileTryProfile(draft(flow, 'later'), id)
    const newToken = readProfileEnv(`${home}--worker`).OPENAI_API_KEY
    assert.notEqual(newToken, oldToken)
    assert.equal(worker.profileTokenKnown(oldToken), false)
    worker.bootHarnessGateway()
    assert.equal(worker.profileTokenKnown(newToken), true)
    await discardTryProfile(id)
    assert.equal(worker.profileTokenKnown(newToken), false)
})
