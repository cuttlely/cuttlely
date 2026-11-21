import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chief-case-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const profilesRoot = path.join(dir, 'runtime', 'profiles')
const { runHarness } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { HarnessError } = await import('./errors.mjs')
const { listRuns } = await import('./history.mjs')
const { stableStringify } = await import('./flow-graph.mjs')
const { hermesProfileId, profileDir } = await import('./paths.mjs')
const {
    adoptLegacyChiefProfile,
    compileProfile,
    compileProfileCached,
    compileTryProfile,
    discardTryProfile,
    PROFILE_COMPILER_VERSION,
    profileDestinationConflicts,
    profileOutdated,
    readProfileEnv,
    recompileOutdatedProfiles,
    specialistProfileName
} = await import('./profile.mjs')
const { appendTurn, closeSessions, ensureSession, readMessages } = await import('./session.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const {
    bootHarnessGateway,
    forgetProfileToken,
    gatewayRequestHooks,
    profileTokenKnown,
    registerProfileToken,
    setGatewayContext,
    startGateway
} = await import('./gateway.mjs')
const { cleanupHooks, deleteHarnessAndProfiles, nameReuseBlockers, sweepOrphanHarnessProfiles } = await import('./cleanup.mjs')

const HERMES_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const calls = []
let gateway
let runtime
let previousContext
before(async () => {
    gateway = await startGateway({ port: 0 })
    process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
    previousContext = setGatewayContext(async () => ({
        componentNodes: {},
        flowOptions: { workspaceId: 'fixture-workspace' },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        async invoke() {
                            return { content: 'Local chief answer.' }
                        }
                    }
                }
            }
    }))
    // Emulate profiles_to_serve and the per-profile API-server bearer check. No model or provider calls.
    runtime = http.createServer(async (req, res) => {
        for await (const chunk of req) void chunk
        calls.push({ url: req.url, method: req.method })
        const id = decodeURIComponent((req.url.match(/^\/p\/([^/]+)\//) || [])[1] || '')
        res.setHeader('content-type', 'application/json')
        if (!HERMES_PROFILE_ID.test(id) || !fs.existsSync(path.join(profileDir(id), 'config.yaml'))) {
            res.writeHead(404).end(JSON.stringify({ error: 'Unknown or unconfigured profile' }))
        } else if (req.headers.authorization !== `Bearer ${readProfileEnv(id).API_SERVER_KEY}`) {
            res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }))
        } else if (req.method === 'POST' && req.url === `/p/${id}/v1/runs`) {
            res.end(JSON.stringify({ run_id: `chief-${id}`, status: 'completed', output: 'Chief answer.' }))
        } else {
            res.writeHead(404).end('{}')
        }
    })
    await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve))
})
after(async () => {
    runtime?.closeAllConnections()
    if (runtime) await new Promise((resolve) => runtime.close(resolve))
    await gateway?.close()
    setGatewayContext(previousContext)
    closeSessions()
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

const chief = { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } }
const recordFor = (name) =>
    saveHarness({
        name,
        workspaceId: 'fixture-workspace',
        chief,
        specialists: [
            { name: 'reader', model: { nodeName: 'fixtureChat', inputs: { modelName: 'reader-model' } } },
            { name: 'writer', model: { nodeName: 'fixtureChat', inputs: { modelName: 'writer-model' } } }
        ]
    })
const run = (name, mode = 'agent') =>
    runHarness({
        name,
        mode,
        chatId: `fixture-${name}`,
        input: 'Answer the fixture.',
        baseUrl: `http://127.0.0.1:${runtime.address().port}`,
        timeoutMs: 5000,
        flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
        loadNode: async () => {
            throw new Error('The router must not run in agent mode.')
        }
    })
const boot = (records) => recompileOutdatedProfiles(records, { log: { info() {}, warn() {} } })
const completion = async (token) => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
    })
    await response.json()
    return response.status
}
function snapshot(folder) {
    const files = {}
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) {
            for (const [child, bytes] of Object.entries(snapshot(file))) files[`${entry.name}/${child}`] = bytes
        } else files[entry.name] = fs.readFileSync(file).toString('base64')
    }
    return files
}
const collisionFor = (name, owner) => (error) => {
    assert.ok(error instanceof HarnessError)
    assert.equal(error.code, 'bad_name')
    assert.equal(
        error.message,
        `Harness "${name}" cannot be compiled: its runtime profile "${hermesProfileId(
            name
        )}" is the same as harness "${owner}". Rename one of them.`
    )
    return true
}
const collision = collisionFor('Caps', 'caps')
function isolatedCase(label, check) {
    return async () => {
        const previousData = process.env.CUTTLELY_DATA_DIR
        const previousRuntime = process.env.CUTTLELY_HERMES_HOME
        process.env.CUTTLELY_DATA_DIR = path.join(dir, label)
        process.env.CUTTLELY_HERMES_HOME = path.join(dir, label, 'runtime')
        try {
            await check()
        } finally {
            closeSessions()
            process.env.CUTTLELY_DATA_DIR = previousData
            process.env.CUTTLELY_HERMES_HOME = previousRuntime
        }
    }
}

