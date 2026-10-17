import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { appendHistory, historyKeepLimit, pageHistory, readHistory } from './history'
import { resetRuntimeLimitsForTests } from './runtime'
import { HISTORY_FILE, SETTINGS_FILE, writeSettingsFile } from './store'

const SECRET = 'pw-made-up-for-the-bakery-0001'

function folder(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-history-')), 'settings')
}

function row(to: string) {
    return { kind: 'save' as const, by: 'owner@example.com', changes: [{ key: 'LOG_LEVEL', from: '', to }] }
}

describe('settings history retention', () => {
    it('keeps the newest rows and drops the older ones', () => {
        const dir = folder()
        for (let i = 1; i <= 5; i++) appendHistory(dir, row(String(i)), 3)
        const entries = readHistory(dir, 10)
        expect(entries.map((entry) => entry.changes?.[0].to)).toEqual(['5', '4', '3'])
        expect(entries.map((entry) => entry.seq)).toEqual([5, 4, 3])
        const raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
        expect(raw.trim().split('\n')).toHaveLength(3)
        expect(raw).not.toContain('"to":"1"')
        expect(raw).not.toContain('"to":"2"')
    })

    it('still leaves a secret value out after the file is rewritten', () => {
        const dir = folder()
        appendHistory(dir, { kind: 'save', by: 'owner@example.com', changes: [{ key: 'WORKOS_API_KEY', from: '', to: SECRET }] }, 2)
        appendHistory(dir, row('next'), 2)
        const raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
        expect(raw).not.toContain(SECRET)
        expect(raw).toContain('"secret":"changed"')
    })

    it('trims to the saved limit when the caller does not pass one', () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-history-keep-'))
        const previousDir = process.env.CUTTLELY_DATA_DIR
        const previousKeep = process.env.CUTTLELY_HISTORY_KEEP
        process.env.CUTTLELY_DATA_DIR = data
        delete process.env.CUTTLELY_HISTORY_KEEP
        resetRuntimeLimitsForTests()
        try {
            const dir = path.join(data, 'settings')
            writeSettingsFile(dir, { CUTTLELY_HISTORY_KEEP: '100' }, { key: 'test-key-not-a-real-secret-0123456789abcdef' })
            resetRuntimeLimitsForTests()
            expect(historyKeepLimit()).toBe(100)
            for (let i = 1; i <= 101; i++) appendHistory(dir, row(String(i)))
            const entries = readHistory(dir, 200)
            expect(entries).toHaveLength(100)
            expect(entries[0].changes?.[0].to).toBe('101')
            expect(entries[99].changes?.[0].to).toBe('2')
            expect(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')).not.toContain('"to":"1"')
        } finally {
            if (previousDir === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = previousDir
            if (previousKeep === undefined) delete process.env.CUTTLELY_HISTORY_KEEP
            else process.env.CUTTLELY_HISTORY_KEEP = previousKeep
            resetRuntimeLimitsForTests()
        }
    })

    it('uses a cap saved after an older limit was cached', () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-history-stale-'))
        const previousDir = process.env.CUTTLELY_DATA_DIR
        const previousKeep = process.env.CUTTLELY_HISTORY_KEEP
        process.env.CUTTLELY_DATA_DIR = data
        delete process.env.CUTTLELY_HISTORY_KEEP
        resetRuntimeLimitsForTests()
        try {
            expect(historyKeepLimit()).toBe(1000)
            const dir = path.join(data, 'settings')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(
                path.join(dir, SETTINGS_FILE),
                JSON.stringify({ version: 1, values: { CUTTLELY_HISTORY_KEEP: '100' } }),
                'utf8'
            )
            for (let i = 1; i <= 101; i++) appendHistory(dir, row(String(i)))
            expect(readHistory(dir, 200)).toHaveLength(100)
            expect(readHistory(dir, 200)[0].changes?.[0].to).toBe('101')
        } finally {
            if (previousDir === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = previousDir
            if (previousKeep === undefined) delete process.env.CUTTLELY_HISTORY_KEEP
            else process.env.CUTTLELY_HISTORY_KEEP = previousKeep
            resetRuntimeLimitsForTests()
        }
    })

    it('returns an empty page when the cursor is older than every row still kept', () => {
        const dir = folder()
        for (let i = 1; i <= 5; i++) appendHistory(dir, row(String(i)), 3)
        const gone = pageHistory(dir, { limit: 50, cursor: 2 })
        expect(gone.entries).toEqual([])
        expect(gone.nextCursor).toBeNull()
        const still = pageHistory(dir, { limit: 50, cursor: 5 })
        expect(still.entries.map((entry) => entry.seq)).toEqual([4, 3])
    })

    it('drops a damaged line when it rewrites the file', () => {
        const dir = folder()
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
            path.join(dir, HISTORY_FILE),
            '{"at":"2020-01-01T00:00:00.000Z","kind":"save","seq":1,"changes":[{"key":"LOG_LEVEL","from":"","to":"kept"}]}\nnot-json\n',
            'utf8'
        )
        appendHistory(dir, row('2'), 10)
        const raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
        expect(raw).not.toContain('not-json')
        expect(raw).toContain('"to":"kept"')
        expect(readHistory(dir, 10)).toHaveLength(2)
    })

    it('does not drop a row that is still inside the cap when several appends overlap', async () => {
        const dir = folder()
        const markers = Array.from({ length: 12 }, (_, index) => `m${index}`)
        await appendInChildren(dir, markers, 12)
        const entries = readHistory(dir, 20)
        expect(entries).toHaveLength(12)
        expect(new Set(entries.map((entry) => entry.changes?.[0].to)).size).toBe(12)
        for (const line of fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8').trim().split('\n')) {
            expect(() => JSON.parse(line)).not.toThrow()
        }
    }, 60000)

    it('keeps the newest cap when overlapping appends are past that cap', async () => {
        const dir = folder()
        const markers = Array.from({ length: 12 }, (_, index) => `c${index}`)
        await appendInChildren(dir, markers, 4)
        const entries = readHistory(dir, 20)
        expect(entries).toHaveLength(4)
        const kept = entries.map((entry) => entry.changes?.[0].to)
        expect(new Set(kept).size).toBe(4)
        for (const marker of kept) expect(markers).toContain(marker)
        const seqs = entries.map((entry) => entry.seq ?? 0)
        expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
        expect(Math.min(...seqs)).toBe(Math.max(...seqs) - 3)
    }, 60000)
})

