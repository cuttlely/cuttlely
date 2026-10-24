// Removes the agent runtime profiles of a deleted harness: its own profile (named after the harness) and every
// specialist profile whose harness-parent marker names it. A harness is matched by its exact name, the id its
// store file uses, never by a prefix, a display label or another letter case.
//
// Safety rules for every removal:
// - Only entries directly inside the profiles root (or the specialist workspaces root) are touched. Both roots
//   are resolved with realpath. A target whose realpath is outside its root, or is the root, is refused.
// - Symbolic links are never followed: a link is unlinked, its target stays.
// - A profile whose harness still has a store file (exact name, or the same name in another letter case) stays.
// - Gateway tokens are revoked before any directory is removed. If that fails, nothing is removed.
// - A profile directory is first moved into a trash directory under the runtime home and then removed, so a
//   crash midway leaves either the intact profile or a trash entry. Both are picked up by the next run.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HarnessError } from './errors.mjs'
import { revokeHarnessTokens } from './gateway.mjs'
import { dataRoot, harnessStoreDir, hermesHome } from './paths.mjs'
import { forgetCompiledProfile, unserveRuntimeProfile } from './profile.mjs'
import { assertHarnessName, deleteHarness } from './store.mjs'

export const ORPHAN_SWEEP_ENV = 'CUTTLELY_HARNESS_ORPHAN_SWEEP'
export const ORPHAN_SWEEP_MIN_AGE_MS = 10 * 60 * 1000

const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TRY_HOME = /^try[a-f0-9]{8,32}$/i
const TRYX_HOME = /^tryx[a-f0-9]{16}$/i
const TRASH = '.cuttlely-removing'
const MARKERS = ['harness-parent', 'harness-roster.json', 'harness-try', 'config.yaml', '.env', 'SOUL.md']

// Tests replace these. revoke must throw to stop a removal; close is best effort.
export const cleanupHooks = {
    revoke: null,
    close: null,
    log: (line) => console.warn(line)
}

function profilesRoot() {
    return path.join(hermesHome(), 'profiles')
}

function workspacesRoot() {
    return path.join(dataRoot(), 'workspaces')
}

function trashRoot() {
    return path.join(hermesHome(), TRASH)
}

function realDir(dir) {
    try {
        const stat = fs.lstatSync(dir)
        if (stat.isSymbolicLink() || !stat.isDirectory()) return ''
        return fs.realpathSync(dir)
    } catch {
        return ''
    }
}

function lstatOrNull(file) {
    try {
        return fs.lstatSync(file)
    } catch {
        return null
    }
}

// The one place that decides whether a path may be removed. Returns the checked absolute path or ''.
export function containedEntry(root, entry) {
    if (typeof entry !== 'string' || !ENTRY_RE.test(entry)) return ''
    const rootReal = realDir(root)
    if (!rootReal) return ''
    const target = path.join(rootReal, entry)
    if (path.dirname(target) !== rootReal || target === rootReal) return ''
    const stat = lstatOrNull(target)
    if (!stat) return ''
    if (stat.isSymbolicLink()) return target
    let real
    try {
        real = fs.realpathSync(target)
    } catch {
        return ''
    }
    if (real === rootReal || path.dirname(real) !== rootReal) return ''
    return target
}

// Removes one entry of a root. A link is unlinked (its target stays). A missing entry is already done.
function removeEntry(root, entry) {
    const target = containedEntry(root, entry)
    if (!target) return false
    const stat = lstatOrNull(target)
    if (!stat) return false
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fs.unlinkSync(target)
        return true
    }
    fs.rmSync(target, { recursive: true, force: true })
    return true
}

// A profile directory moves into the trash in one rename, then the trash entry is removed.
function removeProfileEntry(entry) {
    const target = containedEntry(profilesRoot(), entry)
    if (!target) return false
    const stat = lstatOrNull(target)
    if (!stat) return false
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fs.unlinkSync(target)
        return true
    }
    fs.mkdirSync(trashRoot(), { recursive: true })
    const parked = `${entry}-${crypto.randomBytes(6).toString('hex')}`
    if (path.dirname(path.join(trashRoot(), parked)) !== trashRoot()) return false
    fs.renameSync(target, path.join(trashRoot(), parked))
    removeEntry(trashRoot(), parked)
    return true
}