test('Caps cannot compile or run over caps; the existing chief, specialists, tokens and memory stay intact', async () => {
    const lower = recordFor('caps')
    // Compile as normal run admission does, retaining the compiled existing harness for later agent calls.
    const compiled = compileProfileCached(lower)
    assert.equal(compiled.dir, path.join(profilesRoot, 'caps'))
    const folders = ['caps', ...compiled.roster.specialists.map((item) => item.profileName)]
    fs.writeFileSync(path.join(compiled.dir, 'memory', 'MEMORY.md'), 'Existing memory.\n')
    appendTurn(lower.name, 'kept-chat', 'Kept question', 'Kept answer')
    closeSessions()
    const sessions = path.join(compiled.dir, 'sessions.sqlite')
    const sessionBytes = fs.readFileSync(sessions)
    const token = readProfileEnv('caps').OPENAI_API_KEY
    const caps = recordFor('Caps')
    const resaved = saveHarness(lower, { overwrite: true })
    assert.equal(compileProfile(resaved).dir, compiled.dir)
    assert.deepEqual(profileDestinationConflicts(resaved), [])
    fs.writeFileSync(path.join(compiled.dir, 'harness-compiler'), '10\n')
    assert.deepEqual(
        boot([resaved, caps]).map((row) => [row.name, row.status]),
        [
            ['caps', 'recompiled'],
            ['Caps', 'failed']
        ]
    )
    assert.equal(readProfileEnv('caps').OPENAI_API_KEY, token)
    const before = folders.map((folder) => snapshot(path.join(profilesRoot, folder)))
    assert.ok(profileDestinationConflicts(caps).includes('caps'))
    assert.throws(() => compileProfile(caps), collision)
    await assert.rejects(run('Caps'), collision)
    assert.throws(() => ensureSession('Caps', 'kept-chat'), collision)
    assert.throws(() => readMessages('Caps', 'kept-chat'), collision)
    assert.throws(() => appendTurn('Caps', 'kept-chat', 'Wrong question', 'Wrong answer'), collision)
    await assert.rejects(run('Caps', 'router'), collision)
    assert.deepEqual(
        boot([caps]).map((row) => row.status),
        ['failed']
    )
    assert.deepEqual(
        folders.map((folder) => snapshot(path.join(profilesRoot, folder))),
        before
    )
    assert.deepEqual(fs.readFileSync(sessions), sessionBytes)
    assert.deepEqual(
        readMessages('caps', 'kept-chat').map((message) => message.content),
        ['Kept question', 'Kept answer']
    )
    // Check the guard again while the owner's connection is cached.
    assert.throws(() => ensureSession('Caps', 'cached-chat'), collision)
    closeSessions()
    assert.deepEqual(fs.readFileSync(sessions), sessionBytes)
    assert.equal(await completion(token), 200)
    assert.equal((await run('caps')).text, 'Chief answer.')
    assert.equal(listRuns('caps').at(0).status, 'succeeded')
    assert.ok(!fs.existsSync(path.join(profilesRoot, 'Caps')))
    // Tries have their own ids and are unaffected by the published-name collision.
    const tried = compileTryProfile(caps, 'abcddcba')
    assert.ok(tried.dir.endsWith('/tryabcddcba'))
    await discardTryProfile('abcddcba')
})

