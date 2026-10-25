import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { isFlowiseMcpBinding } from './bridge.mjs'
import { CHIEF_MODEL_REQUIRED, HarnessError } from './errors.mjs'
import { stableStringify } from './flow-graph.mjs'
import { credentialStamp } from './credential-store.mjs'
import { forgetProfileToken, gatewayListenPort, gatewayOrigin, gatewayUrl, registerProfileToken } from './gateway.mjs'
import { endLiveTry, noteLiveTry } from './try-live.mjs'
import { ancestorPaths, listDirNoFollow, readFileNoFollow } from './contained-walk.mjs'
import { dataRoot, harnessStoreDir, repoRoot, hermesHome, profileDir } from './paths.mjs'
import { ANALYST_RULES_MAX_CHARS, ROUTING_SUMMARY_CHARS, joinedAnalystRules, routingSummaryText } from './store.mjs'
import { SQL_TOOL_REFUSED, refusedRawServer } from './sql-tools.mjs'
import { installPresetKit, normalizePresetSpecialist, presetInstructions, presetSummary } from './presets.mjs'
import { parseRelationSelection } from './runtime/analyst-relations.mjs'

const require = createRequire(import.meta.url)

const CHIEF_TOOLSETS = ['delegation', 'memory', 'session_search']
const BLOCKED_UNLESS_ENABLED = ['terminal', 'browser', 'code_execution', 'file', 'web']
// Read-only Hermes skills (skills_list, skill_view; a Cuttlely patch in hermes/toolsets.py). Playbooks live in
// the profile's skills folder under PLAYBOOK_DIR, which Cuttlely owns and rewrites on every compile.
export const PLAYBOOK_TOOLSET = 'skills_read'
export const PLAYBOOK_DIR = 'harness-playbooks'
export const SPECIALIST_PLAYBOOKS =
    'Your playbooks are listed under skills. Before you answer, load each playbook whose description fits the question with skill_view, and follow it.'
const SPECIALIST_STALE_SECONDS = 45
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PROFILE_MAX = 64
const PROFILE_HASH = 8

// Provider keys are never written into a profile. Tool credentials still cannot smuggle one in under these names.
const MODEL_ENV_KEYS = [
    ['OPENAI', '_API_KEY'].join(''),
    ['XAI', '_API_KEY'].join(''),
    ['ANTHROPIC', '_API_KEY'].join(''),
    ['OPENROUTER', '_API_KEY'].join(''),
    ['GROQ', '_API_KEY'].join(''),
    ['GOOGLE', '_API_KEY'].join(''),
    ['DEEPSEEK', '_API_KEY'].join(''),
    ['HERMES', '_MODEL_KEY'].join(''),
    ['MINIMAX', '_API_KEY'].join('')
]

const PLACEHOLDER_VALUES = new Set(['', 'changeme', 'change-me', 'your-api-key', 'replace-me', 'sk-xxx'])

function yamlQuote(value) {
    return JSON.stringify(String(value))
}

function yamlToken(value) {
    const text = String(value)
    if (!/^[A-Za-z0-9._-]+$/.test(text)) {
        throw new HarnessError('bad_model', `Model value "${text}" is not a plain token.`)
    }
    return text
}

function credentialIdOf(value) {
    const credentialId = typeof value?.credentialId === 'string' ? value.credentialId.trim() : ''
    if (!credentialId || credentialId.length > 80 || /\s/.test(credentialId)) return ''
    return credentialId
}

export function modelChoice(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.nodeName) {
        const credential = typeof value.credential === 'string' ? value.credential.trim() : ''
        const credentialId = credentialIdOf(value)
        return {
            nodeId: value.nodeId,
            nodeName: value.nodeName,
            label: value.label,
            category: value.category,
            inputs: value.inputs || {},
            ...(value.upstream ? { upstream: value.upstream } : {}),
            ...(value.outputs ? { outputs: value.outputs } : {}),
            ...(value.description ? { description: value.description } : {}),
            ...(credential ? { credential } : {}),
            ...(credentialId ? { credentialId } : {})
        }
    }
    if (!value.provider || !value.model) return null
    const credentialId = credentialIdOf(value)
    return {
        provider: String(value.provider),
        model: String(value.model),
        ...(credentialId ? { credentialId } : {})
    }
}

function describedModel(model) {
    if (!model) return ''
    const name = model.inputs?.modelName || model.label || model.model
    return name ? String(name) : ''
}

// A char-class replace can leave a long run of dashes. An end-anchored dash quantifier is polynomial on that run, so this walks the ends.
function trimDashEnds(value) {
    let start = 0
    let end = value.length
    while (start < end && value.charCodeAt(start) === 45) start += 1
    while (end > start && value.charCodeAt(end - 1) === 45) end -= 1
    return value.slice(start, end)
}

function trimLeadingDashes(value) {
    let start = 0
    while (start < value.length && value.charCodeAt(start) === 45) start += 1
    return value.slice(start)
}

function profileHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, PROFILE_HASH)
}

// A try id is "try" plus 16 hex characters, so a long specialist slug no longer fits in 64.
// Ids that already fit stay as they are. A fitted id keeps a hash of the full slug so two long names cannot collide.
// When the harness name itself leaves no room, the directory is tryx plus 16 hex. That is not a savable harness
// name and it has no "--", so it cannot equal some other harness's specialist profile.
function fittedProfileId(harness, slug) {
    const hash = crypto.createHash('sha256').update(`${harness}\0${slug}`).digest('hex').slice(0, 16)
    return `tryx${hash}`
}

function fitSpecialistProfile(harness, slug) {
    const suffix = `-${profileHash(slug)}`
    const slugRoom = PROFILE_MAX - harness.length - '--'.length - suffix.length
    if (slugRoom < 1) {
        const fitted = fittedProfileId(harness, slug)
        if (!PROFILE_ID_RE.test(fitted)) {
            throw new HarnessError('bad_name', `Specialist "${slug}" cannot get its own model profile.`)
        }
        return fitted
    }
    const slugKept = trimDashEnds(slug.slice(0, slugRoom))
    const fitted = slugKept ? `${harness}--${slugKept}${suffix}` : `${harness}--${profileHash(slug)}`
    if (fitted.length > PROFILE_MAX || !PROFILE_ID_RE.test(fitted)) {
        throw new HarnessError('bad_name', `Specialist "${slug}" cannot get its own model profile.`)
    }
    return fitted
}

export function specialistProfileName(harnessName, specialistName) {
    const harness = String(harnessName || '').toLowerCase()
    const slug = trimDashEnds(
        String(specialistName || '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
    )
    const profile = `${harness}--${slug}`
    if (profile.length <= PROFILE_MAX && PROFILE_ID_RE.test(profile)) return profile
    return fitSpecialistProfile(harness, slug || String(specialistName || 'specialist'))
}

function serverNameFor(specialist) {
    return specialist.name
}

export function hermesToolsetsFor(specialist) {
    // Hermes treats an MCP server name as the toolset. A "mcp-" prefix is an unknown
    // toolset, so the first turn starts before that server's tools exist.
    // Add that name only when the bridge is on. A specialist named "browser" must not
    // drop the built-in browser toolset just because the bridge is off.
    const sets = []
    if (usesBridge(specialist)) sets.push(serverNameFor(specialist))
    for (const mcp of specialist.mcpServers || []) {
        if (isFlowiseMcpBinding(mcp)) continue
        const config = parseServerConfig(mcp)
        if (refusedRawServer(mcp, config)) continue
        if (!config || rawServerProblem(config)) continue
        const name = sanitizeServerName(mcp.serverName || config?.name || `${specialist.name}-mcp`)
        if (!sets.includes(name)) sets.push(name)
    }
    if (specialist.shell) sets.push('terminal')
    if (specialist.browser) sets.push('browser')
    if (specialist.codeExecution) sets.push('code_execution')
    if (specialist.fileAccess) sets.push('file')
    if ((specialist.playbooks || []).length) sets.push(PLAYBOOK_TOOLSET)
    return sets
}

export function needsAgentLoop(specialist) {
    return Boolean(
        specialist?.shell ||
            specialist?.browser ||
            specialist?.codeExecution ||
            specialist?.fileAccess ||
            (specialist?.playbooks || []).length ||
            (specialist?.mcpServers || []).length
    )
}

export function specialistWorkspace(profileName) {
    return path.join(dataRoot(), 'workspaces', profileName)
}

function profilesRoot() {
    return path.join(hermesHome(), 'profiles')
}

function workspacesRoot() {
    return path.join(dataRoot(), 'workspaces')
}

function throwLink(where) {
    throw new HarnessError('profile_link', `profile path is a link: ${where}`)
}

// A quarantined link keeps a sibling name an operator can put back. The dot keeps it out of the runtime's profile ids.
function isQuarantineName(name) {
    return name.endsWith('.quarantine') || /\.quarantine-\d+$/.test(name)
}

// How many sibling names are tried. There is no further fallback after this.
export const QUARANTINE_SUFFIX_CAP = 1000

// Tests replace a directory with a link after its fd is open and before the file is created,
// or create a file at a quarantine destination after that name is chosen.
export const profileWriteTest = {
    beforeFinalOpen: null,
    // Runs after a quarantine destination is chosen and before the exclusive claim, so a test can
    // create a file in that gap. Production leaves this null.
    beforeQuarantineClaim: null,
    // Runs after link(2) names the symlink and before the source name is checked again. Production leaves this null.
    afterQuarantineLink: null,
    // Runs after a cached compile has checked a directory and before it checks that directory's config. Production leaves this null.
    betweenCacheChecks: null,
    // Runs after the directory that holds the profile env is open and before that file is opened.
    // Production leaves this null.
    beforeEnvRead: null,
    // Runs after a profile tree has been checked and before it is created or removed.
    // Production leaves this null.
    beforeTreeMutation: null,
    // Runs after the opened directory is checked and before this file is opened for writing.
    // Production leaves this null.
    beforeContainedOpen: null
}

const quarantineFailureLogged = new Set()

function logQuarantineFailure(linkPath) {
    if (quarantineFailureLogged.has(linkPath)) return
    quarantineFailureLogged.add(linkPath)
    console.error(`[harness] profile link could not be quarantined: ${linkPath}`)
}

function quarantineSuffixName(base, n) {
    return n === 0 ? `${base}.quarantine` : `${base}.quarantine-${n}`
}

// The profiles directory as opened, so a later rename of a child is not still "inside" by its old path.
function profilesRootReal() {
    if (process.platform !== 'linux') return ''
    let opened = null
    try {
        opened = openDirNoFollow(profilesRoot(), { quiet: true })
        if (!opened) return ''
        return realOfFd(opened.fd)
    } catch {
        return ''
    } finally {
        if (opened) closeFds(opened.fds)
    }
}

// Moves the symlink's directory entry to a sibling. link(2) names the symlink itself and fails with
// EEXIST instead of replacing a file that appears at that name; the next suffix is tried. The
// target is not opened. The parent directory is the one opened without following. If that directory
// is moved outside the profiles root before the claim, the link stays where it is.
// After QUARANTINE_SUFFIX_CAP failures the link stays where it is. False when the link is still there.
// The parent of a profile file is inside the profiles tree. The parent of the profiles directory
// itself is not, so that one real directory is opened directly. A link is not opened.
function openQuarantineParent(dir) {
    if (ancestorPaths(dir)) return openDirNoFollow(dir, { quiet: true })
    let fd
    try {
        fd = fs.openSync(dir, DIR_FLAGS)
    } catch {
        return null
    }
    try {
        if (fs.fstatSync(fd).isSymbolicLink()) {
            fs.closeSync(fd)
            return null
        }
    } catch {
        fs.closeSync(fd)
        return null
    }
    return { fd, fds: [fd] }
}

function quarantineSymlink(linkPath) {
    const dir = path.dirname(path.resolve(linkPath))
    const base = path.basename(linkPath)
    if (!base || base === '.' || base === '..') return false
    let opened
    try {
        opened = openQuarantineParent(dir)
    } catch {
        return false
    }
    if (!opened) return false
    const rootReal = profilesRootReal()
    const openedReal = realOfFd(opened.fd)
    // A rename of this directory out of the profiles tree is not a place we claim a sibling name.
    const stillInside = () => {
        if (process.platform !== 'linux') return true
        const here = realOfFd(opened.fd)
        if (!here) return false
        if (openedReal && here === openedReal) return true
        return Boolean(rootReal && insideRoot(rootReal, here))
    }
    const dropClaim = (viaDest, claimed) => {
        try {
            const stillClaimed = fs.lstatSync(viaDest)
            if (stillClaimed.isSymbolicLink() && stillClaimed.dev === claimed.dev && stillClaimed.ino === claimed.ino) {
                fs.unlinkSync(viaDest)
            }
        } catch {
            // The extra name is already gone.
        }
    }
    try {
        let st
        try {
            st = lstatChild(opened.fd, dir, base)
        } catch {
            return false
        }
        if (!st || !st.isSymbolicLink() || !stillInside()) return false
        for (let n = 0; n < QUARANTINE_SUFFIX_CAP; n += 1) {
            const destName = quarantineSuffixName(base, n)
            const dest = path.join(dir, destName)
            if (typeof profileWriteTest.beforeQuarantineClaim === 'function') {
                profileWriteTest.beforeQuarantineClaim(linkPath, dest)
            }
            // The hook can move this directory outside the profiles root. Do not claim through that.
            if (!stillInside()) {
                logQuarantineFailure(linkPath)
                return false
            }
            const viaSrc = childPath(opened.fd, dir, base)
            const viaDest = childPath(opened.fd, dir, destName)
            try {
                // Linux link(2) does not follow the symlink, and it does not replace an existing name.
                fs.linkSync(viaSrc, viaDest)
            } catch (error) {
                if (error?.code === 'EEXIST') continue
                logQuarantineFailure(linkPath)
                return false
            }
            if (!stillInside()) {
                try {
                    const claimed = fs.lstatSync(viaDest)
                    if (claimed.isSymbolicLink() && claimed.dev === st.dev && claimed.ino === st.ino) fs.unlinkSync(viaDest)
                } catch {
                    // The extra name is already gone.
                }
                logQuarantineFailure(linkPath)
                return false
            }
            let claimed
            try {
                claimed = fs.lstatSync(viaDest)
            } catch {
                logQuarantineFailure(linkPath)
                return false
            }
            if (!claimed.isSymbolicLink() || claimed.dev !== st.dev || claimed.ino !== st.ino) {
                // The claim did not name the symlink we saw. Drop that extra name only when it is the
                // same file as the source, so a different file's bytes stay as they were.
                try {
                    const sourceNow = fs.lstatSync(viaSrc)
                    if (sourceNow.dev === claimed.dev && sourceNow.ino === claimed.ino) fs.unlinkSync(viaDest)
                } catch {
                    // The source is still on the load path, or the extra name is already gone.
                }
                logQuarantineFailure(linkPath)
                return false
            }
            if (typeof profileWriteTest.afterQuarantineLink === 'function') profileWriteTest.afterQuarantineLink(linkPath, dest)
            if (!stillInside()) {
                dropClaim(viaDest, claimed)
                logQuarantineFailure(linkPath)
                return false
            }
            // The source name can be replaced after the link. Unlink only when it is still that symlink.
            let sourceNow = null
            let destNow = null
            try {
                sourceNow = fs.lstatSync(viaSrc)
                destNow = fs.lstatSync(viaDest)
            } catch {
                sourceNow = null
                destNow = null
            }
            const sameSymlink = (stat) => stat && stat.isSymbolicLink() && stat.dev === claimed.dev && stat.ino === claimed.ino
            if (!sameSymlink(sourceNow) || !sameSymlink(destNow)) {
                dropClaim(viaDest, claimed)
                logQuarantineFailure(linkPath)
                return false
            }
            try {
                fs.unlinkSync(viaSrc)
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    logQuarantineFailure(linkPath)
                    return false
                }
            }
            console.warn(`[harness] quarantined profile link ${linkPath} as ${dest}`)
            return true
        }
        logQuarantineFailure(linkPath)
        return false
    } finally {
        closeFds(opened.fds)
    }
}

