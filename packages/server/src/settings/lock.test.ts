import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SettingsBusyError, withNamedLock, withNamedLockSync } from './lock'

const NAME = 'settings.lock'

function folder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-lock-'))
}

function writeLock(dir: string, body: unknown, mtimeMs?: number): string {
    const file = path.join(dir, NAME)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
    if (mtimeMs !== undefined) {
        const seconds = mtimeMs / 1000
        fs.utimesSync(file, seconds, seconds)
    }
    return file
}

function exited(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve) => child.once('exit', () => resolve()))
}

describe('settings lock owner', () => {
    it('removes its own lock when the work finishes', () => {
        const dir = folder()
        const file = path.join(dir, NAME)
        withNamedLockSync(dir, NAME, () => {
            const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { token: string; pid: number }
            expect(owner.pid).toBe(process.pid)
            expect(owner.token.length).toBeGreaterThan(0)
        })
        expect(fs.existsSync(file)).toBe(false)
    })

    it('does not remove a lock it no longer owns', async () => {
        const dir = folder()
        const file = path.join(dir, NAME)
        await withNamedLock(dir, NAME, async () => {
            fs.writeFileSync(file, JSON.stringify({ token: 'other', pid: process.pid }))
        })
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ token: 'other', pid: process.pid })
    })

    it('takes a lock whose process is gone', async () => {
        const dir = folder()
        const child = spawn('sleep', ['30'])
        const pid = child.pid as number
        child.kill('SIGKILL')
        await exited(child)
        const file = writeLock(dir, { token: 'dead', pid })
        let ran = false
        await withNamedLock(dir, NAME, async () => {
            ran = true
            const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { token: string; pid: number }
            expect(owner.token).not.toBe('dead')
            expect(owner.pid).toBe(process.pid)
        })
        expect(ran).toBe(true)
        expect(fs.existsSync(file)).toBe(false)
    })

    it('leaves a live process its lock, including one older than 15 seconds', async () => {
        const dir = folder()
        const child = spawn('sleep', ['30'])
        const pid = child.pid as number
        try {
            const file = writeLock(dir, { token: 'live', pid }, Date.now() - 60_000)
            await expect(withNamedLock(dir, NAME, async () => undefined)).rejects.toBeInstanceOf(SettingsBusyError)
            expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ token: 'live', pid })
        } finally {
            child.kill('SIGKILL')
        }
    }, 15000)

    it('takes an old lock that records no owner', async () => {
        const dir = folder()
        const file = writeLock(dir, '', Date.now() - 60_000)
        let ran = false
        await withNamedLock(dir, NAME, async () => {
            ran = true
        })
        expect(ran).toBe(true)
        expect(fs.existsSync(file)).toBe(false)
    })

    it('does not take a fresh lock that has no owner yet', async () => {
        const dir = folder()
        const file = writeLock(dir, '')
        await expect(withNamedLock(dir, NAME, async () => undefined)).rejects.toBeInstanceOf(SettingsBusyError)
        expect(fs.readFileSync(file, 'utf8')).toBe('')
    }, 15000)
})
