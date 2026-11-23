// Stops the MCP bridge processes the runtime started for canvas try profiles.
// The runtime starts each stdio MCP server for a profile, and a try profile is deleted after its turn. A bridge
// that outlives the profile keeps running from the deleted folder, so teardown stops the try's bridges first,
// and a sweep (before the runtime starts and on a timer) stops any try bridge whose profile folder is gone or
// whose runtime is no longer running. Published profiles are never matched: only try entry names are.
// Linux only (it reads /proc). Elsewhere every call finds nothing.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, harnessStoreDir, hermesHome } from './paths.mjs'

// The marker each try profile's MCP blocks carry in their env. Children of a bridge inherit it.
export const TRY_PROFILE_DIR_ENV = 'CUTTLELY_TRY_PROFILE_DIR'
const TRY_ENTRY = /^(?:try[a-f0-9]{8,32}(?:--[A-Za-z0-9_-]{1,128})?|tryx[a-f0-9]{16})$/
const RUNTIME_CMD = 'cuttlely-hermes-api.py'
export const TRY_BRIDGE_STOP_GRACE_MS = 2000
export const TRY_BRIDGE_SWEEP_MS = 60 * 1000
const POLL_MS = 25

export function isTryEntry(entry) {
    return TRY_ENTRY.test(String(entry || ''))
}

function tryHomeOf(entry) {
    return String(entry).startsWith('tryx') ? '' : String(entry).split('--')[0]
}

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return ''
    }
}

function readStat(pid) {
    const stat = readText(`/proc/${pid}/stat`)
    const close = stat.lastIndexOf(')')
    if (close === -1) return null
    const rest = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/)
    // rest[0] is the state, then ppid, pgrp.
    if (rest[0] === 'Z' || rest[0] === 'X') return null
    return { ppid: Number(rest[1]), pgid: Number(rest[2]) }
}

function readEnv(pid) {
    const env = {}
    for (const pair of readText(`/proc/${pid}/environ`).split('\0')) {
        const split = pair.indexOf('=')
        if (split > 0) env[pair.slice(0, split)] = pair.slice(split + 1)
    }
    return env
}

function readCwd(pid) {
    try {
        const link = fs.readlinkSync(`/proc/${pid}/cwd`)
        const deleted = link.endsWith(' (deleted)')
        return { cwd: deleted ? link.slice(0, -' (deleted)'.length) : link, deleted }
    } catch {
        return { cwd: '', deleted: false }
    }
}

function entryUnder(root, file) {
    if (!file) return ''
    const rel = path.relative(root, path.resolve(file))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
    return rel.split(path.sep)[0]
}

// Every live process on this host, with the try entry it belongs to (empty when it is not a try bridge of this home).
export function listProcesses() {
    let pids
    try {
        pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
    } catch {
        return []
    }
    const profiles = path.resolve(hermesHome(), 'profiles')
    const workspaces = path.resolve(dataRoot(), 'workspaces')
    const home = path.resolve(hermesHome())
    const out = []
    for (const name of pids) {
        const pid = Number(name)
        const stat = readStat(pid)
        if (!stat) continue
        const cmdline = readText(`/proc/${pid}/cmdline`).split('\0').filter(Boolean)
        const proc = { pid, ...stat, cmdline, entry: '', cwdDeleted: false }
        out.push(proc)
        if (pid === process.pid) continue
        const env = readEnv(pid)
        const { cwd, deleted } = readCwd(pid)
        let entry = entryUnder(profiles, env[TRY_PROFILE_DIR_ENV])
        const marked = Boolean(entry)
        if (!entry && env.CUTTLELY_HARNESS_PROFILE_ENV) entry = entryUnder(profiles, env.CUTTLELY_HARNESS_PROFILE_ENV)
        // The chief's roster bridge names its profile on the command line.
        if (!entry && env.CUTTLELY_HERMES_HOME && path.resolve(env.CUTTLELY_HERMES_HOME) === home) {
            const at = cmdline.indexOf('--harness')
            if (at !== -1 && cmdline.some((arg) => arg.endsWith(`${path.sep}roster-mcp.mjs`))) entry = cmdline[at + 1] || ''
        }
        if (!entry) entry = entryUnder(profiles, cwd) || entryUnder(workspaces, cwd)
        if (!isTryEntry(entry) || !(marked || tryOwned(entry))) continue
        proc.entry = entry
        proc.cwdDeleted = deleted
    }
    return out
}

