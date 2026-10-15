// One settings change at a time, including from another process in this install.
// A lock older than 15 seconds is dropped: a crash must not block the next save.
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

function lockPath(dir: string, name: string): string {
    return path.join(dir, name)
}

function take(dir: string, name: string): boolean {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = lockPath(dir, name)
    try {
        const fd = fs.openSync(file, 'wx', 0o600)
        fs.closeSync(fd)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
            if (Date.now() - fs.statSync(file).mtimeMs > STALE_MS) {
                fs.rmSync(file, { force: true })
                return take(dir, name)
            }
        } catch {
            // The other process released it. Try once more on the next loop.
        }
        return false
    }
}

function release(dir: string, name: string): void {
    try {
        fs.rmSync(lockPath(dir, name), { force: true })
    } catch {
        // Already gone.
    }
}

function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function pauseSync(ms: number): void {
    const buffer = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(buffer, 0, 0, ms)
}

async function acquire(dir: string, name: string): Promise<void> {
    const started = Date.now()
    for (;;) {
        if (take(dir, name)) return
        if (Date.now() - started > WAIT_MS) throw new SettingsBusyError()
        await pause(20)
    }
}

function acquireSync(dir: string, name: string): void {
    const started = Date.now()
    for (;;) {
        if (take(dir, name)) return
        if (Date.now() - started > WAIT_MS) throw new SettingsBusyError()
        pauseSync(20)
    }
}

/** A named lock in the settings folder. Callers that take two locks take the settings lock first. */
export async function withNamedLock<T>(dir: string, name: string, work: () => Promise<T>): Promise<T> {
    await acquire(dir, name)
    try {
        return await work()
    } finally {
        release(dir, name)
    }
}

export function withNamedLockSync<T>(dir: string, name: string, work: () => T): T {
    acquireSync(dir, name)
    try {
        return work()
    } finally {
        release(dir, name)
    }
}

export async function withSettingsLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
    return withNamedLock(dir, SETTINGS_LOCK, work)
}

export function withSettingsLockSync<T>(dir: string, work: () => T): T {
    return withNamedLockSync(dir, SETTINGS_LOCK, work)
}
