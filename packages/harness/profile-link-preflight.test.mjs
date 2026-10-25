// Acceptance checks for a cached profile compile: preflight links, an ancestor link
// before the profile env is read, and a path outside the profiles root.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-link-preflight-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'hermes')
delete process.env.HERMES_API_URL

const {
    compileProfileCached,
    discardTryProfile,
    forgetCompiledProfile,
    profileDestinationConflicts,
    profileWriteTest,
    readProfileEnv,
    recompileOutdatedProfiles,
    removeContainedTree,
    setAsideOutdatedConfigs,
    specialistWorkspace,
    tryRuntime
} = await import('./profile.mjs')
const { installPresetKit } = await import('./presets.mjs')
const { readFileNoFollow } = await import('./contained-walk.mjs')
const { bootHarnessGateway, profileTokenKnown } = await import('./gateway.mjs')

const failures = []

function check(name, ok, detail) {
    if (ok) {
        console.log(`ok  ${name}`)
        return
    }
    failures.push(name)
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

function model() {
    return { nodeName: 'chatXAI', label: 'xAI Grok', inputs: { modelName: 'grok-4.7' } }
}

function record(name, specialists) {
    return {
        name,
        createdAt: '2020-01-01T00:00:00.000Z',
        chief: { instructions: 'Route.', model: model() },
        specialists: specialists || [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [] }]
    }
}

function hermesProfiles() {
    return path.join(process.env.CUTTLELY_HERMES_HOME, 'profiles')
}

function profilePath(name, file = '') {
    return file ? path.join(hermesProfiles(), name, file) : path.join(hermesProfiles(), name)
}

function stamp(file) {
    const stat = fs.statSync(file)
    return { bytes: fs.readFileSync(file), mtimeMs: stat.mtimeMs, size: stat.size }
}

function sameStamp(file, before) {
    const after = fs.statSync(file)
    return after.mtimeMs === before.mtimeMs && after.size === before.size && fs.readFileSync(file).equals(before.bytes)
}

function treeHas(dir, needle) {
    if (!fs.existsSync(dir)) return false
    const walk = (current) => {
        for (const name of fs.readdirSync(current)) {
            const file = path.join(current, name)
            const stat = fs.lstatSync(file)
            if (stat.isSymbolicLink()) continue
            if (stat.isDirectory()) {
                if (walk(file)) return true
                continue
            }
            if (stat.isFile() && fs.readFileSync(file).includes(needle)) return true
        }
        return false
    }
    return walk(dir)
}

function quarantineNames(dir, base) {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((entry) => entry === `${base}.quarantine` || entry.startsWith(`${base}.quarantine-`))
}

function warm(name, specialists) {
    const saved = record(name, specialists)
    const first = compileProfileCached(saved)
    const again = compileProfileCached(saved)
    return { saved, first, again }
}

// Wrap filesystem calls for one compile. A hit is any use of the real target, or of a path
// under the link other than the link path itself (that lookup follows the link).
function guardLink(linkPath, realTarget, fn) {
    const orig = {
        openSync: fs.openSync,
        readFileSync: fs.readFileSync,
        writeFileSync: fs.writeFileSync,
        appendFileSync: fs.appendFileSync,
        mkdirSync: fs.mkdirSync,
        readdirSync: fs.readdirSync,
        existsSync: fs.existsSync,
        statSync: fs.statSync,
        lstatSync: fs.lstatSync,
        realpathSync: fs.realpathSync,
        rmSync: fs.rmSync,
        renameSync: fs.renameSync,
        linkSync: fs.linkSync,
        unlinkSync: fs.unlinkSync,
        copyFileSync: fs.copyFileSync,
        chmodSync: fs.chmodSync
    }
    const hits = []
    const note = (label, value) => {
        if (hits.length > 8) return
        hits.push(`${label} ${value}`)
    }
    const consider = (p, how) => {
        if (typeof p === 'number') {
            try {
                const got = fs.readlinkSync(`/proc/self/fd/${p}`)
                if (got === realTarget || got.startsWith(realTarget + path.sep)) note(how, `fd ${got}`)
            } catch {
                // The descriptor is already closed.
            }
            return
        }
        if (typeof p !== 'string') return
        const resolved = path.resolve(p)
        const linkItself = (candidate) => {
            if (candidate !== linkPath) return false
            // lstat and an O_NOFOLLOW open name the link. A successful open is checked from its descriptor.
            if (how === 'lstatSync' || how === 'openSync' || how === 'linkSync' || how === 'unlinkSync' || how === 'renameSync') return true
            // A regular file at this path is not a follow. Count the call only once the path is a link.
            let linked = false
            try {
                linked = orig.lstatSync(candidate).isSymbolicLink()
            } catch {
                linked = false
            }
            if (linked) note(how, candidate)
            return true
        }
        if (linkItself(resolved)) return
        if (resolved === realTarget || resolved.startsWith(realTarget + path.sep)) note(how, resolved)
        if (resolved.startsWith(linkPath + path.sep)) note(how, resolved)
        const proc = resolved.match(/^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/)
        if (!proc?.[2]) return
        try {
            const base = fs.readlinkSync(`/proc/self/fd/${proc[1]}`)
            const combined = path.resolve(base, proc[2])
            if (linkItself(combined)) return
            if (combined === realTarget || combined.startsWith(realTarget + path.sep)) note(how, combined)
            if (combined.startsWith(linkPath + path.sep)) note(how, combined)
        } catch {
            // The directory descriptor is already closed.
        }
    }
    const wrap = (name, invoke) => {
        fs[name] = (...args) => {
            consider(args[0], name)
            return invoke(...args)
        }
    }
    fs.openSync = (p, ...args) => {
        consider(p, 'openSync')
        const fd = orig.openSync(p, ...args)
        try {
            const got = fs.readlinkSync(`/proc/self/fd/${fd}`)
            if (got === realTarget || got.startsWith(realTarget + path.sep)) note('openSync', `fd ${got}`)
        } catch {
            // The descriptor is already closed.
        }
        return fd
    }
    fs.readFileSync = (p, ...args) => {
        if (typeof p === 'string' && path.resolve(p) === linkPath) note('readFileSync', p)
        else consider(p, 'readFileSync')
        if (typeof p === 'number') {
            try {
                const got = fs.readlinkSync(`/proc/self/fd/${p}`)
                if (got === realTarget || got.startsWith(realTarget + path.sep)) note('readFileSync', `fd ${got}`)
            } catch {
                // The descriptor is already closed.
            }
        }
        return orig.readFileSync(p, ...args)
    }
    wrap('writeFileSync', orig.writeFileSync)
    wrap('appendFileSync', orig.appendFileSync)
    wrap('mkdirSync', orig.mkdirSync)
    wrap('readdirSync', orig.readdirSync)
    wrap('existsSync', orig.existsSync)
    wrap('statSync', orig.statSync)
    wrap('lstatSync', orig.lstatSync)
    wrap('rmSync', orig.rmSync)
    wrap('renameSync', orig.renameSync)
    wrap('linkSync', orig.linkSync)
    wrap('unlinkSync', orig.unlinkSync)
    wrap('copyFileSync', orig.copyFileSync)
    wrap('chmodSync', orig.chmodSync)
    fs.realpathSync = (p, options) => {
        consider(p, 'realpathSync')
        const result = orig.realpathSync(p, options)
        if (typeof result === 'string' && result !== linkPath && (result === realTarget || result.startsWith(realTarget + path.sep))) {
            note('realpathSync', result)
        }
        return result
    }
    try {
        let error = null
        let result
        try {
            result = fn()
        } catch (caught) {
            error = caught
        }
        return { result, hits, error }
    } finally {
        for (const [name, fnOrig] of Object.entries(orig)) fs[name] = fnOrig
    }
}

function outsideFile(label, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plink-${label}-`))
    const file = path.join(dir, 'payload')
    fs.writeFileSync(file, text)
    return { dir, file, text, before: stamp(file) }
}

function outsideDir(label, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plink-${label}-`))
    const file = path.join(dir, 'marker')
    fs.writeFileSync(file, text)
    return { dir, file, text, before: stamp(file) }
}

function cleanupProfile(name) {
    forgetCompiledProfile(name)
    const root = hermesProfiles()
    if (!fs.existsSync(root)) return
    for (const entry of fs.readdirSync(root)) {
        if (entry === name || entry.startsWith(`${name}.quarantine`) || entry.startsWith(`${name}--`)) {
            fs.rmSync(path.join(root, entry), { recursive: true, force: true })
        }
    }
}

// Hole: a cached compile still hits when .env or SOUL.md is replaced with a link.
{
    const cases = [
        ['plinkenv', '.env', 'OUTSIDE_ENV_SENTINEL=env-file-bytes\n', 'env-file-bytes'],
        ['plinksoul', 'SOUL.md', 'outside-soul-sentinel\n', 'outside-soul-sentinel']
    ]
    const results = []
    for (const [name, file, text, needle] of cases) {
        const { saved, first, again } = warm(name)
        const outside = outsideFile(file, text)
        const target = profilePath(name, file)
        fs.rmSync(target, { force: true })
        fs.symlinkSync(outside.file, target)
        let refused = ''
        let returned = null
        try {
            returned = compileProfileCached(saved)
        } catch (error) {
            refused = error?.code || ''
        }
        let readBack = ''
        if (file === '.env') {
            try {
                readBack = readProfileEnv(name).OUTSIDE_ENV_SENTINEL || ''
            } catch (error) {
                readBack = error?.code || ''
            }
        }
        const linkGone = !fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
        const ok =
            again === first &&
            refused === 'profile_link' &&
            returned !== first &&
            sameStamp(outside.file, outside.before) &&
            readBack !== 'env-file-bytes' &&
            !treeHas(profilePath(name), Buffer.from(needle)) &&
            linkGone
        results.push({ file, ok, cacheHit: again === first, refused, returnedCache: returned === first, readBack, linkGone })
        cleanupProfile(name)
        fs.rmSync(outside.dir, { recursive: true, force: true })
    }
    check(
        'a cache hit refuses a linked env file and a linked soul file',
        results.length === 2 && results.every((row) => row.ok),
        JSON.stringify(results)
    )
}

// Hole: preflight runs, then the directory identity check. A file swapped for a link in that gap is still a cache hit.
{
    const cases = [
        ['plinkgapenv', '.env', 'OUTSIDE_ENV_SENTINEL=gap-env-bytes\n', 'gap-env-bytes'],
        ['plinkgapsoul', 'SOUL.md', 'gap-soul-sentinel\n', 'gap-soul-sentinel']
    ]
    const results = []
    for (const [name, file, text, needle] of cases) {
        const { saved, first, again } = warm(name)
        const outside = outsideFile(file, text)
        const target = profilePath(name, file)
        const held = `${target}.held`
        let swapped = false
        profileWriteTest.betweenCacheChecks = (dirPath) => {
            if (swapped || path.resolve(dirPath) !== path.resolve(profilePath(name))) return
            swapped = true
            fs.renameSync(target, held)
            fs.symlinkSync(outside.file, target)
        }
        let refused = ''
        let returned = null
        let hits = []
        try {
            const guarded = guardLink(target, outside.file, () => compileProfileCached(saved))
            hits = guarded.hits
            returned = guarded.result
            refused = guarded.error?.code || ''
        } finally {
            profileWriteTest.betweenCacheChecks = null
        }
        const linkStat = fs.lstatSync(target, { throwIfNoEntry: false })
        const ok =
            swapped &&
            again === first &&
            refused === 'profile_link' &&
            returned !== first &&
            hits.length === 0 &&
            sameStamp(outside.file, outside.before) &&
            !treeHas(profilePath(name), Buffer.from(needle)) &&
            !linkStat?.isSymbolicLink()
        results.push({
            file,
            ok,
            swapped,
            cacheHit: again === first,
            refused,
            returnedCache: returned === first,
            hits,
            stillLink: linkStat?.isSymbolicLink() === true
        })
        fs.rmSync(held, { force: true })
        cleanupProfile(name)
        fs.rmSync(outside.dir, { recursive: true, force: true })
    }
    check(
        'a cache hit refuses an env or soul file swapped for a link during the cache checks',
        results.length === 2 && results.every((row) => row.ok),
        JSON.stringify(results)
    )
}