// A published harness can have a try-like profile name (an older saved name, or a long name's tryx specialist).
// Only the env marker, which only try profiles carry, or try markers on disk make a process a try process. An
// unmarked one whose folder is gone counts only for a try home that no saved harness owns.
function tryOwned(entry) {
    const profiles = path.join(hermesHome(), 'profiles')
    const home = tryHomeOf(entry)
    if (fs.existsSync(path.join(profiles, entry))) {
        if (/^CUTTLELY_GATEWAY_TRY=1$/m.test(readText(path.join(profiles, entry, '.env')))) return true
        return Boolean(home) && readText(path.join(profiles, home, 'harness-try')).trim() === home
    }
    if (!home) return false
    const store = harnessStoreDir()
    return !fs.existsSync(path.join(store, `${home}.json`)) && !fs.existsSync(path.join(store, `${home}.json.deleting`))
}

function ownAncestors(procs) {
    const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
    const mine = new Set([process.pid])
    let at = byPid.get(process.pid)
    while (at && at.ppid > 1 && !mine.has(at.ppid)) {
        mine.add(at.ppid)
        at = byPid.get(at.ppid)
    }
    return mine
}

function alive(pid) {
    return readStat(pid) !== null
}

function signal(target, sig) {
    try {
        process.kill(target, sig)
    } catch {
        // Already gone, or not ours.
    }
}

// Signals whole process groups when every member of the group is one of the targets (the runtime starts each
// stdio server in its own group), otherwise only the target pids. Never this process, its parents, or pid 1.
function signalTargets(procs, targets, sig) {
    const keep = ownAncestors(procs)
    const ids = new Set(targets.map((proc) => proc.pid))
    const groups = new Set(targets.map((proc) => proc.pgid))
    for (const pgid of groups) {
        const members = procs.filter((proc) => proc.pgid === pgid)
        const wholeGroup = pgid > 1 && members.every((proc) => ids.has(proc.pid) && !keep.has(proc.pid))
        if (wholeGroup) signal(-pgid, sig)
        else for (const proc of members) if (ids.has(proc.pid) && !keep.has(proc.pid) && proc.pid > 1) signal(proc.pid, sig)
    }
}

