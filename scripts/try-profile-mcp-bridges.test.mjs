// A try turn's MCP bridges stop even when its folders stay, and the sweep stops bridges a dead runtime left
// behind. Published profile bridges are never touched. Linux only (the stop reads /proc).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-profile-mcp-bridges-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'hermes')
process.env.HERMES_HOME = process.env.CUTTLELY_HERMES_HOME
const profiles = path.join(process.env.HERMES_HOME, 'profiles')
const { discardTryProfile, removeTryProfileForFlow, tryIdForFlow, tryRuntime } = await import('../packages/harness/profile.mjs')
const { TRY_PROFILE_DIR_ENV, sweepOrphanTryBridges } = await import('../packages/harness/try-bridges.mjs')
const { endLiveTry, noteLiveTry } = await import('../packages/harness/try-live.mjs')
const spawned = []
after(() => {
    for (const child of spawned) {
        try {
            process.kill(-child.pid, 'SIGKILL')
        } catch {
            // Already gone.
        }
    }
    fs.rmSync(dir, { recursive: true, force: true })
})

const linux = process.platform === 'linux'

// A stdio MCP server the way the runtime starts one: its own process group, the profile env, the profile as cwd.
// It starts a grandchild in the same group, as npx does.
const BRIDGE = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' }); setInterval(() => {}, 1e9)`

function startBridge(entry, { marked = true } = {}) {
    const home = path.join(profiles, entry)
    const child = spawn(process.execPath, ['-e', BRIDGE], {
        cwd: home,
        detached: true,
        stdio: 'ignore',
        env: { PATH: process.env.PATH, ...(marked ? { [TRY_PROFILE_DIR_ENV]: home } : {}) }
    })
    spawned.push(child)
    return child
}

function groupMembers(pgid) {
    return fs
        .readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .filter((pid) => {
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
                const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
                return rest[0] !== 'Z' && Number(rest[2]) === pgid
            } catch {
                return false
            }
        }).length
}

async function waitFor(check, ms = 3000) {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    return check()
}

// Every process in the process groups this test started that is still running.
function bridgeCount() {
    return spawned.reduce((sum, child) => sum + groupMembers(child.pid), 0)
}

