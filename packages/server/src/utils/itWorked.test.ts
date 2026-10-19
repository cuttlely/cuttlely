import fs from 'fs'
import os from 'os'
import path from 'path'

const newTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-itworked-'))

describe('itWorked one-time log marker', () => {
    const ORIGINAL_ENV = { ...process.env }
    let dataDir: string

    beforeEach(() => {
        jest.resetModules()
        dataDir = newTempDir()
        process.env = { ...ORIGINAL_ENV, CUTTLELY_DATA_DIR: dataDir }
        delete process.env.CUTTLELY_DISABLE_IT_WORKED
    })

    afterEach(() => {
        process.env = ORIGINAL_ENV
        try {
            fs.rmSync(dataDir, { recursive: true, force: true })
        } catch {
            // ignore
        }
    })

    test('writes marker only once and creates no network calls', async () => {
        const info = jest.fn()
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info, error: jest.fn() }
        }))
        const http = require('http')
        const https = require('https')
        const fetchSpy = jest.spyOn(global as any, 'fetch' as any).mockImplementation(() => Promise.resolve({} as any))
        const httpSpy = jest.spyOn(http, 'request')
        const httpsSpy = jest.spyOn(https, 'request')

        const { maybeLogFirstSuccess } = await import('./itWorked')
        const marker = path.join(dataDir, 'settings', 'it-worked.json')
        expect(fs.existsSync(marker)).toBe(false)

        maybeLogFirstSuccess()
        expect(fs.existsSync(marker)).toBe(true)
        const first = fs.readFileSync(marker, 'utf8')
        expect(() => JSON.parse(first)).not.toThrow()
        expect(JSON.parse(first).shown).toBe(true)
        expect(info).toHaveBeenCalledTimes(1)

        // Second call should keep the marker as-is and not log again
        const mtime = fs.statSync(marker).mtimeMs
        maybeLogFirstSuccess()
        expect(fs.statSync(marker).mtimeMs).toBe(mtime)
        expect(info).toHaveBeenCalledTimes(1)

        // No network calls in this path
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(httpSpy).not.toHaveBeenCalled()
        expect(httpsSpy).not.toHaveBeenCalled()
        fetchSpy.mockRestore()
        httpSpy.mockRestore()
        httpsSpy.mockRestore()
    })

    test('sets the in-process flag from an existing marker without taking the lock', async () => {
        const settings = path.join(dataDir, 'settings')
        fs.mkdirSync(settings, { recursive: true })
        fs.writeFileSync(path.join(settings, 'it-worked.json'), JSON.stringify({ shown: true }) + '\n')

        const tryNamedLockSync = jest.fn()
        jest.doMock('../settings/lock', () => ({
            tryNamedLockSync
        }))
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), error: jest.fn() }
        }))

        const { maybeLogFirstSuccess } = await import('./itWorked')
        maybeLogFirstSuccess()
        maybeLogFirstSuccess()
        expect(tryNamedLockSync).not.toHaveBeenCalled()
    })

    test('returns immediately when the lock is already held', async () => {
        const tryNamedLockSync = jest.fn(() => undefined)
        jest.doMock('../settings/lock', () => ({
            tryNamedLockSync
        }))
        const info = jest.fn()
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info, error: jest.fn() }
        }))

        const { maybeLogFirstSuccess } = await import('./itWorked')
        maybeLogFirstSuccess()
        expect(tryNamedLockSync).toHaveBeenCalledWith(expect.any(String), '.it-worked.lock', expect.any(Function))
        expect(info).not.toHaveBeenCalled()
        expect(fs.existsSync(path.join(dataDir, 'settings', 'it-worked.json'))).toBe(false)
    })

    test('notifyFirstSuccess is fire-and-forget and never throws', async () => {
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), error: jest.fn() }
        }))
        const { notifyFirstSuccess } = await import('./itWorked')
        expect(() => notifyFirstSuccess()).not.toThrow()
    })

    test('respects CUTTLELY_DISABLE_IT_WORKED', async () => {
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), error: jest.fn() }
        }))
        process.env.CUTTLELY_DISABLE_IT_WORKED = 'true'
        const { maybeLogFirstSuccess } = await import('./itWorked')
        const marker = path.join(dataDir, 'settings', 'it-worked.json')
        maybeLogFirstSuccess()
        expect(fs.existsSync(marker)).toBe(false)
    })
})
