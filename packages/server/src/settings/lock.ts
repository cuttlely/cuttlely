// One settings change at a time, including from another process in this install.
// The lock file records an owner token and the process id. release removes the file only when that token is still
// the owner, so a writer that finishes cannot delete a lock another process has taken. A lock is taken over only
// when its process is not alive. A file with no process id is taken over after 15 seconds, which covers a crash
// that left the previous empty lock behind.
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'

const SETTINGS_LOCK = '.settings.lock'
const STALE_MS = 15000
const WAIT_MS = 5000

export class SettingsBusyError extends Error {
    constructor() {
        super('Another settings change is still being saved.')
        this.name = 'SettingsBusyError'
    }
}

interface LockOwner {
    token: string
    pid: number
}

function lockPath(dir: string, name: string): string {
    return path.join(dir, name)
}

function ownerOf(raw: string): LockOwner | null {
    try {
        const parsed = JSON.parse(raw) as { token?: unknown; pid?: unknown }
        if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null
        if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
        return { token: parsed.token, pid: parsed.pid }
    } catch {
        return null
    }
}

/** A process that can still be in the critical section. A zombie has exited and is not holding the lock. */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const state = stat
            .slice(stat.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)[0]
        if (state === 'Z') return false
    } catch {
        // No /proc on this host, or the process exited between the checks.
    }
    return true
}

function olderThan(file: string, ms: number): boolean {
    try {
        return Date.now() - fs.statSync(file).mtimeMs > ms
    } catch {
        return false
    }
}

function stale(file: string): boolean {
    let raw = ''
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch {
        return false
    }
    const owner = ownerOf(raw)
    if (owner) return !pidAlive(owner.pid)
    return olderThan(file, STALE_MS)
}

/** Removes a stale lock only when the path still names the file that was stale. */
function breakStale(file: string): boolean {
    let raw = ''
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch {
        return false
    }
    if (!stale(file)) return false
    let fd: number
    try {
        fd = fs.openSync(file, 'r')
    } catch {
        return false
    }
    try {
        const now = fs.readFileSync(fd, 'utf8')
        if (now !== raw || !stale(file)) return false
        const held = fs.fstatSync(fd)
        const linked = fs.statSync(file)
        if (held.ino !== linked.ino || held.dev !== linked.dev) return false
        fs.rmSync(file, { force: true })
        return true
    } catch {
        return false
    } finally {
        try {
            fs.closeSync(fd)
        } catch {
            // The file is already gone.
        }
    }
}

function take(dir: string, name: string): string | null {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = lockPath(dir, name)
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = randomBytes(16).toString('hex')
        try {
            const fd = fs.openSync(file, 'wx', 0o600)
            try {
                fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid }))
            } finally {
                fs.closeSync(fd)
            }
            return token
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (!breakStale(file)) return null
        }
    }
    return null
}

function release(dir: string, name: string, token: string): void {
    const file = lockPath(dir, name)
    let raw = ''
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch {
        return
    }
    const owner = ownerOf(raw)
    if (!owner || owner.token !== token) return
    let fd: number
    try {
        fd = fs.openSync(file, 'r')
    } catch {
        return
    }
    try {
        const now = fs.readFileSync(fd, 'utf8')
        if (now !== raw) return
        const held = fs.fstatSync(fd)
        const linked = fs.statSync(file)
        if (held.ino !== linked.ino || held.dev !== linked.dev) return
        const again = ownerOf(now)
        if (!again || again.token !== token) return
        fs.rmSync(file, { force: true })
    } catch {
        // Already gone, or it is no longer ours.
    } finally {
        try {
            fs.closeSync(fd)
        } catch {
            // The file is already gone.
        }
    }
}

function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function pauseSync(ms: number): void {
    const buffer = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(buffer, 0, 0, ms)
}

async function acquire(dir: string, name: string): Promise<string> {
    const started = Date.now()
    for (;;) {
        const token = take(dir, name)
        if (token) return token
        if (Date.now() - started > WAIT_MS) throw new SettingsBusyError()
        await pause(20)
    }
}

function acquireSync(dir: string, name: string): string {
    const started = Date.now()
    for (;;) {
        const token = take(dir, name)
        if (token) return token
        if (Date.now() - started > WAIT_MS) throw new SettingsBusyError()
        pauseSync(20)
    }
}

/** A named lock in the settings folder. Callers that take two locks take the settings lock first. */
export async function withNamedLock<T>(dir: string, name: string, work: () => Promise<T>): Promise<T> {
    const token = await acquire(dir, name)
    try {
        return await work()
    } finally {
        release(dir, name, token)
    }
}

export function withNamedLockSync<T>(dir: string, name: string, work: () => T): T {
    const token = acquireSync(dir, name)
    try {
        return work()
    } finally {
        release(dir, name, token)
    }
}

export async function withSettingsLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
    return withNamedLock(dir, SETTINGS_LOCK, work)
}

export function withSettingsLockSync<T>(dir: string, work: () => T): T {
    return withNamedLockSync(dir, SETTINGS_LOCK, work)
}
