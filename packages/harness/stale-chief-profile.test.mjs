import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

// A lowercase chief folder left by a deleted spelling (for example "acme-agentic", deleted before #285 removed profile
// folders) must not block the saved capitalised harness ("Acme-Agentic") after chief ids became lowercase (#554).
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stale-chief-'))
process.env.HOME = top
process.env.DATABASE_PATH = top
const { saveHarness, listHarnesses, getHarness } = await import('./store.mjs')
const { HarnessError } = await import('./errors.mjs')
const {
    PROFILE_COMPILER_VERSION,
    STALE_CHIEFS_DIR,
    compileProfile,
    compileProfileCached,
    profileDestinationConflicts,
    recompileOutdatedProfiles,
    staleChiefOwner
} = await import('./profile.mjs')
const { appendTurn, closeSessions, readMessages } = await import('./session.mjs')
const { startGateway } = await import('./gateway.mjs')
const { cleanupHooks, sweepOrphanHarnessProfiles } = await import('./cleanup.mjs')

let gateway
let n = 0
before(async () => {
    cleanupHooks.log = () => {}
    cleanupHooks.revoke = () => {}
    gateway = await startGateway({ port: 0 })
    process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
})
after(async () => {
    closeSessions()
    await gateway?.close()
    fs.rmSync(top, { recursive: true, force: true })
})

function freshHome() {
    closeSessions()
    const dir = path.join(top, `case-${(n += 1)}`)
    fs.mkdirSync(dir)
    process.env.CUTTLELY_DATA_DIR = dir
    process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
    return dir
}
const profiles = () => path.join(process.env.CUTTLELY_HERMES_HOME, 'profiles')
const parkRoot = () => path.join(process.env.CUTTLELY_HERMES_HOME, STALE_CHIEFS_DIR)
const chief = { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } }
const save = (name, createdAt = '2026-10-22T17:30:19.771Z') =>
    saveHarness({
        name,
        createdAt,
        workspaceId: 'fixture-workspace',
        chief,
        specialists: [{ name: 'resources', model: { nodeName: 'fixtureChat', inputs: { modelName: 'm' } } }]
    })
const boot = () => recompileOutdatedProfiles(listHarnesses(), { log: { info() {}, warn() {} } })
const roster = (entry) => JSON.parse(fs.readFileSync(path.join(profiles(), entry, 'harness-roster.json'), 'utf8')).name

// The upgrade state: stale lowercase chief of a deleted "acme-agentic" (roster only, no parent marker, as compiler 10 wrote
// chiefs) beside the legacy capitalised chief of the saved "Acme-Agentic", which holds router history and memory.
function seedLeftoverState({ legacy = true } = {}) {
    freshHome()
    compileProfile(save('acme-agentic', '2026-10-20T00:00:00.000Z'))
    fs.rmSync(path.join(process.env.CUTTLELY_DATA_DIR, 'harnesses', 'acme-agentic.json'))
    fs.rmSync(path.join(profiles(), 'acme-agentic', 'harness-parent'), { force: true })
    fs.writeFileSync(path.join(profiles(), 'acme-agentic', 'memory', 'MEMORY.md'), 'stale memory\n')
    // Compiled by an older server, so boot recompiles Acme-Agentic.
    fs.writeFileSync(path.join(profiles(), 'acme-agentic', 'harness-compiler'), '10\n')
    // Acme-Agentic's first compile took over the shared specialist folder before #285 added the destination check.
    fs.writeFileSync(path.join(profiles(), 'acme-agentic--resources', 'harness-parent'), 'Acme-Agentic\n')
    const record = save('Acme-Agentic')
    if (legacy) {
        const folder = path.join(profiles(), 'Acme-Agentic')
        fs.cpSync(path.join(profiles(), 'acme-agentic'), folder, { recursive: true })
        fs.writeFileSync(
            path.join(folder, 'harness-roster.json'),
            JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(folder, 'harness-roster.json'), 'utf8')), name: 'Acme-Agentic' })
        )
        fs.writeFileSync(path.join(folder, 'memory', 'MEMORY.md'), 'Acme-Agentic memory\n')
        fs.rmSync(path.join(folder, 'sessions.sqlite'), { force: true })
    }
    return record
}