function tryFolders(scope, { sticky = false } = {}) {
    fs.mkdirSync(path.join(profiles, scope, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(profiles, scope, 'harness-try'), `${scope}\n`)
    fs.writeFileSync(path.join(profiles, scope, 'config.yaml'), 'mcp_servers: {}\n')
    if (sticky) fs.writeFileSync(path.join(profiles, scope, 'harness-try-keep'), `${scope}\n`)
    fs.mkdirSync(path.join(profiles, `${scope}--worker`), { recursive: true })
    fs.writeFileSync(path.join(profiles, `${scope}--worker`, 'harness-parent'), `${scope}\n`)
    fs.mkdirSync(path.join(dir, 'workspaces', `${scope}--worker`), { recursive: true })
}

test('N sticky try turns reuse their folders and leave the bridge count where it started', { skip: !linux }, async () => {
    fs.mkdirSync(path.join(profiles, 'finance'), { recursive: true })
    const published = startBridge('finance')
    assert.ok(await waitFor(() => groupMembers(published.pid) === 2))
    const before = bridgeCount()
    // The runtime close answers but leaves the bridges running, as the soak saw.
    tryRuntime.closeProfiles = async () => {}
    try {
        for (let turn = 0; turn < 20; turn += 1) {
            const id = 'a0000000'
            const scope = `try${id}`
            tryFolders(scope, { sticky: true })
            noteLiveTry(scope)
            const chief = startBridge(scope)
            const worker = startBridge(`${scope}--worker`)
            // An older bridge without the env marker is still found by its working folder.
            const legacy = startBridge(`${scope}--worker`, { marked: false })
            assert.ok(await waitFor(() => [chief, worker, legacy].every((child) => groupMembers(child.pid) === 2)))
            const rmdir = fs.rmdirSync
            let removedWhileRunning = 0
            fs.rmdirSync = function (target, ...args) {
                if (path.resolve(target).startsWith(path.join(profiles, scope)))
                    removedWhileRunning += [chief, worker, legacy].reduce((sum, child) => sum + groupMembers(child.pid), 0)
                return rmdir.call(fs, target, ...args)
            }
            try {
                await discardTryProfile(id)
            } finally {
                fs.rmdirSync = rmdir
            }
            assert.equal(removedWhileRunning, 0, 'a try folder was removed while its bridges still ran')
            assert.equal(fs.statSync(path.join(profiles, scope)).isDirectory(), true)
            assert.equal(fs.readFileSync(path.join(profiles, scope, 'harness-try-keep'), 'utf8').trim(), scope)
            assert.equal(fs.statSync(path.join(profiles, `${scope}--worker`)).isDirectory(), true)
            assert.equal(fs.existsSync(path.join(dir, 'workspaces', `${scope}--worker`)), true)
            assert.equal(fs.existsSync(path.join(profiles, scope, 'try.lock')), false)
            assert.equal(bridgeCount(), before, `bridges survived turn ${turn + 1}`)
        }
    } finally {
        tryRuntime.closeProfiles = null
    }
    assert.equal(bridgeCount(), before)
    assert.equal(groupMembers(published.pid), 2, 'a published bridge was stopped')
    // Teardown again is a no-op.
    await discardTryProfile('a0000000')
    assert.equal(groupMembers(published.pid), 2)
})

test(
    'the sweep stops try bridges whose folder is gone or whose runtime is dead, and keeps live and published ones',
    { skip: !linux },
    async () => {
        fs.mkdirSync(path.join(profiles, 'payroll'), { recursive: true })
        const published = startBridge('payroll')
        // A saved harness from before try names were reserved, and its specialist. Their bridges carry no try marker.
        fs.mkdirSync(path.join(dir, 'harnesses'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'harnesses', 'trydddd0001.json'), JSON.stringify({ name: 'trydddd0001' }))
        fs.mkdirSync(path.join(profiles, 'trydddd0001--sales'), { recursive: true })
        const tryLikePublished = startBridge('trydddd0001--sales', { marked: false })
        // Its folder was removed while it ran.
        const gone = 'trybbbb0001'
        fs.mkdirSync(path.join(profiles, gone), { recursive: true })
        const goneBridge = startBridge(gone)
        // Its folder is still there, but the runtime that started it is dead (re-parented) and no try turn holds it.
        const stale = 'trybbbb0002'
        tryFolders(stale, { sticky: true })
        // The server's try turn is still waiting on the dead runtime, so its lock is live.
        noteLiveTry(stale)
        const runtimeDir = path.join(dir, 'fake-runtime')
        fs.mkdirSync(runtimeDir, { recursive: true })
        const runtimeScript = path.join(runtimeDir, 'cuttlely-hermes-api.py')
        // A stand-in runtime whose command line matches the real one. It starts a bridge for the try named in argv.
        fs.writeFileSync(
            runtimeScript,
            `const { spawn } = require('child_process'); const home = process.argv[2];
         spawn(process.execPath, ['-e', ${JSON.stringify(
             BRIDGE
         )}], { cwd: home, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, ${TRY_PROFILE_DIR_ENV}: home } }).unref();
         setInterval(() => {}, 1e9)`
        )
        const live = 'trybbbb0003'
        tryFolders(live, { sticky: true })
        noteLiveTry(live)
        const runtime = spawn(process.execPath, [runtimeScript, path.join(profiles, live)], { stdio: 'ignore' })
        const deadRuntime = spawn(process.execPath, [runtimeScript, path.join(profiles, stale)], { stdio: 'ignore' })
        spawned.push(runtime, deadRuntime)
        const pgOfChild = (parent) => {
            for (const name of fs.readdirSync('/proc').filter((item) => /^\d+$/.test(item))) {
                try {
                    const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
                    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
                    if (Number(rest[1]) === parent && Number(rest[2]) === Number(name)) return Number(name)
                } catch {
                    // Gone.
                }
            }
            return 0
        }
        assert.ok(await waitFor(() => pgOfChild(runtime.pid) && pgOfChild(deadRuntime.pid)))
        const liveGroup = pgOfChild(runtime.pid)
        const staleGroup = pgOfChild(deadRuntime.pid)
        spawned.push({ pid: liveGroup }, { pid: staleGroup })
        assert.ok(
            await waitFor(() => groupMembers(liveGroup) === 2 && groupMembers(staleGroup) === 2 && groupMembers(goneBridge.pid) === 2)
        )
        deadRuntime.kill('SIGKILL')
        assert.ok(await waitFor(() => deadRuntime.exitCode !== null || deadRuntime.signalCode !== null))
        fs.rmSync(path.join(profiles, gone), { recursive: true, force: true })

        await sweepOrphanTryBridges()

        assert.equal(groupMembers(goneBridge.pid), 0, 'a bridge of a deleted try folder still runs')
        assert.equal(groupMembers(staleGroup), 0, 'a bridge of a dead runtime still runs')
        assert.equal(groupMembers(liveGroup), 2, 'a live try bridge was stopped')
        assert.equal(groupMembers(published.pid), 2, 'a published bridge was stopped')
        assert.equal(groupMembers(tryLikePublished.pid), 2, 'a published bridge with a try-like name was stopped')
        endLiveTry(live)
        endLiveTry(stale)
        runtime.kill('SIGKILL')
    }
)

test('an empty try folder left after teardown is removed once it is 10 minutes old', async () => {
    const { sweepAbandonedTryProfiles } = await import('../packages/harness/gateway.mjs')
    const old = 'trycccc0001'
    const fresh = 'trycccc0002'
    for (const name of [old, fresh]) fs.mkdirSync(path.join(profiles, name, 'logs'), { recursive: true })
    const past = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(path.join(profiles, old), past, past)
    const swept = sweepAbandonedTryProfiles()
    assert.ok(swept.has(old))
    assert.equal(fs.existsSync(path.join(profiles, old)), false)
    assert.equal(swept.has(fresh), false)
    assert.ok(fs.existsSync(path.join(profiles, fresh)))
})

test('sticky bridges stop through the finally path when runtime close throws', { skip: !linux }, async () => {
    const scope = 'tryeeee0001'
    tryFolders(scope, { sticky: true })
    const bridge = startBridge(`${scope}--worker`)
    assert.ok(await waitFor(() => groupMembers(bridge.pid) === 2))
    tryRuntime.closeProfiles = async () => {
        throw new Error('fixture close failed')
    }
    try {
        await assert.rejects(discardTryProfile(scope.slice(3)), /fixture close failed/)
        assert.equal(groupMembers(bridge.pid), 0)
        assert.ok(fs.statSync(path.join(profiles, scope)).isDirectory())
    } finally {
        tryRuntime.closeProfiles = null
    }
})

test('flow deletion stops sticky process groups before removing home and specialist folders', { skip: !linux }, async () => {
    const flow = 'fixture-deleted-flow'
    const scope = `try${tryIdForFlow(flow)}`
    tryFolders(scope, { sticky: true })
    const bridges = [startBridge(scope), startBridge(`${scope}--worker`)]
    assert.ok(await waitFor(() => bridges.every((child) => groupMembers(child.pid) === 2)))
    const rmdir = fs.rmdirSync
    let checked = false
    fs.rmdirSync = function (target, ...args) {
        if (fs.realpathSync(target).startsWith(path.join(profiles, scope))) {
            for (const child of bridges) assert.equal(groupMembers(child.pid), 0, 'folder removed before bridge exit')
            checked = true
        }
        return rmdir.call(fs, target, ...args)
    }
    try {
        await removeTryProfileForFlow(flow)
        assert.equal(checked, true)
        assert.equal(fs.existsSync(path.join(profiles, scope)), false)
        assert.equal(fs.existsSync(path.join(profiles, `${scope}--worker`)), false)
    } finally {
        fs.rmdirSync = rmdir
    }
})