function emptyTrash() {
    const root = trashRoot()
    const rootStat = lstatOrNull(root)
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return
    for (const entry of fs.readdirSync(root)) {
        try {
            removeEntry(root, entry)
        } catch (error) {
            cleanupHooks.log(`[harness] could not empty ${TRASH}/${entry}: ${error?.code || error?.name || 'error'}`)
        }
    }
}

function readText(file) {
    const stat = lstatOrNull(file)
    if (!stat || !stat.isFile()) return ''
    return fs.readFileSync(file, 'utf8')
}

function readMarker(dir, name) {
    return readText(path.join(dir, name)).trim()
}

function rosterName(dir) {
    try {
        const parsed = JSON.parse(readText(path.join(dir, 'harness-roster.json')) || 'null')
        return typeof parsed?.name === 'string' ? parsed.name : ''
    } catch {
        return ''
    }
}

function isTryName(name) {
    return TRY_HOME.test(name) || TRYX_HOME.test(name)
}

// Saved harness names straight from the store directory, compared exactly. null when the store cannot be read.
function savedNames() {
    const dir = harnessStoreDir()
    if (!fs.existsSync(dir)) return new Set()
    try {
        return new Set(
            fs
                .readdirSync(dir)
                // A record staged by a canvas delete (<name>.json.deleting) can still be put back, so it counts as saved.
                .map((entry) =>
                    entry.endsWith('.json')
                        ? entry.slice(0, -'.json'.length)
                        : entry.endsWith('.json.deleting')
                        ? entry.slice(0, -'.json.deleting'.length)
                        : ''
                )
                .filter(Boolean)
        )
    } catch {
        return null
    }
}

// Saved under this exact name, or under the same name in another letter case (one file on a case-insensitive disk).
function stillSaved(id, saved) {
    if (!saved) return true
    if (saved.has(id)) return true
    const lower = id.toLowerCase()
    for (const name of saved) if (name.toLowerCase() === lower) return true
    return false
}

// What a profile directory belongs to: { kind: 'home' | 'child', id } or null when it is not a saved-harness profile.
function profileOwner(entry) {
    const dir = containedEntry(profilesRoot(), entry)
    if (!dir) return null
    const stat = lstatOrNull(dir)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null
    if (lstatOrNull(path.join(dir, 'harness-try'))) return null
    const parent = readMarker(dir, 'harness-parent')
    if (parent) {
        if (parent === entry || isTryName(parent)) return null
        return { kind: 'child', id: parent }
    }
    const name = rosterName(dir)
    if (name && name === entry && !isTryName(name)) return { kind: 'home', id: name }
    return null
}

// Every profile entry that belongs to this exact harness id. The home profile comes last.
function profilesOf(id) {
    const root = profilesRoot()
    if (!realDir(root)) return []
    const children = []
    let home = ''
    for (const entry of fs.readdirSync(root).sort()) {
        const owner = profileOwner(entry)
        if (!owner || owner.id !== id) continue
        if (owner.kind === 'home') home = entry
        else children.push(entry)
    }
    return home ? [...children, home] : children
}

function newestChange(entry) {
    const dir = path.join(profilesRoot(), entry)
    let newest = 0
    for (const file of [dir, ...MARKERS.map((name) => path.join(dir, name))]) {
        const stat = lstatOrNull(file)
        if (stat) newest = Math.max(newest, stat.mtimeMs)
    }
    return newest
}

function revoke(id, entries) {
    const fn = cleanupHooks.revoke || revokeHarnessTokens
    fn(id, entries)
}

async function closeRuntime(entries) {
    const fn = cleanupHooks.close || unserveRuntimeProfile
    for (const entry of entries) {
        try {
            await fn(entry)
        } catch {
            // A runtime that is not running has nothing to close.
        }
    }
}

