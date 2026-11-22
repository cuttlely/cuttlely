import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-profile-tombstones-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'hermes')
process.env.HERMES_HOME = process.env.CUTTLELY_HERMES_HOME
const profiles = path.join(process.env.HERMES_HOME, 'profiles')
const { listDirNoFollow } = await import('../packages/harness/contained-walk.mjs')
const { startGateway, profileTokenKnown, sweepAbandonedTryProfiles } = await import('../packages/harness/gateway.mjs')
const { compileProfile, compileTryProfile, discardTryProfile, markProfileDeleted, tryRuntime } = await import(
    '../packages/harness/profile.mjs'
)
const { saveHarness } = await import('../packages/harness/store.mjs')
const { hermesProfileId } = await import('../packages/harness/paths.mjs')
const { endLiveTry, noteLiveTry } = await import('../packages/harness/try-live.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

function fixture(scope, child = `${scope}--worker`) {
    fs.mkdirSync(path.join(profiles, scope), { recursive: true })
    fs.writeFileSync(path.join(profiles, scope, 'harness-try'), `${scope}\n`)
    fs.mkdirSync(path.join(profiles, child), { recursive: true })
    fs.writeFileSync(path.join(profiles, child, 'harness-parent'), `${scope}\n`)
    return [scope, child]
}

function assertDeleted(name) {
    assert.equal(fs.readFileSync(path.join(profiles, '.deleted', name), 'utf8'), 'deleted\n')
}

test('abandoned try sweep writes Hermes markers before removing parent and specialist trees', () => {
    const names = fixture('try1234abcd')
    const rmdir = fs.rmdirSync
    const checked = new Set()
    fs.rmdirSync = function (target, ...args) {
        const resolved = fs.realpathSync(target)
        for (const name of names) {
            if (resolved !== path.join(profiles, name)) continue
            assertDeleted(name)
            checked.add(name)
        }
        return rmdir.call(fs, target, ...args)
    }
    try {
        const swept = sweepAbandonedTryProfiles()
        for (const name of names) {
            assert.ok(swept.has(name))
            assert.ok(checked.has(name))
            assertDeleted(name)
            assert.equal(fs.existsSync(path.join(profiles, name)), false)
        }
    } finally {
        fs.rmdirSync = rmdir
    }
})

test('try teardown marks deletion before runtime close and retains the late-mkdir guard', async () => {
    const id = '4567abcd'
    const names = fixture(`try${id}`)
    tryRuntime.closeProfiles = async (closed) => {
        assert.deepEqual(new Set(closed), new Set(names))
        for (const name of names) {
            assertDeleted(name)
            assert.ok(fs.statSync(path.join(profiles, name)).isDirectory())
        }
    }
    tryRuntime.afterFirstRemoval = () => {
        for (const name of names) {
            assert.equal(fs.existsSync(path.join(profiles, name)), false)
            // A stale runtime may still write. Its directory stays hidden by the persistent marker.
            fs.mkdirSync(path.join(profiles, name, 'logs'), { recursive: true })
        }
    }
    const writeFile = fs.writeFileSync
    const guarded = new Set()
    fs.writeFileSync = function (target, ...args) {
        const result = writeFile.call(fs, target, ...args)
        for (const name of names) {
            if (String(target) !== path.join(profiles, name)) continue
            assertDeleted(name)
            assert.throws(() => fs.mkdirSync(path.join(profiles, name, 'logs'), { recursive: true }), { code: 'ENOTDIR' })
            guarded.add(name)
        }
        return result
    }
    try {
        await discardTryProfile(id)
        assert.deepEqual(guarded, new Set(names))
        for (const name of names) {
            assertDeleted(name)
            assert.equal(fs.existsSync(path.join(profiles, name)), false)
        }
    } finally {
        fs.writeFileSync = writeFile
        tryRuntime.closeProfiles = null
        tryRuntime.afterFirstRemoval = null
    }
})

test('successful recompilation clears the parent and specialist Hermes markers', () => {
    const id = '89abcdef'
    const scope = `try${id}`
    const names = [scope, `${scope}--worker`]
    for (const name of names) markProfileDeleted(name)
    const model = { nodeName: 'chatXAI', inputs: { modelName: 'grok-4.7' } }
    compileTryProfile({ name: 'fixture-team', chief: { model }, specialists: [{ name: 'worker', model, shell: true, modules: [] }] }, id)
    for (const name of names) {
        assert.equal(fs.existsSync(path.join(profiles, '.deleted', name)), false)
        assert.ok(fs.statSync(path.join(profiles, name, 'config.yaml')).isFile())
    }
})

test('.deleted is excluded from profile listing, gateway ingest and sweeping', async () => {
    const token = 'T'.repeat(43)
    const record = saveHarness({
        name: 'tombstone-fixture',
        chief: { model: { nodeName: 'unused' } },
        specialists: [{ name: 'worker', modules: [] }]
    })
    fs.writeFileSync(path.join(profiles, '.deleted', 'harness-try'), '.deleted\n')
    fs.writeFileSync(
        path.join(profiles, '.deleted', '.env'),
        `OPENAI_API_KEY=${token}\nOPENAI_BASE_URL=http://127.0.0.1:43118/v1\nCUTTLELY_GATEWAY_HARNESS=${record.name}\nCUTTLELY_GATEWAY_SPECIALIST=worker\nCUTTLELY_GATEWAY_CREATED=${record.createdAt}\n`
    )
    assert.equal(listDirNoFollow(profiles).includes('.deleted'), false)
    assert.equal(sweepAbandonedTryProfiles().has('.deleted'), false)
    const gateway = await startGateway({ port: 0 })
    try {
        assert.equal(profileTokenKnown(token), false)
        assert.ok(fs.statSync(path.join(profiles, '.deleted')).isDirectory())
    } finally {
        await gateway.close()
    }
})

test('sweeping preserves live tries, saved harnesses and unmarked try-like directories', () => {
    const live = 'tryaabbccdd'
    const saved = 'tryddccbbaa'
    const unmarked = 'try11223344'
    const kept = [...fixture(live), ...fixture(saved), unmarked]
    fs.mkdirSync(path.join(profiles, unmarked))
    // Older saved records may already have a name now reserved for tries.
    fs.writeFileSync(path.join(dir, 'harnesses', `${saved}.json`), JSON.stringify({ name: saved }))
    noteLiveTry(live)
    try {
        const swept = sweepAbandonedTryProfiles()
        for (const name of kept) {
            assert.equal(swept.has(name), false)
            assert.ok(fs.statSync(path.join(profiles, name)).isDirectory())
            assert.equal(fs.existsSync(path.join(profiles, '.deleted', name)), false)
        }
    } finally {
        endLiveTry(live)
    }
})

test('supervisor sweep entry removes an abandoned try without starting a server', () => {
    const names = fixture('trycafe1234')
    const result = spawnSync(process.execPath, ['scripts/sweep-try-profiles.mjs'], { encoding: 'utf8', env: process.env })
    assert.equal(result.status, 0, result.stderr)
    for (const name of names) {
        assertDeleted(name)
        assert.equal(fs.existsSync(path.join(profiles, name)), false)
    }
})

test('tombstone writes reject path components and linked marker directories', () => {
    assert.throws(() => markProfileDeleted('../escaped'), { code: 'bad_name' })
    const markers = path.join(profiles, '.deleted')
    const held = path.join(profiles, '.deleted-held')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.renameSync(markers, held)
    fs.symlinkSync(outside, markers)
    try {
        assert.throws(() => markProfileDeleted('tryfeed1234'))
        assert.equal(fs.existsSync(path.join(outside, 'tryfeed1234')), false)
    } finally {
        if (fs.existsSync(markers)) fs.rmSync(markers, { force: true })
        fs.renameSync(held, markers)
    }
})

test('a legacy child name that cannot be tombstoned still gets removed without stopping the sweep', () => {
    const names = fixture('trydead1234', 'trydead1234--legacy.invalid')
    const others = fixture('tryface5678')
    const swept = sweepAbandonedTryProfiles()
    for (const name of [...names, ...others]) {
        assert.ok(swept.has(name))
        assert.equal(fs.existsSync(path.join(profiles, name)), false)
    }
})

test('clearing a deletion marker preserves supported mixed-case harness names', () => {
    const record = { name: 'MarkerTeam', chief: { model: { nodeName: 'unused' } }, specialists: [] }
    const id = hermesProfileId(record.name)
    assert.equal(id, 'markerteam')
    compileProfile(record)
    markProfileDeleted(id)
    assertDeleted(id)
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', record.name)), false)
    compileProfile(record)
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', id)), false)
    assert.equal(fs.existsSync(path.join(profiles, '.deleted', record.name)), false)
    assert.ok(fs.statSync(path.join(profiles, 'markerteam', 'config.yaml')).isFile())
})
