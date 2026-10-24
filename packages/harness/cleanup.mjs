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
import { closeHarnessTokens, reopenHarnessTokens, revokeHarnessTokens } from './gateway.mjs'
import { dataRoot, harnessStoreDir, hermesHome } from './paths.mjs'
import { forgetCompiledProfile, stopRuntimeProfile } from './profile.mjs'
import { assertHarnessName, deleteHarness } from './store.mjs'

export const ORPHAN_SWEEP_ENV = 'CUTTLELY_HARNESS_ORPHAN_SWEEP'
export const ORPHAN_SWEEP_MIN_AGE_MS = 10 * 60 * 1000

const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TRASH = '.cuttlely-removing'

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

// A removal root only counts when it is a plain directory directly inside the real runtime home (or data root).
function checkedRoot(root) {
    const real = realDir(root)
    if (!real) return ''
    const parent = realDir(path.dirname(root))
    return parent && real === path.join(parent, path.basename(root)) ? real : ''
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
    const rootReal = checkedRoot(root)
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

// A profile directory moves into the trash in one step, then the trash entry is removed. afterPark runs once the
// profile is out of profiles/ (so the runtime's profile watcher cannot serve it again) and before anything is
// removed; when it answers false the entry goes back to profiles/ (or, when the name was taken meanwhile, stays
// parked in the trash with its owner note for a later run). Returns true (removed), false (kept in place) or 'parked'.
async function removeProfileEntry(entry, afterPark = async () => true) {
    const target = containedEntry(profilesRoot(), entry)
    if (!target) return false
    const stat = lstatOrNull(target)
    if (!stat) return false
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        if (!(await afterPark(null))) return false
        fs.unlinkSync(target)
        return true
    }
    const trash = checkedTrashRoot(true)
    if (!trash) {
        cleanupHooks.log(`[harness] kept profiles/${entry}: ${TRASH} is not a plain directory inside the runtime home`)
        return false
    }
    const owner = profileOwner(entry)
    const parked = `${entry}-${crypto.randomBytes(6).toString('hex')}`
    if (path.dirname(path.join(trash, parked)) !== trash) return false
    // The owner is written next to the parked entry first, so a crash midway through the recursive removal (which
    // may already have taken the markers inside) still leaves a leftover the next run can attribute.
    if (owner) fs.writeFileSync(path.join(trash, `${parked}${OWNER_SUFFIX}`), `${owner.id}\n`, { flag: 'wx' })
    fs.renameSync(target, path.join(trash, parked))
    if (!(await afterPark(path.join(trash, parked)))) return putBackParked(trash, parked, entry) ? false : 'parked'
    if (removeEntry(trash, parked)) cleanupHooks.log(`[harness] removed ${TRASH}/${parked} (was profiles/${entry})`)
    removeOwnerNote(trash, parked)
    return true
}

// A parked profile that is kept goes back to profiles/ by copy (timestamps kept), then the parked copy is removed.
// Nothing comes back over an entry created under the name meanwhile; the parked copy then stays, with its owner note,
// for a later run.
function putBackParked(trash, parked, entry) {
    const rootReal = checkedRoot(profilesRoot())
    const target = rootReal && ENTRY_RE.test(entry) ? path.join(rootReal, entry) : ''
    if (!target || path.dirname(target) !== rootReal || lstatOrNull(target)) {
        cleanupHooks.log(`[harness] kept ${TRASH}/${parked} (was profiles/${entry}) for a later run`)
        return false
    }
    fs.cpSync(path.join(trash, parked), target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true })
    removeEntry(trash, parked)
    removeOwnerNote(trash, parked)
    return true
}

// The trash directory, only when it is a real directory (not a link) directly inside the real runtime home.
function checkedTrashRoot(create = false) {
    const home = realDir(hermesHome())
    if (!home) return ''
    const want = path.join(home, TRASH)
    if (create && !lstatOrNull(want)) {
        try {
            fs.mkdirSync(want)
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error
        }
    }
    const real = realDir(want)
    return real && real === want && path.dirname(real) === home ? real : ''
}

const PARKED_RE = /^(.+)-[a-f0-9]{12}$/
const OWNER_SUFFIX = '.owner'