test('TigerMom upgrade moves only the chief once, recompiles version 10, reloads its token and runs agent mode', async () => {
    const record = recordFor('TigerMom')
    const legacy = path.join(profilesRoot, record.name)
    const child = specialistProfileName(record.name, 'reader')
    assert.equal(child, 'tigermom--reader')
    appendTurn(record.name, 'upgrade-chat', 'Kept question', 'Kept answer')
    closeSessions()
    const sessionBytes = fs.readFileSync(path.join(profileDir(record.name), 'sessions.sqlite'))
    fs.renameSync(profileDir(record.name), legacy)
    fs.mkdirSync(path.join(legacy, 'memories'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'memories', 'MEMORY.md'), 'kept memory')
    fs.writeFileSync(path.join(legacy, 'harness-compiler'), '10\n')
    fs.writeFileSync(path.join(legacy, 'harness-roster.json'), JSON.stringify(record))
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'old chief config\n')
    const stale = 'T'.repeat(43)
    const key = crypto
        .createHash('sha256')
        .update(
            stableStringify({
                nodeName: chief.model.nodeName,
                inputs: chief.model.inputs,
                credential: '',
                upstream: {}
            })
        )
        .digest('hex')
    fs.writeFileSync(
        path.join(legacy, '.env'),
        [
            `OPENAI_BASE_URL=http://127.0.0.1:${gateway.port}/v1`,
            `OPENAI_API_KEY=${stale}`,
            `CUTTLELY_MODEL_KEY=${key}`,
            'CUTTLELY_GATEWAY_ROLE=chief',
            'CUTTLELY_GATEWAY_HARNESS=TigerMom',
            `CUTTLELY_GATEWAY_CREATED=${record.createdAt}`,
            'API_SERVER_KEY=legacy-runtime-key',
            ''
        ].join('\n')
    )
    fs.mkdirSync(path.join(profilesRoot, child), { recursive: true })
    fs.writeFileSync(path.join(profilesRoot, child, 'harness-parent'), 'TigerMom\n')
    fs.writeFileSync(path.join(profilesRoot, child, 'harness-compiler'), '10\n')
    fs.writeFileSync(path.join(profilesRoot, child, 'kept.txt'), 'specialist data')
    const childInode = fs.statSync(path.join(profilesRoot, child)).ino
    registerProfileToken({ token: stale, role: 'chief', harnessName: record.name, profileName: record.name, modelKey: key })
    assert.equal(await completion(stale), 200, 'the pre-upgrade token is initially accepted')
    const movedInode = fs.statSync(legacy).ino
    assert.equal(profileDir(record.name), path.join(profilesRoot, 'tigermom'))
    assert.ok(fs.existsSync(legacy), 'the path getter does not migrate')
    assert.deepEqual(boot([record]), [{ name: record.name, status: 'recompiled' }])
    const target = profileDir(record.name)
    assert.equal(fs.statSync(target).ino, movedInode, 'the chief was renamed, not copied')
    assert.ok(!fs.existsSync(legacy))
    assert.deepEqual(fs.readFileSync(path.join(target, 'sessions.sqlite')), sessionBytes)
    assert.equal(fs.readFileSync(path.join(target, 'memories', 'MEMORY.md'), 'utf8'), 'kept memory')
    assert.equal(fs.statSync(path.join(profilesRoot, child)).ino, childInode)
    assert.equal(fs.readFileSync(path.join(profilesRoot, child, 'kept.txt'), 'utf8'), 'specialist data')
    assert.equal(readProfileEnv(child).CUTTLELY_GATEWAY_HARNESS, record.name)
    assert.equal(fs.readFileSync(path.join(profilesRoot, child, 'harness-parent'), 'utf8').trim(), record.name)
    assert.equal(fs.readFileSync(path.join(target, 'harness-compiler'), 'utf8').trim(), PROFILE_COMPILER_VERSION)
    assert.equal(profileOutdated(record), false)
    const env = readProfileEnv(record.name)
    assert.equal(env.CUTTLELY_GATEWAY_HARNESS, 'TigerMom')
    assert.equal(env.CUTTLELY_GATEWAY_ROLE, 'chief')
    assert.notEqual(env.OPENAI_API_KEY, stale)
    assert.equal(profileTokenKnown(stale), false)
    forgetProfileToken(env.OPENAI_API_KEY)
    bootHarnessGateway()
    assert.equal(profileTokenKnown(env.OPENAI_API_KEY), true, 'disk reload agrees with lowercase registration')
    let seen
    gatewayRequestHooks.beforeRun = (meta) => {
        seen = meta
    }
    try {
        assert.equal(await completion(env.OPENAI_API_KEY), 200)
        assert.equal(seen.role, 'chief')
        assert.equal(seen.harnessName, 'TigerMom')
        assert.equal(seen.profileName, 'tigermom')
        assert.equal(await completion(stale), 401)
    } finally {
        gatewayRequestHooks.beforeRun = null
    }
    const before = snapshot(target)
    const stat = fs.statSync(target)
    assert.deepEqual(boot([record]), [])
    assert.equal(adoptLegacyChiefProfile(record.name), false)
    assert.equal(fs.statSync(target).ino, stat.ino)
    assert.equal(fs.statSync(target).mtimeMs, stat.mtimeMs)
    assert.deepEqual(snapshot(target), before)
    // The fake runtime itself refuses capital prefixes and incorrect per-profile API keys.
    const base = `http://127.0.0.1:${runtime.address().port}`
    assert.equal((await fetch(`${base}/p/TigerMom/v1/runs`, { method: 'POST' })).status, 404)
    assert.equal((await fetch(`${base}/p/tigermom/v1/runs`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401)
    calls.length = 0
    assert.equal((await run('TigerMom')).text, 'Chief answer.')
    assert.deepEqual(
        calls.filter((call) => call.method === 'POST').map((call) => call.url),
        ['/p/tigermom/v1/runs']
    )
    const runs = listRuns('TigerMom')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].mode, 'agent')
    assert.equal(runs[0].status, 'succeeded')
})