function rootFor(file) {
    const resolved = path.resolve(file)
    for (const root of [profilesRoot(), workspacesRoot()]) {
        const base = path.resolve(root)
        if (resolved === base || resolved.startsWith(base + path.sep)) return base
    }
    throwLink(file)
}

// Refuse a symlink at the root and at every segment down to the file. realpath of what exists must stay inside the root.
function assertContained(file) {
    const root = rootFor(file)
    // The containment root is opened from above it, so a link in an ancestor is not followed.
    assertDirNoFollow(root)
    let rootStat
    try {
        rootStat = fs.lstatSync(root)
    } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
    }
    if (rootStat.isSymbolicLink()) {
        refuseLink(root)
    }
    const rel = path.relative(root, path.resolve(file))
    if (rel.startsWith('..') || path.isAbsolute(rel)) throwLink(file)
    if (!rel) return
    let cursor = root
    for (const part of rel.split(path.sep)) {
        if (!part) continue
        cursor = path.join(cursor, part)
        let st
        try {
            st = fs.lstatSync(cursor)
        } catch (error) {
            if (error?.code === 'ENOENT') return
            throw error
        }
        if (st.isSymbolicLink()) {
            refuseLink(cursor)
        }
    }
    let realRoot
    try {
        realRoot = fs.realpathSync(root)
    } catch {
        return
    }
    let existing = path.resolve(file)
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing)
        if (parent === existing) return
        existing = parent
    }
    let realExisting
    try {
        realExisting = fs.realpathSync(existing)
    } catch {
        return
    }
    const within = path.relative(realRoot, realExisting)
    if (within.startsWith('..') || path.isAbsolute(within)) throwLink(file)
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW

function fdPath(dirFd, name) {
    // An absolute path opened after the parent was checked still walks every ancestor.
    // Without a descriptor path, or without O_NOFOLLOW, that walk can follow a link.
    if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW) return null
    return `/proc/self/fd/${dirFd}/${name}`
}

function realOfFd(fd) {
    if (process.platform !== 'linux') return ''
    return fs.realpathSync(`/proc/self/fd/${fd}`)
}

function insideRoot(rootReal, candidate) {
    if (!rootReal || !candidate) return false
    const rel = path.relative(rootReal, candidate)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function closeFds(fds) {
    for (let i = fds.length - 1; i >= 0; i -= 1) {
        try {
            fs.closeSync(fds[i])
        } catch {
            // Already closed.
        }
    }
}

function insideProfilesRoot(file) {
    let root
    try {
        root = path.resolve(profilesRoot())
    } catch {
        return false
    }
    const resolved = path.resolve(file)
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// A link inside the profiles tree is moved off the load path. A link outside that tree is left where it is.
function quarantineContained(linkPath) {
    if (!insideProfilesRoot(linkPath)) return false
    return quarantineSymlink(linkPath)
}

function refuseLink(linkPath) {
    quarantineContained(linkPath)
    throwLink(linkPath)
}

// Opens dir from the filesystem root. Each step uses O_DIRECTORY|O_NOFOLLOW, so a link swapped in
// for an ancestor is not a path we follow. Null when a component does not exist yet.
// leaf: false opens every ancestor and stops before dir, so the caller can still handle a link at dir.
function openDirNoFollow(dir, options = {}) {
    const includeLeaf = options.leaf !== false
    // quiet returns null when a component is a link, and does not move that link aside.
    const quiet = options.quiet === true
    const paths = ancestorPaths(dir)
    if (!paths) {
        if (quiet) return null
        throwLink(dir)
    }
    const limit = includeLeaf ? paths.length : paths.length - 1
    if (limit <= 0) return null
    const fds = []
    const stop = (where) => {
        closeFds(fds)
        if (quiet) return null
        refuseLink(where)
    }
    try {
        let dirFd
        try {
            dirFd = fs.openSync(paths[0], DIR_FLAGS)
        } catch (error) {
            if (error?.code === 'ELOOP' || error?.code === 'EEXIST') return stop(paths[0])
            throw error
        }
        fds.push(dirFd)
        for (let i = 1; i < limit; i += 1) {
            const logical = paths[i]
            const part = path.basename(logical)
            if (!part || part === '.' || part === '..') return stop(logical)
            const via = fdPath(dirFd, part)
            if (!via) return stop(logical)
            let next
            try {
                next = fs.openSync(via, DIR_FLAGS)
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    closeFds(fds)
                    return null
                }
                if (error?.code === 'ELOOP' || error?.code === 'EEXIST' || error?.code === 'ENOTDIR') return stop(logical)
                closeFds(fds)
                throw error
            }
            fds.push(next)
            dirFd = next
            if (fs.fstatSync(dirFd).isSymbolicLink()) return stop(logical)
        }
        if (!includeLeaf) {
            closeFds(fds)
            return null
        }
        return { fd: dirFd, fds }
    } catch (error) {
        closeFds(fds)
        throw error
    }
}

// A link above dir is refused before dir is used. A link at dir itself is left for the caller.
function refuseAncestorsOf(dir) {
    openDirNoFollow(dir, { leaf: false })
}

function assertDirNoFollow(dir) {
    const opened = openDirNoFollow(dir)
    if (opened) closeFds(opened.fds)
}

// The child is named through the directory descriptor. The absolute path would follow an ancestor
// swapped after this directory was opened, so a missing descriptor path is refused.
function childPath(dirFd, logicalDir, name) {
    const via = fdPath(dirFd, name)
    if (!via) throwLink(path.join(logicalDir, name))
    return via
}

function namesIn(fd, logicalDir) {
    if (!fdPath(fd, '.')) throwLink(logicalDir)
    return fs.readdirSync(`/proc/self/fd/${fd}`)
}

function lstatChild(dirFd, logicalDir, name) {
    try {
        return fs.lstatSync(childPath(dirFd, logicalDir, name))
    } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
    }
}

// Creates or opens one child of an already-open directory. A link at that name is refused.
function ensureChildDir(dirFd, logicalDir, name, fds, anchor = '') {
    const logical = path.join(logicalDir, name)
    const via = childPath(dirFd, logicalDir, name)
    const openDir = () => {
        try {
            return fs.openSync(via, DIR_FLAGS)
        } catch (error) {
            if (error?.code === 'ENOENT') return null
            if (error?.code === 'ELOOP' || error?.code === 'EEXIST') refuseLink(logical)
            if (error?.code === 'ENOTDIR') {
                if (lstatChild(dirFd, logicalDir, name)?.isSymbolicLink()) refuseLink(logical)
                throw error
            }
            throw error
        }
    }
    let fd = openDir()
    if (fd == null) {
        try {
            fs.mkdirSync(via)
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error
        }
        fd = openDir()
        if (fd == null) throwLink(logical)
    }
    fds.push(fd)
    if (anchor && process.platform === 'linux') {
        const here = realOfFd(fd)
        if (here && !insideRoot(anchor, here)) throwLink(logical)
    }
    return fd
}

// Opens absDir from the filesystem root, creating missing directories from the parent descriptor.
// A link swapped in for any component is not followed.
function ensureContainedDir(absDir) {
    const paths = ancestorPaths(absDir)
    if (!paths) throwLink(absDir)
    const root = rootFor(absDir)
    const fds = []
    try {
        let dirFd
        try {
            dirFd = fs.openSync(paths[0], DIR_FLAGS)
        } catch (error) {
            if (error?.code === 'ELOOP' || error?.code === 'EEXIST') refuseLink(paths[0])
            throw error
        }
        fds.push(dirFd)
        let anchor = ''
        for (let i = 1; i < paths.length; i += 1) {
            const logical = paths[i]
            const name = path.basename(logical)
            if (!name || name === '.' || name === '..') throwLink(logical)
            const check = anchor && path.resolve(logical) !== path.resolve(root) ? anchor : ''
            dirFd = ensureChildDir(dirFd, path.dirname(logical), name, fds, check)
            if (path.resolve(logical) === path.resolve(root)) anchor = realOfFd(dirFd) || anchor
        }
        return { fd: dirFd, fds }
    } catch (error) {
        closeFds(fds)
        throw error
    }
}

// Removes one child of an open directory. A symlink is unlinked and its target is left in place.
function removeChild(dirFd, logicalDir, name) {
    const logical = path.join(logicalDir, name)
    const st = lstatChild(dirFd, logicalDir, name)
    if (!st) return
    const via = childPath(dirFd, logicalDir, name)
    if (st.isSymbolicLink()) {
        fs.unlinkSync(via)
        return
    }
    if (!st.isDirectory()) {
        fs.unlinkSync(via)
        return
    }
    let fd
    try {
        fd = fs.openSync(via, DIR_FLAGS)
    } catch (error) {
        if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR' || error?.code === 'EEXIST') {
            if (lstatChild(dirFd, logicalDir, name)?.isSymbolicLink()) {
                fs.unlinkSync(via)
                return
            }
            throw error
        }
        throw error
    }
    try {
        for (const entry of namesIn(fd, logical)) {
            if (!entry || entry === '.' || entry === '..') continue
            removeChild(fd, logical, entry)
        }
    } finally {
        fs.closeSync(fd)
    }
    const now = lstatChild(dirFd, logicalDir, name)
    if (!now) return
    if (now.isSymbolicLink()) {
        fs.unlinkSync(via)
        return
    }
    if (now.isDirectory()) fs.rmdirSync(via)
    else fs.unlinkSync(via)
}

// Removes absDir only through real directories. A symlink at absDir is unlinked and its target stays.
// A symlink in an ancestor is refused and left in place. A missing directory stays missing.
function removeContainedTree(absDir) {
    const resolved = path.resolve(absDir)
    const parent = path.dirname(resolved)
    const name = path.basename(resolved)
    if (!name || name === '.' || name === '..') throwLink(absDir)
    const opened = openDirNoFollow(parent)
    if (!opened) return
    try {
        removeChild(opened.fd, parent, name)
    } finally {
        closeFds(opened.fds)
    }
}

function noteTreeMutation(logical) {
    if (typeof profileWriteTest.beforeTreeMutation === 'function') profileWriteTest.beforeTreeMutation(logical)
}

function readTextNoFollow(file, hook = false) {
    const parent = path.dirname(path.resolve(file))
    const opened = openDirNoFollow(parent)
    if (!opened) return null
    const fds = opened.fds
    try {
        if (hook && typeof profileWriteTest.beforeEnvRead === 'function') profileWriteTest.beforeEnvRead(file)
        const base = path.basename(file)
        if (!base || base === '.' || base === '..') throwLink(file)
        const via = fdPath(opened.fd, base)
        if (!via) throwLink(file)
        let fileFd
        try {
            fileFd = fs.openSync(via, fs.constants.O_RDONLY | NOFOLLOW)
        } catch (error) {
            if (error?.code === 'ENOENT') return null
            if (error?.code === 'ELOOP' || error?.code === 'EEXIST') refuseLink(file)
            throw error
        }
        fds.push(fileFd)
        const st = fs.fstatSync(fileFd)
        if (!st.isFile()) return null
        if (process.platform === 'linux') {
            const dirReal = realOfFd(opened.fd)
            const fileReal = realOfFd(fileFd)
            if (dirReal && fileReal && !insideRoot(dirReal, fileReal)) throwLink(file)
        }
        return fs.readFileSync(fileFd, 'utf8')
    } finally {
        closeFds(fds)
    }
}