function ownerNote(root, entry) {
    const file = path.join(root, `${entry}${OWNER_SUFFIX}`)
    if (path.dirname(file) !== root) return ''
    return readText(file).trim()
}

function removeOwnerNote(root, entry) {
    const file = path.join(root, `${entry}${OWNER_SUFFIX}`)
    const stat = lstatOrNull(file)
    if (path.dirname(file) === root && stat && !stat.isDirectory()) fs.unlinkSync(file)
}

// Who a trash entry belongs to: the note written before it was parked, else the markers still inside it.
function trashOwner(root, entry) {
    const match = PARKED_RE.exec(entry)
    if (!match || !containedEntry(root, entry)) return ''
    return ownerNote(root, entry) || ownerOf(root, entry, match[1])?.id || ''
}

// Trash entries left by a crash, with the harness each belongs to (read from the markers inside).
function trashEntries() {
    const root = checkedTrashRoot()
    if (!root) return []
    const out = []
    for (const entry of fs.readdirSync(root).sort()) {
        if (entry.endsWith(OWNER_SUFFIX)) {
            // A note whose parked entry is gone (a crash right before the rename or after the removal).
            const base = entry.slice(0, -OWNER_SUFFIX.length)
            const id = PARKED_RE.test(base) && !lstatOrNull(path.join(root, base)) ? ownerNote(root, base) : ''
            if (id) out.push({ entry: base, id })
            continue
        }
        const id = trashOwner(root, entry)
        if (id) out.push({ entry, id })
    }
    return out
}

