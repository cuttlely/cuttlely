// An in-flight canvas try is recorded on disk so a second process (the external worker)
// does not treat it as a crash leftover. The in-memory set is only a same-process hint.
import fs from 'node:fs'
import path from 'node:path'
import { hermesHome } from './paths.mjs'

const live = new Set()

export const TRY_LOCK_NAME = 'try.lock'
// A turn is far shorter than this. A lock older than it is a leftover even when the pid was reused.
export const TRY_LOCK_MAX_AGE_MS = 30 * 60 * 1000

function lockFile(name) {
    return path.join(hermesHome(), 'profiles', name, TRY_LOCK_NAME)
}

export function noteLiveTry(name) {
    if (!name) return
    live.add(name)
    const file = lockFile(name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = JSON.stringify({ pid: process.pid, at: Date.now() })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
}

export function endLiveTry(name) {
    if (!name) return
    live.delete(name)
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

// A lock protects the try only while its owner is alive and the file is inside the age bound.
export function tryLockIsLive(name) {
    if (!name) return false
    let parsed
    try {
        parsed = JSON.parse(fs.readFileSync(lockFile(name), 'utf8'))
    } catch {
        return false
    }
    const at = Number(parsed?.at)
    if (!Number.isFinite(at) || Date.now() - at > TRY_LOCK_MAX_AGE_MS) return false
    return pidAlive(Number(parsed.pid))
}

export function isLiveTry(name) {
    return tryLockIsLive(name)
}