test('compile migrates a legacy chief before preflight and keeps an all-lowercase folder exactly', () => {
    const record = recordFor('CompileUpgrade')
    const legacy = path.join(profilesRoot, record.name)
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'kept.txt'), 'legacy data')
    const inode = fs.statSync(legacy).ino
    const compiled = compileProfile(record)
    assert.equal(fs.statSync(compiled.dir).ino, inode)
    assert.equal(fs.readFileSync(path.join(compiled.dir, 'kept.txt'), 'utf8'), 'legacy data')
    const lower = recordFor('plain-lowercase')
    const folder = profileDir(lower.name)
    fs.mkdirSync(folder)
    const before = fs.statSync(folder).ino
    assert.equal(adoptLegacyChiefProfile(lower.name), false)
    assert.equal(compileProfile(lower).dir, folder)
    assert.equal(fs.statSync(folder).ino, before)
})

test('migration skips symlinks, non-directories, existing targets and saved-name collisions', () => {
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'kept.txt'), 'outside')
    const linked = path.join(profilesRoot, 'LinkedChief')
    fs.symlinkSync(outside, linked, 'dir')
    assert.equal(adoptLegacyChiefProfile('LinkedChief'), false)
    assert.ok(fs.lstatSync(linked).isSymbolicLink())
    assert.ok(!fs.existsSync(profileDir('LinkedChief')))
    fs.writeFileSync(path.join(profilesRoot, 'FileChief'), 'plain file')
    assert.equal(adoptLegacyChiefProfile('FileChief'), false)
    for (const name of ['ExistingTarget', 'existingtarget', 'Collision', 'collision']) fs.mkdirSync(path.join(profilesRoot, name))
    fs.writeFileSync(path.join(profilesRoot, 'ExistingTarget', 'kept.txt'), 'source')
    assert.equal(adoptLegacyChiefProfile('ExistingTarget'), false)
    assert.equal(fs.readFileSync(path.join(profilesRoot, 'ExistingTarget', 'kept.txt'), 'utf8'), 'source')
    recordFor('Collision')
    recordFor('collision')
    // Remove the target so the saved-name collision is the guard preventing a move.
    fs.rmdirSync(profileDir('Collision'))
    assert.equal(adoptLegacyChiefProfile('Collision'), false)
    assert.ok(fs.existsSync(path.join(profilesRoot, 'Collision')))
    assert.ok(!fs.existsSync(profileDir('Collision')))
})