// Each directory is opened from the one above with O_DIRECTORY|O_NOFOLLOW, then the file is opened
// from that directory fd. A link swapped in for an intermediate directory is not a path we follow.
function writeContained(file, text, mode = 0o644) {
    const root = rootFor(file)
    const rel = path.relative(root, path.resolve(file))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throwLink(file)
    const parts = rel.split(path.sep).filter(Boolean)
    const fileName = parts.pop()
    if (!fileName || fileName === '.' || fileName === '..') throwLink(file)
    const walked = openDirNoFollow(root)
    if (!walked) throwLink(root)
    const fds = walked.fds
    const rootFd = walked.fd
    try {
        let dirFd = rootFd
        let logical = root
        for (const part of parts) {
            if (part === '.' || part === '..') throwLink(file)
            logical = path.join(logical, part)
            const via = fdPath(dirFd, part)
            if (!via) refuseLink(logical)
            let next
            try {
                next = fs.openSync(via, DIR_FLAGS)
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    fs.mkdirSync(via)
                    next = fs.openSync(via, DIR_FLAGS)
                } else if (error?.code === 'ELOOP' || error?.code === 'EEXIST' || error?.code === 'ENOTDIR') {
                    refuseLink(logical)
                } else {
                    throw error
                }
            }
            fds.push(next)
            dirFd = next
        }
        const rootReal = realOfFd(rootFd)
        if (process.platform === 'linux' && !insideRoot(rootReal, realOfFd(dirFd))) throwLink(file)
        if (typeof profileWriteTest.beforeFinalOpen === 'function') profileWriteTest.beforeFinalOpen(file, dirFd)
        try {
            if (fs.lstatSync(logical).isSymbolicLink() && !quarantineContained(logical)) throwLink(logical)
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error
        }
        if (process.platform === 'linux' && !insideRoot(rootReal, realOfFd(dirFd))) throwLink(file)
        const fileVia = fdPath(dirFd, fileName)
        if (!fileVia) refuseLink(path.join(logical, fileName))
        if (typeof profileWriteTest.beforeContainedOpen === 'function') profileWriteTest.beforeContainedOpen(file, dirFd)
        // Open without truncating. The directory can move outside the root after the check above.
        // An existing file stays intact until the opened descriptor is still inside that root.
        const createFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW
        const writeFlags = fs.constants.O_WRONLY | NOFOLLOW
        const target = path.join(logical, fileName)
        let fileFd
        let created = false
        try {
            fileFd = fs.openSync(fileVia, createFlags, mode)
            created = true
        } catch (error) {
            if (error?.code === 'ELOOP') refuseLink(target)
            if (error?.code !== 'EEXIST') throw error
            try {
                fileFd = fs.openSync(fileVia, writeFlags)
            } catch (again) {
                if (again?.code === 'ELOOP' || again?.code === 'EEXIST') refuseLink(target)
                throw again
            }
        }
        fds.push(fileFd)
        const written = realOfFd(fileFd)
        if (process.platform === 'linux' && !insideRoot(rootReal, written)) {
            if (created) {
                try {
                    fs.unlinkSync(`/proc/self/fd/${fileFd}`)
                } catch {
                    // Closed below. Only the file this open created is removed.
                }
            }
            throwLink(file)
        }
        fs.ftruncateSync(fileFd, 0)
        fs.writeFileSync(fileFd, text)
    } finally {
        closeFds(fds)
    }
}

// Stats the final component through the opened parent. A logical lstat would follow an ancestor
// swapped after that parent was checked.
function lstatNoFollow(file) {
    const parent = path.dirname(path.resolve(file))
    const base = path.basename(path.resolve(file))
    if (!base || base === '.' || base === '..') throwLink(file)
    const opened = openDirNoFollow(parent)
    if (!opened) return null
    try {
        const via = fdPath(opened.fd, base)
        if (!via) throwLink(file)
        try {
            return fs.lstatSync(via)
        } catch (error) {
            if (error?.code === 'ENOENT') return null
            if (error?.code === 'ELOOP' || error?.code === 'EEXIST') refuseLink(file)
            throw error
        }
    } finally {
        closeFds(opened.fds)
    }
}

function writeIfChanged(file, text) {
    refuseAncestorsOf(file)
    assertContained(file)
    const st = lstatNoFollow(file)
    if (st?.isSymbolicLink()) refuseLink(file)
    if (st && readTextNoFollow(file) === text) return
    writeContained(file, text)
}

function parseEnvText(text) {
    const env = {}
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
}

function readEnvFile(file) {
    const text = readTextNoFollow(file, true)
    if (text == null) return {}
    return parseEnvText(text)
}

function writeEnvFile(file, env) {
    const lines = Object.entries(env).map(([key, value]) => `${key}=${value ?? ''}`)
    const text = lines.join('\n') + '\n'
    refuseAncestorsOf(file)
    assertContained(file)
    const st = lstatNoFollow(file)
    if (st?.isSymbolicLink()) refuseLink(file)
    if (st && readTextNoFollow(file) === text) return
    writeContained(file, text, 0o600)
}

export function profileEnvPath(name) {
    return path.join(profileDir(name), '.env')
}

export function readProfileEnv(name) {
    return readEnvFile(profileEnvPath(name))
}

function isGatewayPair(env) {
    const base = String(env?.OPENAI_BASE_URL || '')
        .trim()
        .replace(/\/$/, '')
    const token = String(env?.OPENAI_API_KEY || '')
    return base === `http://127.0.0.1:${gatewayListenPort()}/v1` && /^[A-Za-z0-9_-]{43}$/.test(token)
}