// Each child pays for ts-node and the settings modules before it can append. Loading two at a time keeps that CPU
// burst off the test files the suite runs alongside, and every append still starts together once all are loaded.
const LOADING = 2

async function appendInChildren(dir: string, markers: string[], keep: number): Promise<void> {
    const appends: Array<() => Promise<void>> = []
    for (let i = 0; i < markers.length; i += LOADING) {
        appends.push(...(await Promise.all(markers.slice(i, i + LOADING).map((marker) => loadChild(dir, marker, keep)))))
    }
    await Promise.all(appends.map((append) => append()))
}

// A child can die in the runtime, or be killed by a signal, while the suite is already busy. One more try is the same
// append, unless the first child wrote its row before it died.
const retryable = (error: Error) => /Fatal error|unreachable code|killed by/.test(error.message)

async function loadChild(dir: string, marker: string, keep: number): Promise<() => Promise<void>> {
    const append = await startChild(dir, marker, keep).catch((error: Error) => {
        if (!retryable(error)) throw error
        return startChild(dir, marker, keep)
    })
    return () =>
        append().catch(async (error: Error) => {
            if (!retryable(error)) throw error
            if (readHistory(dir, 1000).some((entry) => entry.changes?.[0].to === marker)) return
            return (await startChild(dir, marker, keep))()
        })
}

/** Resolves once the child has loaded history.ts. Calling the result makes it append and resolves when it exits. */
function startChild(dir: string, marker: string, keep: number): Promise<() => Promise<void>> {
    return new Promise((resolveReady, rejectReady) => {
        const historyFile = path.join(__dirname, 'history.ts')
        const code = `
        require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, target: 'ES2022' } })
        const { appendHistory } = require(${JSON.stringify(historyFile)})
        process.stdin.once('data', () => {
            appendHistory(process.argv[1], { kind: 'save', by: 'child', changes: [{ key: 'LOG_LEVEL', from: '', to: process.argv[2] }] }, Number(process.argv[3]))
            process.exit(0)
        })
        process.stdout.write('ready\\n')
    `
        const child = spawn(process.execPath, ['-e', code, dir, marker, String(keep)], {
            cwd: path.resolve(__dirname, '../..')
        })
        let err = ''
        let ready = false
        let settle: (error?: Error) => void = () => undefined
        const exited = new Promise<void>((resolve, reject) => {
            settle = (error) => (error ? reject(error) : resolve())
        })
        child.stdin.on('error', () => undefined)
        child.stderr.on('data', (chunk) => {
            err += String(chunk)
        })
        child.stdout.on('data', (chunk) => {
            if (ready || !String(chunk).includes('ready')) return
            ready = true
            resolveReady(() => {
                child.stdin.end('go\n')
                return exited
            })
        })
        child.on('exit', (code, signal) => {
            const error =
                code === 0
                    ? undefined
                    : new Error(signal ? `append killed by ${signal}${err ? `: ${err}` : ''}` : err || `append exited ${code}`)
            if (ready) settle(error)
            else rejectReady(error ?? new Error('append exited before it loaded'))
        })
    })
}
