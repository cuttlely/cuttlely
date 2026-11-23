// Fake drafts and runtime hooks only; no Hermes boot or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
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
    resetTryProfileSession,
    removeTryProfileForFlow,
    tryIdForFlow,
    tryProfileName,
    tryRuntime,
    withTryProfile
} = await import('../packages/harness/profile.mjs')
const { bootHarnessGateway, sweepAbandonedTryProfiles, profileTokenKnown, stopGateway } = await import('../packages/harness/gateway.mjs')
const { noteLiveTry, tryLockIsLive } = await import('../packages/harness/try-live.mjs')
const { runHarness, runHooks } = await import('../packages/harness/run.mjs')
const { acquireTurn, releaseTurn, closeQueueDb, BUSY_MESSAGE, database } = await import('../packages/harness/lock.mjs')
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
    tryOwner: 'user:fixture',
    chief: { model, instructions: `chief-${revision}` },
    specialists: [{ name: 'worker', model, instructions: `worker-${revision}`, shell: true, modules: [] }]
})
const homeFor = (flow) => tryProfileName(tryIdForFlow(flow, 'user:fixture'))
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
        const id = tryIdForFlow(flow, 'user:fixture')
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

test('canvas and replay collisions return busy immediately; cleanup waits without releasing the chat lock', async () => {
    const flow = 'fixture-concurrent-flow'
    const id = tryIdForFlow(flow, 'user:fixture')
    const home = homeFor(flow)
    const entered = deferred()
    const finish = deferred()
    let compiles = 0
    let second
    let discard
    let closes = 0
    let baselineCloses = 0
    const oldClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async (names) => {
        closes += 1
        await oldClose(names)
    }
    runHooks.afterProfile = async (info) => {
        assert.equal(info.tryId, id)
        compiles += 1
        if (compiles === 1) {
            baselineCloses = closes
            const started = performance.now()
            // Starting these inside the active hook must not inherit ownership of its teardown.
            second = assert
                .rejects(runHarness({ ...args, replay: true, record: { ...draft(flow, 'later'), tryId: 'abcdef01' } }), {
                    code: 'busy',
                    message: BUSY_MESSAGE
                })
                .then(() => assert.ok(performance.now() - started < 100))
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
        assert.equal(closes, baselineCloses)
        assert.ok(tryLockIsLive(home))
        assert.throws(() => acquireTurn(record.name, args.chatId), { code: 'busy' })
        assert.ok(read(home, 'SOUL.md').includes('chief-first'))
        finish.resolve()
        await Promise.all([first, second, discard])
        assert.equal(compiles, 1)
        assert.equal(closes, baselineCloses + 2)
        assert.ok(read(home, 'SOUL.md').includes('chief-first'))
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
    const otherOwner = 'user:second'
    const otherId = tryIdForFlow(flow, otherOwner)
    const otherHome = tryProfileName(otherId)
    compileTryProfile({ ...draft(flow), tryOwner: otherOwner }, otherId)
    const savedChild = `${home}--saved`
    fs.mkdirSync(path.join(profiles, savedChild), { recursive: true })
    fs.mkdirSync(path.join(dir, 'harnesses'), { recursive: true })
    fs.writeFileSync(
        path.join(dir, 'harnesses', `${savedChild}.json`),
        JSON.stringify({ name: savedChild, chief: { model }, specialists: [] })
    )
    fs.writeFileSync(path.join(profiles, savedChild, 'harness-parent'), home)
    fs.writeFileSync(path.join(profiles, savedChild, 'config.yaml'), 'saved child fixture')
    const entered = deferred()
    const finish = deferred()
    const turn = withTryProfile(tryIdForFlow(flow, 'user:fixture'), async (discard) => {
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
    for (const entry of [home, `${home}--worker`, otherHome, `${otherHome}--worker`]) {
        assert.equal(fs.existsSync(path.join(profiles, entry)), false)
        assert.equal(fs.existsSync(path.join(dir, 'workspaces', entry)), false)
    }
    assert.ok(fs.existsSync(path.join(profiles, homeFor('fixture-flow-a'))))
    assert.ok(fs.existsSync(path.join(profiles, 'published-fixture')))
    assert.equal(read(savedChild, 'config.yaml'), 'saved child fixture')
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', savedChild)), false)
    assert.equal(sweepAbandonedTryProfiles().has(savedChild), false)
    assert.equal(read(savedChild, 'config.yaml'), 'saved child fixture')
    await removeTryProfileForFlow(flow)
})

test('workers in separate processes get busy immediately and recover a dead owner', { timeout: 10000 }, async () => {
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
            const started = performance.now()
            await assert.rejects(
                withTryProfile('abcdf01234567890', async () => assert.fail('collision admitted')),
                {
                    code: 'busy',
                    message: BUSY_MESSAGE
                }
            )
            assert.ok(performance.now() - started < 100)
            if (crash) worker.kill('SIGKILL')
            else worker.send('release')
            await exited
            let admitted = false
            await withTryProfile('abcdf01234567890', async () => {
                admitted = true
            })
            assert.equal(admitted, true)
        } finally {
            worker.kill('SIGKILL')
        }
    }
})

test('a sticky runtime-close error still forgets tokens and deletion still removes the files', async () => {
    const flow = 'fixture-close-error'
    const id = tryIdForFlow(flow, 'user:fixture')
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
    const id = tryIdForFlow(flow, 'user:fixture')
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
    fs.writeFileSync(path.join(profiles, home, 'harness-try-flow'), flow)
    fs.writeFileSync(path.join(profiles, home, 'harness-try-owner'), 'user:fixture')
    fs.writeFileSync(path.join(profiles, home, 'harness-try-keep'), home)
    assert.throws(() => compileTryProfile(draft(flow), tryIdForFlow(flow, 'user:fixture')), { code: 'name_taken' })
    await assert.rejects(resetTryProfileSession(tryIdForFlow(flow, 'user:fixture'), 'new-chat'), { code: 'name_taken' })
    await removeTryProfileForFlow(flow)
    assert.equal(read(home, 'config.yaml'), 'saved fixture')
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', home)), false)
})

test('another gateway worker cannot retain access to a finished or replaced sticky turn', async () => {
    const flow = 'fixture-worker-token'
    const id = tryIdForFlow(flow, 'user:fixture')
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

test('sticky ids require an owner and separate users can hold one flow at the same time', async () => {
    const flow = 'fixture-two-users'
    for (const owner of [undefined, '', ' ', 1]) assert.throws(() => tryIdForFlow(flow, owner), { code: 'bad_session' })
    const firstId = tryIdForFlow(flow, 'user:fixture')
    const secondId = tryIdForFlow(flow, 'user:second')
    assert.equal(firstId, createHash('sha256').update(`cuttlely-try-flow-owner:${flow}:user:fixture`).digest('hex').slice(0, 16))
    assert.notEqual(firstId, secondId)
    await withTryProfile(firstId, async () => {
        const started = performance.now()
        await assert.rejects(
            withTryProfile(firstId, async () => assert.fail('collision admitted')),
            { code: 'busy', message: BUSY_MESSAGE }
        )
        assert.ok(performance.now() - started < 100)
        await withTryProfile(secondId, async () => {})
    })
    database()
        .prepare('INSERT INTO try_profile_turns (scope, owner, pid, started_at) VALUES (?, ?, ?, ?)')
        .run(tryProfileName(firstId), 'fixture-recycled-pid', process.pid, 'stale-start-ticks')
    await withTryProfile(firstId, async () => {})
    await assert.rejects(runHarness({ record: { ...draft(flow), tryOwner: undefined, tryId: firstId } }), /owner key/)
})

test('next compile overwrites the prompt, specialist and model in the same home', async () => {
    const flow = 'fixture-edits'
    const id = tryIdForFlow(flow, 'user:fixture')
    const first = compileTryProfile(draft(flow, 'old'), id)
    const state = path.join(first.dir, 'state.db')
    fs.writeFileSync(state, 'fixture file identity only')
    const inode = fs.statSync(state).ino
    const retiredFiles = ['state.db', 'state.db-wal', 'state.db-shm', 'mcp-stderr.log'].map((file) => {
        const target = path.join(profiles, `${tryProfileName(id)}--worker`, file)
        fs.writeFileSync(target, 'retired specialist fixture')
        return [target, fs.statSync(target).ino]
    })
    const changed = draft(flow)
    changed.chief.instructions = 'reply only BANANA'
    changed.chief.model = { ...model, inputs: { modelName: 'fixture-new-model' } }
    changed.specialists = [{ ...changed.specialists[0], name: 'new-worker', instructions: 'new tool fixture' }]
    const next = compileTryProfile(changed, id)
    assert.equal(next.dir, first.dir)
    assert.match(read(tryProfileName(id), 'SOUL.md'), /reply only BANANA/)
    assert.equal(read(tryProfileName(id), 'SOUL.md').includes('chief-old'), false)
    const roster = JSON.parse(read(tryProfileName(id), 'harness-roster.json'))
    assert.equal(roster.chief.model.inputs.modelName, 'fixture-new-model')
    assert.deepEqual(
        roster.specialists.map((row) => row.name),
        ['new-worker']
    )
    assert.equal(read(tryProfileName(id), 'config.yaml').includes(`${tryProfileName(id)}--worker`), false)
    assert.equal(read(tryProfileName(id), 'harness-try-keep').trim(), tryProfileName(id))
    assert.equal(fs.statSync(state).ino, inode)
    for (const [file, identity] of retiredFiles) assert.equal(fs.statSync(file).ino, identity)
})

test('chat boundaries clear SQLite history and file memory in place for chief and specialist homes', async () => {
    const flow = 'fixture-chat-boundary'
    const id = tryIdForFlow(flow, 'user:fixture')
    const scope = tryProfileName(id)
    const compileAndReset = async (chatId) =>
        withTryProfile(id, async (discard) => {
            compileTryProfile(draft(flow), id)
            await resetTryProfileSession(id, chatId)
            await discard()
        })
    await compileAndReset('chat-a')
    const identities = new Map()
    for (const name of [scope, `${scope}--worker`]) {
        const home = path.join(profiles, name)
        const state = path.join(home, 'state.db')
        const db = new DatabaseSync(state)
        db.exec(`PRAGMA journal_mode = WAL;
            CREATE TABLE sessions(id TEXT PRIMARY KEY);
            CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), content TEXT);
            CREATE TABLE memories(content TEXT);
            CREATE TABLE configuration(value TEXT);
            CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
            CREATE TRIGGER message_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END;
            CREATE TRIGGER message_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); END;
            INSERT INTO sessions VALUES('chat-a'); INSERT INTO messages VALUES(1, 'chat-a', 'secret fixture');
            INSERT INTO memories VALUES('remember fixture'); INSERT INTO configuration VALUES('keep schema');`)
        const reader = new DatabaseSync(state, { readOnly: true })
        reader.prepare('SELECT * FROM sessions').all()
        db.close()
        reader.close()
        for (const file of ['state.db', 'state.db-wal', 'state.db-shm'])
            identities.set(path.join(home, file), fs.statSync(path.join(home, file)).ino)
        for (const file of ['memories/MEMORY.md', 'memories/USER.md', 'sessions/chat-a.jsonl']) {
            const target = path.join(home, file)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, 'remember chat-a fixture')
            identities.set(target, fs.statSync(target).ino)
        }
    }
    // A follow-up keeps this chat's state and still overwrites configuration.
    await compileAndReset('chat-a')
    for (const name of [scope, `${scope}--worker`]) {
        const db = new DatabaseSync(path.join(profiles, name, 'state.db'), { readOnly: true })
        assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 1)
        db.close()
    }
    await compileAndReset('chat-b')
    for (const [file, inode] of identities) assert.equal(fs.statSync(file).ino, inode, file)
    for (const name of [scope, `${scope}--worker`]) {
        const db = new DatabaseSync(path.join(profiles, name, 'state.db'), { readOnly: true })
        for (const table of ['sessions', 'messages', 'memories']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
        assert.equal(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'secret'").get().n, 0)
        assert.equal(db.prepare('SELECT value FROM configuration').get().value, 'keep schema')
        db.close()
        for (const file of ['memories/MEMORY.md', 'memories/USER.md', 'sessions/chat-a.jsonl']) assert.equal(read(name, file), '')
        assert.equal(read(name, 'harness-try-session'), 'chat-b')
    }
    const secondId = tryIdForFlow(flow, 'user:second')
    const second = compileTryProfile({ ...draft(flow), tryOwner: 'user:second' }, secondId)
    await resetTryProfileSession(secondId, 'chat-b')
    assert.notEqual(second.dir, path.join(profiles, scope))
    assert.equal(fs.existsSync(path.join(second.dir, 'state.db')), false)
    assert.equal(fs.existsSync(path.join(second.dir, 'memories/MEMORY.md')), false)
    // Upgrade: a missing boundary marker also clears existing state.
    fs.unlinkSync(path.join(profiles, scope, 'harness-try-session'))
    const state = path.join(profiles, scope, 'state.db')
    const reader = new DatabaseSync(state, { readOnly: true })
    reader.prepare('SELECT * FROM memories').all()
    const writer = new DatabaseSync(state)
    writer.exec("INSERT INTO memories VALUES('old-version fixture')")
    writer.close()
    reader.close()
    await compileAndReset('chat-c')
    const db = new DatabaseSync(state, { readOnly: true })
    assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 0)
    db.close()
    for (const [file, inode] of identities) assert.equal(fs.statSync(file).ino, inode, file)
})

test('KIWI memory pair matches main: the same Try chat keeps it, a new Try chat or another user never sees it', async () => {
    const flow = 'fixture-kiwi'
    const id = tryIdForFlow(flow, 'user:fixture')
    const scope = tryProfileName(id)
    const turn = async (chatId) =>
        withTryProfile(id, async (discard) => {
            compileTryProfile(draft(flow), id)
            await resetTryProfileSession(id, chatId)
            await discard()
        })
    const kiwiFiles = (name) => {
        const found = []
        const walk = (folder) => {
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const target = path.join(folder, entry.name)
                if (entry.isDirectory()) walk(target)
                else if (fs.readFileSync(target).includes('KIWI')) found.push(target)
            }
        }
        if (fs.existsSync(path.join(profiles, name))) walk(path.join(profiles, name))
        return found
    }
    // Turn 1 of chat A: the runtime remembers KIWI in its database and memory file.
    await turn('chat-kiwi-a')
    const home = path.join(profiles, scope)
    const db = new DatabaseSync(path.join(home, 'state.db'))
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(session_id TEXT, content TEXT); CREATE TABLE memories(content TEXT);
        INSERT INTO sessions VALUES('chat-kiwi-a'); INSERT INTO messages VALUES('chat-kiwi-a', 'remember KIWI'); INSERT INTO memories VALUES('KIWI');`)
    db.close()
    fs.mkdirSync(path.join(home, 'memories'), { recursive: true })
    fs.writeFileSync(path.join(home, 'memories', 'MEMORY.md'), 'The word is KIWI')
    // Turn 2 of chat A is a follow-up; Cuttlely also supplies the chat history, as on main.
    await turn('chat-kiwi-a')
    assert.ok(kiwiFiles(scope).length > 0, 'a same-chat follow-up lost its state')
    // A new Try chat starts clean, as each Try did on main.
    await turn('chat-kiwi-b')
    assert.deepEqual(kiwiFiles(scope), [])
    const check = new DatabaseSync(path.join(home, 'state.db'), { readOnly: true })
    assert.equal(check.prepare("SELECT count(*) AS n FROM memories WHERE content LIKE '%KIWI%'").get().n, 0)
    check.close()
    // Another user on the same flow has a separate home with no KIWI.
    const otherId = tryIdForFlow(flow, 'user:second')
    assert.notEqual(tryProfileName(otherId), scope)
    compileTryProfile({ ...draft(flow), tryOwner: 'user:second' }, otherId)
    await resetTryProfileSession(otherId, 'chat-kiwi-c')
    assert.deepEqual(kiwiFiles(tryProfileName(otherId)), [])
})

test('upgrade sweep removes old unique homes with state and stale markers, keeping sticky and saved homes', () => {
    const homes = ['try0000000000000001', 'try0000000000000002', 'try0000000000000003']
    const past = new Date(Date.now() - 11 * 60 * 1000)
    for (const name of homes) {
        const home = path.join(profiles, name)
        fs.mkdirSync(home, { recursive: true })
        fs.writeFileSync(path.join(home, 'state.db'), 'old fake state')
        if (name.endsWith('2')) fs.writeFileSync(path.join(home, 'harness-try'), 'stale-unique-id')
        if (!name.endsWith('1')) fs.utimesSync(home, past, past)
    }
    fs.writeFileSync(path.join(dir, 'harnesses', `${homes[2]}.json`), JSON.stringify({ name: homes[2], chief: { model }, specialists: [] }))
    const swept = sweepAbandonedTryProfiles()
    for (const name of homes.slice(0, 2)) {
        assert.ok(swept.has(name))
        assert.equal(fs.existsSync(path.join(profiles, name)), false)
    }
    assert.equal(read(homes[2], 'state.db'), 'old fake state')
    assert.equal(swept.has(homeFor('fixture-flow-a')), false)
    assert.ok(fs.existsSync(path.join(profiles, 'published-fixture')))
})

test('a session reset refuses to change memory until the previous runtime closes', async () => {
    const flow = 'fixture-reset-close-failed'
    const id = tryIdForFlow(flow, 'user:fixture')
    const compiled = compileTryProfile(draft(flow), id)
    const memory = path.join(compiled.dir, 'memories', 'MEMORY.md')
    fs.mkdirSync(path.dirname(memory), { recursive: true })
    fs.writeFileSync(memory, 'previous session fixture')
    const oldClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async () => {
        throw new Error('fixture still served')
    }
    try {
        await assert.rejects(resetTryProfileSession(id, 'new-chat'), /fixture still served/)
        assert.equal(fs.readFileSync(memory, 'utf8'), 'previous session fixture')
        assert.equal(fs.existsSync(path.join(compiled.dir, 'harness-try-session')), false)
    } finally {
        tryRuntime.closeProfiles = oldClose
    }
})