// The processes to stop plus all their descendants (a child of a bridge that changed its cwd or dropped the env
// still goes), and every other try process in their groups. Never this process or its parents.
function withGroupPeers(procs, targets) {
    const keep = ownAncestors(procs)
    const children = new Map()
    for (const proc of procs) {
        if (!children.has(proc.ppid)) children.set(proc.ppid, [])
        children.get(proc.ppid).push(proc)
    }
    const groups = new Set(targets.map((proc) => proc.pgid))
    const out = new Map()
    const add = (proc) => {
        if (out.has(proc.pid) || keep.has(proc.pid) || proc.pid <= 1) return
        out.set(proc.pid, proc)
        for (const child of children.get(proc.pid) || []) add(child)
    }
    for (const proc of targets) add(proc)
    for (const proc of procs) if (proc.entry && groups.has(proc.pgid)) add(proc)
    return [...out.values()]
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

// SIGTERM, a bounded wait for every process to exit, then SIGKILL and a short wait. Returns the pids still alive.
async function stopProcesses(procs, targets, graceMs, wait = sleep) {
    if (!targets.length) return []
    const all = withGroupPeers(procs, targets)
    signalTargets(procs, all, 'SIGTERM')
    let deadline = Date.now() + graceMs
    let left = all.filter((proc) => alive(proc.pid))
    while (left.length && Date.now() < deadline) {
        await wait(POLL_MS)
        left = left.filter((proc) => alive(proc.pid))
    }
    if (!left.length) return []
    signalTargets(procs, left, 'SIGKILL')
    deadline = Date.now() + 1000
    while (left.length && Date.now() < deadline) {
        await wait(POLL_MS)
        left = left.filter((proc) => alive(proc.pid))
    }
    return left.map((proc) => proc.pid)
}

// Stops every MCP bridge (and its process group) of these try entries, or of any entry under these try homes.
// Called before the try's folders are removed. Idempotent: no process left means nothing to do.
export async function stopTryProfileBridges(entries, { graceMs = TRY_BRIDGE_STOP_GRACE_MS } = {}) {
    const names = new Set((entries || []).filter(isTryEntry))
    if (!names.size) return { stopped: [], left: [] }
    const homes = new Set([...names].map(tryHomeOf).filter(Boolean))
    const procs = listProcesses()
    const targets = procs.filter((proc) => proc.entry && (names.has(proc.entry) || homes.has(tryHomeOf(proc.entry))))
    const left = await stopProcesses(procs, targets, graceMs, sleep)
    return { stopped: targets.map((proc) => proc.pid), left }
}

// The try entries, and their try homes, that still have a running bridge. Folder sweeps skip them.
export function tryEntriesWithBridges() {
    const out = new Set()
    if (process.platform !== 'linux') return out
    for (const proc of listProcesses()) {
        if (!proc.entry) continue
        out.add(proc.entry)
        const home = tryHomeOf(proc.entry)
        if (home) out.add(home)
    }
    return out
}

function recordedRuntimePid() {
    const text = readText(path.join(hermesHome(), 'gateway.pid')).trim()
    if (!text) return 0
    try {
        const parsed = JSON.parse(text)
        return Number.parseInt(typeof parsed === 'object' && parsed ? parsed.pid : parsed, 10) || 0
    } catch {
        return Number.parseInt(text, 10) || 0
    }
}

// A try bridge is owned while a running runtime is one of its ancestors. One the runtime left behind is
// re-parented to pid 1, tini or another subreaper, which is not a runtime. Any ancestor whose command line names
// hermes counts as a runtime, so a runtime started another way keeps its bridges.
function ownedByRuntime(procs, proc) {
    const byPid = new Map(procs.map((item) => [item.pid, item]))
    const runtimePid = recordedRuntimePid()
    const seen = new Set()
    let at = byPid.get(proc.ppid)
    while (at && !seen.has(at.pid)) {
        seen.add(at.pid)
        if (at.pid === runtimePid || at.cmdline.some((arg) => arg.endsWith(RUNTIME_CMD) || /hermes/i.test(arg))) return true
        if (at.pid <= 1) return false
        at = byPid.get(at.ppid)
    }
    return false
}

function orphanTargets(procs) {
    const profiles = path.join(hermesHome(), 'profiles')
    return procs.filter((proc) => {
        if (!proc.entry) return false
        if (proc.cwdDeleted || !fs.existsSync(path.join(profiles, proc.entry))) return true
        // Its runtime is gone (killed mid-turn, for example), even if the try turn in the server is still waiting.
        return !ownedByRuntime(procs, proc)
    })
}

// Stops try bridges whose profile folder is gone, whose working folder was deleted, or whose runtime is not
// running any more. A bridge of a try profile that still exists under a running runtime stays, and a descendant
// of a stopped bridge goes with it.
export async function sweepOrphanTryBridges({ graceMs = TRY_BRIDGE_STOP_GRACE_MS } = {}) {
    const procs = listProcesses()
    const targets = orphanTargets(procs)
    const left = await stopProcesses(procs, targets, graceMs, sleep)
    return { stopped: targets.map((proc) => proc.pid), left }
}
