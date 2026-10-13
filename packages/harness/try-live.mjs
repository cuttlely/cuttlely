// An in-flight canvas try is recorded on disk so a second process (the external worker)
// does not treat it as a crash leftover. The lock names the owner pid and that process's
// start time, so a long turn stays live and a recycled pid does not.
import fs from 'node:fs'
import path from 'node:path'
import { hermesHome } from './paths.mjs'

const heartbeats = new Map()

export const TRY_LOCK_NAME = 'try.lock'
// Used only when the process start time cannot be read. A real owner refreshes `at` well inside this.
export const TRY_LOCK_MAX_AGE_MS = 30 * 60 * 1000
export const TRY_LOCK_HEARTBEAT_MS = 60 * 1000

function lockFile(name) {
    return path.join(hermesHome(), 'profiles', name, TRY_LOCK_NAME)
}

// Field 22 of /proc/<pid>/stat is starttime (clock ticks since boot). Empty when /proc is unavailable.
export function processStartTicks(pid) {
    const id = Number(pid)
    if (!Number.isInteger(id) || id <= 0) return ''
    try {
        const stat = fs.readFileSync(`/proc/${id}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        if (close === -1) return ''
        const rest = stat
            .slice(close + 2)
            .trim()
            .split(/\s+/)
        return rest[19] || ''
    } catch {
        return ''
    }
}

function writeLock(name, { create }) {
    const file = lockFile(name)
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) {
        if (!create) return
        fs.mkdirSync(dir, { recursive: true })
    } else if (!fs.lstatSync(dir).isDirectory()) return
    const body = JSON.stringify({ pid: process.pid, startedAt: processStartTicks(process.pid), at: Date.now() })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
}

export function noteLiveTry(name) {
    if (!name) return
    writeLock(name, { create: true })
    if (heartbeats.has(name)) return
    const timer = setInterval(() => {
        try {
            writeLock(name, { create: false })
        } catch {
            // The directory can disappear while the turn is ending.
        }
    }, TRY_LOCK_HEARTBEAT_MS)
    timer.unref?.()
    heartbeats.set(name, timer)
}

export function endLiveTry(name) {
    if (!name) return
    const timer = heartbeats.get(name)
    if (timer) clearInterval(timer)
    heartbeats.delete(name)
    try {
        fs.rmSync(lockFile(name), { force: true })
    } catch {
        // The directory may already be gone, or a tombstone file may occupy its name.
    }
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

function readLock(name) {
    try {
        return JSON.parse(fs.readFileSync(lockFile(name), 'utf8'))
    } catch {
        return null
    }
}

// Live while this pid is still the same process, at any age. A dead pid or a reused pid is not live.
// The age cap applies only when the start time cannot be read.
export function tryLockIsLive(name) {
    if (!name) return false
    const parsed = readLock(name)
    if (!parsed) return false
    const pid = Number(parsed.pid)
    if (!pidAlive(pid)) return false
    const recorded = String(parsed.startedAt || '')
    const current = processStartTicks(pid)
    if (recorded && current) return recorded === current
    const at = Number(parsed.at)
    if (!Number.isFinite(at)) return false
    return Date.now() - at <= TRY_LOCK_MAX_AGE_MS
}

export function isLiveTry(name) {
    return tryLockIsLive(name)
}