// Revokes the tokens, then removes each entry. Returns the removed entries.
// Refuses when the harness is still saved. A revocation failure removes nothing.
async function removeOwned(id, entries, { reason }) {
    const saved = savedNames()
    if (stillSaved(id, saved)) {
        cleanupHooks.log(`[harness] kept the profiles of harness "${id}": it is still saved or the store could not be read`)
        return { removed: [], kept: entries, error: null }
    }
    try {
        revoke(id, entries)
    } catch (error) {
        cleanupHooks.log(
            `[harness] removed nothing for harness "${id}" (${reason}): revoking its gateway tokens failed: ${error?.message || 'error'}`
        )
        return { removed: [], kept: entries, error }
    }
    await closeRuntime(entries)
    const removed = []
    for (const entry of entries) {
        try {
            removeEntry(workspacesRoot(), entry)
            if (removeProfileEntry(entry)) {
                removed.push(entry)
                cleanupHooks.log(`[harness] removed profiles/${entry} of harness "${id}" (${reason})`)
            }
        } catch (error) {
            cleanupHooks.log(`[harness] could not remove profiles/${entry} of harness "${id}": ${error?.code || error?.name || 'error'}`)
        }
    }
    forgetCompiledProfile(id)
    return { removed, kept: [], error: null }
}

// Removes the profiles of one harness that has no store file. Safe to run again after a crash.
export async function removeHarnessProfiles(name, { reason = 'harness deleted' } = {}) {
    const id = assertHarnessName(name)
    emptyTrash()
    return removeOwned(id, profilesOf(id), { reason })
}

// The harness delete: tokens are revoked first (a failure keeps the store file and every profile),
// then the store file goes, then the profiles. A rerun after a crash finishes what is left.
export async function deleteHarnessAndProfiles(name) {
    const id = assertHarnessName(name)
    const entries = profilesOf(id)
    try {
        revoke(id, entries)
    } catch (error) {
        cleanupHooks.log(`[harness] removed nothing for harness "${id}": revoking its gateway tokens failed: ${error?.message || 'error'}`)
        throw new HarnessError(
            'cleanup_failed',
            `Harness "${id}" was not deleted, because its gateway tokens could not be revoked. Try again.`
        )
    }
    deleteHarness(id)
    return removeHarnessProfiles(id)
}

export function orphanSweepMode(env = process.env) {
    return env[ORPHAN_SWEEP_ENV] === 'delete' ? 'delete' : 'log'
}

// Profiles whose harness has no store file. Logs them; removes them only when CUTTLELY_HARNESS_ORPHAN_SWEEP=delete.
// Anything changed in the last 10 minutes, try profiles and profiles of a saved harness stay.
export async function sweepOrphanHarnessProfiles({ mode = orphanSweepMode(), now = Date.now() } = {}) {
    const root = profilesRoot()
    const result = { mode, orphans: [], removed: [], skipped: [] }
    if (!realDir(root)) return result
    if (mode === 'delete') emptyTrash()
    const saved = savedNames()
    if (!saved) {
        cleanupHooks.log('[harness] orphan profile sweep skipped: the harness store could not be read')
        return result
    }
    const groups = new Map()
    for (const entry of fs.readdirSync(root).sort()) {
        const owner = profileOwner(entry)
        if (!owner || stillSaved(owner.id, saved)) continue
        let valid = true
        try {
            assertHarnessName(owner.id)
        } catch {
            valid = false
        }
        if (!valid) continue
        if (now - newestChange(entry) < ORPHAN_SWEEP_MIN_AGE_MS) {
            result.skipped.push(entry)
            cleanupHooks.log(
                `[harness] orphan profile sweep: profiles/${entry} of harness "${owner.id}" changed in the last 10 minutes, kept`
            )
            continue
        }
        const list = groups.get(owner.id) || []
        list.push({ entry, kind: owner.kind })
        groups.set(owner.id, list)
    }
    for (const [id, list] of groups) {
        const entries = [...list.filter((item) => item.kind === 'child'), ...list.filter((item) => item.kind === 'home')].map(
            (item) => item.entry
        )
        result.orphans.push(...entries.map((entry) => ({ id, entry })))
        if (mode !== 'delete') {
            for (const entry of entries) {
                cleanupHooks.log(
                    `[harness] orphan profile sweep (dry run): would remove profiles/${entry} of harness "${id}". Set ${ORPHAN_SWEEP_ENV}=delete to remove it`
                )
            }
            continue
        }
        const outcome = await removeOwned(id, entries, { reason: 'orphan sweep' })
        result.removed.push(...outcome.removed)
    }
    return result
}