test('a stale lowercase chief of a deleted spelling is parked, and the legacy chief keeps its router history and memory', () => {
    seedLeftoverState()
    // Router turns written before the upgrade, straight into the legacy folder (the pre-#554 path).
    const legacyDb = path.join(profiles(), 'Acme-Agentic', 'sessions.sqlite')
    const scope = 'a'.repeat(64)
    appendTurn('Acme-Agentic', 'router-chat', 'old question', 'old answer', [], undefined, { scope })
    closeSessions()
    fs.renameSync(path.join(process.env.CUTTLELY_DATA_DIR, 'harness-draft-sessions', scope, 'sessions.sqlite'), legacyDb)
    assert.equal(staleChiefOwner('Acme-Agentic'), 'acme-agentic')
    assert.deepEqual(profileDestinationConflicts(getHarness('Acme-Agentic')), [])

    const results = boot()
    assert.deepEqual(
        results.filter((row) => row.name === 'Acme-Agentic').map((row) => row.status),
        ['recompiled']
    )
    assert.equal(roster('acme-agentic'), 'Acme-Agentic')
    assert.equal(fs.readFileSync(path.join(profiles(), 'acme-agentic', 'harness-parent'), 'utf8').trim(), 'Acme-Agentic')
    assert.equal(fs.readFileSync(path.join(profiles(), 'acme-agentic', 'memory', 'MEMORY.md'), 'utf8'), 'Acme-Agentic memory\n')
    assert.ok(!fs.existsSync(path.join(profiles(), 'Acme-Agentic')))
    assert.deepEqual(
        readMessages('Acme-Agentic', 'router-chat').map((m) => m.content),
        ['old question', 'old answer']
    )
    // Parked, not deleted, with its owner noted; outside profiles/ so the runtime never serves it.
    const parked = fs.readdirSync(parkRoot()).filter((entry) => !entry.endsWith('.owner'))
    assert.equal(parked.length, 1)
    assert.match(parked[0], /^acme-agentic-[a-f0-9]{12}$/)
    assert.equal(fs.readFileSync(path.join(parkRoot(), `${parked[0]}.owner`), 'utf8'), 'acme-agentic\n')
    assert.equal(fs.readFileSync(path.join(parkRoot(), parked[0], 'memory', 'MEMORY.md'), 'utf8'), 'stale memory\n')
    // A second boot changes nothing.
    boot()
    assert.equal(fs.readdirSync(parkRoot()).length, 2)
    assert.doesNotThrow(() => compileProfileCached(getHarness('Acme-Agentic')))
})

test('without a legacy folder the stale chief is parked and boot compiles a fresh chief before the runtime starts', () => {
    seedLeftoverState({ legacy: false })
    const results = boot()
    assert.deepEqual(
        results.filter((row) => row.name === 'Acme-Agentic').map((row) => row.status),
        ['recompiled']
    )
    // The runtime reads this folder only after boot returns; it now holds the compiled chief of the saved harness.
    const chiefDir = path.join(profiles(), 'acme-agentic')
    assert.equal(roster('acme-agentic'), 'Acme-Agentic')
    assert.equal(fs.readFileSync(path.join(chiefDir, 'harness-parent'), 'utf8').trim(), 'Acme-Agentic')
    assert.equal(fs.readFileSync(path.join(chiefDir, 'harness-compiler'), 'utf8').trim(), PROFILE_COMPILER_VERSION)
    assert.match(fs.readFileSync(path.join(chiefDir, 'config.yaml'), 'utf8'), /roster/)
    assert.notEqual(fs.readFileSync(path.join(chiefDir, 'memory', 'MEMORY.md'), 'utf8'), 'stale memory\n')
    const parked = fs.readdirSync(parkRoot()).filter((entry) => !entry.endsWith('.owner'))
    assert.equal(parked.length, 1)
    assert.equal(fs.readFileSync(path.join(parkRoot(), parked[0], 'memory', 'MEMORY.md'), 'utf8'), 'stale memory\n')
    assert.doesNotThrow(() => compileProfileCached(getHarness('Acme-Agentic')))
    // A second boot finds nothing to do.
    assert.deepEqual(boot(), [])
    assert.equal(fs.readdirSync(parkRoot()).length, 2)
})

test('a move-aside that fails leaves every folder as it was and the compile refuses with name_taken', () => {
    seedLeftoverState()
    // The park root cannot be created (a file holds its name), standing in for any move that fails, such as EXDEV.
    fs.mkdirSync(process.env.CUTTLELY_HERMES_HOME, { recursive: true })
    fs.writeFileSync(parkRoot(), 'not a folder\n')
    assert.equal(staleChiefOwner('Acme-Agentic'), 'acme-agentic')
    assert.throws(() => compileProfile(getHarness('Acme-Agentic')), { code: 'name_taken' })
    assert.deepEqual(
        boot()
            .filter((row) => row.name === 'Acme-Agentic')
            .map((row) => row.status),
        ['failed']
    )
    assert.equal(roster('acme-agentic'), 'acme-agentic')
    assert.ok(!fs.existsSync(path.join(profiles(), 'acme-agentic', 'harness-parent')))
    assert.equal(fs.readFileSync(path.join(profiles(), 'acme-agentic', 'memory', 'MEMORY.md'), 'utf8'), 'stale memory\n')
    assert.equal(fs.readFileSync(path.join(profiles(), 'Acme-Agentic', 'memory', 'MEMORY.md'), 'utf8'), 'Acme-Agentic memory\n')
    assert.equal(fs.readFileSync(parkRoot(), 'utf8'), 'not a folder\n')
})