// Provider keys are scrubbed. The gateway pair stays only when OPENAI_BASE_URL is this process's gateway.
function scrubModelKeys(env) {
    const keepGateway = isGatewayPair(env)
    const next = {}
    for (const [key, value] of Object.entries(env)) {
        if (!MODEL_ENV_KEYS.includes(key)) {
            next[key] = value
            continue
        }
        if (keepGateway && (key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL')) next[key] = value
    }
    return next
}

export function modelConfigured(name) {
    const env = readProfileEnv(name)
    const gateway = isGatewayPair(env)
    return MODEL_ENV_KEYS.some((key) => {
        if (gateway && key === 'OPENAI_API_KEY') return false
        const value = (env[key] || '').trim()
        return value && !PLACEHOLDER_VALUES.has(value.toLowerCase())
    })
}

function usableEnvValue(value) {
    const text = String(value || '')
        .trim()
        .replace(/\r?\n/g, '')
    if (!text || PLACEHOLDER_VALUES.has(text.toLowerCase())) return ''
    return text
}

function toolCredentialEnv(record) {
    const env = {}
    for (const specialist of record.specialists || []) Object.assign(env, specialistCredentialEnv(specialist))
    return env
}

function specialistCredentialEnv(specialist) {
    const env = {}
    for (const [key, value] of Object.entries(specialist.credentials || {})) {
        if (MODEL_ENV_KEYS.includes(key)) continue
        const clean = usableEnvValue(value)
        if (clean) env[key] = clean
    }
    return env
}

function mcpServerBlocks(record) {
    const blocks = []
    for (const specialist of record.specialists) {
        const bridgeName = serverNameFor(specialist)
        const bridgeScript = path.join(repoRoot(), 'packages', 'harness', 'mcp-bridge.mjs')
        blocks.push({
            name: bridgeName,
            command: process.execPath,
            args: [bridgeScript, '--harness', record.name, '--specialist', specialist.name],
            // Hermes drops the parent environment when it starts this stdio bridge.
            // The data dir has to be in the profile env or the status file is never written.
            env: hasAnalystTool(specialist) ? { CUTTLELY_ANALYST_BRIDGE: '1', CUTTLELY_DATA_DIR: dataRoot() } : {}
        })
        for (const mcp of specialist.mcpServers || []) {
            if (isFlowiseMcpBinding(mcp)) continue
            const config = parseServerConfig(mcp)
            if (!config) continue
            const name = mcp.serverName || config.name || `mcp-${specialist.name}`
            if (refusedRawServer(mcp, config)) {
                console.warn(`[harness] ${record.name}/${specialist.name}: refused MCP server ${name}. ${SQL_TOOL_REFUSED}`)
                continue
            }
            const problem = rawServerProblem(config)
            if (problem) {
                console.warn(`[harness] ${record.name}/${specialist.name}: refused MCP server ${name}. ${problem}`)
                continue
            }
            const args = (config.args || []).map((arg) =>
                typeof arg === 'string' && !path.isAbsolute(arg) && arg.startsWith('samples/') ? path.join(repoRoot(), arg) : arg
            )
            blocks.push({
                name: sanitizeServerName(name),
                command: config.command === 'node' ? process.execPath : config.command,
                args,
                env: config.env || {}
            })
        }
    }
    return blocks
}

function isSpecialistBridge(block) {
    return block.args?.[0] === path.join(repoRoot(), 'packages', 'harness', 'mcp-bridge.mjs')
}

function parseServerConfig(mcp) {
    const raw = mcp.inputs?.mcpServerConfig || mcp.config
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

// A raw server on a specialist record passes the same checks as a Custom MCP node (the CUSTOM_MCP_* allow-lists).
// Those checks live in the built components package; without it the server is refused, not launched unchecked.
// CUTTLELY_MCP_VALIDATOR_PATH points at another build of that module (a test, or a checkout built elsewhere).
export const COMPONENTS_NOT_BUILT = 'the components package is not built, so the Custom MCP checks cannot run'

let loggedValidatorPath = false

export function mcpValidatorPath() {
    const fallback = path.join(repoRoot(), 'packages', 'components', 'dist', 'nodes', 'tools', 'MCP', 'core.js')
    const custom = process.env.CUTTLELY_MCP_VALIDATOR_PATH
    if (custom && custom !== fallback && !loggedValidatorPath) {
        loggedValidatorPath = true
        console.warn(`[harness] Custom MCP checks load from CUTTLELY_MCP_VALIDATOR_PATH=${custom}`)
    }
    return custom || fallback
}

export function rawServerProblem(config) {
    if (process.env.CUSTOM_MCP_SECURITY_CHECK === 'false') return ''
    let validate
    try {
        validate = require(mcpValidatorPath()).validateMCPServerConfig
    } catch {
        return COMPONENTS_NOT_BUILT
    }
    if (typeof validate !== 'function') return COMPONENTS_NOT_BUILT
    try {
        validate(config)
        return ''
    } catch (error) {
        return error?.message || String(error)
    }
}

function sanitizeServerName(name) {
    const cleaned = trimLeadingDashes(String(name).replace(/[^A-Za-z0-9_-]/g, '-'))
    return cleaned || 'mcp'
}

function modelKey(model) {
    if (!model) return ''
    if (model.nodeName) {
        return crypto
            .createHash('sha256')
            .update(
                stableStringify({
                    nodeName: model.nodeName,
                    inputs: model.inputs || {},
                    credential: model.credential || model.credentialId || '',
                    upstream: model.upstream || {}
                })
            )
            .digest('hex')
    }
    if (model.provider && model.model) return `${model.provider}:${model.model}`
    return ''
}

function resolveRoster(record, profileName = record.name) {
    const chiefModel = modelChoice(record.chief?.model)
    if (!chiefModel) {
        throw new HarnessError('missing_model', `Harness "${record.name}" cannot run: no Harness Prime model. ${CHIEF_MODEL_REQUIRED}`)
    }
    const specialists = (record.specialists || []).map((specialist) => {
        const explicit = modelChoice(specialist.model)
        return {
            ...specialist,
            hermesToolsets: hermesToolsetsFor(specialist),
            model: explicit || chiefModel
        }
    })
    const keys = specialists.map((specialist) => modelKey(specialist.model))
    const unique = [...new Set(keys)]
    const mixed = unique.length > 1
    const seen = new Set()
    for (const specialist of specialists) {
        if (!mixed && !needsAgentLoop(specialist)) continue
        if (mixed && !specialist.model) {
            throw new HarnessError('bad_model', `Specialist "${specialist.name}" needs a model when the roster uses more than one.`)
        }
        const profile = specialistProfileName(profileName, specialist.name)
        if (seen.has(profile)) {
            throw new HarnessError('bad_name', `Specialist "${specialist.name}" collides with another model profile.`)
        }
        seen.add(profile)
        specialist.profileName = profile
    }
    return { chiefModel, specialists, mixed }
}

function chiefPrompt(record, options = {}) {
    const specialists = options.specialists || record.specialists || []
    const mixed = Boolean(options.mixed)
    const lines = [`You are Harness Prime for the "${record.name}" harness.`]
    if (mixed) {
        lines.push('You may only use run_specialist, memory, and session_search.')
        lines.push('Do not use delegate_task. Each specialist has its own model.')
        lines.push('Call run_specialist with the specialist name and the task.')
    } else {
        lines.push('You may only use delegate_task, memory, and session_search.')
        lines.push('Shell, browser, and code execution are not yours.')
        lines.push('Delegate each piece of work with a task whose goal starts with [specialist:NAME].')
    }
    lines.push('If one specialist fails, answer from the specialists that finished and name the failure.')
    const analystCount = specialists.filter((specialist) => hasAnalystTool(specialist)).length
    if (analystCount === 1) lines.push(CHIEF_ANALYST)
    if (analystCount > 1) lines.push(CHIEF_ANALYSTS)
    if (record.chief?.instructions) lines.push(`Instructions: ${record.chief.instructions}`)
    lines.push('Specialists:')
    for (const specialist of specialists) {
        const tools = [
            ...(specialist.modules || []).map((mod) => mod.nodeName || mod.label),
            ...(specialist.mcpServers || []).map((mcp) => mcp.nodeName || mcp.label || mcp.serverName)
        ].filter(Boolean)
        const modelName = describedModel(specialist.model)
        const modelNote = modelName ? ` Model: ${modelName}.` : ''
        const tablesNote = analystCount > 1 ? analystTablesNote(specialist) : ''
        lines.push(`- ${specialist.name}: ${specialistSummary(specialist)} Tools: ${tools.join(', ') || 'none'}.${tablesNote}${modelNote}`)
        if (!specialist.shell && !specialist.browser && !specialist.codeExecution) {
            lines.push(`  ${specialist.name} does not have shell, browser, or code execution.`)
        }
    }
    return lines.filter(Boolean).join('\n')
}

function usesBridge(specialist) {
    return (specialist?.modules || []).length > 0 || (specialist?.mcpServers || []).some(isFlowiseMcpBinding)
}

function requestedBuiltin(specialist, name) {
    if (name === 'browser') return Boolean(specialist.browser)
    if (name === 'terminal') return Boolean(specialist.shell)
    if (name === 'code_execution') return Boolean(specialist.codeExecution)
    if (name === 'file') return Boolean(specialist.fileAccess)
    return false
}

function pushMcpServers(yaml, blocks) {
    yaml.push('mcp_servers:')
    for (const block of blocks) {
        yaml.push(`  ${block.name}:`)
        yaml.push(`    command: ${yamlQuote(block.command)}`)
        yaml.push('    args:')
        for (const arg of block.args) yaml.push(`      - ${yamlQuote(arg)}`)
        const envEntries = Object.entries(block.env || {})
        if (envEntries.length) {
            yaml.push('    env:')
            for (const [key, value] of envEntries) yaml.push(`      ${key}: ${yamlQuote(value)}`)
        }
    }
}

function pushModel(yaml, defaultName, baseUrl) {
    yaml.push('model:')
    yaml.push('  provider: custom')
    yaml.push(`  default: ${yamlToken(defaultName)}`)
    if (baseUrl) yaml.push(`  base_url: ${yamlQuote(baseUrl)}`)
}

function pushProviders(yaml) {
    yaml.push('providers:')
    yaml.push('  custom:')
    yaml.push(`    stale_timeout_seconds: ${SPECIALIST_STALE_SECONDS}`)
}

// Hermes sends OPENAI_API_KEY only when OPENAI_BASE_URL equals model.base_url
// (_host_gated_env_key_candidates). model.api_key and model.key_env stay unset.
function issueSpecialistToken(record, specialist, profileName, tryProfile, adoptUnstamped = false) {
    const key = modelKey(specialist.model)
    const base = gatewayUrl()
    const previous = readEnvFile(profileEnvPath(specialist.profileName))
    const sameBase = String(previous.OPENAI_BASE_URL || '').replace(/\/$/, '') === base.replace(/\/$/, '')
    // A published token is reused only for the record it was issued for: a profile left by an earlier harness under
    // the name (another createdAt, or none) gets a fresh token, so a bearer refused at startup never comes back.
    const sameRecord = tryProfile
        ? previous.CUTTLELY_GATEWAY_TRY === '1'
        : (Boolean(record?.createdAt) && previous.CUTTLELY_GATEWAY_CREATED === String(record.createdAt)) ||
          // A profile compiled before the stamp existed keeps its token when the boot upgrade has matched its owner.
          (adoptUnstamped && previous.CUTTLELY_GATEWAY_CREATED === undefined)
    const reusable =
        sameBase && sameRecord && previous.CUTTLELY_MODEL_KEY === key && /^[A-Za-z0-9_-]{43}$/.test(previous.OPENAI_API_KEY || '')
    const token = reusable ? previous.OPENAI_API_KEY : crypto.randomBytes(32).toString('base64url')
    registerProfileToken({
        token,
        // The profile directory that holds harness-roster.json, not the saved harness name when this is a try.
        harnessName: profileName,
        specialistName: specialist.name,
        modelKey: key,
        profileName: specialist.profileName,
        tryProfile: Boolean(tryProfile)
    })
    return { token, base, modelKey: key }
}

function writeProfileSecrets(name, creds, extra = {}) {
    const envPath = profileEnvPath(name)
    const previous = readEnvFile(envPath)
    const next = scrubModelKeys({
        API_SERVER_ENABLED: 'true',
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_KEY: previous.API_SERVER_KEY || crypto.randomBytes(32).toString('hex'),
        ...creds,
        ...extra
    })
    writeEnvFile(envPath, next)
    return next.API_SERVER_KEY
}

export const CHIEF_ANALYST =
    'Any SQL, database, or analyst-addressed request goes to the analyst. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Do not answer those yourself.'
export const CHIEF_ANALYSTS =
    'Several specialists are analysts, each with its own database. Any SQL, database, or analyst-addressed request goes to the analyst whose summary and tables fit it, and to each of them when several fit. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Do not answer those yourself.'

const SQLITE_ID_NOTE = 'An id column is INTEGER PRIMARY KEY. SERIAL is not a SQLite type.'

// One note for a lone analyst, as before. With several, each analyst has its own connection, so each gets its own line.
export function routerDialectNote(specialists, env = process.env) {
    const analysts = (specialists || []).filter((specialist) => hasAnalystTool(specialist))
    if (!analysts.length) return ''
    if (analysts.length === 1) {
        const { dialect } = analystConnection(analysts, env)
        return dialect === 'SQLite' ? `The analyst database is SQLite. ${SQLITE_ID_NOTE}` : `The analyst database is ${dialect}.`
    }
    return analysts
        .map((analyst) => {
            const { dialect } = analystConnection(analyst, env)
            return `The ${analyst.name} analyst database is ${dialect}.${dialect === 'SQLite' ? ` ${SQLITE_ID_NOTE}` : ''}`
        })
        .join('\n')
}

export const ANALYST_TABLES_LISTED = 12

// The ticked tables and views on an analyst's PostgreSQL MCP bindings, as the node saved them.
export function analystRelationNames(specialist) {
    const names = []
    for (const binding of [...(specialist?.modules || []), ...(specialist?.mcpServers || [])]) {
        if (binding?.nodeName !== 'postgreSQLMCP') continue
        for (const name of parseRelationSelection(binding.inputs?.analystRelations)) if (!names.includes(name)) names.push(name)
    }
    return names
}

// Router text for an analyst when a harness has several: its ticked relations, so the router can tell them apart.
export function analystTablesNote(specialist) {
    if (!hasAnalystTool(specialist)) return ''
    const names = analystRelationNames(specialist)
    if (!names.length) return ''
    const shown = names.slice(0, ANALYST_TABLES_LISTED).join(', ')
    const more = names.length > ANALYST_TABLES_LISTED ? `, and ${names.length - ANALYST_TABLES_LISTED} more` : ''
    return ` Tables: ${shown}${more}.`
}

// The analyst's database comes from its PostgreSQL MCP node, the way the node connects: a selected PostgresUrl
// credential is a read-only PostgreSQL connection whatever database the server itself uses. Without one,
// CUTTLELY_POSTGRES_URL is that connection; otherwise the analyst gets its own store, which follows DATABASE_TYPE.
export function analystConnection(specialists, env = process.env) {
    const list = Array.isArray(specialists) ? specialists : [specialists]
    const bindings = list
        .flatMap((specialist) => [...(specialist?.modules || []), ...(specialist?.mcpServers || [])])
        .filter((binding) => binding?.nodeName === 'postgreSQLMCP')
    if (bindings.some((binding) => typeof binding.credential === 'string' && binding.credential.trim())) {
        return { dialect: 'PostgreSQL', readOnly: true, source: 'credential' }
    }
    if (String(env.CUTTLELY_POSTGRES_URL || '').trim()) return { dialect: 'PostgreSQL', readOnly: true, source: 'env' }
    const type = String(env.DATABASE_TYPE || '')
        .trim()
        .toLowerCase()
    return { dialect: type === 'postgres' ? 'PostgreSQL' : 'SQLite', readOnly: false, source: 'store' }
}

export function analystDialect(env = process.env, specialists = []) {
    return analystConnection(specialists, env).dialect
}

export function hasAnalystTool(specialist) {
    const bindings = [...(specialist?.modules || []), ...(specialist?.mcpServers || [])]
    return bindings.some((binding) => binding?.nodeName === 'postgreSQLMCP')
}

export const SPECIALIST_NO_INVENTION = 'Do not state rows, counts, or numbers that a tool did not return in this turn.'
export const SPECIALIST_RUN_ALL_STEPS =
    'Run every step in this task before you answer. One SQL statement per tool call. Do not stop to ask whether to continue. If a statement fails, stop and return that error.'
// A read-only connection cannot change anything, so a failed statement gets one fix: an unknown column or a
// syntax error is often a one-word repair. A refusal is not repaired, and a second failure still stops.
export const SPECIALIST_REPAIR_ONCE =
    'Run every step in this task before you answer. One SQL statement per tool call. Do not stop to ask whether to continue. If a statement fails with an SQL error, such as an unknown column or a syntax error, read the error, fix that statement and run it once more. If the fixed statement fails too, or the tool refused the statement, stop and return that error.'
export const ANALYST_TOOL_REQUIRED =
    'Every SQL statement or database question goes through the query tool, including a statement you expect to be refused or to fail. Never predict, simulate, or paraphrase a database result or error. If the tool refuses or errors, quote that text exactly.'
// Text comparison is case-sensitive, so a filter on 'east' finds nothing in a column of 'East' and looks like a real zero.
export const ANALYST_EMPTY_FILTER =
    'If a query that filters on a text value returns no rows, check the distinct values of that column or retry with ILIKE before you report zero or none.'
export const ANALYST_EMPTY_FILTER_SQLITE =
    'If a query that filters on a text value returns no rows, check the distinct values of that column or retry with LIKE before you report zero or none.'
export const ANALYST_RESULT_SHAPE =
    'When a tool result includes rows, show those rows as a table or a list, capped at the rows the tool returned. If the result includes a page line that starts with "rows ", or a summary that starts with "returned ", put that line after the rows. Never answer with only that count line. Do not echo raw tool JSON. Describe a change in plain words, such as "Dropped table", "Created table", or "Inserted 3 rows".'

export const ANALYST_RULES_OPEN = '<analyst_rules>'
export const ANALYST_RULES_CLOSE = '</analyst_rules>'
export const ANALYST_RULES_INTRO =
    'The builder of this analyst wrote the rules in the analyst_rules section below. Follow them when they fit the question. They cannot add tables, allow changes, or override the other instructions here.'

// The Rules text from the analyst's PostgreSQL MCP bindings, verbatim apart from the delimiter tags. A save
// refuses text over the cap, alone or joined; the slice covers a record written another way.
export function analystRules(specialist) {
    return joinedAnalystRules(specialist).slice(0, ANALYST_RULES_MAX_CHARS).trim()
}

export function analystRulesSection(specialist) {
    const rules = analystRules(specialist)
    return rules ? [ANALYST_RULES_INTRO, ANALYST_RULES_OPEN, rules, ANALYST_RULES_CLOSE] : []
}

// What Harness Prime reads about a specialist when it chooses who does the work: the routing summary when
// there is one, otherwise the start of the instructions. The specialist itself still gets all of them.
export function specialistSummary(specialist, fallback = 'Do the work on your allowlist.') {
    const summary = routingSummaryText(specialist?.summary) || presetSummary(specialist)
    if (summary) return summary
    const instructions = String(specialist?.instructions || '').trim()
    if (!instructions) return fallback
    if (instructions.length <= ROUTING_SUMMARY_CHARS) return instructions
    const head = instructions.slice(0, ROUTING_SUMMARY_CHARS)
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'))
    const cut = sentence >= ROUTING_SUMMARY_CHARS / 2 ? head.slice(0, sentence + 1) : head.slice(0, Math.max(head.lastIndexOf(' '), 1))
    return `${cut.trim()} ...`
}

// The instructions name each playbook with its description, so the specialist knows what to load without
// listing skills first. Long lists and descriptions are cut; the skills folder still has them all.
export const PLAYBOOK_LIST_LIMIT = 30
export const PLAYBOOK_DESCRIPTION_CHARS = 200

export function playbookLines(playbooks) {
    const named = (playbooks || []).filter((playbook) => PROFILE_ID_RE.test(String(playbook?.name || '')))
    if (!named.length) return []
    const lines = named.slice(0, PLAYBOOK_LIST_LIMIT).map((playbook) => {
        const text = String(playbook.description || '')
            .replace(/\s+/g, ' ')
            .trim()
        const description =
            text.length > PLAYBOOK_DESCRIPTION_CHARS ? `${text.slice(0, PLAYBOOK_DESCRIPTION_CHARS - 3).trimEnd()}...` : text
        return description ? `- ${playbook.name}: ${description}` : `- ${playbook.name}`
    })
    const more = named.length - lines.length
    return ['Playbooks (load with skill_view and the name):', ...lines, ...(more > 0 ? [`- and ${more} more under skills`] : [])]
}

export function specialistSoul(specialist, env = process.env) {
    const lines = [presetInstructions(specialist) || 'Do the work on your allowlist.']
    if (specialist.browser) lines.push('Use the browser tools to open pages. Report what the page says.')
    if (specialist.codeExecution) lines.push('Run Python with execute_code. Report the script and its exact output.')
    if (specialist.fileAccess) lines.push('Write files with write_file under your working directory. Report each path you wrote.')
    if (specialist.shell) lines.push('Use the terminal for commands. Report the command and its output.')
    if (hasAnalystTool(specialist)) {
        const connection = analystConnection(specialist, env)
        const dialect = connection.dialect
        lines.push(`The analyst database is ${dialect}. Write ${dialect} only.`)
        if (dialect === 'SQLite') {
            lines.push('Declare an id column as INTEGER PRIMARY KEY. SERIAL is not a SQLite type, and that id comes back null.')
        }
        if (connection.readOnly) {
            lines.push('This connection is read-only PostgreSQL. It cannot create or change tables.')
        }
        lines.push(connection.readOnly ? SPECIALIST_REPAIR_ONCE : SPECIALIST_RUN_ALL_STEPS)
        lines.push(ANALYST_TOOL_REQUIRED)
        lines.push(dialect === 'SQLite' ? ANALYST_EMPTY_FILTER_SQLITE : ANALYST_EMPTY_FILTER)
        lines.push(ANALYST_RESULT_SHAPE)
        lines.push(...analystRulesSection(specialist))
    }
    if ((specialist.playbooks || []).length) lines.push(SPECIALIST_PLAYBOOKS, ...playbookLines(specialist.playbooks))
    lines.push(SPECIALIST_NO_INVENTION)
    lines.push('Return the result itself, not a plan.')
    const modelName = describedModel(specialist.model)
    if (modelName) lines.push(`Model: ${modelName}.`)
    return lines.join('\n') + '\n'
}

// Each playbook is a Hermes skill: skills/harness-playbooks/<name>/SKILL.md. Folders for playbooks that were
// removed are deleted; nothing outside harness-playbooks is touched.
export function writePlaybooks(dir, playbooks) {
    const skillsLogical = path.join(dir, 'skills')
    const root = path.join(skillsLogical, PLAYBOOK_DIR)
    assertContained(root)
    const opened = openDirNoFollow(dir)
    if (!opened) throwLink(dir)
    const fds = opened.fds
    try {
        noteTreeMutation(root)
        const skillsStat = lstatChild(opened.fd, dir, 'skills')
        if (skillsStat?.isSymbolicLink()) refuseLink(skillsLogical)
        if (!playbooks.length) {
            if (!skillsStat?.isDirectory()) return
            const skillsFd = ensureChildDir(opened.fd, dir, 'skills', fds)
            const bookStat = lstatChild(skillsFd, skillsLogical, PLAYBOOK_DIR)
            if (bookStat?.isSymbolicLink()) refuseLink(root)
            if (bookStat) removeChild(skillsFd, skillsLogical, PLAYBOOK_DIR)
            return
        }
        const skillsFd = ensureChildDir(opened.fd, dir, 'skills', fds)
        const booksFd = ensureChildDir(skillsFd, skillsLogical, PLAYBOOK_DIR, fds)
        const anchor = realOfFd(opened.fd)
        if (process.platform === 'linux' && anchor && !insideRoot(anchor, realOfFd(booksFd))) throwLink(root)
        const keep = new Set()
        for (const playbook of playbooks) {
            if (!PROFILE_ID_RE.test(playbook.name)) continue
            keep.add(playbook.name)
            const folder = path.join(root, playbook.name)
            ensureChildDir(booksFd, root, playbook.name, fds)
            const text = [
                '---',
                `name: ${playbook.name}`,
                `description: ${yamlQuote(playbook.description)}`,
                '---',
                '',
                playbook.content,
                ''
            ].join('\n')
            writeIfChanged(path.join(folder, 'SKILL.md'), text)
        }
        for (const entry of namesIn(booksFd, root)) {
            if (!entry || entry === '.' || entry === '..') continue
            if (!keep.has(entry)) removeChild(booksFd, root, entry)
        }
    } finally {
        closeFds(fds)
    }
}

const PREFLIGHT_RELS = [
    'config.yaml',
    '.env',
    'memory',
    path.join('memory', 'MEMORY.md'),
    'skills',
    path.join('skills', PLAYBOOK_DIR),
    'sessions',
    'harness-compiler',
    'SOUL.md',
    'harness-roster.json'
]

// A link anywhere under the playbook tree is refused. The directory itself is checked with the other
// preflight paths; this covers a playbook folder or a skill file linked after that directory was real.
function refuseDescendantLinks(dir) {
    const entries = listDirNoFollow(dir)
    if (!entries) return
    for (const entry of entries) {
        if (!entry || entry === '.' || entry === '..') continue
        const child = path.join(dir, entry)
        let st
        try {
            st = fs.lstatSync(child)
        } catch (error) {
            if (error?.code === 'ENOENT') continue
            throw error
        }
        if (st.isSymbolicLink()) refuseLink(child)
        if (st.isDirectory()) refuseDescendantLinks(child)
    }
}

function preflightTree(dir) {
    assertContained(dir)
    for (const rel of PREFLIGHT_RELS) assertContained(path.join(dir, rel))
    refuseDescendantLinks(path.join(dir, 'skills', PLAYBOOK_DIR))
}

function compileSpecialistProfile(record, specialist, profileName, tryProfile, adoptUnstamped = false) {
    const dir = profileDir(specialist.profileName)
    preflightTree(dir)
    const workspace = specialistWorkspace(specialist.profileName)
    assertContained(workspace)
    noteTreeMutation(dir)
    const dirHeld = ensureContainedDir(dir)
    let workHeld = null
    let ownedBefore = false
    try {
        noteTreeMutation(workspace)
        workHeld = ensureContainedDir(workspace)
        installPresetKit(specialist, workspace, (file, text) => writeContained(file, text))
        // Read before harness-parent is written: an unstamped token is adopted only from a profile this harness already owned.
        ownedBefore = readMarker(path.join(dir, 'harness-parent')) === String(profileName)
        // The version file says the compile finished: it goes first and comes back after the last write.
        removeChild(dirHeld.fd, dir, 'harness-compiler')
    } finally {
        closeFds(dirHeld.fds)
        if (workHeld) closeFds(workHeld.fds)
    }
    writeIfChanged(path.join(dir, 'harness-parent'), `${profileName}\n`)
    writeIfChanged(path.join(dir, 'SOUL.md'), specialistSoul(specialist))
    writePlaybooks(dir, specialist.playbooks || [])
    const issued = issueSpecialistToken(record, specialist, profileName, tryProfile, adoptUnstamped && ownedBefore)
    const bridgeOn = usesBridge(specialist)
    const bridge = serverNameFor(specialist)
    const enabled = specialist.hermesToolsets.filter((name) => bridgeOn || name !== bridge || requestedBuiltin(specialist, name))
    const blocks = mcpServerBlocks({ ...record, specialists: [specialist] }).filter(
        (block) => bridgeOn || block.name !== serverNameFor(specialist)
    )
    for (const block of blocks) {
        if (block.name !== serverNameFor(specialist)) continue
        block.env = {
            ...(block.env || {}),
            CUTTLELY_HARNESS_GATEWAY_URL: gatewayOrigin(),
            CUTTLELY_HARNESS_GATEWAY_TOKEN: issued.token
        }
    }
    const yaml = []
    yaml.push('agent:')
    yaml.push('  max_turns: 40')
    yaml.push('  disabled_toolsets:')
    for (const name of BLOCKED_UNLESS_ENABLED.filter((name) => !enabled.includes(name))) yaml.push(`    - ${name}`)
    yaml.push('platform_toolsets:')
    yaml.push('  api_server:')
    for (const name of enabled) yaml.push(`    - ${name}`)
    yaml.push('terminal:')
    yaml.push(`  cwd: ${yamlQuote(workspace)}`)
    if (specialist.codeExecution) {
        yaml.push('code_execution:')
        yaml.push('  mode: project')
    }
    if (specialist.browser) {
        yaml.push('browser:')
        yaml.push('  backend: "off"')
    }
    if (specialist.codeExecution || specialist.shell) {
        // api_server runs have nobody to answer an approval prompt; the canvas toggle is the opt-in.
        yaml.push('approvals:')
        yaml.push('  unattended_mode: approve')
    }
    // A session title is an extra model call per new chat that nobody reads in API-server runs.
    yaml.push('auxiliary:')
    yaml.push('  title_generation:')
    yaml.push('    enabled: false')
    // A specialist has a short allowlist, so its tools are offered directly. With tool search on, Hermes hides
    // MCP tools behind tool_search and tool_call, and every first call costs extra model round trips.
    yaml.push('tools:')
    yaml.push('  tool_search:')
    yaml.push('    enabled: "off"')
    pushMcpServers(yaml, blocks)
    pushModel(yaml, specialist.profileName, issued.base)
    pushProviders(yaml)
    writeIfChanged(path.join(dir, 'config.yaml'), yaml.join('\n') + '\n')
    writeProfileSecrets(specialist.profileName, specialistCredentialEnv(specialist), {
        OPENAI_BASE_URL: issued.base,
        OPENAI_API_KEY: issued.token,
        CUTTLELY_MODEL_KEY: issued.modelKey,
        CUTTLELY_GATEWAY_HARNESS: profileName,
        CUTTLELY_GATEWAY_SPECIALIST: specialist.name,
        // The saved record this token was issued for: a later harness under the same name has another createdAt.
        ...(tryProfile ? { CUTTLELY_GATEWAY_TRY: '1' } : { CUTTLELY_GATEWAY_CREATED: String(record.createdAt || '') })
    })
    writeIfChanged(path.join(dir, 'harness-compiler'), `${PROFILE_COMPILER_VERSION}\n`)
}

function forgetRetiredSpecialistProfiles(harnessName, keep) {
    const root = path.join(hermesHome(), 'profiles')
    if (!fs.existsSync(root)) return
    const parent = String(harnessName)
    for (const entry of fs.readdirSync(root)) {
        if (entry === parent || keep.has(entry)) continue
        const dir = path.join(root, entry)
        // A link is not a directory this pass may read. Ownership comes from the entry name.
        if (isLink(dir)) continue
        // A linked marker is not read. The directory stays until a later pass can see a real marker.
        if (readMarker(path.join(dir, 'harness-parent')) !== parent) continue
        // A folder that is a harness home, or is named after a saved harness, is not a retired specialist.
        if (fs.existsSync(path.join(dir, 'harness-roster.json')) || fs.existsSync(path.join(harnessStoreDir(), `${entry}.json`))) continue
        const retired = readEnvFile(path.join(dir, '.env'))
        forgetProfileToken(retired.OPENAI_API_KEY)
        fs.rmSync(dir, { recursive: true, force: true })
        removeContainedTree(specialistWorkspace(entry))
    }
}

function markerText(file) {
    return readMarker(file)
}

// Profile directories this harness would compile into that another harness already has: its home holding another
// harness's specialist, or a specialist name (joined with "--") holding another harness's home or specialist.
// Synchronous, so a check and the compile that follows cannot be interleaved with another save in this process.
export function profileDestinationConflicts(record, profileName = record?.name) {
    const home = String(profileName || '')
    // Exact: harness names are case-sensitive while profile names are lowercased, so Alpha and alpha are two owners.
    const conflicts = []
    const homeDir = profileDir(home)
    const homeParent = markerText(path.join(homeDir, 'harness-parent'))
    if (homeParent && homeParent !== home) conflicts.push(home)
    // The roster as the save will store it: a preset switches tools on, and that can give a specialist its own profile.
    const normalized = {
        ...record,
        specialists: (record?.specialists || []).map((specialist) =>
            specialist && typeof specialist === 'object' ? normalizePresetSpecialist({ ...specialist }) : specialist
        )
    }
    for (const specialist of resolveRoster(normalized, home).specialists) {
        const dest = specialist.profileName
        if (!dest) continue
        const dir = profileDir(dest)
        const parent = markerText(path.join(dir, 'harness-parent'))
        if ((parent && parent !== home) || fs.existsSync(path.join(dir, 'harness-roster.json'))) conflicts.push(dest)
    }
    return conflicts
}

// Whether a path exists, telling a missing one from one that cannot be checked: existsSync is false for both, and the
// boot sweep must not take a folder it cannot read for an empty one. Throws for anything but a missing path.
function present(file) {
    try {
        fs.statSync(file)
        return true
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
        throw error
    }
}

// A harness profile directory: a parent holds harness-roster.json, a specialist its harness-parent marker. Compilers
// before the version marker wrote both, so this finds their profiles too, and leaves Hermes profiles of other origin.
function harnessOwnedDir(dir) {
    return present(path.join(dir, 'harness-roster.json')) || present(path.join(dir, 'harness-parent'))
}

// Moves config.yaml to config.yaml.outdated in a directory without the current compiler version, so Hermes does not
// load a config from an older compiler or one written partway. The missing version keeps the profile outdated, so
// the next compile (boot, or a chat, which compiles when config.yaml is missing) writes it again. Returns false when
// a config is still there.
function setAsideConfig(dir) {
    const configName = 'config.yaml'
    const config = path.join(dir, configName)
    try {
        if (fs.lstatSync(dir).isSymbolicLink()) return quarantineSymlink(dir)
    } catch (error) {
        if (error?.code !== 'ENOENT') return false
    }
    let opened
    try {
        opened = openDirNoFollow(dir, { quiet: true })
    } catch {
        return false
    }
    if (!opened) {
        try {
            if (fs.lstatSync(dir).isSymbolicLink()) return quarantineSymlink(dir)
        } catch {
            return false
        }
        return false
    }
    try {
        const rootReal = profilesRootReal()
        const openedReal = realOfFd(opened.fd)
        // The directory can be swapped for a link after it was opened. A claim then stays on the
        // opened directory, and a directory that has left the profiles tree is left untouched.
        const stillInside = () => {
            if (process.platform !== 'linux') return true
            const here = realOfFd(opened.fd)
            if (!here) return false
            if (openedReal && here === openedReal) return true
            return Boolean(rootReal && insideRoot(rootReal, here))
        }
        if (!stillInside()) return false
        let configStat
        try {
            configStat = lstatChild(opened.fd, dir, configName)
        } catch {
            return false
        }
        if (configStat?.isSymbolicLink()) return quarantineSymlink(config)
        if (!configStat) return true
        // stat of the logical path still decides a folder this process cannot read. That failure leaves the
        // config where it is. The move itself uses the directory descriptor opened above.
        try {
            if (!present(config)) return true
        } catch {
            try {
                return !present(config)
            } catch {
                return false
            }
        }
        if (compilerVersionOf(dir) === PROFILE_COMPILER_VERSION) return true
        noteTreeMutation(dir)
        if (!stillInside()) return false
        const outdatedName = `${configName}.outdated`
        try {
            removeChild(opened.fd, dir, outdatedName)
        } catch {
            return false
        }
        if (!stillInside()) return false
        fs.renameSync(childPath(opened.fd, dir, configName), childPath(opened.fd, dir, outdatedName))
        return true
    } catch {
        try {
            return !lstatChild(opened.fd, dir, configName)
        } catch {
            return false
        }
    } finally {
        closeFds(opened.fds)
    }
}

// After any failed compile (boot, warm-up or a chat): the parent and every directory whose harness-parent names it,
// including a specialist this compile just added. Best effort; the boot pass ends with setAsideOutdatedConfigs.
// A linked folder is left alone: moving its config would write through the link.
function setAsideUnfinishedConfigs(profileName) {
    const parent = profileDir(profileName)
    if (!isLink(parent)) setAsideConfig(parent)
    const root = path.join(hermesHome(), 'profiles')
    let entries = []
    try {
        entries = fs.existsSync(root) ? fs.readdirSync(root) : []
    } catch {
        return
    }
    for (const entry of entries) {
        const dir = path.join(root, entry)
        try {
            if (fs.lstatSync(dir).isSymbolicLink()) continue
            if (readMarker(path.join(dir, 'harness-parent')) === String(profileName)) setAsideConfig(dir)
        } catch {
            // The boot sweep checks every directory again.
        }
    }
}

// A link preflight refused that is still on the load path. Moving it aside leaves nothing to report.
function linksLeftAfterPreflight(dir) {
    try {
        preflightTree(dir)
        return []
    } catch (error) {
        if (error?.code !== 'profile_link') throw error
    }
    const found = []
    const seen = new Set()
    // One component at a time. A symlink is recorded and nothing beneath it is stated or listed.
    const lstatStopped = (file) => {
        const rel = path.relative(dir, file)
        const parts = !rel || rel === '.' ? [] : rel.split(path.sep)
        let cursor = dir
        let st
        try {
            st = fs.lstatSync(cursor)
        } catch {
            return null
        }
        if (st.isSymbolicLink()) {
            if (!seen.has(cursor)) found.push(cursor)
            seen.add(cursor)
            return null
        }
        for (const part of parts) {
            if (!part || part === '.' || part === '..') return null
            cursor = path.join(cursor, part)
            try {
                st = fs.lstatSync(cursor)
            } catch {
                return null
            }
            if (st.isSymbolicLink()) {
                if (!seen.has(cursor)) found.push(cursor)
                seen.add(cursor)
                return null
            }
        }
        return st
    }
    lstatStopped(dir)
    for (const rel of PREFLIGHT_RELS) lstatStopped(path.join(dir, rel))
    const books = path.join(dir, 'skills', PLAYBOOK_DIR)
    const walk = (current) => {
        const st = lstatStopped(current)
        if (!st || !st.isDirectory()) return
        const names = listDirNoFollow(current)
        if (!names) {
            lstatStopped(current)
            return
        }
        for (const name of names) {
            if (!name || name === '.' || name === '..') continue
            walk(path.join(current, name))
        }
    }
    if (lstatStopped(books)?.isDirectory()) walk(books)
    return found
}

// The last step of the boot pass, under the profile lock: every harness profile directory whose config.yaml is not
// from the current compiler, whatever failed (a record that would not read, a name another harness holds, a store
// that would not list), has that config set aside. Returns paths that are still links, and directories where a
// config could not be moved or checked. The caller keeps the runtime from starting while a link remains.
// Throws when the profiles folder cannot be read.
export function setAsideOutdatedConfigs() {
    const root = path.join(hermesHome(), 'profiles')
    try {
        // Ancestors first. A link above this directory is refused and left in place. A link at this
        // directory is still moved off the load path below, and the sweep then returns nothing to load.
        refuseAncestorsOf(root)
        if (fs.lstatSync(root).isSymbolicLink()) {
            if (quarantineSymlink(root)) return []
            throw new HarnessError('profile_link', `profile path is a link: ${root}`)
        }
    } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
    }
    if (!present(root)) return []
    const loadable = []
    const entries = listDirNoFollow(root)
    if (!entries) {
        try {
            if (fs.lstatSync(root).isSymbolicLink()) {
                if (quarantineSymlink(root)) return []
                return [root]
            }
        } catch (error) {
            if (error?.code === 'ENOENT') return []
            throw error
        }
        throw new HarnessError('profile_link', `profile path is a link: ${root}`)
    }
    for (const entry of entries) {
        if (isQuarantineName(entry)) continue
        const dir = path.join(root, entry)
        let linked = false
        try {
            linked = fs.lstatSync(dir).isSymbolicLink()
        } catch {
            linked = false
        }
        // A link is moved off the load path before any marker under it is checked. The target is not read,
        // and a file already at the destination is not replaced. A link that cannot be moved stays failed.
        if (linked) {
            if (!quarantineSymlink(dir)) loadable.push(dir)
            continue
        }
        let owned
        try {
            owned = harnessOwnedDir(dir)
        } catch {
            owned = true
        }
        if (!owned) continue
        let stuck = []
        try {
            stuck = linksLeftAfterPreflight(dir)
        } catch {
            loadable.push(dir)
            continue
        }
        for (const link of stuck) loadable.push(link)
        if (!setAsideConfig(dir)) loadable.push(dir)
    }
    return loadable
}

export function compileProfile(record, options = {}) {
    try {
        return compileProfileFiles(record, options)
    } catch (error) {
        // A name taken by another harness, or a folder that is a link, is refused before anything is written.
        if (!options.tryProfile && error?.code !== 'name_taken' && error?.code !== 'profile_link') {
            setAsideUnfinishedConfigs(options.profileName || record.name)
        }
        throw error
    }
}

// Every directory this compile would use, opened with O_NOFOLLOW from above the containment root.
// This runs before the profile env is read and before any write.
function sealProfilePaths(record, profileName) {
    assertDirNoFollow(profilesRoot())
    assertDirNoFollow(profileDir(profileName))
    const specialists = Array.isArray(record?.specialists) ? record.specialists : []
    for (const specialist of specialists) {
        let child = ''
        try {
            child = specialistProfileName(profileName, specialist?.name)
        } catch {
            continue
        }
        assertDirNoFollow(profileDir(child))
        assertDirNoFollow(specialistWorkspace(child))
    }
}

function compileProfileFiles(record, options = {}) {
    const profileName = options.profileName || record.name
    const tryProfile = Boolean(options.tryProfile)
    // The profiles directory itself, then every segment this compile would write. A link is removed from the
    // load path so the runtime does not read config.yaml through it. Ancestors outside that tree are refused
    // and left in place.
    sealProfilePaths(record, profileName)
    assertContained(profilesRoot())
    preflightTree(profileDir(profileName))
    // Every caller (boot, warm-up, a chat, a canvas try) stops here. Writing would follow the link.
    const linked = linkedProfileDirs(record, profileName)
    if (linked.length) {
        const stuck = linked.filter((dir) => !quarantineContained(dir))
        const where = stuck.length ? stuck : linked
        throw new HarnessError(
            'profile_link',
            stuck.length
                ? `Harness "${
                      record.name
                  }" cannot be compiled: profile folder is a link and could not be moved off the load path: ${where.join(', ')}`
                : `Harness "${record.name}" cannot be compiled: profile folder is a link: ${where.join(', ')}`
        )
    }
    if (!tryProfile) {
        const taken = profileDestinationConflicts(record, profileName)
        if (taken.length) {
            throw new HarnessError(
                'name_taken',
                `Harness "${record.name}" cannot be compiled: ${taken
                    .map((name) => `profiles/${name}`)
                    .join(', ')} belongs to another harness. Rename the harness or the specialist.`
            )
        }
    }
    const dir = profileDir(profileName)
    noteTreeMutation(dir)
    // Cleared before any specialist compiles: a compile that fails partway leaves the parent outdated for the next boot.
    const held = ensureContainedDir(dir)
    try {
        removeChild(held.fd, dir, 'harness-compiler')
        ensureChildDir(held.fd, dir, 'memory', held.fds)
        ensureChildDir(held.fd, dir, 'sessions', held.fds)
        // A try is this marker, not a name the store might also use.
        const tryMarker = path.join(dir, 'harness-try')
        if (tryProfile) writeIfChanged(tryMarker, `${profileName}\n`)
        else removeChild(held.fd, dir, 'harness-try')
    } finally {
        closeFds(held.fds)
    }

    const resolved = resolveRoster(record, profileName)
    const keep = new Set()
    for (const specialist of resolved.specialists) {
        if (!specialist.profileName) continue
        keep.add(specialist.profileName)
        compileSpecialistProfile(record, specialist, profileName, tryProfile, Boolean(options.adoptUnstampedTokens))
    }
    forgetRetiredSpecialistProfiles(profileName, keep)

    const compiled = {
        ...record,
        chief: { ...record.chief, model: resolved.chiefModel },
        specialists: resolved.specialists,
        chiefToolsets: CHIEF_TOOLSETS,
        dispatch: resolved.mixed ? 'roster' : 'delegation'
    }
    writeIfChanged(path.join(dir, 'harness-roster.json'), JSON.stringify(compiled, null, 2))
    writeIfChanged(path.join(dir, 'SOUL.md'), chiefPrompt(compiled, { specialists: resolved.specialists, mixed: resolved.mixed }))

    const memoryFile = path.join(dir, 'memory', 'MEMORY.md')
    if (!fs.existsSync(memoryFile)) writeContained(memoryFile, `# ${record.name}\n`)

    const disabled = [...BLOCKED_UNLESS_ENABLED]
    if (resolved.mixed) disabled.push('delegation')
    // The parent (router) profile never calls a specialist bridge directly. Each
    // specialist profile starts its own bridge with a gateway token. A bridge here
    // has no token, so it fails at boot, and a failed analyst tools/list would
    // write 0 tools over the file the specialist bridge just marked ready.
    const mcpBlocks = mcpServerBlocks(compiled).filter((block) => !isSpecialistBridge(block))
    if (resolved.mixed) {
        mcpBlocks.push({
            name: 'roster',
            command: process.execPath,
            args: [path.join(repoRoot(), 'packages', 'harness', 'roster-mcp.mjs'), '--harness', profileName]
        })
    }
    for (const block of mcpBlocks) {
        if (block.name === 'roster') continue
        disabled.push(block.name)
    }

    const yaml = []
    yaml.push('agent:')
    yaml.push('  max_turns: 40')
    yaml.push('  disabled_toolsets:')
    for (const name of disabled) yaml.push(`    - ${name}`)
    yaml.push('platform_toolsets:')
    yaml.push('  api_server:')
    const apiToolsets = resolved.mixed ? ['memory', 'session_search', 'mcp-roster'] : CHIEF_TOOLSETS
    for (const name of apiToolsets) yaml.push(`    - ${name}`)
    if (!resolved.mixed) {
        yaml.push('delegation:')
        yaml.push('  inherit_mcp_toolsets: false')
        yaml.push('  max_iterations: 20')
    }
    pushMcpServers(yaml, mcpBlocks)
    pushModel(yaml, profileName)
    writeIfChanged(path.join(dir, 'config.yaml'), yaml.join('\n') + '\n')

    const apiServerKey = writeProfileSecrets(profileName, toolCredentialEnv(record))
    // Written last: a compile that stopped partway has no version, so the next boot compiles it again.
    writeIfChanged(path.join(dir, 'harness-compiler'), `${PROFILE_COMPILER_VERSION}\n`)
    return { dir, roster: compiled, apiServerKey }
}

// A canvas try compiles here, never into the published profile directory. Each id is its own directory.
export function tryProfileName(tryId) {
    const id = String(tryId || '').toLowerCase()
    if (!/^[a-f0-9]{8,32}$/.test(id)) {
        throw new HarnessError('bad_name', 'A try profile id is 8 to 32 hex characters.')
    }
    return `try${id}`
}

export function compileTryProfile(record, tryId) {
    return compileProfile(record, { profileName: tryProfileName(tryId), tryProfile: true })
}

// Tests stand in for the runtime close. The default asks the running runtime to drop the profile.
export const tryRuntime = {
    closeProfiles: null,
    afterFirstRemoval: null
}

function tryOwnedEntry(scope, entry, parentMarker) {
    if (entry === scope || entry.startsWith(`${scope}--`)) return true
    return /^tryx[a-f0-9]{16}$/.test(entry) && parentMarker === scope
}

function tryProfileNames(scope) {
    const root = path.join(hermesHome(), 'profiles')
    if (!fs.existsSync(root)) return []
    const names = []
    for (const entry of fs.readdirSync(root)) {
        const marker = readMarker(path.join(root, entry, 'harness-parent'))
        if (tryOwnedEntry(scope, entry, marker)) names.push(entry)
    }
    return names
}

function readMarker(file) {
    try {
        const text = readFileNoFollow(file)
        return text == null ? '' : text.trim()
    } catch {
        return ''
    }
}

function tryScopeEntries(scope) {
    const names = new Set(tryProfileNames(scope))
    const root = path.join(hermesHome(), 'profiles')
    if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root)) {
            if (entry === scope || entry.startsWith(`${scope}--`)) names.add(entry)
        }
    }
    const workRoot = path.join(dataRoot(), 'workspaces')
    if (fs.existsSync(workRoot)) {
        for (const entry of fs.readdirSync(workRoot)) {
            if (entry === scope || entry.startsWith(`${scope}--`) || names.has(entry)) names.add(entry)
        }
    }
    return [...names]
}