test('opening a published router session migrates its existing database before any compile', () => {
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'session-runtime')
    try {
        appendTurn('TigerMom', 'old-chat', 'Previous question', 'Previous answer')
        closeSessions()
        const target = profileDir('TigerMom')
        const legacy = path.join(process.env.CUTTLELY_HERMES_HOME, 'profiles', 'TigerMom')
        fs.renameSync(target, legacy)
        const inode = fs.statSync(path.join(legacy, 'sessions.sqlite')).ino
        assert.ok(!fs.existsSync(path.join(legacy, 'config.yaml')))
        assert.deepEqual(
            readMessages('TigerMom', 'old-chat').map((message) => message.content),
            ['Previous question', 'Previous answer']
        )
        assert.ok(!fs.existsSync(legacy))
        assert.equal(fs.statSync(path.join(target, 'sessions.sqlite')).ino, inode)
    } finally {
        closeSessions()
        process.env.CUTTLELY_HERMES_HOME = previousHome
    }
})

test(
    'TigerMom keeps its marked chief when tigermom is saved later',
    isolatedCase('marked-owner', async () => {
        const owner = recordFor('TigerMom')
        const compiled = compileProfileCached(owner)
        appendTurn(owner.name, 'owner-chat', 'Owner question', 'Owner answer')
        closeSessions()
        const sessions = path.join(compiled.dir, 'sessions.sqlite')
        const bytes = fs.readFileSync(sessions)
        const lower = recordFor('tigermom')
        const refused = collisionFor(lower.name, owner.name)
        assert.equal(compileProfile(saveHarness(owner, { overwrite: true })).dir, compiled.dir)
        assert.deepEqual(profileDestinationConflicts(owner), [])
        fs.writeFileSync(path.join(compiled.dir, 'harness-compiler'), '10\n')
        assert.deepEqual(
            boot([owner, lower]).map((row) => [row.name, row.status]),
            [
                ['TigerMom', 'recompiled'],
                ['tigermom', 'failed']
            ]
        )
        const before = snapshot(compiled.dir)
        assert.throws(() => compileProfile(lower), refused)
        assert.throws(() => compileProfileCached(lower), refused)
        assert.throws(() => ensureSession(lower.name, 'owner-chat'), refused)
        assert.throws(() => readMessages(lower.name, 'owner-chat'), refused)
        assert.throws(() => appendTurn(lower.name, 'owner-chat', 'Wrong question', 'Wrong answer'), refused)
        await assert.rejects(run(lower.name), refused)
        await assert.rejects(run(lower.name, 'router'), refused)
        assert.deepEqual(snapshot(compiled.dir), before)
        assert.deepEqual(fs.readFileSync(sessions), bytes)
        assert.deepEqual(
            readMessages(owner.name, 'owner-chat').map((message) => message.content),
            ['Owner question', 'Owner answer']
        )
        assert.equal((await run(owner.name)).text, 'Chief answer.')
        assert.ok(!fs.existsSync(path.join(path.dirname(compiled.dir), owner.name)))
    })
)

test(
    'an unmarked legacy TigerMom stays in place when the saved lowercase name wins',
    isolatedCase('legacy-collision', async () => {
        const legacyRecord = recordFor('TigerMom')
        appendTurn(legacyRecord.name, 'legacy-chat', 'Legacy question', 'Legacy answer')
        closeSessions()
        const target = profileDir(legacyRecord.name)
        const legacy = path.join(path.dirname(target), legacyRecord.name)
        fs.renameSync(target, legacy)
        fs.writeFileSync(path.join(legacy, 'kept.txt'), 'Legacy data')
        const before = snapshot(legacy)
        const inode = fs.statSync(legacy).ino
        const lower = recordFor('tigermom')
        const refused = collisionFor(legacyRecord.name, lower.name)
        assert.equal(adoptLegacyChiefProfile(legacyRecord.name), false)
        assert.throws(() => compileProfile(legacyRecord), refused)
        assert.throws(() => ensureSession(legacyRecord.name, 'legacy-chat'), refused)
        assert.throws(() => readMessages(legacyRecord.name, 'legacy-chat'), refused)
        await assert.rejects(run(legacyRecord.name), refused)
        await assert.rejects(run(legacyRecord.name, 'router'), refused)
        assert.deepEqual(
            boot([legacyRecord, lower]).map((row) => [row.name, row.status]),
            [['TigerMom', 'failed']]
        )
        assert.ok(!fs.existsSync(target), 'boot does not move the refused legacy chief or compile an absent owner')
        assert.equal(compileProfile(lower).dir, target)
        assert.equal(fs.readFileSync(path.join(target, 'harness-parent'), 'utf8').trim(), lower.name)
        assert.ok(!fs.existsSync(path.join(target, 'kept.txt')))
        assert.deepEqual(readMessages(lower.name, 'legacy-chat'), [])
        ensureSession(lower.name, 'new-chat')
        assert.throws(() => ensureSession(legacyRecord.name, 'new-chat'), refused)
        assert.equal(adoptLegacyChiefProfile(legacyRecord.name), false)
        assert.equal(fs.statSync(legacy).ino, inode)
        assert.deepEqual(snapshot(legacy), before)
    })
)

