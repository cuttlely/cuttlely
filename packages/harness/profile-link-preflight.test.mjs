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
    forgetCompiledProfile,
    profileDestinationConflicts,
    profileWriteTest,
    readProfileEnv,
    recompileOutdatedProfiles,
    setAsideOutdatedConfigs,
    specialistWorkspace
} = await import('./profile.mjs')
const { installPresetKit } = await import('./presets.mjs')
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

// A roster file that is a link is not read while boot decides what to compile.
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
    const guarded = guardLink(roster, outside.file, () => recompileOutdatedProfiles([saved]))
    const linkStat = fs.lstatSync(roster, { throwIfNoEntry: false })
    check(
        'a linked roster file is not read during boot',
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

fs.rmSync(dataDir, { recursive: true, force: true })
if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
}
console.log('\nall profile link preflight checks passed')