test('the park folder is outside profiles/ and the orphan sweep never touches it', async () => {
    seedLeftoverState()
    boot()
    const home = process.env.CUTTLELY_HERMES_HOME
    assert.equal(path.dirname(parkRoot()), home)
    assert.ok(!fs.readdirSync(profiles()).some((entry) => entry.includes('stale') || /^acme-agentic-[a-f0-9]{12}$/.test(entry)))
    const before = fs.readdirSync(parkRoot()).sort()
    const parked = before.find((entry) => !entry.endsWith('.owner'))
    const memory = fs.readFileSync(path.join(parkRoot(), parked, 'memory', 'MEMORY.md'), 'utf8')
    // Delete mode, an hour later: a sweep that looked at the park folder would remove the deleted owner's files.
    const result = await sweepOrphanHarnessProfiles({ mode: 'delete', now: Date.now() + 60 * 60 * 1000 })
    assert.ok(![...result.orphans, ...result.removed, ...result.skipped].some((entry) => String(entry).includes(parked)))
    assert.deepEqual(fs.readdirSync(parkRoot()).sort(), before)
    assert.equal(fs.readFileSync(path.join(parkRoot(), parked, 'memory', 'MEMORY.md'), 'utf8'), memory)
    assert.equal(roster('acme-agentic'), 'Acme-Agentic')
})

test('a lowercase chief whose owner is still saved is never parked', () => {
    freshHome()
    compileProfile(save('acme-agentic', '2026-10-20T00:00:00.000Z'))
    save('Acme-Agentic')
    assert.equal(staleChiefOwner('Acme-Agentic'), '')
    assert.throws(
        () => compileProfile(getHarness('Acme-Agentic')),
        (error) => error instanceof HarnessError && error.code === 'bad_name'
    )
    assert.ok(!fs.existsSync(parkRoot()))
    assert.equal(roster('acme-agentic'), 'acme-agentic')
})

test('a staged delete (.json.deleting) of the lowercase owner still counts as saved', () => {
    seedLeftoverState()
    const store = path.join(process.env.CUTTLELY_DATA_DIR, 'harnesses')
    fs.writeFileSync(path.join(store, 'acme-agentic.json.deleting'), '{}')
    assert.equal(staleChiefOwner('Acme-Agentic'), '')
    assert.ok(!fs.existsSync(parkRoot()))
})

test('a try folder, a link, disagreeing markers or an unrelated owner are not parked', () => {
    for (const mutate of [
        (dir) => fs.writeFileSync(path.join(dir, 'harness-try'), 'try\n'),
        (dir) => fs.writeFileSync(path.join(dir, 'harness-parent'), 'someone-else\n'),
        (dir) =>
            fs.writeFileSync(
                path.join(dir, 'harness-roster.json'),
                JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'harness-roster.json'), 'utf8')), name: 'other' })
            )
    ]) {
        seedLeftoverState()
        mutate(path.join(profiles(), 'acme-agentic'))
        assert.equal(staleChiefOwner('Acme-Agentic'), '')
    }
    seedLeftoverState()
    const real = path.join(process.env.CUTTLELY_DATA_DIR, 'elsewhere')
    fs.renameSync(path.join(profiles(), 'acme-agentic'), real)
    fs.symlinkSync(real, path.join(profiles(), 'acme-agentic'))
    assert.equal(staleChiefOwner('Acme-Agentic'), '')
})

test('a missing or different store never parks a lowercase chief', () => {
    seedLeftoverState()
    const data = process.env.CUTTLELY_DATA_DIR
    process.env.CUTTLELY_DATA_DIR = path.join(data, 'no-store-here')
    try {
        assert.equal(staleChiefOwner('Acme-Agentic'), '')
        assert.throws(() => compileProfile(getHarness('Acme-Agentic') || { name: 'Acme-Agentic', chief, specialists: [] }), {
            code: 'name_taken'
        })
    } finally {
        process.env.CUTTLELY_DATA_DIR = data
    }
    assert.ok(!fs.existsSync(parkRoot()))
    assert.equal(roster('acme-agentic'), 'acme-agentic')
})

test('an all-lowercase harness never parks its own folder', () => {
    freshHome()
    compileProfile(save('acme-agentic'))
    assert.equal(staleChiefOwner('acme-agentic'), '')
    assert.ok(boot().every((row) => row.status !== 'failed'))
    assert.ok(!fs.existsSync(parkRoot()))
})