function removeTrashEntry(id, entry, { minAgeMs = 0, now = Date.now } = {}) {
    const root = checkedTrashRoot()
    if (!root) return
    if (!lstatOrNull(path.join(root, entry))) {
        if (minAgeMs && now() - newestChange(entry, root) < minAgeMs) {
            cleanupHooks.log(`[harness] kept ${TRASH}/${entry}${OWNER_SUFFIX}: it changed in the last 10 minutes`)
            return
        }
        if (ownerNote(root, entry) === id) {
            removeOwnerNote(root, entry)
            cleanupHooks.log(`[harness] removed ${TRASH}/${entry}${OWNER_SUFFIX} of harness "${id}"`)
        }
        return
    }
    // Checked again right before the removal: the entry may have changed while the runtime was closing.
    if (trashOwner(root, entry) !== id || (minAgeMs && now() - newestChange(entry, root) < minAgeMs)) {
        cleanupHooks.log(`[harness] kept ${TRASH}/${entry}: it changed during cleanup`)
        return
    }
    try {
        if (removeEntry(root, entry)) cleanupHooks.log(`[harness] removed ${TRASH}/${entry} of harness "${id}"`)
        removeOwnerNote(root, entry)
    } catch (error) {
        cleanupHooks.log(`[harness] could not remove ${TRASH}/${entry}: ${error?.code || error?.name || 'error'}`)
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

// A temporary (try) profile is known by its lifecycle markers, never by its name: its own harness-try marker, the
// CUTTLELY_GATEWAY_TRY flag its specialist .env carries, or a parent profile that has the harness-try marker.
function envFlag(dir, key) {
    for (const line of readText(path.join(dir, '.env')).split(/\r?\n/)) {
        const at = line.indexOf('=')
        if (at > 0 && line.slice(0, at).trim() === key)
            return line
                .slice(at + 1)
                .trim()
                .replace(/^['"]|['"]$/g, '')
    }
    return ''
}

function isTempProfile(dir, parent) {
    if (lstatOrNull(path.join(dir, 'harness-try'))) return true
    if (envFlag(dir, 'CUTTLELY_GATEWAY_TRY') === '1') return true
    if (!parent) return false
    const parentDir = containedEntry(profilesRoot(), parent)
    return Boolean(parentDir && lstatOrNull(path.join(parentDir, 'harness-try')))
}

// Saved harness names straight from the store directory, compared exactly. null when the store cannot be read.
function savedNames() {
    const dir = harnessStoreDir()
    // Only a store that is missing (ENOENT) is empty; one that cannot be checked (EACCES and the like) reads as null.
    try {
        fs.statSync(dir)
    } catch (error) {
        return error?.code === 'ENOENT' ? new Set() : null
    }
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
    return ownerOf(profilesRoot(), entry, entry)
}

// base is the profile name the entry had before it was parked in the trash (the entry itself otherwise).
function ownerOf(root, entry, base) {
    const dir = containedEntry(root, entry)
    if (!dir) return null
    const stat = lstatOrNull(dir)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null
    const parent = readMarker(dir, 'harness-parent')
    if (isTempProfile(dir, parent)) return null
    const name = rosterName(dir)
    if (parent) {
        if (parent === base) return null
        // A folder whose roster names another harness is not this parent's specialist.
        if (name && name !== parent) return null
        return { kind: 'child', id: parent }
    }
    if (name && name === base) return { kind: 'home', id: name }
    return null
}

// A profile folder named after a saved harness, or whose roster names one, belongs to that harness whatever its
// harness-parent marker says, so it is never revoked or removed for another harness. saved null: the store could
// not be read, and every folder counts as claimed.
function claimedBySaved(entry, saved, root = profilesRoot()) {
    if (stillSaved(entry, saved)) return true
    const dir = containedEntry(root, entry)
    const name = dir ? rosterName(dir) : ''
    return Boolean(name) && stillSaved(name, saved)
}

// Every profile entry that belongs to this exact harness id. The home profile comes last.
function profilesOf(id) {
    const root = profilesRoot()
    if (!realDir(root)) return []
    const saved = savedNames()
    const children = []
    let home = ''
    for (const entry of fs.readdirSync(root).sort()) {
        const owner = profileOwner(entry)
        if (!owner || owner.id !== id) continue
        if (claimedBySaved(entry, saved)) {
            cleanupHooks.log(`[harness] kept profiles/${entry}: a saved harness has this name`)
            continue
        }
        if (owner.kind === 'home') home = entry
        else children.push(entry)
    }
    return home ? [...children, home] : children
}

const WALK_LIMIT = 20000

// Newest mtime of the directory and everything under it, by lstat (links are not followed). Infinity when the
// tree is too large to walk, so a huge tree counts as recently changed and is kept.
function newestTreeChange(dir) {
    let newest = 0
    let seen = 0
    const stack = [dir]
    while (stack.length) {
        const current = stack.pop()
        const stat = lstatOrNull(current)
        if (!stat) continue
        newest = Math.max(newest, stat.mtimeMs)
        if (++seen > WALK_LIMIT) return Infinity
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue
        let names = []
        try {
            names = fs.readdirSync(current)
        } catch {
            return Infinity
        }
        for (const name of names) stack.push(path.join(current, name))
    }
    return newest
}

// The profile and its specialist workspace.
function newestChange(entry, root = profilesRoot()) {
    let newest = 0
    const profile = containedEntry(root, entry)
    if (profile) newest = Math.max(newest, newestTreeChange(profile))
    if (root === profilesRoot()) {
        const work = containedEntry(workspacesRoot(), entry)
        if (work) newest = Math.max(newest, newestTreeChange(work))
    } else {
        // A trash entry: its owner note counts too (and is all there is when only the note is left).
        const note = lstatOrNull(path.join(root, `${entry}${OWNER_SUFFIX}`))
        if (note && !note.isSymbolicLink()) newest = Math.max(newest, note.mtimeMs)
    }
    return newest
}

// harnessWide also revokes tokens of this harness that no listed profile holds. The sweep revokes only the
// profiles it is about to remove, so a recent profile it keeps keeps working.
function revoke(id, entries, { harnessWide = true } = {}) {
    const fn = cleanupHooks.revoke || revokeHarnessTokens
    fn(id, entries, { harnessWide })
}

// The gateway token of a profile lives in its .env. It goes right after the in-memory revocation, so a later
// failure to remove the directory cannot bring the token back when the gateway reloads tokens at the next start.
function dropTokenFiles(id, entries) {
    let failed = null
    for (const entry of entries) {
        const owner = profileOwner(entry)
        const dir = owner && owner.id === id ? containedEntry(profilesRoot(), entry) : ''
        if (!dir) continue
        const file = path.join(dir, '.env')
        const stat = lstatOrNull(file)
        if (!stat || stat.isDirectory()) continue
        try {
            fs.unlinkSync(file)
            cleanupHooks.log(`[harness] removed profiles/${entry}/.env of harness "${id}"`)
        } catch (error) {
            failed = failed || error
            cleanupHooks.log(`[harness] could not remove profiles/${entry}/.env: ${error?.code || error?.name || 'error'}`)
        }
    }
    return failed
}

// The entries whose runtime is confirmed stopped. Any other entry stays for a later run.
async function closeRuntime(id, entries) {
    const fn = cleanupHooks.close || stopRuntimeProfile
    const stopped = new Set()
    for (const entry of entries) {
        let ok = false
        try {
            ok = (await fn(entry)) !== false
        } catch {
            ok = false
        }
        if (ok) stopped.add(entry)
        else cleanupHooks.log(`[harness] kept profiles/${entry} of harness "${id}": its runtime could not be confirmed stopped`)
    }
    return stopped
}

// Revokes the tokens, then removes each entry. Returns the removed entries.
// Refuses when the harness is still saved. A revocation failure removes nothing.
async function removeOwned(id, entries, { reason, trash = [], minAgeMs = 0, now = Date.now, revoked = false } = {}) {
    if (stillSaved(id, savedNames())) {
        cleanupHooks.log(`[harness] kept the profiles of harness "${id}": it is still saved or the store could not be read`)
        return { removed: [], kept: entries, error: null }
    }
    // The sweep removes only what is older than the cutoff, checked before anything is touched.
    const kept = []
    // Folders of another, saved harness: never touched, and not counted as left over for this one.
    const claimed = []
    const before = savedNames()
    entries = entries.filter((entry) => {
        if (!claimedBySaved(entry, before)) return true
        claimed.push(entry)
        cleanupHooks.log(`[harness] kept profiles/${entry}: a saved harness has this name`)
        return false
    })
    if (minAgeMs) {
        entries = entries.filter((entry) => {
            if (now() - newestChange(entry) >= minAgeMs) return true
            kept.push(entry)
            cleanupHooks.log(`[harness] kept profiles/${entry} of harness "${id}": it changed in the last 10 minutes`)
            return false
        })
    }
    try {
        // Scoped revocation names the parked profiles too, by the profile name they had before parking.
        const parkedNames = trash.map((entry) => PARKED_RE.exec(entry)?.[1]).filter((base) => base && !stillSaved(base, before))
        if (!revoked) revoke(id, [...entries, ...parkedNames], { harnessWide: !minAgeMs })
    } catch (error) {
        cleanupHooks.log(
            `[harness] removed nothing for harness "${id}" (${reason}): revoking its gateway tokens failed: ${error?.message || 'error'}`
        )
        return { removed: [], kept: entries, error }
    }
    const tokenError = dropTokenFiles(id, entries)
    if (tokenError) {
        cleanupHooks.log(`[harness] removed nothing more for harness "${id}" (${reason}): a token file could not be removed`)
        return { removed: [], kept: [...kept, ...entries], error: tokenError }
    }
    // What each profile looked like after cleanup's own change; a later change is someone else's and keeps it.
    const settled = new Map(entries.map((entry) => [entry, newestChange(entry)]))
    const removed = []
    let after = before
    for (const [index, entry] of entries.entries()) {
        after = savedNames()
        if (stillSaved(id, after)) {
            cleanupHooks.log(`[harness] kept the profiles of harness "${id}": it was saved again during cleanup`)
            kept.push(...entries.slice(index))
            break
        }
        const owner = profileOwner(entry)
        if (claimedBySaved(entry, after)) {
            claimed.push(entry)
            cleanupHooks.log(`[harness] kept profiles/${entry}: a saved harness has this name`)
            continue
        }
        if (!owner || owner.id !== id || (minAgeMs && newestChange(entry) > settled.get(entry))) {
            kept.push(entry)
            cleanupHooks.log(`[harness] kept profiles/${entry}: it changed during cleanup`)
            continue
        }
        const beforeStop = newestChange(entry)
        // Parked first, then stopped, then removed: once out of profiles/ the runtime cannot serve it again.
        const afterPark = async (parkedDir) => {
            const stopped = await closeRuntime(id, [entry])
            if (!stopped.has(entry)) return false
            if (stillSaved(id, savedNames())) {
                cleanupHooks.log(`[harness] kept profiles/${entry} of harness "${id}": it was saved again during cleanup`)
                return false
            }
            if (minAgeMs) {
                const work = containedEntry(workspacesRoot(), entry)
                const changed = Math.max(parkedDir ? newestTreeChange(parkedDir) : 0, work ? newestTreeChange(work) : 0)
                if (changed > beforeStop) {
                    cleanupHooks.log(`[harness] kept profiles/${entry}: it changed during cleanup`)
                    return false
                }
            }
            // A workspace that is there but could not be removed (a linked or foreign root) keeps the profile, whose
            // markers are what lets a later run find the workspace again.
            if (removeEntry(workspacesRoot(), entry)) {
                cleanupHooks.log(`[harness] removed workspaces/${entry} of harness "${id}" (${reason})`)
                return true
            }
            if (lstatOrNull(path.join(workspacesRoot(), entry))) {
                cleanupHooks.log(`[harness] kept profiles/${entry} of harness "${id}": its workspace could not be removed`)
                return false
            }
            return true
        }
        try {
            const outcome = await removeProfileEntry(entry, afterPark)
            if (outcome === true) {
                removed.push(entry)
                cleanupHooks.log(`[harness] removed profiles/${entry} of harness "${id}" (${reason})`)
            } else {
                kept.push(entry)
            }
        } catch (error) {
            kept.push(entry)
            cleanupHooks.log(`[harness] could not remove profiles/${entry} of harness "${id}": ${error?.code || error?.name || 'error'}`)
        }
    }
    after = savedNames()
    for (const item of trash) {
        const base = PARKED_RE.exec(item)?.[1] || ''
        if (base && stillSaved(base, after)) continue
        // A profile parked by a run that stopped before its runtime stop goes through the same steps as one in
        // profiles/: its runtime is stopped first, then its workspace goes, then the parked copy.
        const parkedDir = checkedTrashRoot() ? path.join(checkedTrashRoot(), item) : ''
        if (base && parkedDir && lstatOrNull(parkedDir)) {
            const stopped = await closeRuntime(id, [base])
            if (!stopped.has(base)) {
                kept.push(`${TRASH}/${item}`)
                cleanupHooks.log(`[harness] kept ${TRASH}/${item}: its runtime was not confirmed stopped`)
                continue
            }
            if (stillSaved(id, savedNames()) || stillSaved(base, savedNames())) continue
            // The parked copy is checked again before anything goes: one that changed while its runtime was stopping
            // keeps its workspace too.
            const trashRoot = checkedTrashRoot()
            if (!trashRoot || trashOwner(trashRoot, item) !== id || (minAgeMs && now() - newestChange(item, trashRoot) < minAgeMs)) {
                kept.push(`${TRASH}/${item}`)
                cleanupHooks.log(`[harness] kept ${TRASH}/${item}: it changed during cleanup`)
                continue
            }
            // The workspace is left to a profile now in profiles/ under the same name.
            if (!lstatOrNull(path.join(profilesRoot(), base))) {
                const work = containedEntry(workspacesRoot(), base)
                if (work && minAgeMs && now() - newestTreeChange(work) < minAgeMs) {
                    kept.push(`${TRASH}/${item}`)
                    cleanupHooks.log(`[harness] kept ${TRASH}/${item}: its workspace changed in the last 10 minutes`)
                    continue
                }
                if (removeEntry(workspacesRoot(), base))
                    cleanupHooks.log(`[harness] removed workspaces/${base} of harness "${id}" (${reason})`)
                else if (lstatOrNull(path.join(workspacesRoot(), base))) {
                    kept.push(`${TRASH}/${item}`)
                    cleanupHooks.log(`[harness] kept ${TRASH}/${item}: its workspace could not be removed`)
                    continue
                }
            }
        }
        removeTrashEntry(id, item, { minAgeMs, now })
    }
    forgetCompiledProfile(id)
    return { removed, kept, claimed, error: null }
}

// Revokes the gateway tokens of a harness and its profiles. Throws when that fails.
// The compiled profile is forgotten too, so if the delete stops later and the harness stays, its next run compiles
// again and registers fresh tokens.
// From here until reopenHarness, no new published token of this harness is registered.
export function revokeHarness(name) {
    const id = assertHarnessName(name)
    closeHarnessTokens(id)
    try {
        revoke(id, profilesOf(id))
    } catch (error) {
        reopenHarnessTokens(id)
        throw error
    }
    forgetCompiledProfile(id)
}

// A delete that stopped after revokeHarness, or one that finished: the name may register tokens again.
// A profile compiled while the delete ran registered no tokens, so its cache entry is dropped here and the next
// run of a harness saved meanwhile compiles again with working tokens.
export function reopenHarness(name) {
    const id = assertHarnessName(name)
    reopenHarnessTokens(id)
    forgetCompiledProfile(id)
}

// Removes the profiles of one harness that has no store file. Safe to run again after a crash.
// revoked: the caller already revoked this harness's tokens (and would have stopped on a failure), so a second
// revocation cannot fail after the caller has removed the store record.
// expected: profile names the harness about to be saved compiles into (fitted tryx names included), checked too.
export async function removeHarnessProfiles(name, { reason = 'harness deleted', revoked = false, expected = [] } = {}) {
    const id = assertHarnessName(name)
    const trash = trashEntries()
        .filter((item) => item.id === id)
        .map((item) => item.entry)
    const outcome = await removeOwned(id, profilesOf(id), { reason, trash, revoked })
    // Anything a new harness with this name would compile into and that cleanup could not attribute or remove
    // (a linked root or entry, a workspace without its profile) is a leftover too, so the name is not reused over it.
    const blockers = nameReuseBlockers(id, { expected }).filter((item) => !outcome.kept.includes(item.replace(/^profiles\//, '')))
    for (const item of blockers) cleanupHooks.log(`[harness] left over for harness "${id}": ${item}`)
    return blockers.length ? { ...outcome, kept: [...outcome.kept, ...blockers] } : outcome
}

// Paths a harness saved under this name would compile into (profile names are lowercased, specialists and fitted
// hashes come after "--") that are still there after cleanup: a profiles or workspaces root that is not a plain
// directory, any profile entry not owned by another harness (a linked one, one whose markers are missing, unreadable
// or conflicting, one cleanup kept), and a workspace whose profile is gone or is not another harness's.
// Entries of a saved harness are skipped, except an exact output path of this harness owned by another one, which blocks.
export function nameReuseBlockers(name, { expected = [] } = {}) {
    const id = assertHarnessName(name)
    const lower = id.toLowerCase()
    const saved = savedNames()
    const blockers = []
    const exact = new Set(expected.map((entry) => String(entry).toLowerCase()))
    const mine = (entry) => {
        const low = entry.toLowerCase()
        return low === lower || low.startsWith(`${lower}--`) || exact.has(low)
    }
    const otherHarness = (entry) => {
        const owner = profileOwner(entry)
        return Boolean(owner) && owner.id.toLowerCase() !== lower
    }
    const destinations = new Set([lower, ...exact])
    const foreign = (entry) => {
        const low = entry.toLowerCase()
        if (otherHarness(entry)) return true
        // A saved harness of another name whose home is this entry, or whose roster this profile carries.
        if (low !== lower && stillSaved(entry, saved)) return true
        const dir = containedEntry(profilesRoot(), entry)
        const roster = dir ? rosterName(dir) : ''
        if (roster && roster.toLowerCase() !== lower && stillSaved(roster, saved)) return true
        return false
    }
    for (const [label, root] of [
        ['profiles', profilesRoot()],
        ['workspaces', workspacesRoot()]
    ]) {
        if (!lstatOrNull(root)) continue
        if (!realDir(root)) {
            blockers.push(`${label} (not a plain directory)`)
            continue
        }
        let names = []
        try {
            names = fs.readdirSync(root).sort()
        } catch {
            blockers.push(`${label} (could not be read)`)
            continue
        }
        for (const entry of names) {
            if (!mine(entry)) continue
            // An exact output path of this harness (its home or a specialist profile it compiles into) that belongs to
            // another harness, saved or not, blocks the save: compiling would write into that harness's profile.
            if (destinations.has(entry.toLowerCase()) && lstatOrNull(path.join(root, entry)) && foreign(entry)) {
                blockers.push(`${label}/${entry} (belongs to another harness)`)
                continue
            }
            if (claimedBySaved(entry, saved, root)) continue
            if (!lstatOrNull(path.join(root, entry))) continue
            if (label === 'profiles') {
                if (!otherHarness(entry)) blockers.push(`profiles/${entry}`)
                continue
            }
            if (lstatOrNull(path.join(profilesRoot(), entry)) && otherHarness(entry)) continue
            blockers.push(`workspaces/${entry}`)
        }
    }
    return blockers
}

// The harness delete: tokens are revoked first (a failure keeps the store file and every profile),
// then the store file goes, then the profiles. A rerun after a crash finishes what is left.
export async function deleteHarnessAndProfiles(name, { revoked = false } = {}) {
    const id = assertHarnessName(name)
    try {
        if (!revoked) revokeHarness(id)
    } catch (error) {
        cleanupHooks.log(`[harness] removed nothing for harness "${id}": revoking its gateway tokens failed: ${error?.message || 'error'}`)
        throw new HarnessError(
            'cleanup_failed',
            `Harness "${id}" was not deleted, because its gateway tokens could not be revoked. Try again.`
        )
    }
    deleteHarness(id)
    try {
        return await removeHarnessProfiles(id, { revoked: true })
    } finally {
        reopenHarness(id)
    }
}

export function orphanSweepMode(env = process.env) {
    return env[ORPHAN_SWEEP_ENV] === 'delete' ? 'delete' : 'log'
}

// Profiles whose harness has no store file. Logs them; removes them only when CUTTLELY_HARNESS_ORPHAN_SWEEP=delete.
// Anything changed in the last 10 minutes, try profiles and profiles of a saved harness stay.
export async function sweepOrphanHarnessProfiles({ mode = orphanSweepMode(), now = Date.now() } = {}) {
    const root = profilesRoot()
    const result = { mode, orphans: [], removed: [], skipped: [] }
    const started = Date.now()
    if (!realDir(root)) return result
    const saved = savedNames()
    if (!saved) {
        cleanupHooks.log('[harness] orphan profile sweep skipped: the harness store could not be read')
        return result
    }
    const groups = new Map()
    for (const entry of fs.readdirSync(root).sort()) {
        const owner = profileOwner(entry)
        // Dry run and delete agree: a folder of a saved harness is not an orphan, whatever its marker says.
        if (!owner || stillSaved(owner.id, saved) || claimedBySaved(entry, saved)) continue
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
    for (const item of trashEntries()) {
        if (stillSaved(item.id, saved)) continue
        if (now - newestChange(item.entry, checkedTrashRoot()) < ORPHAN_SWEEP_MIN_AGE_MS) continue
        if (!groups.has(item.id)) groups.set(item.id, [])
        const list = groups.get(item.id)
        list.trash = [...(list.trash || []), item.entry]
    }
    for (const [id, list] of groups) {
        const entries = [...list.filter((item) => item.kind === 'child'), ...list.filter((item) => item.kind === 'home')].map(
            (item) => item.entry
        )
        result.orphans.push(...entries.map((entry) => ({ id, entry })))
        if (mode !== 'delete') {
            for (const entry of list.trash || []) {
                cleanupHooks.log(`[harness] orphan profile sweep (dry run): would remove ${TRASH}/${entry} of harness "${id}"`)
            }
            for (const entry of entries) {
                cleanupHooks.log(
                    `[harness] orphan profile sweep (dry run): would remove profiles/${entry} of harness "${id}". Set ${ORPHAN_SWEEP_ENV}=delete to remove it`
                )
            }
            continue
        }
        const outcome = await removeOwned(id, entries, {
            reason: 'orphan sweep',
            trash: list.trash || [],
            minAgeMs: ORPHAN_SWEEP_MIN_AGE_MS,
            now: () => now + (Date.now() - started)
        })
        result.removed.push(...outcome.removed)
    }
    return result
}
