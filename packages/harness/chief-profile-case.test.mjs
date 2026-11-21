import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chief-case-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { runHarness } = await import('./run.mjs')
const { saveHarness, deleteHarness } = await import('./store.mjs')
const { listRuns } = await import('./history.mjs')
const { stableStringify } = await import('./flow-graph.mjs')
const {
    compileProfile,
    compileTryProfile,
    migrateHarnessProfiles,
    readProfileEnv,
    recompileOutdatedProfiles,
    specialistProfileName,
    specialistWorkspace,
    PROFILE_COMPILER_VERSION
} = await import('./profile.mjs')
const { harnessProfileId, profileDir } = await import('./paths.mjs')
const { appendMessage, readMessages, closeSessions } = await import('./session.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { bootHarnessGateway, forgetProfileToken, profileTokenKnown, registerProfileToken, setGatewayContext, startGateway } = await import(
    './gateway.mjs'
)
const { cleanupHooks, nameReuseBlockers, sweepOrphanHarnessProfiles, deleteHarnessAndProfiles } = await import('./cleanup.mjs')
after(() => {
    closeSessions()
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

const HERMES_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const model = (modelName) => ({ nodeName: 'fixtureChat', inputs: { modelName } })
const chief = { model: model('chief-model') }
const specialists = [
    { name: 'reader', model: model('reader-model') },
    { name: 'writer', model: model('writer-model') }
]
const save = (name) => saveHarness({ name, workspaceId: 'fixture-workspace', chief, specialists }, { overwrite: true })
const quiet = { info() {}, warn() {} }
const file = (id, name) => path.join(profileDir(id), name)
const read = (id, name) => fs.readFileSync(file(id, name), 'utf8')
const put = (id, name, text) => {
    fs.mkdirSync(path.dirname(file(id, name)), { recursive: true })
    fs.writeFileSync(file(id, name), text)
}
const stat = (name) => {
    const st = fs.statSync(name)
    return [st.ino, st.mtimeMs, st.size]
}

async function gatewayFixture(t) {
    const gateway = await startGateway({ port: 0 })
    process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
    const resolved = []
    const lines = []
    const originalInfo = console.info
    console.info = (line) => lines.push(String(line))
    const previous = setGatewayContext(async (record) => {
        resolved.push(record.name)
        return {
            componentNodes: {},
            flowOptions: { workspaceId: record.workspaceId },
            loadNode: async () =>
                class {
                    async init(data) {
                        return {
                            async invoke() {
                                return { content: `Answer from ${data.inputs.modelName}` }
                            }
                        }
                    }
                }
        }
    })
    t.after(async () => {
        console.info = originalInfo
        setGatewayContext(previous)
        await gateway.close?.()
    })
    const request = (token) =>
        fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ model: 'body-cannot-select-owner', messages: [{ role: 'user', content: 'Hello' }] })
        })
    return { request, resolved, lines }
}