// Hole: a skills directory that appears as a link after the compile is still a cache hit.
{
    const name = 'plinkskills'
    const { saved, first, again } = warm(name)
    const skills = profilePath(name, 'skills')
    const skillsMissing = !fs.lstatSync(skills, { throwIfNoEntry: false })
    const outside = outsideDir('skills', 'skills-sentinel\n')
    if (skillsMissing) fs.symlinkSync(outside.dir, skills)
    let refused = ''
    let returned = null
    try {
        returned = compileProfileCached(saved)
    } catch (error) {
        refused = error?.code || ''
    }
    const linkStat = fs.lstatSync(skills, { throwIfNoEntry: false })
    check(
        'a cache hit refuses a skills directory linked after the compile',
        skillsMissing &&
            again === first &&
            refused === 'profile_link' &&
            returned !== first &&
            sameStamp(outside.file, outside.before) &&
            fs.readdirSync(outside.dir).join() === 'marker' &&
            !linkStat?.isSymbolicLink() &&
            quarantineNames(profilePath(name), 'skills').length === 1,
        JSON.stringify({
            skillsMissing,
            cacheHit: again === first,
            refused,
            returnedCache: returned === first,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: an ancestor link is written through, and the profile env is read, before the refusal.
{
    const name = 'plinkancestor'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-ancestor-'))
    const realHome = path.join(scratch, 'real-home')
    const linkHome = path.join(scratch, 'link-home')
    fs.mkdirSync(path.join(realHome, 'profiles', name), { recursive: true })
    fs.writeFileSync(path.join(realHome, 'sentinel'), 'ancestor-sentinel\n')
    fs.writeFileSync(
        path.join(realHome, 'profiles', name, '.env'),
        'API_SERVER_KEY=from-the-target\nOUTSIDE_ENV_SENTINEL=from-the-target\n'
    )
    const before = stamp(path.join(realHome, 'sentinel'))
    const envBefore = stamp(path.join(realHome, 'profiles', name, '.env'))
    const profileListingBefore = fs.readdirSync(path.join(realHome, 'profiles', name)).sort().join()
    fs.symlinkSync(realHome, linkHome)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = linkHome
    let refused = ''
    let hits = []
    try {
        const guarded = guardLink(linkHome, realHome, () => compileProfileCached(record(name)))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
    }
    const linkStat = fs.lstatSync(linkHome, { throwIfNoEntry: false })
    const profileListing = fs.readdirSync(path.join(realHome, 'profiles', name)).sort().join()
    check(
        'an ancestor link is refused before the profile env is read and left in place',
        refused === 'profile_link' &&
            hits.length === 0 &&
            linkStat?.isSymbolicLink() === true &&
            fs.readlinkSync(linkHome) === realHome &&
            quarantineNames(scratch, 'link-home').length === 0 &&
            sameStamp(path.join(realHome, 'sentinel'), before) &&
            sameStamp(path.join(realHome, 'profiles', name, '.env'), envBefore) &&
            profileListing === profileListingBefore,
        JSON.stringify({
            refused,
            hits,
            stillLink: linkStat?.isSymbolicLink() === true,
            quarantined: quarantineNames(scratch, 'link-home'),
            profileListing
        })
    )
    forgetCompiledProfile(name)
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: a path outside the profiles root is quarantined. It must be refused and left in place.
{
    const name = 'plinkwork'
    const saved = record(name, [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [], codeExecution: true }])
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const child = `${name}--alpha`
    const workspace = specialistWorkspace(child)
    const outside = outsideDir('work', 'work-sentinel\n')
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.symlinkSync(outside.dir, workspace)
    let refused = ''
    try {
        compileProfileCached(saved)
    } catch (error) {
        refused = error?.code || ''
    }
    const linkStat = fs.lstatSync(workspace, { throwIfNoEntry: false })
    check(
        'a workspace path outside the profiles root is refused and left in place',
        refused === 'profile_link' &&
            linkStat?.isSymbolicLink() === true &&
            fs.readlinkSync(workspace) === outside.dir &&
            quarantineNames(path.dirname(workspace), path.basename(workspace)).length === 0 &&
            sameStamp(outside.file, outside.before) &&
            fs.readdirSync(outside.dir).join() === 'marker',
        JSON.stringify({
            refused,
            stillLink: linkStat?.isSymbolicLink() === true,
            quarantined: quarantineNames(path.dirname(workspace), path.basename(workspace))
        })
    )
    cleanupProfile(name)
    fs.rmSync(workspace, { force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: the profile env can be swapped for a link after it is checked and before it is read.
{
    const name = 'plinkrace'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const envFile = profilePath(name, '.env')
    const outside = outsideFile('race', 'OUTSIDE_ENV_SENTINEL=swapped-before-read\n')
    const realCopy = `${envFile}.real`
    let swapped = false
    profileWriteTest.beforeEnvRead = (file) => {
        if (swapped || path.resolve(file) !== path.resolve(envFile)) return
        swapped = true
        fs.renameSync(envFile, realCopy)
        fs.symlinkSync(outside.file, envFile)
    }
    let refused = ''
    let hits = []
    try {
        const guarded = guardLink(envFile, outside.file, () => compileProfileCached(saved))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        profileWriteTest.beforeEnvRead = null
    }
    const linkStat = fs.lstatSync(envFile, { throwIfNoEntry: false })
    check(
        'an env file swapped for a link before the read is not followed',
        swapped &&
            refused === 'profile_link' &&
            hits.length === 0 &&
            sameStamp(outside.file, outside.before) &&
            !treeHas(profilePath(name), Buffer.from('swapped-before-read')) &&
            !linkStat?.isSymbolicLink(),
        JSON.stringify({ swapped, refused, hits, stillLink: linkStat?.isSymbolicLink() === true })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// ino 0 is not a refusal. The profile is compiled again.
{
    const name = 'plinkino'
    const { saved, first, again } = warm(name)
    const realLstat = fs.lstatSync
    fs.lstatSync = (entry, options) => {
        const stat = realLstat(entry, options)
        if (!options?.bigint) return stat
        return {
            isSymbolicLink: () => stat.isSymbolicLink(),
            isDirectory: () => stat.isDirectory(),
            isFile: () => stat.isFile(),
            dev: 0n,
            ino: 0n
        }
    }
    let refused = ''
    let third = null
    try {
        third = compileProfileCached(saved)
    } catch (error) {
        refused = error?.code || ''
    } finally {
        fs.lstatSync = realLstat
    }
    check(
        'an inode of zero is not a cache hit and the profile is compiled again',
        again === first && refused === '' && third && third !== first && realLstat(profilePath(name)).isDirectory(),
        JSON.stringify({ cacheHit: again === first, refused, reused: third === first, got: Boolean(third) })
    )
    cleanupProfile(name)
}

// A link above the parent of the hermes home is still an ancestor. Opening a lower directory follows it.
{
    const name = 'plinkhigh'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-high-'))
    const realTree = path.join(scratch, 'real-tree')
    const linkTop = path.join(scratch, 'link-top')
    const realHome = path.join(realTree, 'nested', 'data', 'hermes')
    fs.mkdirSync(path.join(realHome, 'profiles', name), { recursive: true })
    fs.writeFileSync(path.join(realTree, 'sentinel'), 'high-sentinel\n')
    fs.writeFileSync(
        path.join(realHome, 'profiles', name, '.env'),
        'API_SERVER_KEY=from-the-target\nOUTSIDE_ENV_SENTINEL=from-the-high-ancestor\n'
    )
    const before = stamp(path.join(realTree, 'sentinel'))
    const envBefore = stamp(path.join(realHome, 'profiles', name, '.env'))
    const profileListingBefore = fs.readdirSync(path.join(realHome, 'profiles', name)).sort().join()
    fs.symlinkSync(realTree, linkTop)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = path.join(linkTop, 'nested', 'data', 'hermes')
    let refused = ''
    let hits = []
    try {
        const guarded = guardLink(linkTop, realTree, () => compileProfileCached(record(name)))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
    }
    const linkStat = fs.lstatSync(linkTop, { throwIfNoEntry: false })
    const profileListing = fs.readdirSync(path.join(realHome, 'profiles', name)).sort().join()
    check(
        'a link above the hermes home is refused before the profile env is read and left in place',
        refused === 'profile_link' &&
            hits.length === 0 &&
            linkStat?.isSymbolicLink() === true &&
            fs.readlinkSync(linkTop) === realTree &&
            quarantineNames(scratch, 'link-top').length === 0 &&
            sameStamp(path.join(realTree, 'sentinel'), before) &&
            sameStamp(path.join(realHome, 'profiles', name, '.env'), envBefore) &&
            profileListing === profileListingBefore,
        JSON.stringify({ refused, hits, stillLink: linkStat?.isSymbolicLink() === true, profileListing })
    )
    forgetCompiledProfile(name)
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Finding profiles that belong to a harness must not read through a linked directory.
{
    const name = 'plinkboot'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const outside = outsideDir('boot-link', 'boot-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'harness-parent'), `${name}\n`)
    const linked = profilePath('plinkother')
    fs.symlinkSync(outside.dir, linked)
    let hits = []
    let refused = ''
    try {
        const guarded = guardLink(linked, outside.dir, () => compileProfileCached(saved))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        forgetCompiledProfile(name)
    }
    const linkStat = fs.lstatSync(linked, { throwIfNoEntry: false })
    check(
        'a linked profile directory is not read while another profile compiles',
        hits.length === 0 &&
            refused === '' &&
            linkStat?.isSymbolicLink() === true &&
            fs.readlinkSync(linked) === outside.dir &&
            sameStamp(outside.file, outside.before),
        JSON.stringify({ hits, refused, stillLink: linkStat?.isSymbolicLink() === true })
    )
    fs.rmSync(linked, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The gateway loads profile env files at startup. A linked env file is not a file it may read.
{
    const name = 'plinkgate'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const envFile = profilePath(name, '.env')
    const outside = outsideFile(
        'gate',
        'OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCDE\nOPENAI_BASE_URL=http://127.0.0.1:9/v1\nCUTTLELY_GATEWAY_HARNESS=plinkgate\nCUTTLELY_GATEWAY_SPECIALIST=alpha\nCUTTLELY_GATEWAY_CREATED=2020-01-01T00:00:00.000Z\n'
    )
    const realCopy = `${envFile}.real`
    fs.renameSync(envFile, realCopy)
    fs.symlinkSync(outside.file, envFile)
    const guarded = guardLink(envFile, outside.file, () => bootHarnessGateway())
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDE'
    const linkStat = fs.lstatSync(envFile, { throwIfNoEntry: false })
    check(
        'the gateway does not read a linked profile env file',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            profileTokenKnown(token) === false &&
            sameStamp(outside.file, outside.before) &&
            !treeHas(profilePath(name), Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789ABCDE')),
        JSON.stringify({ hits: guarded.hits, error: guarded.error?.code || '', known: profileTokenKnown(token) })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The boot sweep must not rename files through a link above the hermes home.
{
    const name = 'plinksweep'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-sweep-'))
    const realTree = path.join(scratch, 'real-tree')
    const linkTop = path.join(scratch, 'link-top')
    const realHome = path.join(realTree, 'nested', 'data', 'hermes')
    const profileDirPath = path.join(realHome, 'profiles', name)
    fs.mkdirSync(profileDirPath, { recursive: true })
    fs.writeFileSync(path.join(realTree, 'sentinel'), 'sweep-sentinel\n')
    fs.writeFileSync(path.join(profileDirPath, 'config.yaml'), 'old-config\n')
    fs.writeFileSync(path.join(profileDirPath, 'harness-roster.json'), '{}\n')
    const configBefore = stamp(path.join(profileDirPath, 'config.yaml'))
    fs.symlinkSync(realTree, linkTop)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = path.join(linkTop, 'nested', 'data', 'hermes')
    let refused = ''
    let hits = []
    try {
        const guarded = guardLink(linkTop, realTree, () => setAsideOutdatedConfigs())
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
    }
    const linkStat = fs.lstatSync(linkTop, { throwIfNoEntry: false })
    check(
        'the boot sweep does not write through a link above the hermes home',
        refused === 'profile_link' &&
            hits.length === 0 &&
            linkStat?.isSymbolicLink() === true &&
            quarantineNames(scratch, 'link-top').length === 0 &&
            sameStamp(path.join(profileDirPath, 'config.yaml'), configBefore) &&
            !fs.existsSync(path.join(profileDirPath, 'config.yaml.outdated')),
        JSON.stringify({ refused, hits, stillLink: linkStat?.isSymbolicLink() === true })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// A roster file that is a link is not read while boot decides what to compile. It is inside the
// profiles tree, so the same check a compile uses moves it aside instead of leaving it on the load path.
{
    const name = 'plinkroster'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const roster = profilePath(name, 'harness-roster.json')
    const outside = outsideFile('roster', `{"name":"${name}","specialists":[{"profileName":"nope"}]}\n`)
    const realCopy = `${roster}.real`
    fs.renameSync(roster, realCopy)
    fs.symlinkSync(outside.file, roster)
    const guarded = guardLink(roster, outside.file, () => recompileOutdatedProfiles([saved], { log: {} }))
    const result = Array.isArray(guarded.result) ? guarded.result : []
    const linkStat = fs.lstatSync(roster, { throwIfNoEntry: false })
    check(
        'a linked roster file is not read during boot',
        result.length === 1 &&
            (result[0].status === 'recompiled' || result[0].status === 'failed') &&
            guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            !linkStat?.isSymbolicLink() &&
            quarantineNames(profilePath(name), 'harness-roster.json').length === 1 &&
            !treeHas(profilePath(name), Buffer.from('"profileName":"nope"')),
        JSON.stringify({
            status: result[0]?.status || '',
            error: result[0]?.error || guarded.error?.code || '',
            hits: guarded.hits,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A profile name in the on-disk roster must not move a link that lives outside the profiles tree.
{
    const name = 'plinkout'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const outside = outsideDir('out-link', 'out-sentinel\n')
    const escaped = path.resolve(path.join(hermesProfiles(), '..', '..', 'plink-escaped'))
    fs.symlinkSync(outside.dir, escaped)
    const roster = JSON.parse(fs.readFileSync(profilePath(name, 'harness-roster.json'), 'utf8'))
    roster.specialists = [{ name: 'alpha', profileName: '../../plink-escaped' }]
    fs.writeFileSync(profilePath(name, 'harness-roster.json'), JSON.stringify(roster))
    let error = ''
    try {
        recompileOutdatedProfiles([saved])
    } catch (caught) {
        error = caught?.code || ''
    }
    const linkStat = fs.lstatSync(escaped, { throwIfNoEntry: false })
    check(
        'a roster path outside the profiles root is not moved',
        linkStat?.isSymbolicLink() === true &&
            fs.readlinkSync(escaped) === outside.dir &&
            quarantineNames(path.dirname(escaped), 'plink-escaped').length === 0 &&
            sameStamp(outside.file, outside.before),
        JSON.stringify({ error, stillLink: linkStat?.isSymbolicLink() === true })
    )
    fs.rmSync(escaped, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A compiler marker that is a link is not read to decide the profile is current.
{
    const name = 'plinkmarker'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const marker = profilePath(name, 'harness-compiler')
    const outside = outsideFile('compiler', '2\n')
    const realCopy = `${marker}.real`
    fs.renameSync(marker, realCopy)
    fs.symlinkSync(outside.file, marker)
    const guarded = guardLink(marker, outside.file, () => recompileOutdatedProfiles([saved]))
    const skipped = Array.isArray(guarded.result) && guarded.result.length === 0
    check(
        'a linked compiler marker is not read during boot',
        guarded.hits.length === 0 && guarded.error == null && !skipped && sameStamp(outside.file, outside.before),
        JSON.stringify({ hits: guarded.hits, error: guarded.error?.code || '', skipped, result: guarded.result })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A playbook file or directory linked after the compile is not a cache hit.
{
    const name = 'plinkbook'
    const saved = record(name, [
        {
            name: 'alpha',
            instructions: 'Alpha work.',
            model: model(),
            modules: [],
            playbooks: [{ name: 'refund-rules', description: 'When to refund', content: 'Refund the order.' }]
        }
    ])
    const first = compileProfileCached(saved)
    const again = compileProfileCached(saved)
    const specialist = profilePath(`${name}--alpha`)
    const playbookDir = path.join(specialist, 'skills', 'harness-playbooks', 'refund-rules')
    const skillFile = path.join(playbookDir, 'SKILL.md')
    const fileOutside = outsideFile('playbook-file', 'outside-playbook-sentinel\n')
    const realSkill = `${skillFile}.real`
    fs.renameSync(skillFile, realSkill)
    fs.symlinkSync(fileOutside.file, skillFile)
    let fileRefused = ''
    let fileReturned = null
    const fileGuarded = guardLink(skillFile, fileOutside.file, () => {
        try {
            fileReturned = compileProfileCached(saved)
        } catch (error) {
            fileRefused = error?.code || ''
        }
    })
    const fileLink = fs.lstatSync(skillFile, { throwIfNoEntry: false })
    check(
        'a cache hit refuses a linked playbook file',
        again === first &&
            fileRefused === 'profile_link' &&
            fileReturned !== first &&
            fileGuarded.hits.length === 0 &&
            fileGuarded.error == null &&
            sameStamp(fileOutside.file, fileOutside.before) &&
            !fileLink?.isSymbolicLink() &&
            quarantineNames(playbookDir, 'SKILL.md').length === 1,
        JSON.stringify({
            cacheHit: again === first,
            fileRefused,
            hits: fileGuarded.hits,
            stillLink: fileLink?.isSymbolicLink() === true
        })
    )
    fs.rmSync(realSkill, { force: true })
    fs.rmSync(fileOutside.dir, { recursive: true, force: true })
    cleanupProfile(name)
    forgetCompiledProfile(name)

    const savedDir = record(name, [
        {
            name: 'alpha',
            instructions: 'Alpha work.',
            model: model(),
            modules: [],
            playbooks: [{ name: 'refund-rules', description: 'When to refund', content: 'Refund the order.' }]
        }
    ])
    const warmed = compileProfileCached(savedDir)
    const warmedAgain = compileProfileCached(savedDir)
    const dirPath = path.join(profilePath(`${name}--alpha`), 'skills', 'harness-playbooks', 'refund-rules')
    const parent = path.dirname(dirPath)
    const dirOutside = outsideDir('playbook-dir', 'outside-playbook-dir\n')
    fs.rmSync(dirPath, { recursive: true, force: true })
    fs.symlinkSync(dirOutside.dir, dirPath)
    let dirRefused = ''
    let dirReturned = null
    const dirGuarded = guardLink(dirPath, dirOutside.dir, () => {
        try {
            dirReturned = compileProfileCached(savedDir)
        } catch (error) {
            dirRefused = error?.code || ''
        }
    })
    const dirLink = fs.lstatSync(dirPath, { throwIfNoEntry: false })
    check(
        'a cache hit refuses a linked playbook directory',
        warmedAgain === warmed &&
            dirRefused === 'profile_link' &&
            dirReturned !== warmed &&
            dirGuarded.hits.length === 0 &&
            dirGuarded.error == null &&
            sameStamp(dirOutside.file, dirOutside.before) &&
            fs.readdirSync(dirOutside.dir).join() === 'marker' &&
            !dirLink?.isSymbolicLink() &&
            quarantineNames(parent, 'refund-rules').length === 1,
        JSON.stringify({
            cacheHit: warmedAgain === warmed,
            dirRefused,
            hits: dirGuarded.hits,
            stillLink: dirLink?.isSymbolicLink() === true
        })
    )
    cleanupProfile(name)
    fs.rmSync(dirOutside.dir, { recursive: true, force: true })
}

// An ownership marker that is a link is not read when a save checks who owns a profile.
{
    const name = 'plinkowner'
    const saved = record(name, [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [], codeExecution: true }])
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const marker = profilePath(`${name}--alpha`, 'harness-parent')
    const outside = outsideFile('owner', `${name}\n`)
    const realCopy = `${marker}.real`
    fs.renameSync(marker, realCopy)
    fs.symlinkSync(outside.file, marker)
    const guarded = guardLink(marker, outside.file, () => profileDestinationConflicts(saved))
    const linkStat = fs.lstatSync(marker, { throwIfNoEntry: false })
    check(
        'a linked ownership marker is not read',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            linkStat?.isSymbolicLink() === true,
        JSON.stringify({ hits: guarded.hits, error: guarded.error?.code || '', stillLink: linkStat?.isSymbolicLink() === true })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A kit file swapped for a link between the check and the read is not followed.
{
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-kit-'))
    const target = path.join(workspace, 'cuttlely_assets.py')
    fs.writeFileSync(target, 'local-kit\n')
    const outside = outsideFile('kit', 'outside-kit-sentinel\n')
    const realCopy = `${target}.real`
    let swapped = false
    const origLstat = fs.lstatSync
    const origRead = fs.readFileSync
    let hits = 0
    const note = (file) => {
        if (typeof file !== 'string') return
        const resolved = path.resolve(file)
        if (resolved === path.resolve(target) || resolved === path.resolve(outside.file)) hits += 1
    }
    fs.lstatSync = (file, ...args) => {
        const stat = origLstat(file, ...args)
        if (!swapped && typeof file === 'string' && path.resolve(file) === path.resolve(target)) {
            swapped = true
            fs.renameSync(target, realCopy)
            fs.symlinkSync(outside.file, target)
        }
        return stat
    }
    fs.readFileSync = (file, ...args) => {
        note(file)
        return origRead(file, ...args)
    }
    let error = ''
    try {
        installPresetKit({ preset: 'assets' }, workspace, () => {})
    } catch (caught) {
        error = caught?.code || ''
    } finally {
        fs.lstatSync = origLstat
        fs.readFileSync = origRead
    }
    check(
        'a preset kit file swapped for a link is not read',
        hits === 0 && error === '' && sameStamp(outside.file, outside.before),
        JSON.stringify({ hits, error, swapped })
    )
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The boot sweep must not stat through a linked profile directory to decide whether it is owned.
{
    const name = 'plinksweepdir'
    const outside = outsideDir('sweep-dir', 'sweep-dir-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'harness-parent'), 'someone\n')
    fs.writeFileSync(path.join(outside.dir, 'config.yaml'), 'old\n')
    fs.mkdirSync(hermesProfiles(), { recursive: true })
    const link = profilePath(name)
    fs.symlinkSync(outside.dir, link)
    const guarded = guardLink(link, outside.dir, () => setAsideOutdatedConfigs())
    const linkStat = fs.lstatSync(link, { throwIfNoEntry: false })
    const loadable = Array.isArray(guarded.result) ? guarded.result : []
    check(
        'the boot sweep does not read through a linked profile directory',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            !loadable.some((dir) => String(dir).endsWith(name)) &&
            !linkStat &&
            sameStamp(outside.file, outside.before) &&
            fs.readFileSync(path.join(outside.dir, 'config.yaml'), 'utf8') === 'old\n',
        JSON.stringify({
            hits: guarded.hits,
            error: guarded.error?.code || '',
            loadable,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A skills directory swapped for a link after the playbook check must not receive new playbook files.
{
    const name = 'plinkswapbook'
    const specialists = [
        {
            name: 'alpha',
            instructions: 'Alpha work.',
            model: model(),
            modules: [],
            playbooks: [{ name: 'refund-rules', description: 'When to refund', content: 'Refund the order.' }]
        }
    ]
    const saved = record(name, specialists)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const skills = path.join(profilePath(`${name}--alpha`), 'skills')
    const root = path.join(skills, 'harness-playbooks')
    const outside = outsideDir('swap-book', 'swap-book-sentinel\n')
    let swapped = false
    let held = ''
    profileWriteTest.beforeTreeMutation = (logical) => {
        if (swapped || path.resolve(logical) !== path.resolve(root)) return
        swapped = true
        held = `${skills}.held`
        fs.renameSync(skills, held)
        fs.symlinkSync(outside.dir, skills)
    }
    let hits = []
    let refused = ''
    try {
        const guarded = guardLink(skills, outside.dir, () => compileProfileCached(saved))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        profileWriteTest.beforeTreeMutation = null
    }
    const listing = fs.readdirSync(outside.dir).sort().join()
    check(
        'a playbook directory is not created through a skills link swapped after the check',
        swapped &&
            refused === 'profile_link' &&
            !hits.some((hit) => hit.includes(outside.dir)) &&
            sameStamp(outside.file, outside.before) &&
            listing === 'marker',
        JSON.stringify({ swapped, refused, hits, listing })
    )
    if (held) fs.rmSync(held, { recursive: true, force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Removing playbooks must not delete a tree reached through a skills link swapped after the check.
{
    const name = 'plinkswaprm'
    compileProfileCached(
        record(name, [
            {
                name: 'alpha',
                instructions: 'Alpha work.',
                model: model(),
                modules: [],
                codeExecution: true,
                playbooks: [{ name: 'refund-rules', description: 'When to refund', content: 'Refund the order.' }]
            }
        ])
    )
    forgetCompiledProfile(name)
    const skills = path.join(profilePath(`${name}--alpha`), 'skills')
    const root = path.join(skills, 'harness-playbooks')
    const outside = outsideDir('swap-rm', 'swap-rm-sentinel\n')
    const keep = path.join(outside.dir, 'harness-playbooks', 'keep.txt')
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(keep, 'keep-playbook\n')
    const keepBefore = stamp(keep)
    const saved = record(name, [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [], codeExecution: true }])
    let swapped = false
    let held = ''
    profileWriteTest.beforeTreeMutation = (logical) => {
        if (swapped || path.resolve(logical) !== path.resolve(root)) return
        swapped = true
        held = `${skills}.held`
        fs.renameSync(skills, held)
        fs.symlinkSync(outside.dir, skills)
    }
    let hits = []
    let refused = ''
    try {
        const guarded = guardLink(skills, outside.dir, () => compileProfileCached(saved))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        profileWriteTest.beforeTreeMutation = null
    }
    let keepText = ''
    try {
        keepText = fs.readFileSync(keep, 'utf8')
    } catch {
        keepText = ''
    }
    check(
        'a playbook tree is not removed through a skills link swapped after the check',
        swapped &&
            refused === 'profile_link' &&
            !hits.some((hit) => hit.includes(outside.dir)) &&
            sameStamp(outside.file, outside.before) &&
            keepText === 'keep-playbook\n' &&
            fs.existsSync(keep) &&
            sameStamp(keep, keepBefore),
        JSON.stringify({ swapped, refused, hits, keepText, listing: fs.readdirSync(outside.dir) })
    )
    if (held) fs.rmSync(held, { recursive: true, force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A folder that leaves the profiles root while its child directory is still open must not be emptied.
{
    const name = 'plinkrmout'
    const root = profilePath(name)
    const folderA = path.join(root, 'a')
    const folderB = path.join(folderA, 'b')
    fs.mkdirSync(folderB, { recursive: true })
    fs.writeFileSync(path.join(folderB, 'one.txt'), 'keep-one\n')
    fs.writeFileSync(path.join(folderB, 'two.txt'), 'keep-two\n')
    const escaped = path.join(path.dirname(hermesProfiles()), `${name}-a`)
    let moved = false
    profileWriteTest.beforeTreeMutation = (logical) => {
        if (moved) return
        const resolved = path.resolve(logical)
        const dirB = path.resolve(folderB)
        if (resolved === path.resolve(root) || resolved === path.resolve(folderA) || resolved === dirB) return
        if (!resolved.startsWith(dirB + path.sep)) return
        moved = true
        fs.renameSync(folderA, escaped)
    }
    let refused = ''
    try {
        removeContainedTree(profilePath(name))
    } catch (error) {
        refused = error?.code || ''
    } finally {
        profileWriteTest.beforeTreeMutation = null
    }
    let oneText = ''
    let twoText = ''
    try {
        oneText = fs.readFileSync(path.join(escaped, 'b', 'one.txt'), 'utf8')
    } catch {
        oneText = ''
    }
    try {
        twoText = fs.readFileSync(path.join(escaped, 'b', 'two.txt'), 'utf8')
    } catch {
        twoText = ''
    }
    check(
        'a folder moved out of the profiles folder during removal is not emptied',
        moved && refused === 'profile_link' && oneText === 'keep-one\n' && twoText === 'keep-two\n',
        JSON.stringify({ moved, refused, oneText, twoText })
    )
    fs.rmSync(escaped, { recursive: true, force: true })
    cleanupProfile(name)
}

// A profile whose compiler marker is current is still checked at boot. An env link is not left for the runtime.
{
    const name = 'plinkbootenv'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const envFile = profilePath(name, '.env')
    const outside = outsideFile('boot-env', 'OUTSIDE_ENV_SENTINEL=boot-current\n')
    const realCopy = `${envFile}.real`
    fs.renameSync(envFile, realCopy)
    fs.symlinkSync(outside.file, envFile)
    const guarded = guardLink(envFile, outside.file, () => recompileOutdatedProfiles([saved], { log: {} }))
    const result = Array.isArray(guarded.result) ? guarded.result : []
    const linkStat = fs.lstatSync(envFile, { throwIfNoEntry: false })
    check(
        'a current profile is preflighted at boot before an env link is left in place',
        result.length === 1 &&
            (result[0].status === 'recompiled' || result[0].status === 'failed') &&
            guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            !linkStat?.isSymbolicLink() &&
            !treeHas(profilePath(name), Buffer.from('boot-current')),
        JSON.stringify({
            status: result[0]?.status || '',
            error: result[0]?.error || guarded.error?.code || '',
            hits: guarded.hits,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Creating memory must not follow a profile directory swapped for a link after the check.
{
    const name = 'plinkswapmem'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const dir = profilePath(name)
    const outside = outsideDir('swap-mem', 'swap-mem-sentinel\n')
    const compiler = path.join(outside.dir, 'harness-compiler')
    fs.writeFileSync(compiler, 'keep-compiler\n')
    const compilerBefore = stamp(compiler)
    let swapped = false
    let held = ''
    profileWriteTest.beforeTreeMutation = (logical) => {
        if (swapped || path.resolve(logical) !== path.resolve(dir)) return
        swapped = true
        held = `${dir}.held`
        fs.renameSync(dir, held)
        fs.symlinkSync(outside.dir, dir)
    }
    let hits = []
    let refused = ''
    try {
        const guarded = guardLink(dir, outside.dir, () => compileProfileCached(saved))
        hits = guarded.hits
        refused = guarded.error?.code || ''
    } finally {
        profileWriteTest.beforeTreeMutation = null
    }
    const listing = fs.readdirSync(outside.dir).sort().join()
    check(
        'memory is not created through a profile directory swapped after the check',
        swapped &&
            refused === 'profile_link' &&
            !hits.some((hit) => hit.includes(outside.dir)) &&
            sameStamp(outside.file, outside.before) &&
            fs.existsSync(compiler) &&
            sameStamp(compiler, compilerBefore) &&
            listing === 'harness-compiler,marker',
        JSON.stringify({ swapped, refused, hits, listing })
    )
    if (held) fs.rmSync(held, { recursive: true, force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Quarantine can fail (the profile directory is not writable). The env link stays, the target is not
// read, and the sweep reports that path so startup can see it is still a link.
{
    const name = 'plinkbootstuck'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const envFile = profilePath(name, '.env')
    const outside = outsideFile('boot-stuck', 'OUTSIDE_ENV_SENTINEL=boot-stuck\n')
    const realCopy = `${envFile}.real`
    fs.renameSync(envFile, realCopy)
    fs.symlinkSync(outside.file, envFile)
    fs.chmodSync(profilePath(name), 0o555)
    let guarded = { hits: [], error: null, result: null }
    try {
        guarded = guardLink(envFile, outside.file, () => {
            const recompiled = recompileOutdatedProfiles([saved], { log: {} })
            const loadable = setAsideOutdatedConfigs()
            return { recompiled, loadable }
        })
    } finally {
        fs.chmodSync(profilePath(name), 0o755)
    }
    const reported = guarded.result || { recompiled: [], loadable: [] }
    const loadable = reported.loadable || []
    const linkStat = fs.lstatSync(envFile, { throwIfNoEntry: false })
    check(
        'a current profile env link that cannot be moved aside is reported and not read',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            linkStat?.isSymbolicLink() === true &&
            loadable.includes(envFile) &&
            !treeHas(profilePath(name), Buffer.from('boot-stuck')),
        JSON.stringify({
            hits: guarded.hits,
            error: guarded.error?.code || '',
            loadable,
            recompiled: reported.recompiled,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// A skills directory that cannot be moved aside is not a directory the sweep may list.
{
    const name = 'plinkskillsstuck'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const skills = profilePath(name, 'skills')
    const outside = outsideDir('skills-stuck', 'skills-stuck-sentinel\n')
    const keep = path.join(outside.dir, 'harness-playbooks', 'keep.txt')
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(keep, 'keep-skills\n')
    fs.symlinkSync(outside.dir, skills)
    fs.chmodSync(profilePath(name), 0o555)
    let guarded = { hits: [], error: null, result: [] }
    try {
        guarded = guardLink(skills, outside.dir, () => setAsideOutdatedConfigs())
    } finally {
        fs.chmodSync(profilePath(name), 0o755)
    }
    const loadable = Array.isArray(guarded.result) ? guarded.result : []
    const linkStat = fs.lstatSync(skills, { throwIfNoEntry: false })
    let keepText = ''
    try {
        keepText = fs.readFileSync(keep, 'utf8')
    } catch {
        keepText = ''
    }
    check(
        'a skills link that cannot be moved aside is not read',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            keepText === 'keep-skills\n' &&
            linkStat?.isSymbolicLink() === true &&
            loadable.includes(skills),
        JSON.stringify({
            hits: guarded.hits,
            error: guarded.error?.code || '',
            loadable,
            stillLink: linkStat?.isSymbolicLink() === true,
            keepText
        })
    )
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Retiring a specialist removes its workspace. A link at the workspaces directory must not
// let that removal delete the directory the link names.
{
    const name = 'plinkretire'
    const withChild = record(name, [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [], codeExecution: true }])
    compileProfileCached(withChild)
    forgetCompiledProfile(name)
    const child = `${name}--alpha`
    const workspaces = path.dirname(specialistWorkspace(child))
    const outside = outsideDir('retire-ws', 'retire-ws-sentinel\n')
    const kept = path.join(outside.dir, child, 'keep.txt')
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, 'keep-workspace\n')
    const held = `${workspaces}.held`
    fs.renameSync(workspaces, held)
    fs.symlinkSync(outside.dir, workspaces)
    const bare = record(name, [])
    let guarded = { hits: [], error: null, result: null }
    let linkStat = null
    let readlink = ''
    let keepText = ''
    let quarantined = []
    try {
        guarded = guardLink(workspaces, outside.dir, () => compileProfileCached(bare))
        linkStat = fs.lstatSync(workspaces, { throwIfNoEntry: false })
        readlink = linkStat?.isSymbolicLink() ? fs.readlinkSync(workspaces) : ''
        quarantined = quarantineNames(path.dirname(workspaces), path.basename(workspaces))
        try {
            keepText = fs.readFileSync(kept, 'utf8')
        } catch {
            keepText = ''
        }
    } finally {
        const current = fs.lstatSync(workspaces, { throwIfNoEntry: false })
        if (current?.isSymbolicLink()) fs.unlinkSync(workspaces)
        else if (current) fs.rmSync(workspaces, { recursive: true, force: true })
        if (fs.existsSync(held) && !fs.existsSync(workspaces)) fs.renameSync(held, workspaces)
    }
    check(
        'a retired specialist workspace is not removed through a workspaces link',
        guarded.hits.length === 0 &&
            guarded.error?.code === 'profile_link' &&
            linkStat?.isSymbolicLink() === true &&
            readlink === outside.dir &&
            quarantined.length === 0 &&
            sameStamp(outside.file, outside.before) &&
            keepText === 'keep-workspace\n',
        JSON.stringify({
            hits: guarded.hits,
            error: guarded.error?.code || '',
            stillLink: linkStat?.isSymbolicLink() === true,
            readlink,
            quarantined,
            keepText
        })
    )
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
    fs.rmSync(held, { recursive: true, force: true })
}

// The quarantine claim must not follow a profile directory that was swapped for a link
// after the symlink was seen and before the claim.
{
    const name = 'plinkqswap'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const dir = profilePath(name)
    const envFile = path.join(dir, '.env')
    const payload = outsideFile('qswap', 'OUTSIDE_ENV_SENTINEL=qswap\n')
    fs.rmSync(envFile, { force: true })
    fs.symlinkSync(payload.file, envFile)
    const sentinelInDir = path.join(dir, 'sentinel-qswap.txt')
    fs.writeFileSync(sentinelInDir, 'qswap-sentinel\n')
    const sentinelBefore = stamp(sentinelInDir)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-qswap-moved-'))
    const moved = path.join(scratch, 'moved')
    const sentinel = path.join(moved, 'sentinel-qswap.txt')
    let swapped = false
    profileWriteTest.beforeQuarantineClaim = (linkPath) => {
        if (swapped || path.basename(linkPath) !== '.env') return
        swapped = true
        fs.renameSync(dir, moved)
        fs.symlinkSync(moved, dir)
    }
    let guarded = { hits: [], error: null, result: null }
    try {
        guarded = guardLink(dir, moved, () => compileProfileCached(saved))
    } finally {
        profileWriteTest.beforeQuarantineClaim = null
    }
    const names = fs.existsSync(moved) ? fs.readdirSync(moved).sort() : []
    const envStat = fs.lstatSync(path.join(moved, '.env'), { throwIfNoEntry: false })
    const mutations = guarded.hits.filter((hit) =>
        /^(linkSync|unlinkSync|writeFileSync|appendFileSync|rmSync|mkdirSync|renameSync|copyFileSync|chmodSync) /.test(hit)
    )
    check(
        'a quarantine does not follow a profile directory swapped for a link',
        swapped &&
            guarded.error?.code === 'profile_link' &&
            mutations.length === 0 &&
            envStat?.isSymbolicLink() === true &&
            !names.some((entry) => entry.includes('quarantine')) &&
            sameStamp(sentinel, sentinelBefore) &&
            sameStamp(payload.file, payload.before) &&
            fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true,
        JSON.stringify({
            swapped,
            error: guarded.error?.code || '',
            mutations,
            names,
            stillEnv: envStat?.isSymbolicLink() === true
        })
    )
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dir)
    fs.rmSync(scratch, { recursive: true, force: true })
    cleanupProfile(name)
    fs.rmSync(payload.dir, { recursive: true, force: true })
}

// The boot sweep moves an older config aside. A directory swapped for a link after that
// check must not let the move rename the link's target.
{
    const name = 'plinksetaside'
    const saved = record(name)
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const dir = profilePath(name)
    fs.writeFileSync(path.join(dir, 'harness-compiler'), '0\n')
    const outside = outsideDir('setaside', 'setaside-sentinel\n')
    const outsideConfig = path.join(outside.dir, 'config.yaml')
    fs.writeFileSync(outsideConfig, 'outside-config\n')
    const configBefore = stamp(outsideConfig)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-setaside-held-'))
    const held = path.join(scratch, 'held')
    let swapped = false
    profileWriteTest.beforeTreeMutation = (logical) => {
        if (swapped || path.resolve(logical) !== path.resolve(dir)) return
        swapped = true
        fs.renameSync(dir, held)
        fs.symlinkSync(outside.dir, dir)
    }
    let guarded = { hits: [], error: null, result: null }
    try {
        guarded = guardLink(dir, outside.dir, () => setAsideOutdatedConfigs())
    } finally {
        profileWriteTest.beforeTreeMutation = null
    }
    let outsideNames = []
    let outsideText = ''
    try {
        outsideNames = fs.readdirSync(outside.dir).sort()
        outsideText = fs.readFileSync(outsideConfig, 'utf8')
    } catch {
        outsideText = ''
    }
    check(
        'the boot sweep does not rename a config through a directory swapped for a link',
        swapped &&
            guarded.error == null &&
            outsideText === 'outside-config\n' &&
            sameStamp(outsideConfig, configBefore) &&
            sameStamp(outside.file, outside.before) &&
            !outsideNames.includes('config.yaml.outdated') &&
            fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true,
        JSON.stringify({
            swapped,
            error: guarded.error?.code || guarded.error?.message || '',
            outsideNames,
            outsideText,
            hits: guarded.hits
        })
    )
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dir)
    fs.rmSync(scratch, { recursive: true, force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

function withPlatform(platform, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform })
    try {
        return fn()
    } finally {
        Object.defineProperty(process, 'platform', descriptor)
    }
}

function swapTree(slot, replacement) {
    const held = `${slot}.held`
    fs.renameSync(slot, held)
    fs.symlinkSync(replacement, slot)
    return held
}

function restoreTree(slot, held) {
    if (!held) return
    const current = fs.lstatSync(slot, { throwIfNoEntry: false })
    if (current?.isSymbolicLink()) fs.unlinkSync(slot)
    if (!fs.existsSync(slot) && fs.existsSync(held)) fs.renameSync(held, slot)
}

// True when targetPath is dir, or a directory descriptor currently naming dir.
function pathNamesDir(targetPath, dir) {
    if (typeof targetPath !== 'string') return false
    const want = path.resolve(dir)
    if (path.resolve(targetPath) === want) return true
    const proc = path.resolve(targetPath).match(/^\/proc\/self\/fd\/(\d+)$/)
    if (!proc) return false
    try {
        return path.resolve(fs.readlinkSync(`/proc/self/fd/${proc[1]}`)) === want
    } catch {
        return false
    }
}

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return ''
    }
}

// Hole: without a directory-descriptor path, the file open uses the absolute path after the parent
// was checked. An ancestor swapped in that gap is followed.
{
    const name = 'plinknfread'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-nf-read-'))
    const slot = path.join(scratch, 'slot')
    const outSlot = path.join(scratch, 'outslot')
    const home = path.join(slot, 'home')
    fs.mkdirSync(path.join(home, 'profiles', name), { recursive: true })
    fs.mkdirSync(path.join(outSlot, 'home', 'profiles', name), { recursive: true })
    const envFile = path.join(home, 'profiles', name, '.env')
    const outsideEnv = path.join(outSlot, 'home', 'profiles', name, '.env')
    fs.writeFileSync(envFile, 'API_SERVER_KEY=safe-local\n')
    fs.writeFileSync(outsideEnv, 'OUTSIDE_ENV_SENTINEL=secret-ancestor-swap\n')
    const outsideBefore = stamp(outsideEnv)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let swapped = false
    let held = ''
    let readBack = ''
    let refused = ''
    profileWriteTest.beforeEnvRead = (file) => {
        if (swapped || path.resolve(file) !== path.resolve(envFile)) return
        swapped = true
        held = swapTree(slot, outSlot)
    }
    try {
        withPlatform('darwin', () => {
            try {
                readBack = readProfileEnv(name).OUTSIDE_ENV_SENTINEL || ''
            } catch (error) {
                refused = error?.message || ''
                readBack = ''
            }
        })
    } finally {
        profileWriteTest.beforeEnvRead = null
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(slot, held)
    }
    check(
        'a non-linux read does not follow an ancestor swapped before the file open',
        readBack !== 'secret-ancestor-swap' &&
            sameStamp(outsideEnv, outsideBefore) &&
            refused === 'Agent profiles are saved and compiled only on Linux (darwin). Use the Docker image.',
        JSON.stringify({ swapped, refused, readBack })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: the same absolute-path fallback truncates a file reached through the swapped ancestor.
{
    const name = 'plinknfwrite'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-nf-write-'))
    const slot = path.join(scratch, 'slot')
    const outSlot = path.join(scratch, 'outslot')
    const home = path.join(slot, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    let held = ''
    let swapped = false
    let refused = ''
    let outsideLeak = ''
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        const profileDirPath = path.join(home, 'profiles', name)
        const mirror = path.join(outSlot, 'home', 'profiles', name)
        fs.mkdirSync(mirror, { recursive: true })
        fs.writeFileSync(path.join(mirror, 'sentinel'), 'nf-write-sentinel\n')
        const sentinelBefore = stamp(path.join(mirror, 'sentinel'))
        profileWriteTest.beforeFinalOpen = () => {
            if (swapped) return
            swapped = true
            held = swapTree(slot, outSlot)
        }
        withPlatform('darwin', () => {
            try {
                compileProfileCached({ ...saved, chief: { instructions: 'Route somewhere else.', model: model() } })
            } catch (error) {
                refused = error?.code || ''
            }
        })
        const names = fs.existsSync(mirror) ? fs.readdirSync(mirror).sort() : []
        outsideLeak = names.filter((entry) => entry !== 'sentinel').join(',')
        const sentinelSame = fs.existsSync(path.join(mirror, 'sentinel')) && sameStamp(path.join(mirror, 'sentinel'), sentinelBefore)
        check(
            'a non-linux write does not follow an ancestor swapped before the file open',
            sentinelSame && outsideLeak === '' && !treeHas(mirror, Buffer.from('Route somewhere else.')),
            JSON.stringify({ swapped, refused, outsideLeak, names, profileExisted: fs.existsSync(profileDirPath) })
        )
    } finally {
        profileWriteTest.beforeFinalOpen = null
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(slot, held)
        forgetCompiledProfile(name)
    }
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: contained-walk uses the same absolute path when it has no descriptor path.
{
    const name = 'plinknfwalk'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-nf-walk-'))
    const slot = path.join(scratch, 'slot')
    const outSlot = path.join(scratch, 'outslot')
    const home = path.join(slot, 'home')
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(outSlot, 'home', 'profiles', name), { recursive: true })
    const target = path.join(dir, 'note.txt')
    const outsideFilePath = path.join(outSlot, 'home', 'profiles', name, 'note.txt')
    fs.writeFileSync(target, 'safe-note\n')
    fs.writeFileSync(outsideFilePath, 'OUTSIDE-WALK-SECRET\n')
    const outsideBefore = stamp(outsideFilePath)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const origOpen = fs.openSync
    let swapped = false
    let held = ''
    let text = ''
    try {
        fs.openSync = (p, ...args) => {
            if (!swapped && typeof p === 'string' && path.resolve(p) === path.resolve(target)) {
                swapped = true
                held = swapTree(slot, outSlot)
            }
            return origOpen(p, ...args)
        }
        withPlatform('darwin', () => {
            text = readFileNoFollow(target) || ''
        })
    } finally {
        fs.openSync = origOpen
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(slot, held)
    }
    check(
        'a non-linux contained read does not follow an ancestor swapped before the file open',
        !text.includes('OUTSIDE-WALK-SECRET') && sameStamp(outsideFilePath, outsideBefore),
        JSON.stringify({ swapped, text })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: the boot sweep lists a directory after lstat, so a swap in that gap is followed.
{
    const name = 'plinklistswap'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-list-'))
    const home = path.join(scratch, 'home')
    const root = path.join(home, 'profiles')
    const dir = path.join(root, name)
    const books = path.join(dir, 'skills', 'harness-playbooks')
    fs.mkdirSync(books, { recursive: true })
    fs.writeFileSync(path.join(dir, 'harness-roster.json'), '{}\n')
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'old\n')
    const soulOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-list-soul-'))
    fs.writeFileSync(path.join(soulOutside, 'soul'), 'soul-target\n')
    fs.symlinkSync(path.join(soulOutside, 'soul'), path.join(dir, 'SOUL.md'))
    const outside = outsideDir('list-swap', 'list-swap-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-listing.txt'), 'listed-through-the-link\n')
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let swapped = false
    let held = ''
    let guarded = { hits: [], error: null, result: null }
    try {
        guarded = guardLink(books, outside.dir, () => {
            const wrapped = fs.readdirSync
            fs.readdirSync = (p, ...args) => {
                if (!swapped && typeof p === 'string' && path.resolve(p) === path.resolve(books)) {
                    swapped = true
                    held = `${books}.held`
                    fs.renameSync(books, held)
                    fs.symlinkSync(outside.dir, books)
                }
                return wrapped(p, ...args)
            }
            try {
                return setAsideOutdatedConfigs()
            } finally {
                fs.readdirSync = wrapped
            }
        })
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
        const current = fs.lstatSync(books, { throwIfNoEntry: false })
        if (current?.isSymbolicLink()) fs.unlinkSync(books)
        if (held && fs.existsSync(held) && !fs.existsSync(books)) fs.renameSync(held, books)
    }
    check(
        'the boot sweep does not list a directory swapped for a link before the listing',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            fs.readFileSync(path.join(outside.dir, 'secret-listing.txt'), 'utf8') === 'listed-through-the-link\n',
        JSON.stringify({ swapped, hits: guarded.hits, error: guarded.error?.code || guarded.error?.message || '' })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(soulOutside, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: the profiles root is listed the same way, after it was seen as a real directory.
{
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-root-list-'))
    const home = path.join(scratch, 'home')
    const root = path.join(home, 'profiles')
    fs.mkdirSync(root, { recursive: true })
    const outside = outsideDir('root-list', 'root-list-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-profile'), 'from-outside\n')
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let swapped = false
    let held = ''
    let guarded = { hits: [], error: null, result: null }
    try {
        guarded = guardLink(root, outside.dir, () => {
            const wrapped = fs.readdirSync
            fs.readdirSync = (p, ...args) => {
                if (!swapped && typeof p === 'string' && path.resolve(p) === path.resolve(root)) {
                    swapped = true
                    held = path.join(home, 'profiles.held')
                    fs.renameSync(root, held)
                    fs.symlinkSync(outside.dir, root)
                }
                return wrapped(p, ...args)
            }
            try {
                return setAsideOutdatedConfigs()
            } finally {
                fs.readdirSync = wrapped
            }
        })
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
        const current = fs.lstatSync(root, { throwIfNoEntry: false })
        if (current?.isSymbolicLink()) fs.unlinkSync(root)
        if (held && fs.existsSync(held) && !fs.existsSync(root)) fs.renameSync(held, root)
    }
    check(
        'the boot sweep does not list the profiles root swapped for a link before the listing',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            fs.readFileSync(path.join(outside.dir, 'secret-profile'), 'utf8') === 'from-outside\n',
        JSON.stringify({ swapped, hits: guarded.hits, error: guarded.error?.code || guarded.error?.message || '' })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: a kit file whose no-follow read returns null is still written with the path, which follows a link.
{
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-kit-link-'))
    const outside = outsideDir('kit-link', 'kit-link-sentinel\n')
    const linkedWorkspace = path.join(scratch, 'linked-workspace')
    fs.symlinkSync(outside.dir, linkedWorkspace)
    const plain = path.join(scratch, 'plain-workspace')
    fs.mkdirSync(plain)
    let error = ''
    try {
        installPresetKit({ preset: 'assets' }, linkedWorkspace)
        installPresetKit({ preset: 'assets' }, plain)
    } catch (caught) {
        error = caught?.code || caught?.message || ''
    }
    check(
        'a preset kit is not written through a link',
        error === '' &&
            sameStamp(outside.file, outside.before) &&
            !fs.existsSync(path.join(outside.dir, 'cuttlely_assets.py')) &&
            fs.existsSync(path.join(plain, 'cuttlely_assets.py')) &&
            fs.readFileSync(path.join(plain, 'cuttlely_assets.py'), 'utf8').includes('TABLE_THEME'),
        JSON.stringify({
            error,
            outside: fs.existsSync(outside.dir) ? fs.readdirSync(outside.dir).sort() : [],
            plain: fs.existsSync(plain) ? fs.readdirSync(plain).sort() : []
        })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: writeIfChanged and writeEnvFile lstat the logical path before the ancestor is opened no-follow.
{
    const name = 'plinkstatfirst'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-stat-'))
    const slot = path.join(scratch, 'slot')
    const outSlot = path.join(scratch, 'outslot')
    const home = path.join(slot, 'home')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(outSlot)
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const origLstat = fs.lstatSync
    let swapped = false
    let held = ''
    let followed = false
    let directStats = 0
    try {
        fs.lstatSync = (p, ...args) => {
            if (typeof p === 'string' && path.resolve(p).startsWith(slot + path.sep)) {
                const stack = new Error().stack || ''
                const direct =
                    (stack.includes('writeIfChanged') || stack.includes('writeEnvFile')) &&
                    !stack.includes('assertContained') &&
                    !stack.includes('writeContained')
                if (direct && !swapped) {
                    directStats += 1
                    const rel = path.relative(slot, path.resolve(p))
                    const dest = path.join(outSlot, rel)
                    fs.mkdirSync(path.dirname(dest), { recursive: true })
                    fs.writeFileSync(dest, 'OUTSIDE-SECRET-STAT\n')
                    const marker = fs.statSync(dest)
                    held = swapTree(slot, outSlot)
                    swapped = true
                    const st = origLstat(p, ...args)
                    if (st && st.ino === marker.ino && st.dev === marker.dev) followed = true
                    return st
                }
            }
            return origLstat(p, ...args)
        }
        try {
            compileProfileCached(record(name))
        } catch {
            // A refusal after the stat is still a follow if the stat already saw the outside file.
        }
    } finally {
        fs.lstatSync = origLstat
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(slot, held)
        forgetCompiledProfile(name)
    }
    check(
        'a logical stat of the profile env and soul does not follow a swapped ancestor',
        !followed,
        JSON.stringify({ swapped, followed, directStats })
    )
    const workspace = path.join(process.env.CUTTLELY_DATA_DIR, 'workspaces')
    for (const entry of [`${name}`, `${name}--alpha`]) {
        fs.rmSync(path.join(workspace, entry), { recursive: true, force: true })
    }
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: the file is opened with truncation before the opened descriptor is checked.
// A directory that moves outside in that gap is truncated, then refused.
{
    const name = 'plinktrunc'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-trunc-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    const sentinel = 'KEEP-THIS-BYTES\n'
    let movedTo = ''
    let refused = ''
    let after = ''
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        const roster = profilePath(name, 'harness-roster.json')
        fs.writeFileSync(roster, sentinel)
        profileWriteTest.beforeContainedOpen = (file) => {
            if (movedTo || !String(file).endsWith(`${path.sep}harness-roster.json`)) return
            movedTo = path.join(scratch, 'outside-held')
            fs.renameSync(path.dirname(file), movedTo)
        }
        try {
            compileProfileCached({ ...saved, chief: { instructions: 'Route somewhere else.', model: model() } })
        } catch (error) {
            refused = error?.code || ''
        }
        try {
            after = fs.readFileSync(path.join(movedTo, 'harness-roster.json'), 'utf8')
        } catch (error) {
            after = error?.code || String(error)
        }
    } finally {
        profileWriteTest.beforeContainedOpen = null
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
    }
    check(
        'a profile file moved outside before it is opened is not truncated',
        refused === 'profile_link' && after === sentinel,
        JSON.stringify({ refused, movedTo, after })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: a directory that moves outside before the open, when the file is absent, is created there.
{
    const name = 'plinkcreate'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-create-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    let movedTo = ''
    let refused = ''
    let created = false
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        fs.rmSync(profilePath(name, 'harness-roster.json'), { force: true })
        profileWriteTest.beforeContainedOpen = (file) => {
            if (movedTo || !String(file).endsWith(`${path.sep}harness-roster.json`)) return
            movedTo = path.join(scratch, 'outside-held')
            fs.renameSync(path.dirname(file), movedTo)
        }
        try {
            compileProfileCached({ ...saved, chief: { instructions: 'Route somewhere else.', model: model() } })
        } catch (error) {
            refused = error?.code || ''
        }
        created = Boolean(movedTo) && fs.existsSync(path.join(movedTo, 'harness-roster.json'))
    } finally {
        profileWriteTest.beforeContainedOpen = null
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
    }
    check(
        'a missing profile file is not created after its directory moves outside',
        refused === 'profile_link' && movedTo !== '' && !created,
        JSON.stringify({ refused, movedTo, created })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Hole: the boot sweep stats a marker through a link while deciding the directory is owned.
{
    const name = 'plinkownlink'
    const saved = record(name, [])
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const roster = profilePath(name, 'harness-roster.json')
    const outside = outsideFile('ownlink', 'outside-roster-secret\n')
    const realCopy = `${roster}.real`
    fs.renameSync(roster, realCopy)
    fs.symlinkSync(outside.file, roster)
    const guarded = guardLink(roster, outside.file, () => setAsideOutdatedConfigs())
    const reported = Array.isArray(guarded.result) ? guarded.result : []
    const linkStat = fs.lstatSync(roster, { throwIfNoEntry: false })
    check(
        'the boot sweep does not follow a linked roster while deciding ownership',
        guarded.hits.length === 0 &&
            guarded.error == null &&
            sameStamp(outside.file, outside.before) &&
            (linkStat?.isSymbolicLink() !== true || reported.some((dir) => String(dir).endsWith(`${path.sep}harness-roster.json`))),
        JSON.stringify({
            hits: guarded.hits,
            error: guarded.error?.code || '',
            reported,
            stillLink: linkStat?.isSymbolicLink() === true
        })
    )
    fs.rmSync(realCopy, { force: true })
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Hole: linkedProfileDirs lists the profiles root after lstat, so a swap in that gap is followed.
{
    const name = 'plinkcomplist'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-comp-list-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    const outside = outsideDir('comp-list', 'comp-list-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-profile'), 'from-outside\n')
    let hits = 0
    let swapped = false
    let held = ''
    let error = ''
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        const profilesRoot = path.join(home, 'profiles')
        const wrapped = fs.readdirSync
        fs.readdirSync = (p, ...args) => {
            if (typeof p === 'string' && path.resolve(p) === path.resolve(profilesRoot)) {
                if (!swapped) {
                    swapped = true
                    held = path.join(home, 'profiles.held')
                    fs.renameSync(profilesRoot, held)
                    fs.symlinkSync(outside.dir, profilesRoot)
                }
                hits += 1
            }
            return wrapped(p, ...args)
        }
        try {
            recompileOutdatedProfiles([saved], { log: {} })
        } catch (caught) {
            error = caught?.code || String(caught)
        } finally {
            fs.readdirSync = wrapped
        }
    } finally {
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        const profilesRoot = path.join(home, 'profiles')
        const current = fs.lstatSync(profilesRoot, { throwIfNoEntry: false })
        if (current?.isSymbolicLink()) fs.unlinkSync(profilesRoot)
        if (held && fs.existsSync(held) && !fs.existsSync(profilesRoot)) fs.renameSync(held, profilesRoot)
    }
    check(
        'a compile does not list the profiles root through a link swapped before the listing',
        hits === 0 && error === '' && sameStamp(outside.file, outside.before),
        JSON.stringify({ hits, swapped, error, outside: fs.readdirSync(outside.dir).sort() })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Contained deletion: absolute removal follows a profiles directory swapped for a link.
{
    const name = 'plinkretdel'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-ret-del-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [{ name: 'alpha', instructions: 'Alpha work.', model: model(), modules: [], codeExecution: true }])
    const retired = `${name}--alpha`
    const outside = outsideDir('ret-del', 'ret-del-sentinel\n')
    const precious = path.join(outside.dir, retired, 'precious')
    fs.mkdirSync(path.dirname(precious))
    fs.writeFileSync(precious, 'keep-retired\n')
    let swapped = false
    let held = ''
    let error = ''
    const origRead = fs.readFileSync
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        fs.readFileSync = (p, ...args) => {
            const result = origRead(p, ...args)
            // The env read is the last step before the directory is removed. Swap only then,
            // so an earlier marker read does not refuse the walk before the removal.
            if (!swapped && typeof p === 'number' && (new Error().stack || '').includes('forgetRetiredSpecialistProfiles')) {
                let named = ''
                try {
                    named = fs.readlinkSync(`/proc/self/fd/${p}`)
                } catch {
                    named = ''
                }
                if (named.endsWith(`${path.sep}.env`)) {
                    swapped = true
                    held = swapTree(hermesProfiles(), outside.dir)
                }
            }
            return result
        }
        try {
            compileProfileCached(record(name, []))
        } catch (caught) {
            // A refusal still fails the check when the outside tree was removed.
            error = caught?.code || caught?.message || ''
        }
    } finally {
        fs.readFileSync = origRead
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(path.join(home, 'profiles'), held)
    }
    check(
        'a retired specialist is not deleted through a profiles directory swapped for a link',
        swapped && readText(precious) === 'keep-retired\n',
        JSON.stringify({ swapped, precious: readText(precious), error, held: Boolean(held) })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The gateway sweep removes an abandoned try. That removal must not follow a swapped profiles
// directory or a workspace directory that is already a link.
{
    const entry = 'tryabcdef01'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-gw-del-'))
    const home = path.join(scratch, 'home')
    const profileDirPath = path.join(home, 'profiles', entry)
    fs.mkdirSync(profileDirPath, { recursive: true })
    fs.writeFileSync(path.join(profileDirPath, 'harness-try'), `${entry}\n`)
    fs.writeFileSync(path.join(profileDirPath, '.env'), 'A=b\n')
    const outsideProfiles = outsideDir('gw-prof', 'gw-prof-sentinel\n')
    const profilePrecious = path.join(outsideProfiles.dir, entry, 'precious')
    fs.mkdirSync(path.dirname(profilePrecious))
    fs.writeFileSync(profilePrecious, 'keep-profile\n')
    const outsideWork = outsideDir('gw-work', 'gw-work-sentinel\n')
    const workPrecious = path.join(outsideWork.dir, entry, 'precious')
    fs.mkdirSync(path.dirname(workPrecious))
    fs.writeFileSync(workPrecious, 'keep-workspace\n')
    const workRoot = path.join(process.env.CUTTLELY_DATA_DIR, 'workspaces')
    if (!fs.existsSync(workRoot)) fs.mkdirSync(workRoot, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let swapped = false
    let heldProfiles = ''
    let heldWork = ''
    const origRead = fs.readFileSync
    try {
        heldWork = swapTree(workRoot, outsideWork.dir)
        fs.readFileSync = (p, ...args) => {
            const result = origRead(p, ...args)
            if (!swapped && typeof p === 'number' && (new Error().stack || '').includes('removeProfileTree')) {
                swapped = true
                heldProfiles = swapTree(path.join(home, 'profiles'), outsideProfiles.dir)
            }
            return result
        }
        try {
            bootHarnessGateway()
        } catch {
            // A refusal still fails the check when an outside tree was removed.
        }
    } finally {
        fs.readFileSync = origRead
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(path.join(home, 'profiles'), heldProfiles)
        restoreTree(workRoot, heldWork)
    }
    const profileKept = readText(profilePrecious) === 'keep-profile\n'
    const workKept = readText(workPrecious) === 'keep-workspace\n'
    check(
        'an abandoned try is not deleted through a swapped profiles directory or a linked workspace',
        swapped && profileKept && workKept,
        JSON.stringify({ swapped, profileKept, workKept })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outsideProfiles.dir, { recursive: true, force: true })
    fs.rmSync(outsideWork.dir, { recursive: true, force: true })
}

// Try removal deletes by absolute path. A profiles directory swapped after its stat, or a workspaces
// root that is already a link, is not a tree that removal may empty.
{
    const id = 'abcdef01'
    const scope = `try${id}`
    const profilesRoot = hermesProfiles()
    fs.mkdirSync(path.join(profilesRoot, scope), { recursive: true })
    const outsideProfiles = outsideDir('try-prof', 'try-prof-sentinel\n')
    const profilePrecious = path.join(outsideProfiles.dir, scope, 'precious')
    fs.mkdirSync(path.dirname(profilePrecious))
    fs.writeFileSync(profilePrecious, 'keep-try-profile\n')
    const outsideWork = outsideDir('try-work', 'try-work-sentinel\n')
    const workPrecious = path.join(outsideWork.dir, scope, 'precious')
    fs.mkdirSync(path.dirname(workPrecious))
    fs.writeFileSync(workPrecious, 'keep-try-workspace\n')
    const workRoot = path.join(process.env.CUTTLELY_DATA_DIR, 'workspaces')
    if (!fs.existsSync(workRoot)) fs.mkdirSync(workRoot, { recursive: true })
    const heldWork = swapTree(workRoot, outsideWork.dir)
    let heldProfiles = ''
    const origRm = fs.rmSync
    fs.rmSync = (p, ...args) => {
        if (!heldProfiles && typeof p === 'string' && path.resolve(p) === path.join(profilesRoot, scope)) {
            const stack = new Error().stack || ''
            if (stack.includes('removeOneTryDir')) heldProfiles = swapTree(profilesRoot, outsideProfiles.dir)
        }
        return origRm(p, ...args)
    }
    const previousClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async () => {}
    try {
        await discardTryProfile(id)
    } finally {
        fs.rmSync = origRm
        tryRuntime.closeProfiles = previousClose
        restoreTree(profilesRoot, heldProfiles)
        restoreTree(workRoot, heldWork)
        fs.rmSync(path.join(profilesRoot, scope), { recursive: true, force: true })
    }
    const profileKept = readText(profilePrecious) === 'keep-try-profile\n'
    const workKept = readText(workPrecious) === 'keep-try-workspace\n'
    check(
        'a try directory is not deleted through a linked profiles or workspaces root',
        profileKept && workKept,
        JSON.stringify({ profileKept, workKept, heldProfiles: Boolean(heldProfiles) })
    )
    fs.rmSync(outsideProfiles.dir, { recursive: true, force: true })
    fs.rmSync(outsideWork.dir, { recursive: true, force: true })
}

// Containment preflight falls back to an absolute stat, which follows an ancestor swapped underneath it.
{
    const name = 'plinkcont'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-cont-'))
    const home = path.join(scratch, 'home')
    const profilesRoot = path.join(home, 'profiles')
    fs.mkdirSync(profilesRoot, { recursive: true })
    const outside = outsideDir('cont', 'cont-sentinel\n')
    fs.mkdirSync(path.join(outside.dir, name))
    const marker = fs.statSync(path.join(outside.dir, name))
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const origLstat = fs.lstatSync
    let absoluteStats = 0
    let followed = false
    let swapped = false
    let held = ''
    try {
        fs.lstatSync = (p, ...args) => {
            const stack = new Error().stack || ''
            const resolved = typeof p === 'string' ? path.resolve(p) : ''
            const absolute =
                typeof p === 'string' &&
                !resolved.startsWith('/proc/') &&
                stack.includes('assertContained') &&
                (resolved === profilesRoot || resolved.startsWith(profilesRoot + path.sep))
            if (absolute) absoluteStats += 1
            if (absolute && !swapped && resolved === path.join(profilesRoot, name)) {
                swapped = true
                held = swapTree(profilesRoot, outside.dir)
            }
            const st = origLstat(p, ...args)
            if (swapped && resolved === path.join(profilesRoot, name) && st && st.ino === marker.ino && st.dev === marker.dev) {
                followed = true
            }
            return st
        }
        try {
            compileProfileCached(record(name, []))
        } catch {
            // A later refusal does not undo a stat that already followed.
        }
    } finally {
        fs.lstatSync = origLstat
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(profilesRoot, held)
    }
    check(
        'containment preflight does not stat a profile through a swapped ancestor',
        absoluteStats === 0 && !followed,
        JSON.stringify({ absoluteStats, followed, swapped })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Descendant preflight lists through a directory fd, then stats each child by its absolute path.
{
    const name = 'plinkdesc'
    const saved = record(name, [
        {
            name: 'alpha',
            instructions: 'Alpha work.',
            model: model(),
            modules: [],
            playbooks: [{ name: 'refund-rules', description: 'When to refund', content: 'Refund the order.' }]
        }
    ])
    compileProfileCached(saved)
    forgetCompiledProfile(name)
    const playbookDir = path.join(profilePath(`${name}--alpha`), 'skills', 'harness-playbooks')
    const child = path.join(playbookDir, 'refund-rules')
    const outside = outsideDir('desc', 'desc-sentinel\n')
    fs.mkdirSync(path.join(outside.dir, 'refund-rules'))
    const marker = fs.statSync(path.join(outside.dir, 'refund-rules'))
    const origLstat = fs.lstatSync
    let absoluteStats = 0
    let followed = false
    let swapped = false
    let held = ''
    try {
        fs.lstatSync = (p, ...args) => {
            const stack = new Error().stack || ''
            const resolved = typeof p === 'string' ? path.resolve(p) : ''
            const absolute =
                typeof p === 'string' &&
                !resolved.startsWith('/proc/') &&
                stack.includes('refuseDescendantLinks') &&
                resolved.startsWith(playbookDir + path.sep)
            if (absolute) absoluteStats += 1
            if (absolute && !swapped && resolved === child) {
                swapped = true
                held = swapTree(playbookDir, outside.dir)
            }
            const st = origLstat(p, ...args)
            if (swapped && resolved === child && st && st.ino === marker.ino && st.dev === marker.dev) followed = true
            return st
        }
        try {
            compileProfileCached(saved)
        } catch {
            // Refusal after the stat is still a follow.
        }
    } finally {
        fs.lstatSync = origLstat
        forgetCompiledProfile(name)
        restoreTree(playbookDir, held)
    }
    check(
        'playbook preflight does not stat a child through a swapped directory',
        absoluteStats === 0 && !followed,
        JSON.stringify({ absoluteStats, followed, swapped })
    )
    cleanupProfile(name)
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The cache snapshot keeps walking after the first ancestor link, so the next stat follows it.
{
    const name = 'plinksnap'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-snap-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    const outside = outsideDir('snap', 'snap-sentinel\n')
    const origLstat = fs.lstatSync
    let followed = false
    let swapped = false
    let held = ''
    const profileDirPath = path.join(home, 'profiles', name)
    try {
        fs.lstatSync = (p, ...args) => {
            const stack = new Error().stack || ''
            const resolved = typeof p === 'string' ? path.resolve(p) : ''
            if (!swapped && stack.includes('profileDirectoryChain') && resolved === profileDirPath) {
                swapped = true
                held = swapTree(profileDirPath, outside.dir)
            }
            if (swapped && resolved.startsWith(profileDirPath + path.sep) && stack.includes('profileDirectoryChain')) followed = true
            return origLstat(p, ...args)
        }
        try {
            compileProfileCached(saved)
        } catch {
            // The snapshot refuses the link. The failure is stating a path under it.
        }
    } finally {
        fs.lstatSync = origLstat
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(profileDirPath, held)
    }
    check(
        'the cache snapshot stops at the first ancestor link',
        swapped && !followed && sameStamp(outside.file, outside.before),
        JSON.stringify({ swapped, followed })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Listing a profiles directory by its absolute path follows a swap in front of that call.
{
    const name = 'plinkretlist'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-ret-list-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const outside = outsideDir('ret-list', 'ret-list-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-retired'), 'listed\n')
    let followed = false
    let held = ''
    const origReadDir = fs.readdirSync
    try {
        compileProfileCached(record(name))
        forgetCompiledProfile(name)
        fs.readdirSync = (p, ...args) => {
            if (!held && pathNamesDir(p, hermesProfiles()) && (new Error().stack || '').includes('forgetRetiredSpecialistProfiles')) {
                held = swapTree(hermesProfiles(), outside.dir)
            }
            const names = origReadDir(p, ...args)
            if (names.includes('secret-retired')) followed = true
            return names
        }
        try {
            compileProfileCached(record(name, []))
        } catch {
            // A refusal is fine. Listing the outside directory is not.
        }
    } finally {
        fs.readdirSync = origReadDir
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(path.join(home, 'profiles'), held)
    }
    check(
        'a retired-profile sweep does not list a profiles directory swapped for a link',
        held !== '' && !followed && sameStamp(outside.file, outside.before),
        JSON.stringify({ held: Boolean(held), followed })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

{
    const name = 'plinkunfin'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-unfin-'))
    const home = path.join(scratch, 'home')
    const profilesRoot = path.join(home, 'profiles')
    fs.mkdirSync(profilesRoot, { recursive: true })
    const outside = outsideDir('unfin', 'unfin-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-unfinished'), 'listed\n')
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let followed = false
    let held = ''
    const origReadDir = fs.readdirSync
    fs.readdirSync = (p, ...args) => {
        if (!held && pathNamesDir(p, profilesRoot) && (new Error().stack || '').includes('setAsideUnfinishedConfigs')) {
            held = swapTree(profilesRoot, outside.dir)
        }
        const names = origReadDir(p, ...args)
        if (names.includes('secret-unfinished')) followed = true
        return names
    }
    profileWriteTest.beforeTreeMutation = () => {
        throw new Error('boom')
    }
    try {
        try {
            compileProfileCached(record(name, []))
        } catch {
            // The injected failure is what reaches the unfinished sweep.
        }
    } finally {
        fs.readdirSync = origReadDir
        profileWriteTest.beforeTreeMutation = null
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(profilesRoot, held)
    }
    check(
        'an unfinished compile does not list a profiles directory swapped for a link',
        held !== '' && !followed && sameStamp(outside.file, outside.before),
        JSON.stringify({ held: Boolean(held), followed })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

{
    const id = 'abcdef02'
    const scope = `try${id}`
    const outsideProfiles = outsideDir('try-list-prof', 'try-list-prof\n')
    fs.writeFileSync(path.join(outsideProfiles.dir, 'secret-try-profiles'), 'listed\n')
    const outsideWork = outsideDir('try-list-work', 'try-list-work\n')
    fs.writeFileSync(path.join(outsideWork.dir, 'secret-try-workspaces'), 'listed\n')
    const profilesRoot = hermesProfiles()
    if (!fs.existsSync(profilesRoot)) fs.mkdirSync(profilesRoot, { recursive: true })
    const workRoot = path.join(process.env.CUTTLELY_DATA_DIR, 'workspaces')
    if (!fs.existsSync(workRoot)) fs.mkdirSync(workRoot, { recursive: true })
    let profilesFollowed = false
    let workFollowed = false
    let heldProfiles = ''
    let heldWork = ''
    const origReadDir = fs.readdirSync
    fs.readdirSync = (p, ...args) => {
        const stack = new Error().stack || ''
        if (!heldProfiles && pathNamesDir(p, profilesRoot) && (stack.includes('tryProfileNames') || stack.includes('tryScopeEntries'))) {
            heldProfiles = swapTree(profilesRoot, outsideProfiles.dir)
        }
        if (!heldWork && pathNamesDir(p, workRoot) && stack.includes('tryScopeEntries')) {
            heldWork = swapTree(workRoot, outsideWork.dir)
        }
        const names = origReadDir(p, ...args)
        if (names.includes('secret-try-profiles')) profilesFollowed = true
        if (names.includes('secret-try-workspaces')) workFollowed = true
        return names
    }
    const previousClose = tryRuntime.closeProfiles
    tryRuntime.closeProfiles = async () => {}
    try {
        await discardTryProfile(id)
    } finally {
        fs.readdirSync = origReadDir
        tryRuntime.closeProfiles = previousClose
        restoreTree(profilesRoot, heldProfiles)
        restoreTree(workRoot, heldWork)
    }
    check(
        'try cleanup does not list profiles or workspaces swapped for a link',
        heldProfiles !== '' &&
            heldWork !== '' &&
            !profilesFollowed &&
            !workFollowed &&
            sameStamp(outsideProfiles.file, outsideProfiles.before) &&
            sameStamp(outsideWork.file, outsideWork.before),
        JSON.stringify({ heldProfiles: Boolean(heldProfiles), heldWork: Boolean(heldWork), profilesFollowed, workFollowed })
    )
    fs.rmSync(outsideProfiles.dir, { recursive: true, force: true })
    fs.rmSync(outsideWork.dir, { recursive: true, force: true })
}

{
    const name = 'plinkoldlist'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-old-list-'))
    const home = path.join(scratch, 'home')
    const profilesRoot = path.join(home, 'profiles')
    fs.mkdirSync(profilesRoot, { recursive: true })
    const outside = outsideDir('old-list', 'old-list-sentinel\n')
    fs.writeFileSync(path.join(outside.dir, 'secret-outdated'), 'listed\n')
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let followed = false
    let held = ''
    const origReadDir = fs.readdirSync
    fs.readdirSync = (p, ...args) => {
        if (!held && pathNamesDir(p, profilesRoot) && (new Error().stack || '').includes('profileOutdated')) {
            held = swapTree(profilesRoot, outside.dir)
        }
        const names = origReadDir(p, ...args)
        if (names.includes('secret-outdated')) followed = true
        return names
    }
    try {
        try {
            recompileOutdatedProfiles([record(name, [])], { log: {} })
        } catch {
            // Listing the outside directory is the failure, not the refusal.
        }
    } finally {
        fs.readdirSync = origReadDir
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
        restoreTree(profilesRoot, held)
    }
    check(
        'an outdated check does not list a profiles directory swapped for a link',
        held !== '' && !followed && sameStamp(outside.file, outside.before),
        JSON.stringify({ held: Boolean(held), followed })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// The anchor is checked only after mkdir, so a parent that has left the root still gets a child.
{
    const name = 'plinkanchor'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-anchor-'))
    const home = path.join(scratch, 'home')
    const profilesRoot = path.join(home, 'profiles')
    fs.mkdirSync(profilesRoot, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let movedTo = ''
    let mkdirAfterMove = false
    let refused = ''
    const origOpen = fs.openSync
    const origMkdir = fs.mkdirSync
    fs.openSync = (p, ...args) => {
        if (!movedTo && typeof p === 'string' && p.endsWith(`/${name}`)) {
            const stack = new Error().stack || ''
            if (stack.includes('ensureChildDir') && stack.includes('ensureContainedDir')) {
                movedTo = path.join(scratch, 'outside-profiles')
                fs.renameSync(profilesRoot, movedTo)
            }
        }
        return origOpen(p, ...args)
    }
    fs.mkdirSync = (p, ...args) => {
        if (movedTo) mkdirAfterMove = true
        return origMkdir(p, ...args)
    }
    try {
        try {
            compileProfileCached(record(name, []))
        } catch (error) {
            refused = error?.code || ''
        }
    } finally {
        fs.openSync = origOpen
        fs.mkdirSync = origMkdir
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
    }
    const created = Boolean(movedTo) && fs.existsSync(path.join(movedTo, name))
    check(
        'a profile directory is not created once its parent has left the profiles root',
        refused === 'profile_link' && movedTo !== '' && !created && !mkdirAfterMove,
        JSON.stringify({ refused, movedTo: Boolean(movedTo), created, mkdirAfterMove })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// A child such as memory is created from the opened profile directory. That directory can leave the
// profiles root after it was opened and before the child is created.
{
    const name = 'plinkmem'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-mem-'))
    const home = path.join(scratch, 'home')
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let movedTo = ''
    let mkdirAfterMove = false
    let refused = ''
    const origOpen = fs.openSync
    const origMkdir = fs.mkdirSync
    fs.openSync = (p, ...args) => {
        if (!movedTo && typeof p === 'string' && p.endsWith('/memory')) {
            const stack = new Error().stack || ''
            if (stack.includes('ensureChildDir') && !stack.includes('ensureContainedDir')) {
                movedTo = path.join(scratch, 'outside-profile')
                fs.renameSync(dir, movedTo)
            }
        }
        return origOpen(p, ...args)
    }
    fs.mkdirSync = (p, ...args) => {
        if (movedTo) mkdirAfterMove = true
        return origMkdir(p, ...args)
    }
    try {
        try {
            compileProfileCached(record(name, []))
        } catch (error) {
            refused = error?.code || ''
        }
    } finally {
        fs.openSync = origOpen
        fs.mkdirSync = origMkdir
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
    }
    const created = Boolean(movedTo) && fs.existsSync(path.join(movedTo, 'memory'))
    check(
        'a profile child is not created once its directory has left the profiles root',
        refused === 'profile_link' && movedTo !== '' && !created && !mkdirAfterMove,
        JSON.stringify({ refused, movedTo: Boolean(movedTo), created, mkdirAfterMove })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// openedReal is accepted when it still matches the fd, even if that path is already outside the root.
{
    const name = 'plinkqout'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-qout-'))
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home, { recursive: true })
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const saved = record(name, [])
    const outside = outsideFile('qout', 'qout-sentinel\n')
    let movedTo = ''
    const origRealpath = fs.realpathSync
    try {
        compileProfileCached(saved)
        forgetCompiledProfile(name)
        const soul = profilePath(name, 'SOUL.md')
        fs.renameSync(soul, `${soul}.real`)
        fs.symlinkSync(outside.file, soul)
        fs.realpathSync = (p, options) => {
            if (!movedTo && typeof p === 'string' && /^\/proc\/self\/fd\/\d+$/.test(p)) {
                const stack = new Error().stack || ''
                if (stack.includes('quarantineSymlink') && !stack.includes('profilesRootReal')) {
                    movedTo = path.join(scratch, 'outside-profile')
                    fs.renameSync(profilePath(name), movedTo)
                }
            }
            return origRealpath(p, options)
        }
        try {
            compileProfileCached(saved)
        } catch {
            // The refusal is expected. Claiming the name outside the root is not.
        }
    } finally {
        fs.realpathSync = origRealpath
        process.env.CUTTLELY_HERMES_HOME = previousHome
        forgetCompiledProfile(name)
    }
    const soulStat = movedTo ? fs.lstatSync(path.join(movedTo, 'SOUL.md'), { throwIfNoEntry: false }) : null
    const claimed = movedTo
        ? fs.readdirSync(movedTo).some((entry) => entry === 'SOUL.md.quarantine' || entry.startsWith('SOUL.md.quarantine-'))
        : false
    check(
        'quarantine does not claim a name once the opened directory is outside the profiles root',
        movedTo !== '' && soulStat?.isSymbolicLink() === true && !claimed && sameStamp(outside.file, outside.before),
        JSON.stringify({ movedTo: Boolean(movedTo), stillLink: soulStat?.isSymbolicLink() === true, claimed })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

{
    const name = 'plinkaside'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-aside-'))
    const home = path.join(scratch, 'home')
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'old-config\n')
    fs.writeFileSync(path.join(dir, 'harness-roster.json'), '{}\n')
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    let movedTo = ''
    const origRealpath = fs.realpathSync
    fs.realpathSync = (p, options) => {
        if (!movedTo && typeof p === 'string' && /^\/proc\/self\/fd\/\d+$/.test(p)) {
            const stack = new Error().stack || ''
            if (stack.includes('setAsideConfig') && !stack.includes('profilesRootReal')) {
                movedTo = path.join(scratch, 'outside-profile')
                fs.renameSync(dir, movedTo)
                // The logical path has to exist or the set-aside stops before the opened directory is renamed.
                fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(path.join(dir, 'config.yaml'), 'decoy\n')
                fs.writeFileSync(path.join(dir, 'harness-roster.json'), '{}\n')
            }
        }
        return origRealpath(p, options)
    }
    try {
        try {
            setAsideOutdatedConfigs()
        } catch {
            // A refusal leaves the config where it was opened.
        }
    } finally {
        fs.realpathSync = origRealpath
        process.env.CUTTLELY_HERMES_HOME = previousHome
    }
    const configText =
        movedTo && fs.existsSync(path.join(movedTo, 'config.yaml')) ? fs.readFileSync(path.join(movedTo, 'config.yaml'), 'utf8') : ''
    const outdated = Boolean(movedTo) && fs.existsSync(path.join(movedTo, 'config.yaml.outdated'))
    check(
        'config set-aside does not rename a file once the opened directory is outside the profiles root',
        movedTo !== '' && configText === 'old-config\n' && !outdated,
        JSON.stringify({ movedTo: Boolean(movedTo), configText, outdated })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
}

// Ownership and set-aside must not stat a child through a directory swapped for a link.
{
    const name = 'plinkownstat'
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-own-stat-'))
    const home = path.join(scratch, 'home')
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'old-config\n')
    fs.writeFileSync(path.join(dir, 'harness-roster.json'), '{}\n')
    const outside = outsideDir('own-stat', 'own-stat-sentinel\n')
    const outsideDirPath = path.join(outside.dir, name)
    fs.mkdirSync(outsideDirPath)
    fs.writeFileSync(path.join(outsideDirPath, 'config.yaml'), 'outside-config\n')
    fs.writeFileSync(path.join(outsideDirPath, 'harness-roster.json'), '{}\n')
    const marker = fs.statSync(path.join(outsideDirPath, 'harness-roster.json'))
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_HERMES_HOME = home
    const origLstat = fs.lstatSync
    const origStat = fs.statSync
    const origOpen = fs.openSync
    let absoluteStats = 0
    let followed = false
    let swapped = false
    let held = ''
    const note = (p) => {
        if (typeof p !== 'string' || path.resolve(p).startsWith('/proc/')) return
        const resolved = path.resolve(p)
        if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return
        if (resolved === dir) return
        const stack = new Error().stack || ''
        if (!stack.includes('setAsideConfig') && !stack.includes('harnessOwnedDir')) return
        absoluteStats += 1
        if (!swapped) {
            swapped = true
            held = swapTree(dir, outsideDirPath)
        }
    }
    fs.lstatSync = (p, ...args) => {
        note(p)
        const st = origLstat(p, ...args)
        if (
            swapped &&
            typeof p === 'string' &&
            path.resolve(p) === path.join(dir, 'harness-roster.json') &&
            st &&
            st.ino === marker.ino &&
            st.dev === marker.dev
        ) {
            followed = true
        }
        return st
    }
    fs.statSync = (p, ...args) => {
        note(p)
        const st = origStat(p, ...args)
        if (swapped && typeof p === 'string' && path.resolve(p) === path.join(dir, 'config.yaml') && st && st.ino === marker.ino)
            followed = true
        return st
    }
    fs.openSync = (p, ...args) => {
        note(p)
        return origOpen(p, ...args)
    }
    try {
        try {
            setAsideOutdatedConfigs()
        } catch {
            // A refusal is fine. Stating the outside directory is not.
        }
    } finally {
        fs.lstatSync = origLstat
        fs.statSync = origStat
        fs.openSync = origOpen
        process.env.CUTTLELY_HERMES_HOME = previousHome
        restoreTree(dir, held)
    }
    check(
        'a boot sweep does not stat a profile child through a swapped directory',
        absoluteStats === 0 && !followed && sameStamp(outside.file, outside.before),
        JSON.stringify({ absoluteStats, followed, swapped })
    )
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(outside.dir, { recursive: true, force: true })
}

// Directory creation uses /proc/self/fd on Linux. Elsewhere the same compile uses the open directory's path.
{
    const name = 'plinkotheros'
    const saved = record(name)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let error = ''
    try {
        compileProfileCached(saved)
    } catch (caught) {
        error = `${caught?.code || ''} ${caught?.message || caught}`
    } finally {
        Object.defineProperty(process, 'platform', descriptor)
    }
    check(
        'a profile is refused where directory descriptors have no proc path',
        error.includes('Agent profiles are saved and compiled only on Linux (darwin). Use the Docker image.') &&
            !fs.existsSync(profilePath(name, 'config.yaml')),
        error
    )
    cleanupProfile(name)
}

// The env file is read from the opened profile directory. That directory can leave the profiles root
// after it was opened and before the read.
{
    const name = 'plinkenvmove'
    compileProfileCached(record(name))
    forgetCompiledProfile(name)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plink-envmove-'))
    const movedTo = path.join(scratch, 'outside-profile')
    let moved = false
    profileWriteTest.beforeEnvRead = (file) => {
        if (moved || path.resolve(file) !== path.resolve(profilePath(name, '.env'))) return
        moved = true
        fs.renameSync(profilePath(name), movedTo)
        fs.writeFileSync(path.join(movedTo, '.env'), 'OUTSIDE_ENV_SENTINEL=moved-before-read\n')
    }
    let refused = ''
    let env = null
    try {
        env = readProfileEnv(name)
    } catch (error) {
        refused = error?.code || ''
    } finally {
        profileWriteTest.beforeEnvRead = null
    }
    check(
        'an env file is not read once its profile directory has left the profiles root',
        moved && refused === 'profile_link' && !env?.OUTSIDE_ENV_SENTINEL,
        JSON.stringify({ moved, refused, read: Boolean(env?.OUTSIDE_ENV_SENTINEL) })
    )
    cleanupProfile(name)
    fs.rmSync(scratch, { recursive: true, force: true })
}

fs.rmSync(dataDir, { recursive: true, force: true })
if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
}
console.log('\nall profile link preflight checks passed')