test(
    'capitalised collisions need a unique legacy folder until an exact marker owns the chief',
    isolatedCase('capitalised-collision', () => {
        const first = recordFor('TigerMom')
        const second = recordFor('Tigermom')
        const refusedFirst = collisionFor(first.name, second.name)
        const refusedSecond = collisionFor(second.name, first.name)
        assert.throws(() => compileProfile(first), refusedFirst)
        assert.throws(() => compileProfile(second), refusedSecond)
        assert.throws(() => ensureSession(first.name, 'ambiguous'), refusedFirst)
        assert.throws(() => ensureSession(second.name, 'ambiguous'), refusedSecond)
        const target = profileDir(first.name)
        const legacy = path.join(path.dirname(target), first.name)
        const otherLegacy = path.join(path.dirname(target), second.name)
        fs.mkdirSync(legacy, { recursive: true })
        fs.mkdirSync(otherLegacy)
        fs.writeFileSync(path.join(legacy, 'kept.txt'), 'First legacy data')
        fs.writeFileSync(path.join(otherLegacy, 'kept.txt'), 'Second legacy data')
        assert.equal(adoptLegacyChiefProfile(first.name), false)
        assert.equal(adoptLegacyChiefProfile(second.name), false)
        assert.throws(() => compileProfile(first), refusedFirst)
        assert.throws(() => compileProfile(second), refusedSecond)
        fs.rmSync(otherLegacy, { recursive: true })
        const inode = fs.statSync(legacy).ino
        assert.equal(adoptLegacyChiefProfile(second.name), false)
        assert.throws(() => compileProfile(second), refusedSecond)
        assert.equal(adoptLegacyChiefProfile(first.name), true)
        assert.equal(fs.statSync(target).ino, inode)
        assert.equal(compileProfile(first).dir, target)
        assert.equal(fs.readFileSync(path.join(target, 'kept.txt'), 'utf8'), 'First legacy data')
        assert.throws(() => compileProfile(second), refusedSecond)
        assert.equal(compileProfileCached(first).dir, target)
    })
)

test('cleanup recognizes exact saved ownership in a lowercase chief folder', async () => {
    const record = recordFor('CleanupChief')
    compileProfile(record)
    assert.deepEqual(nameReuseBlockers('cleanupchief', { expected: ['cleanupchief--reader', 'cleanupchief--writer'] }), [
        'profiles/cleanupchief (belongs to another harness)',
        'profiles/cleanupchief--reader (belongs to another harness)',
        'profiles/cleanupchief--writer (belongs to another harness)',
        'workspaces/cleanupchief--reader (belongs to another harness)',
        'workspaces/cleanupchief--writer (belongs to another harness)'
    ])
    const previous = { ...cleanupHooks }
    Object.assign(cleanupHooks, { log() {}, close: async () => true })
    try {
        const sweep = await sweepOrphanHarnessProfiles({ mode: 'log', now: Date.now() + 20 * 60 * 1000 })
        assert.ok(!sweep.orphans.some((item) => item.id === record.name))
        const result = await deleteHarnessAndProfiles(record.name)
        assert.ok(result.removed.includes(hermesProfileId(record.name)))
        assert.ok(!fs.existsSync(profileDir(record.name)))
    } finally {
        Object.assign(cleanupHooks, previous)
    }
})
