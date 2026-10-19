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
        // Stub the server logger to avoid loading transports and external deps
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), error: jest.fn() }
        }))
        const http = require('http')
        const https = require('https')
        const fetchSpy = jest.spyOn(global as any, 'fetch' as any).mockImplementation(() => Promise.resolve({} as any))
        const httpSpy = jest.spyOn(http, 'request')
        const httpsSpy = jest.spyOn(https, 'request')

        const { maybeLogFirstSuccess } = await import('./itWorked')
        const marker = path.join(dataDir, 'settings', 'it-worked.json')
        expect(fs.existsSync(marker)).toBe(false)

        await maybeLogFirstSuccess()
        expect(fs.existsSync(marker)).toBe(true)
        const first = fs.readFileSync(marker, 'utf8')
        expect(() => JSON.parse(first)).not.toThrow()
        expect(JSON.parse(first).shown).toBe(true)

        // Second call should keep the marker as-is
        const mtime = fs.statSync(marker).mtimeMs
        await maybeLogFirstSuccess()
        expect(fs.statSync(marker).mtimeMs).toBe(mtime)

        // No network calls in this path
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(httpSpy).not.toHaveBeenCalled()
        expect(httpsSpy).not.toHaveBeenCalled()
        fetchSpy.mockRestore()
        httpSpy.mockRestore()
        httpsSpy.mockRestore()
    })

    test('respects CUTTLELY_DISABLE_IT_WORKED', async () => {
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), error: jest.fn() }
        }))
        process.env.CUTTLELY_DISABLE_IT_WORKED = 'true'
        const { maybeLogFirstSuccess } = await import('./itWorked')
        const marker = path.join(dataDir, 'settings', 'it-worked.json')
        await maybeLogFirstSuccess()
        expect(fs.existsSync(marker)).toBe(false)
    })
})