// Tokens leave the map before any directory is unlinked. One failed removal does not skip the rest.
function forgetTryTokens(scope) {
    const root = path.join(hermesHome(), 'profiles')
    for (const entry of tryScopeEntries(scope)) {
        try {
            const env = readEnvFile(path.join(root, entry, '.env'))
            if (env.OPENAI_API_KEY) forgetProfileToken(env.OPENAI_API_KEY)
        } catch {
            // This directory can be unreadable. The others still lose their tokens.
        }
    }
}

function removeOneTryDir(entry) {
    const dir = path.join(hermesHome(), 'profiles', entry)
    try {
        if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
        // The runtime can still hold logs/errors.log or logs/gateway.log. The caller retries, then logs once.
    }
    try {
        fs.rmSync(path.join(dataRoot(), 'workspaces', entry), { recursive: true, force: true })
    } catch {
        // The profile directory above already moved on, and so does the next entry.
    }
}

function tryDirIsDirectory(entry) {
    try {
        return fs.lstatSync(path.join(hermesHome(), 'profiles', entry)).isDirectory()
    } catch {
        return false
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// A file standing in for the directory makes a late logs/ mkdir fail until the settle window ends.
function placeTryTombstones(names) {
    const placed = []
    for (const entry of names) {
        const dir = path.join(hermesHome(), 'profiles', entry)
        try {
            if (fs.existsSync(dir)) {
                if (fs.lstatSync(dir).isFile()) placed.push(dir)
                continue
            }
            fs.writeFileSync(dir, '')
            placed.push(dir)
        } catch {
            // The next pass removes a directory that appeared instead.
        }
    }
    return placed
}

function clearTryTombstones(files) {
    for (const file of files) {
        try {
            if (fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true })
        } catch {
            // Already gone.
        }
    }
}

const TRY_SETTLE_MS = 250
const TRY_REMOVE_ATTEMPTS = 4
const TRY_REMOVE_BACKOFF_MS = 40

function tryDirectoriesLeft(entries) {
    return [...new Set(entries)].filter((entry) => tryDirIsDirectory(entry)).sort()
}

// A few passes after the settle window. A handle released just after the first delete still goes away here.
async function retryBusyTryDirectories(scope) {
    for (let attempt = 0; attempt < TRY_REMOVE_ATTEMPTS; attempt += 1) {
        const owned = tryScopeEntries(scope)
        if (tryDirectoriesLeft(owned).length === 0) return []
        for (const entry of owned) removeOneTryDir(entry)
        const left = tryDirectoriesLeft(tryScopeEntries(scope))
        if (left.length === 0) return []
        if (attempt + 1 < TRY_REMOVE_ATTEMPTS) await delay(TRY_REMOVE_BACKOFF_MS)
    }
    return tryDirectoriesLeft(tryScopeEntries(scope))
}

function warnTryDirectoriesLeft(entries) {
    const left = tryDirectoriesLeft(entries)
    if (!left.length) return
    console.warn(`[harness] try profile directories still on disk after close: ${left.join(', ')}`)
}

async function settleTryDirectories(scope, names) {
    const owned = new Set(names)
    const deadline = Date.now() + TRY_SETTLE_MS
    let tombstones = []
    while (Date.now() < deadline) {
        for (const entry of tryScopeEntries(scope)) owned.add(entry)
        for (const entry of owned) removeOneTryDir(entry)
        if ([...owned].some((entry) => tryDirIsDirectory(entry))) clearTryTombstones(tombstones)
        else tombstones = placeTryTombstones([...owned])
        await delay(40)
    }
    for (const entry of tryScopeEntries(scope)) owned.add(entry)
    clearTryTombstones(tombstones)
    for (const entry of owned) removeOneTryDir(entry)
}

function gatewaySocketPath() {
    const home = hermesHome()
    const direct = path.join(home, 'gateway.sock')
    if (fs.existsSync(direct)) return direct
    const pointer = path.join(home, 'gateway.sock.path')
    if (!fs.existsSync(pointer)) return ''
    const target = fs.readFileSync(pointer, 'utf8').trim()
    return target && fs.existsSync(target) ? target : ''
}

const UNSERVE_ATTEMPTS = 5
const UNSERVE_TIMEOUT_MS = 2000
const UNSERVE_RETRY_MS = 150

function unserveOnce(name, sock) {
    return new Promise((resolve) => {
        const socket = net.createConnection(sock)
        let buf = ''
        let settled = false
        let timer
        const finish = (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            resolve(value)
        }
        timer = setTimeout(() => finish('timeout'), UNSERVE_TIMEOUT_MS)
        socket.on('error', (error) => finish(error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' ? 'down' : 'error'))
        socket.on('data', (chunk) => {
            buf += String(chunk)
            const split = buf.indexOf('\n')
            if (split === -1) return
            let parsed
            try {
                parsed = JSON.parse(buf.slice(0, split))
            } catch {
                finish('error')
                return
            }
            const result = parsed?.ok === true ? parsed.result : null
            const message = String(parsed?.error?.message || parsed?.error || result?.error || '')
            if (result && result.pending !== true && result.unserved === name) finish('unserved')
            else if (message.includes(`profile '${name}' is not served`)) finish('not-served')
            else finish('pending')
        })
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ verb: 'unserve-profile', id: 1, protocol: 1, params: { name } })}\n`)
        })
    })
}

// Pending, a timeout, or a socket error is not a finished close. Poll until the runtime reports this profile unserved.
export async function unserveRuntimeProfile(name) {
    const sock = gatewaySocketPath()
    if (!sock || !name) return false
    for (let attempt = 0; attempt < UNSERVE_ATTEMPTS; attempt += 1) {
        const outcome = await unserveOnce(name, sock)
        if (outcome === 'unserved') return true
        if (attempt + 1 < UNSERVE_ATTEMPTS) await delay(UNSERVE_RETRY_MS)
    }
    return false
}

// For a removal: true only when the runtime is confirmed not to serve this profile any more (it answered that it
// stopped serving it, said it does not serve it, or there is no socket and no live runtime process). Pending, timeouts and
// errors are false.
export async function stopRuntimeProfile(name) {
    const sock = gatewaySocketPath()
    if (!name) return false
    // No socket proves nothing while a runtime process for this home is alive (its socket may have failed to start,
    // or it listens on a pipe this lookup does not see): the profile is kept then.
    if (!sock || !fs.existsSync(sock)) return !liveRuntimeRecorded()
    for (let attempt = 0; attempt < UNSERVE_ATTEMPTS; attempt += 1) {
        const outcome = await unserveOnce(name, sock)
        if (outcome === 'unserved' || outcome === 'not-served') return true
        // A refused or vanished socket is a runtime that is down only when no runtime process of this home is alive.
        if (outcome === 'down' && !liveRuntimeRecorded()) return true
        if (attempt + 1 < UNSERVE_ATTEMPTS) await delay(UNSERVE_RETRY_MS)
    }
    return false
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM'
    }
}

function readJsonOrNull(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

// Whether this home's pid record or runtime state names a process that is still alive. A recycled pid only keeps
// data longer; it never lets a live runtime's profile go.
export function liveRuntimeRecorded() {
    const home = hermesHome()
    const pidRecord = readJsonOrNull(path.join(home, 'gateway.pid'))
    const pidText =
        pidRecord == null
            ? (() => {
                  try {
                      return fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim()
                  } catch {
                      return ''
                  }
              })()
            : ''
    const fromPid = Number.parseInt(pidRecord && typeof pidRecord === 'object' ? pidRecord.pid : pidRecord ?? pidText, 10)
    if (pidAlive(fromPid)) return true
    const state = readJsonOrNull(path.join(home, 'gateway_state.json'))
    if (state && typeof state === 'object' && !['stopped', 'startup_failed', undefined, null].includes(state.gateway_state)) {
        if (pidAlive(Number.parseInt(state.pid, 10))) return true
    }
    return false
}

async function closeTryRuntime(names) {
    const closeProfiles =
        tryRuntime.closeProfiles ||
        (async (profiles) => {
            for (const name of profiles) await unserveRuntimeProfile(name)
        })
    await closeProfiles(names)
}

// Close the runtime for this try and every specialist profile before any directory is removed.
// Tokens leave the map before the unlink. A close can recreate log directories after it answers,
// so removal retries until those directories stay gone. A directory that is still there is logged once.
export async function discardTryProfile(tryId) {
    const scope = tryProfileName(tryId)
    try {
        const names = tryProfileNames(scope)
        const owned = names.length ? names : [scope]
        await closeTryRuntime(owned)
        forgetTryTokens(scope)
        for (const entry of owned) removeOneTryDir(entry)
        if (typeof tryRuntime.afterFirstRemoval === 'function') {
            try {
                tryRuntime.afterFirstRemoval(scope)
            } catch {
                // A recreate during the hook is removed by the settle loop.
            }
        }
        await settleTryDirectories(scope, owned)
        const left = await retryBusyTryDirectories(scope)
        warnTryDirectoriesLeft(left)
    } finally {
        compiledProfiles.delete(scope)
        endLiveTry(scope)
    }
}

export { noteLiveTry }

const compiledProfiles = new Map()

// Raise this whenever compileProfile writes a different shape, so profiles already on disk are compiled again
// at boot. Hermes reads config.yaml from disk, and the compile cache above lives only in memory, so a profile
// compiled by an older server (for example a parent that still lists specialist bridges) would otherwise stay.
export const PROFILE_COMPILER_VERSION = '2'

function compilerVersionOf(dir) {
    try {
        const text = readFileNoFollow(path.join(dir, 'harness-compiler'))
        return text == null ? '' : text.trim()
    } catch {
        return ''
    }
}

function onDiskRoster(dir) {
    try {
        const text = readFileNoFollow(path.join(dir, 'harness-roster.json'))
        if (text == null) return null
        return JSON.parse(text)
    } catch {
        return null
    }
}

// A current compiler marker is not enough. The same tree check a compile uses has to pass, or the
// runtime would load a link that was swapped in after the compile.
function profileTreeBlocked(dir) {
    try {
        preflightTree(dir)
        return false
    } catch (error) {
        if (error?.code === 'profile_link') return true
        throw error
    }
}

// Whether the published profile for this record, or one of its specialists, came from another compiler version.
// A directory with no version file is a compile from an older server or one that stopped partway.
export function profileOutdated(record) {
    const dir = profileDir(record.name)
    if (!fs.existsSync(dir)) {
        // No parent folder: never compiled, unless specialist folders of this harness survived it.
        const root = path.join(hermesHome(), 'profiles')
        if (!fs.existsSync(root)) return false
        return fs.readdirSync(root).some((entry) => {
            try {
                const child = path.join(root, entry)
                if (readMarker(path.join(child, 'harness-parent')) !== String(record.name)) return false
                if (compilerVersionOf(child) !== PROFILE_COMPILER_VERSION) return true
                return profileTreeBlocked(child)
            } catch {
                // Another profile's unreadable marker; the boot sweep reports it if it is a harness folder.
                return false
            }
        })
    }
    if (compilerVersionOf(dir) !== PROFILE_COMPILER_VERSION || profileTreeBlocked(dir)) return true
    const roster = onDiskRoster(dir)
    for (const specialist of roster?.specialists || []) {
        const childName = String(specialist?.profileName || '')
        // A name that leaves the profiles tree is not a profile directory. Leave that path where it is.
        if (!PROFILE_ID_RE.test(childName)) continue
        const child = profileDir(childName)
        if (fs.existsSync(child) && (compilerVersionOf(child) !== PROFILE_COMPILER_VERSION || profileTreeBlocked(child))) return true
    }
    return false
}

function isLink(dir) {
    try {
        return fs.lstatSync(dir).isSymbolicLink()
    } catch {
        return false
    }
}

// Profile folders this compile would write that are links. Compiling through one would write into the link's target.
// profileName is the directory being compiled (a try uses its own name, not the saved harness name).
function linkedProfileDirs(record, profileName = record?.name) {
    const root = path.join(hermesHome(), 'profiles')
    // A link above the profiles directory is refused before the roster or the directory list is read.
    refuseAncestorsOf(root)
    // Listing a linked profiles directory would read its target. The caller moves that one link aside.
    if (isLink(root)) return [root]
    const home = String(profileName || record?.name || '')
    const owner = String(record?.name || home)
    const dirs = new Set()
    const homeDir = home ? profileDir(home) : ''
    if (homeDir) dirs.add(homeDir)
    // A linked home is enough. Don't read the target looking for more folders.
    if (homeDir && !isLink(homeDir)) {
        for (const specialist of onDiskRoster(homeDir)?.specialists || []) {
            const child = String(specialist?.profileName || '')
            if (!PROFILE_ID_RE.test(child)) continue
            dirs.add(profileDir(child))
        }
    }
    for (const specialist of Array.isArray(record?.specialists) ? record.specialists : []) {
        try {
            if (home) dirs.add(profileDir(specialistProfileName(home, specialist?.name)))
        } catch {
            // A name that cannot get its own profile; the compile reports it.
        }
    }
    try {
        for (const entry of fs.readdirSync(root)) {
            if (isQuarantineName(entry)) continue
            const dir = path.join(root, entry)
            if (!isLink(dir)) continue
            // The entry name is the owner. Reading harness-parent would follow the link.
            const named =
                (home && (entry === home || entry.startsWith(`${home}--`))) ||
                (owner && (entry === owner || entry.startsWith(`${owner}--`)))
            if (named) dirs.add(dir)
        }
    } catch {
        // No profiles folder yet.
    }
    return [...dirs].filter(isLink)
}

// Runs at server start, before the gateway answers and so before Hermes loads any profile. Recompiles each saved
// harness whose published profile directory is on disk from an older compiler. Profiles never compiled stay uncompiled, and
// a second run finds nothing to do. The caller holds the profile lock.
export function recompileOutdatedProfiles(records, { log = console } = {}) {
    const results = []
    for (const record of records) {
        if (!record?.name) continue
        const linked = linkedProfileDirs(record)
        if (linked.length) {
            const stuck = linked.filter((dir) => !quarantineContained(dir))
            const where = stuck.length ? stuck : linked
            results.push({
                name: record.name,
                status: 'failed',
                error: stuck.length
                    ? `profile folder is a link and could not be moved off the load path: ${where.join(', ')}`
                    : `profile folder is a link: ${where.join(', ')}`
            })
            continue
        }
        let outdated
        try {
            outdated = profileOutdated(record)
        } catch (error) {
            results.push({ name: record.name, status: 'failed', error: error.message })
            continue
        }
        if (!outdated) continue
        const roster = onDiskRoster(profileDir(record.name))
        // Specialist tokens from before the createdAt stamp are kept only when the profile on disk is this record's.
        const sameRecord = Boolean(record.createdAt) && String(roster?.createdAt || '') === String(record.createdAt)
        try {
            compileProfile(record, { adoptUnstampedTokens: sameRecord })
            forgetCompiledProfile(record.name)
            results.push({ name: record.name, status: 'recompiled' })
        } catch (error) {
            results.push({ name: record.name, status: 'failed', error: error.message })
        }
    }
    const failed = results.filter((result) => result.status === 'failed')
    const done = results.length - failed.length
    if (done) log.info?.(`[harness] recompiled ${done} profile(s) from an older compiler before the runtime starts`)
    for (const result of failed) log.warn?.(`[harness] ${result.name} profile was not recompiled: ${result.error}`)
    return results
}

function credentialIdsIn(record) {
    const ids = []
    JSON.stringify(record, (key, value) => {
        if ((key === 'credentialId' || key === 'credential') && typeof value === 'string') ids.push(value)
        return value
    })
    return ids
}

// Recompiling writes several files and decrypts credentials; on a Windows-mounted drive
// that is most of a single-tool turn. The key covers the record, the home it compiles
// into, and each model credential's updatedDate, so a saved roster or a rotated key recompiles.
export function forgetCompiledProfile(name) {
    compiledProfiles.delete(name)
}

const PREFLIGHT_DIRS = ['memory', 'skills', path.join('skills', PLAYBOOK_DIR), 'sessions']
const BIGINT_STAT = { bigint: true }

// Directories a compile treated as real: the profile, each specialist, memory and the rest of the
// preflight set, specialist workspaces, and every ancestor from the parent of the hermes home down.
function trustedProfileDirs(compiled) {
    const dirs = []
    const addTree = (dir) => {
        if (!dir) return
        dirs.push(dir)
        for (const rel of PREFLIGHT_DIRS) dirs.push(path.join(dir, rel))
    }
    const roster = compiled?.roster || compiled
    addTree(compiled?.dir)
    for (const specialist of roster?.specialists || []) {
        if (!specialist?.profileName) continue
        const dir = profileDir(specialist.profileName)
        addTree(dir)
        dirs.push(specialistWorkspace(specialist.profileName))
    }
    return dirs
}

function lstatIdentity(entry) {
    const stat = fs.lstatSync(entry, BIGINT_STAT)
    if (stat.isSymbolicLink()) return { link: true }
    if (stat.dev === 0n || stat.ino === 0n) return { unverifiable: true, directory: stat.isDirectory() }
    return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() }
}

// null when a path cannot be read. links when a symlink is in the set. unverifiable when dev or ino is 0.
function profileDirectoryChain(compiled) {
    const links = []
    const dirs = []
    const seen = new Set()
    let unverifiable = false
    for (const dir of trustedProfileDirs(compiled)) {
        const paths = ancestorPaths(dir)
        if (!paths) return null
        for (const entry of paths) {
            if (seen.has(entry)) continue
            seen.add(entry)
            let identity
            try {
                identity = lstatIdentity(entry)
            } catch (error) {
                // A missing path has no inode to pin. A link created there later is refused when the
                // cache hit runs preflightTree.
                if (error?.code === 'ENOENT') continue
                return null
            }
            if (identity.link) {
                links.push(entry)
                continue
            }
            if (identity.unverifiable) {
                unverifiable = true
                continue
            }
            // A regular file is not a directory pin. A link was recorded above.
            if (!identity.directory) continue
            dirs.push({ path: entry, dev: identity.dev, ino: identity.ino })
        }
    }
    const rosterForFiles = compiled?.roster || compiled
    const fileDirs = [compiled?.dir].filter(Boolean)
    for (const specialist of rosterForFiles?.specialists || []) {
        if (specialist?.profileName) fileDirs.push(profileDir(specialist.profileName))
    }
    for (const dir of fileDirs) {
        for (const rel of PREFLIGHT_RELS) {
            const entry = path.resolve(path.join(dir, rel))
            if (seen.has(entry)) continue
            seen.add(entry)
            let identity
            try {
                identity = lstatIdentity(entry)
            } catch (error) {
                if (error?.code === 'ENOENT') continue
                return null
            }
            if (identity.link) links.push(entry)
            else if (identity.unverifiable) unverifiable = true
        }
    }
    if (links.length) return { links }
    if (unverifiable) return { unverifiable: true }
    if (!dirs.length) return null
    const configs = []
    const roster = compiled?.roster || compiled
    const profileDirs = [compiled.dir]
    for (const specialist of roster?.specialists || []) {
        if (specialist?.profileName) profileDirs.push(profileDir(specialist.profileName))
    }
    for (const dir of profileDirs) {
        const resolved = path.resolve(dir)
        const recorded = dirs.find((entry) => entry.path === resolved)
        if (!recorded) continue
        let fileStat
        try {
            fileStat = fs.lstatSync(path.join(resolved, 'config.yaml'), BIGINT_STAT)
        } catch (error) {
            if (error?.code === 'ENOENT') continue
            return null
        }
        if (fileStat.isSymbolicLink()) return { links: [path.join(resolved, 'config.yaml')] }
        if (!fileStat.isFile()) continue
        if (fileStat.dev === 0n || fileStat.ino === 0n) return { unverifiable: true }
        configs.push({
            dirPath: resolved,
            dirDev: recorded.dev,
            dirIno: recorded.ino,
            fileDev: fileStat.dev,
            fileIno: fileStat.ino,
            primary: resolved === path.resolve(compiled.dir)
        })
    }
    if (!configs.length) return null
    return { dirs, configs }
}

function directoriesStillHeld(dirs) {
    if (!Array.isArray(dirs) || dirs.length === 0) return false
    for (const entry of dirs) {
        let identity
        try {
            identity = lstatIdentity(entry.path)
        } catch {
            return false
        }
        if (identity.link || identity.unverifiable || !identity.directory) return false
        if (identity.dev !== entry.dev || identity.ino !== entry.ino) return false
    }
    return true
}

// The directory is opened with O_DIRECTORY|O_NOFOLLOW and config.yaml is opened from that descriptor.
// The path is checked again afterwards so a swap between the two lookups is not a hit.
function configHeldFromDir(config, inject) {
    let dirFd
    try {
        dirFd = fs.openSync(config.dirPath, DIR_FLAGS)
        const dirStat = fs.fstatSync(dirFd, BIGINT_STAT)
        if (dirStat.dev === 0n || dirStat.ino === 0n) return false
        if (dirStat.dev !== config.dirDev || dirStat.ino !== config.dirIno) return false
        if (inject && typeof profileWriteTest.betweenCacheChecks === 'function') {
            profileWriteTest.betweenCacheChecks(config.dirPath, dirFd)
        }
        const via = fdPath(dirFd, 'config.yaml')
        if (!via) return false
        let fileFd
        try {
            fileFd = fs.openSync(via, fs.constants.O_RDONLY | NOFOLLOW)
            const fileStat = fs.fstatSync(fileFd, BIGINT_STAT)
            if (!fileStat.isFile() || fileStat.dev === 0n || fileStat.ino === 0n) return false
            if (fileStat.dev !== config.fileDev || fileStat.ino !== config.fileIno) return false
        } finally {
            if (fileFd != null) fs.closeSync(fileFd)
        }
        const again = lstatIdentity(config.dirPath)
        if (again.link || again.unverifiable || again.dev !== config.dirDev || again.ino !== config.dirIno) return false
        return true
    } catch {
        return false
    } finally {
        if (dirFd != null) {
            try {
                fs.closeSync(dirFd)
            } catch {
                // Already closed.
            }
        }
    }
}

function profileDirectoryChainHeld(snapshot) {
    if (!snapshot?.dirs?.length || snapshot.unverifiable || snapshot.links?.length) return false
    if (!directoriesStillHeld(snapshot.dirs)) return false
    const primary = snapshot.configs?.find((entry) => entry.primary) || snapshot.configs?.[0]
    if (!primary || !configHeldFromDir(primary, true)) return false
    for (const config of snapshot.configs || []) {
        if (config === primary) continue
        if (!configHeldFromDir(config, false)) return false
    }
    return directoriesStillHeld(snapshot.dirs)
}

function refuseUnverifiedProfile(compiled, snapshot) {
    const links = new Set(snapshot?.links || [])
    if (!links.size) {
        for (const dir of trustedProfileDirs(compiled)) {
            const paths = ancestorPaths(dir) || [dir]
            for (const entry of paths) {
                try {
                    if (fs.lstatSync(entry).isSymbolicLink()) links.add(entry)
                } catch {
                    // Missing. The refusal still stands.
                }
            }
        }
    }
    for (const link of links) {
        if (insideProfilesRoot(link)) quarantineSymlink(link)
    }
    throw new HarnessError('profile_link', `profile path is a link: ${[...links].join(', ') || compiled?.dir || ''}`)
}

// The same preflight a compile runs. Pinned directory identity is a separate re-check so an inode of
// zero compiles again instead of being treated as a hit.
function recheckCached(compiled) {
    const roster = compiled?.roster || compiled
    const dirs = []
    if (compiled?.dir) dirs.push(compiled.dir)
    for (const specialist of roster?.specialists || []) {
        if (specialist?.profileName) dirs.push(profileDir(specialist.profileName))
    }
    for (const dir of dirs) {
        assertDirNoFollow(dir)
        preflightTree(dir)
    }
    for (const specialist of roster?.specialists || []) {
        if (!specialist?.profileName) continue
        const workspace = specialistWorkspace(specialist.profileName)
        assertDirNoFollow(workspace)
        assertContained(workspace)
    }
}

export function compileProfileCached(record) {
    const key = [hermesHome(), JSON.stringify(record), credentialStamp(credentialIdsIn(record))].join('\0')
    const cached = compiledProfiles.get(record.name)
    if (cached?.key === key && cached.compiled) {
        try {
            recheckCached(cached.compiled)
            if (profileDirectoryChainHeld(cached.chain)) {
                // The directory check opens config.yaml after the first preflight. A file
                // can be replaced in that gap, so the same preflight runs again before reuse.
                recheckCached(cached.compiled)
                return cached.compiled
            }
        } catch (error) {
            compiledProfiles.delete(record.name)
            if (error?.code === 'profile_link') throw error
        }
    }
    if (compiledProfiles.has(record.name)) compiledProfiles.delete(record.name)
    const compiled = compileProfile(record)
    const chain = profileDirectoryChain(compiled)
    if (!chain || chain.links) {
        refuseUnverifiedProfile(compiled, chain)
    }
    if (!chain.unverifiable) compiledProfiles.set(record.name, { key, compiled, chain })
    return compiled
}

export function chiefInstructions(record) {
    const text = readTextNoFollow(path.join(profileDir(record.name), 'SOUL.md'))
    if (text != null) return text
    return chiefPrompt(record)
}

export { CHIEF_TOOLSETS, MODEL_ENV_KEYS }