// Emulate profiles_to_serve and the profile-specific runs bearer, so an accidentally lowercased URL or a
// missing config cannot pass just because the fixture accepts arbitrary profile prefixes.
async function runtimeFixture(t) {
    const calls = []
    const server = http.createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: text ? JSON.parse(text) : null })
        const id = decodeURIComponent((req.url.match(/^\/p\/([^/]+)\//) || [])[1] || '')
        res.setHeader('content-type', 'application/json')
        if (!HERMES_PROFILE_ID.test(id) || !fs.existsSync(file(id, 'config.yaml'))) {
            res.writeHead(404).end(JSON.stringify({ error: 'Unknown or unconfigured profile' }))
        } else if (req.method === 'POST' && req.url === `/p/${id}/v1/runs`) {
            if (req.headers.authorization !== `Bearer ${readProfileEnv(id).API_SERVER_KEY}`) {
                res.writeHead(401).end(JSON.stringify({ error: 'Invalid API key' }))
                return
            }
            res.end(JSON.stringify({ run_id: `chief-run-${calls.length}`, status: 'completed', output: 'Chief answer.' }))
        } else {
            res.writeHead(404).end('{}')
        }
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    t.after(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    })
    return { calls, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function agent(record, baseUrl, fetchImpl) {
    return runHarness({
        name: record.name,
        mode: 'agent',
        chatId: 'fixture-chat',
        input: 'Answer the fixture.',
        baseUrl,
        fetchImpl,
        timeoutMs: 5000,
        flowOptions: { workspaceId: record.workspaceId, harnessCaller: { via: 'session' } },
        loadNode: async () => {
            throw new Error('The router must not run in agent mode.')
        }
    })
}

function legacyFixture(name) {
    const record = save(name)
    const legacy = specialistProfileName(name.toLowerCase(), 'reader')
    put(name, 'harness-roster.json', JSON.stringify(record))
    put(name, 'harness-compiler', '10\n')
    put(name, 'config.yaml', 'agent: {}\n')
    put(name, 'sessions.sqlite', 'chief router sessions')
    put(name, 'memories/MEMORY.md', 'chief memory')
    put(legacy, 'harness-parent', `${name}\n`)
    put(legacy, 'harness-compiler', '10\n')
    put(legacy, 'config.yaml', 'agent: {}\n')
    put(legacy, 'sessions.sqlite', 'specialist sessions')
    put(legacy, 'memories/MEMORY.md', 'specialist memory')
    fs.mkdirSync(specialistWorkspace(legacy), { recursive: true })
    fs.writeFileSync(path.join(specialistWorkspace(legacy), 'notes.txt'), 'workspace memory')
    return { record, legacy }
}

function legacyTokenFixture(name) {
    const { record } = legacyFixture(name)
    const stale = 's'.repeat(43)
    const key = createHash('sha256')
        .update(
            stableStringify({
                nodeName: 'fixtureChat',
                inputs: { modelName: 'chief-model' },
                credential: '',
                upstream: {}
            })
        )
        .digest('hex')
    put(
        record.name,
        '.env',
        [
            `OPENAI_BASE_URL=http://127.0.0.1:${process.env.CUTTLELY_HARNESS_GATEWAY_PORT || 43118}/v1`,
            `OPENAI_API_KEY=${stale}`,
            `CUTTLELY_GATEWAY_HARNESS=${record.name}`,
            'CUTTLELY_GATEWAY_ROLE=chief',
            `CUTTLELY_GATEWAY_CREATED=${record.createdAt}`,
            `CUTTLELY_MODEL_KEY=${key}`
        ].join('\n')
    )
    registerProfileToken({ token: stale, harnessName: record.name, profileName: record.name, role: 'chief' })
    return { record, stale }
}

test('runtime ids keep lowercase names and hash the original case within the runtime limit', () => {
    for (const name of ['caps', 'lower_case-7', 'a'.repeat(64)]) assert.equal(harnessProfileId(name), name)
    const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8)
    assert.equal(harnessProfileId('Caps'), `caps-${hash('Caps')}`)
    assert.notEqual(harnessProfileId('Caps'), harnessProfileId('CAPS'))
    assert.notEqual(harnessProfileId('Caps'), harnessProfileId('caps'))
    for (const name of ['A'.repeat(64), `A${'-'.repeat(63)}`, `A${'_'.repeat(63)}`]) {
        const id = harnessProfileId(name)
        assert.match(id, HERMES_PROFILE_ID)
        assert.ok(id.length <= 64)
        assert.ok(!id.slice(0, -9).endsWith('-') && !id.slice(0, -9).endsWith('_'))
        assert.equal(harnessProfileId(id), id)
        const child = specialistProfileName(id, 'long-reader-name')
        assert.match(child, HERMES_PROFILE_ID)
        assert.ok(child.length <= 64)
    }
})

test('lowercase installs and try profiles keep their existing directories', () => {
    const record = save('unchanged-lower')
    const compiled = compileProfile(record)
    const before = stat(compiled.dir)
    assert.equal(compiled.dir, profileDir(record.name))
    assert.equal(migrateHarnessProfiles(record), 0)
    assert.deepEqual(stat(compiled.dir), before)
    const trial = compileTryProfile(record, 'abcdef12')
    assert.equal(trial.dir, profileDir('tryabcdef12'))
    assert.equal(trial.roster.specialists[0].profileName, 'tryabcdef12--reader')
})

test('boot moves the legacy chief, specialists and workspaces once and recompiles version 11', () => {
    const { record, legacy } = legacyFixture('TigerUpgrade')
    const id = harnessProfileId(record.name)
    const child = specialistProfileName(id, 'reader')
    const chiefSession = stat(file(record.name, 'sessions.sqlite'))
    const specialistSession = stat(file(legacy, 'sessions.sqlite'))
    const workspace = stat(specialistWorkspace(legacy))
    assert.deepEqual(recompileOutdatedProfiles([record], { log: quiet }), [{ name: record.name, status: 'recompiled' }])
    assert.equal(fs.existsSync(profileDir(record.name)), false)
    assert.equal(fs.existsSync(profileDir(legacy)), false)
    assert.equal(fs.existsSync(specialistWorkspace(legacy)), false)
    assert.deepEqual(stat(file(id, 'sessions.sqlite')), chiefSession)
    assert.deepEqual(stat(file(child, 'sessions.sqlite')), specialistSession)
    assert.deepEqual(stat(specialistWorkspace(child)), workspace)
    assert.equal(read(id, 'memories/MEMORY.md'), 'chief memory')
    assert.equal(read(child, 'memories/MEMORY.md'), 'specialist memory')
    assert.equal(fs.readFileSync(path.join(specialistWorkspace(child), 'notes.txt'), 'utf8'), 'workspace memory')
    assert.equal(read(child, 'harness-parent').trim(), record.name)
    assert.equal(JSON.parse(read(id, 'harness-roster.json')).name, record.name)
    assert.equal(PROFILE_COMPILER_VERSION, '11')
    for (const profile of [id, child]) assert.equal(read(profile, 'harness-compiler').trim(), '11')
    const paths = [
        profileDir(id),
        profileDir(child),
        file(id, 'config.yaml'),
        file(child, 'config.yaml'),
        file(id, '.env'),
        file(child, '.env'),
        specialistWorkspace(child)
    ]
    const before = paths.map(stat)
    assert.equal(migrateHarnessProfiles(record), 0)
    assert.deepEqual(recompileOutdatedProfiles([record], { log: quiet }), [])
    assert.deepEqual(paths.map(stat), before)
})

test('router session open migrates before a compile and preserves existing messages', () => {
    const record = save('RouterUpgrade')
    // Build a real pre-upgrade session database using the old exact-name path.
    appendMessage('router-fixture-source', 'chat', 'user', 'kept router question')
    closeSessions()
    fs.mkdirSync(profileDir(record.name), { recursive: true })
    fs.renameSync(file('router-fixture-source', 'sessions.sqlite'), file(record.name, 'sessions.sqlite'))
    // Stored session keys keep the original exact harness identity.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(file(record.name, 'sessions.sqlite'))
    db.exec(
        "UPDATE sessions SET session_key = 'RouterUpgrade:chat', harness_name = 'RouterUpgrade'; UPDATE messages SET session_key = 'RouterUpgrade:chat'"
    )
    db.close()
    assert.equal(readMessages(record.name, 'chat')[0].content, 'kept router question')
    assert.equal(fs.existsSync(profileDir(record.name)), false)
    assert.ok(fs.existsSync(file(harnessProfileId(record.name), 'sessions.sqlite')))
})

test('migration skips links, foreign ownership and occupied destinations', () => {
    const record = save('GuardedCase')
    const id = harnessProfileId(record.name)
    const child = specialistProfileName('guardedcase', 'reader')
    put('foreign-chief', 'harness-roster.json', JSON.stringify({ name: 'foreign-chief' }))
    fs.symlinkSync(profileDir('foreign-chief'), profileDir(record.name))
    assert.equal(migrateHarnessProfiles(record), 0)
    assert.equal(fs.lstatSync(profileDir(record.name)).isSymbolicLink(), true)
    fs.unlinkSync(profileDir(record.name))
    fs.writeFileSync(profileDir(record.name), 'not a directory')
    assert.equal(migrateHarnessProfiles(record), 0)
    fs.unlinkSync(profileDir(record.name))
    put(record.name, 'harness-roster.json', JSON.stringify({ name: 'someone-else' }))
    put(child, 'harness-parent', 'guardedcase\n')
    assert.equal(migrateHarnessProfiles(record), 0)
    put(record.name, 'harness-roster.json', JSON.stringify(record))
    put(id, 'keep.txt', 'occupied')
    assert.equal(migrateHarnessProfiles(record), 0)
    assert.equal(read(id, 'keep.txt'), 'occupied')
    assert.ok(fs.existsSync(profileDir(record.name)))
})

test('capitalised and lowercase names compile into distinct bounded profiles and tokens offline', () => {
    const ids = new Set()
    const tokens = new Set()
    for (const name of ['Caps', 'caps', 'A'.repeat(64)]) {
        const record = save(name)
        const compiled = compileProfile(record)
        const chiefId = harnessProfileId(name)
        assert.equal(compiled.dir, profileDir(chiefId))
        for (const [id, role] of [[chiefId, 'chief'], ...compiled.roster.specialists.map((s) => [s.profileName, 'specialist'])]) {
            assert.match(id, HERMES_PROFILE_ID)
            assert.ok(id.length <= 64)
            assert.equal(ids.has(id), false)
            ids.add(id)
            const env = readProfileEnv(id)
            assert.equal(env.CUTTLELY_GATEWAY_HARNESS, name)
            assert.equal(env.CUTTLELY_GATEWAY_ROLE, role)
            assert.equal(tokens.has(env.OPENAI_API_KEY), false)
            tokens.add(env.OPENAI_API_KEY)
            assert.equal(profileTokenKnown(env.OPENAI_API_KEY), true)
        }
    }
    assert.equal(ids.size, 9)
    assert.equal(tokens.size, 9)
})

for (const name of ['TransportCaps', 'B'.repeat(64)]) {
    test(`agent transport uses the scoped profile and bearer for a ${name.length}-character saved name offline`, async () => {
        const record = save(name)
        const calls = []
        const result = await agent(record, 'http://127.0.0.1:8642', async (url, options) => {
            const id = new URL(url).pathname.split('/')[2]
            assert.match(id, HERMES_PROFILE_ID)
            assert.ok(fs.existsSync(file(id, 'config.yaml')))
            assert.equal(options.headers.authorization, `Bearer ${readProfileEnv(id).API_SERVER_KEY}`)
            calls.push({ url, method: options.method })
            return new Response(JSON.stringify({ run_id: 'offline-chief', status: 'completed', output: 'Chief answer.' }))
        })
        assert.equal(result.text, 'Chief answer.')
        assert.deepEqual(calls, [{ url: `http://127.0.0.1:8642/p/${harnessProfileId(name)}/v1/runs`, method: 'POST' }])
        const runs = listRuns(name)
        assert.equal(runs.length, 1)
        assert.equal(runs[0].mode, 'agent')
        assert.equal(runs[0].status, 'succeeded')
    })
}

test('boot replaces a migrated token even when the record, gateway and model are unchanged offline', () => {
    const { record, stale } = legacyTokenFixture('OfflineTokenUpgrade')
    assert.equal(profileTokenKnown(stale), true)
    assert.deepEqual(recompileOutdatedProfiles([record], { log: quiet }), [{ name: record.name, status: 'recompiled' }])
    const token = readProfileEnv(harnessProfileId(record.name)).OPENAI_API_KEY
    assert.notEqual(token, stale)
    assert.equal(profileTokenKnown(stale), false)
    forgetProfileToken(token)
    bootHarnessGateway()
    assert.equal(profileTokenKnown(token), true)
    assert.equal(profileTokenKnown(stale), false)
})

test('migration recovers a marked legacy specialist absent from the current rosters', () => {
    const record = save('MissingChief')
    const legacy = specialistProfileName('missingchief', 'retired')
    const next = specialistProfileName(harnessProfileId(record.name), 'retired')
    put(legacy, 'harness-parent', record.name)
    put(legacy, '.env', 'CUTTLELY_GATEWAY_SPECIALIST=retired\n')
    put(legacy, 'memories/MEMORY.md', 'surviving memory')
    fs.mkdirSync(specialistWorkspace(legacy), { recursive: true })
    assert.equal(migrateHarnessProfiles(record), 2)
    assert.equal(read(next, 'memories/MEMORY.md'), 'surviving memory')
    assert.equal(fs.existsSync(profileDir(legacy)), false)
    assert.ok(fs.existsSync(specialistWorkspace(next)))
    assert.equal(migrateHarnessProfiles(record), 0)
})

test('Caps and caps keep separate mixed-model profiles, gateway bindings and agent runs', async (t) => {
    const { request, resolved, lines } = await gatewayFixture(t)
    const runtime = await runtimeFixture(t)
    const lower = save('caps')
    const lowerCompiled = compileProfile(lower)
    const lowerPaths = [lowerCompiled.dir, ...lowerCompiled.roster.specialists.map((s) => profileDir(s.profileName))]
    const lowerStats = lowerPaths.map(stat)
    const upper = save('Caps')
    assert.equal(migrateHarnessProfiles(upper), 0, 'the lowercase harness owns its folders')
    const upperCompiled = compileProfile(upper)
    assert.deepEqual(lowerPaths.map(stat), lowerStats)
    const ids = new Set()
    const tokens = new Set()
    for (const [record, compiled] of [
        [upper, upperCompiled],
        [lower, lowerCompiled]
    ]) {
        const chiefId = harnessProfileId(record.name)
        assert.equal(compiled.dir, profileDir(chiefId))
        assert.equal(new Set(compiled.roster.specialists.map((s) => s.model.inputs.modelName)).size, 2)
        for (const [id, role, slug] of [
            [chiefId, 'chief', undefined],
            ...compiled.roster.specialists.map((s) => [s.profileName, 'specialist', s.name])
        ]) {
            assert.equal(ids.has(id), false)
            ids.add(id)
            if (slug) assert.equal(id, specialistProfileName(chiefId, slug))
            const env = readProfileEnv(id)
            assert.equal(env.CUTTLELY_GATEWAY_HARNESS, record.name)
            assert.equal(tokens.has(env.OPENAI_API_KEY), false)
            tokens.add(env.OPENAI_API_KEY)
            const response = await request(env.OPENAI_API_KEY)
            const payload = await response.json()
            assert.equal(response.status, 200)
            assert.equal(payload.choices[0].message.content, `Answer from ${slug ? `${slug}-model` : 'chief-model'}`)
            assert.equal(resolved.at(-1), record.name)
            assert.ok(lines.some((line) => line.includes(`completion role=${role} harness=${record.name} profile=${id} `)))
        }
        const result = await agent(record, runtime.baseUrl)
        assert.equal(result.text, 'Chief answer.')
        const runs = listRuns(record.name)
        assert.equal(runs.length, 1)
        assert.equal(runs[0].mode, 'agent')
        assert.equal(runs[0].status, 'succeeded')
    }
    assert.equal(ids.size, 6)
    assert.equal(tokens.size, 6)
    assert.deepEqual(
        runtime.calls.filter((c) => c.method === 'POST').map((c) => c.url),
        [`/p/${harnessProfileId('Caps')}/v1/runs`, '/p/caps/v1/runs']
    )
    bootHarnessGateway()
    for (const token of tokens) assert.equal(profileTokenKnown(token), true)
})

test('upgrade rotates the chief gateway token and reload accepts the new exact-owner binding', async (t) => {
    const { request, resolved, lines } = await gatewayFixture(t)
    const { record, stale } = legacyTokenFixture('TokenUpgrade')
    assert.equal(profileTokenKnown(stale), true)
    assert.deepEqual(recompileOutdatedProfiles([record], { log: quiet }), [{ name: record.name, status: 'recompiled' }])
    const token = readProfileEnv(harnessProfileId(record.name)).OPENAI_API_KEY
    assert.notEqual(token, stale)
    assert.equal(profileTokenKnown(stale), false)
    forgetProfileToken(token)
    bootHarnessGateway()
    const accepted = await request(token)
    assert.equal(accepted.status, 200)
    await accepted.json()
    assert.equal(resolved.at(-1), record.name)
    assert.ok(lines.some((line) => line.includes(`completion role=chief harness=${record.name} profile=${harnessProfileId(record.name)} `)))
    const rejected = await request(stale)
    assert.equal(rejected.status, 401)
    await rejected.json()
})

for (const name of ['TigerMom', 'A'.repeat(64)]) {
    test(`agent mode reaches the chief for ${name.length === 64 ? 'a 64-character capitalised name' : 'TigerMom'} once`, async (t) => {
        await gatewayFixture(t)
        const runtime = await runtimeFixture(t)
        const record = save(name)
        const compiled = compileProfile(record)
        const id = harnessProfileId(name)
        assert.match(id, HERMES_PROFILE_ID)
        assert.ok(id.length <= 64)
        for (const specialist of compiled.roster.specialists) {
            assert.match(specialist.profileName, HERMES_PROFILE_ID)
            assert.ok(specialist.profileName.length <= 64)
            assert.equal(specialist.profileName, specialistProfileName(id, specialist.name))
        }
        const result = await agent(record, runtime.baseUrl)
        assert.equal(result.text, 'Chief answer.')
        assert.equal(result.mode, 'agent')
        assert.deepEqual(
            runtime.calls.map((c) => c.url),
            [`/p/${id}/v1/runs`]
        )
        const runs = listRuns(name)
        assert.equal(runs.length, 1)
        assert.equal(runs[0].status, 'succeeded')
    })
}

test('cleanup attributes hashed profiles to exact saved names', async () => {
    const record = save('CleanCaps')
    const compiled = compileProfile(record)
    const lower = save('cleancaps')
    compileProfile(lower)
    const id = harnessProfileId(record.name)
    assert.ok(
        nameReuseBlockers('CleanCaps').every((entry) => entry.includes(id)),
        'only this exact runtime prefix is considered'
    )
    const previous = { ...cleanupHooks }
    cleanupHooks.close = async () => true
    cleanupHooks.revoke = () => {}
    cleanupHooks.log = () => {}
    try {
        const sweep = await sweepOrphanHarnessProfiles({ mode: 'delete', now: Date.now() + 1e9 })
        assert.equal(sweep.removed.includes(id), false)
        const outcome = await deleteHarnessAndProfiles(record.name)
        assert.ok(outcome.removed.includes(id))
        assert.equal(fs.existsSync(compiled.dir), false)
        assert.ok(fs.existsSync(profileDir(lower.name)))
        for (const s of compiled.roster.specialists) assert.equal(fs.existsSync(profileDir(s.profileName)), false)
    } finally {
        Object.assign(cleanupHooks, previous)
        deleteHarness(lower.name)
    }
})
