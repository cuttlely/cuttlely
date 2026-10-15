import fs from 'fs'
import os from 'os'
import path from 'path'
import { settingFor } from './registry'
import {
    RUNTIME_CACHE_MS,
    invalidateRuntimeCache,
    parseRuntimeInteger,
    resetRuntimeLimitsForTests,
    runtimeConflict,
    runtimeNumber,
    runtimeSnapshot
} from './runtime'
import { writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'

function tempEnv() {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-runtime-'))
    return { data, env: { CUTTLELY_DATA_DIR: data } as Record<string, string | undefined> }
}

function save(data: string, values: Record<string, string>) {
    writeSettingsFile(path.join(data, 'settings'), values, { key: KEY })
}

beforeEach(() => {
    resetRuntimeLimitsForTests()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
})

describe('runtime limits', () => {
    it('keeps the cache at or under five seconds', () => {
        expect(RUNTIME_CACHE_MS).toBeLessThanOrEqual(5000)
    })

    it('uses the host value, then the panel, then the default', () => {
        const { data, env } = tempEnv()
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(2)
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_CONCURRENCY')?.source).toBe('default')
        save(data, { CUTTLELY_CHECK_CONCURRENCY: '4' })
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_CONCURRENCY')).toEqual({ value: 4, source: 'panel' })
        env.CUTTLELY_CHECK_CONCURRENCY = '6'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_CONCURRENCY')).toEqual({ value: 6, source: 'host' })
        expect(console.warn).not.toHaveBeenCalled()
    })

    it('ignores a bad host value and uses a valid panel value, then the default', () => {
        const { data, env } = tempEnv()
        save(data, { CUTTLELY_CHECK_MAX_SECONDS: '30' })
        env.CUTTLELY_CHECK_MAX_SECONDS = '5'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_MAX_SECONDS')).toEqual({ value: 30, source: 'panel' })
        env.CUTTLELY_CHECK_MAX_SECONDS = 'banana'
        resetRuntimeLimitsForTests()
        fs.rmSync(path.join(data, 'settings'), { recursive: true, force: true })
        expect(runtimeNumber('CUTTLELY_CHECK_MAX_SECONDS', env)).toBe(180)
        const warnings = (console.warn as jest.Mock).mock.calls.map((call) => String(call[0]))
        expect(warnings.some((line) => line.includes('CUTTLELY_CHECK_MAX_SECONDS'))).toBe(true)
        expect(warnings.join('\n')).not.toContain('banana')
        expect(warnings.join('\n')).not.toContain('5')
    })

    it('rejects empty, whitespace, float, exponent, NaN, Infinity and an unsafe integer', () => {
        expect(parseRuntimeInteger('')).toBeNull()
        expect(parseRuntimeInteger('   ')).toBeNull()
        expect(parseRuntimeInteger(' 20')).toBeNull()
        expect(parseRuntimeInteger('1.5')).toBeNull()
        expect(parseRuntimeInteger('1e2')).toBeNull()
        expect(parseRuntimeInteger('NaN')).toBeNull()
        expect(parseRuntimeInteger('Infinity')).toBeNull()
        expect(parseRuntimeInteger('9007199254740993')).toBeNull()
        expect(parseRuntimeInteger('20')).toBe(20)
        expect(parseRuntimeInteger('0')).toBe(0)
    })

    it('keeps an in-range host limit and bounds the partner when nothing else fits', () => {
        const { env } = tempEnv()
        env.CUTTLELY_CHECK_COUNT_MAX = '10'
        env.CUTTLELY_CHECK_COUNT_DEFAULT = '50'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_MAX')).toEqual({ value: 10, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_DEFAULT')).toEqual({ value: 4, source: 'default' })
        resetRuntimeLimitsForTests()
        env.CUTTLELY_CHECK_COUNT_MAX = '1'
        env.CUTTLELY_CHECK_COUNT_DEFAULT = '8'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_MAX')).toEqual({ value: 1, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_DEFAULT')).toEqual({
            value: 1,
            source: 'bounded',
            boundedBy: 'CUTTLELY_CHECK_COUNT_MAX'
        })
        resetRuntimeLimitsForTests()
        delete env.CUTTLELY_CHECK_COUNT_MAX
        delete env.CUTTLELY_CHECK_COUNT_DEFAULT
        env.CUTTLELY_RATING_SCAN_CAP = '300'
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_SCAN_CAP')).toEqual({ value: 300, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_IMPORT_CAP')).toEqual({
            value: 300,
            source: 'bounded',
            boundedBy: 'CUTTLELY_RATING_SCAN_CAP'
        })
        resetRuntimeLimitsForTests()
        env.CUTTLELY_RATING_IMPORT_CAP = '800'
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_SCAN_CAP')).toEqual({ value: 300, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_IMPORT_CAP')).toEqual({
            value: 300,
            source: 'bounded',
            boundedBy: 'CUTTLELY_RATING_SCAN_CAP'
        })
        resetRuntimeLimitsForTests()
        delete env.CUTTLELY_RATING_SCAN_CAP
        env.CUTTLELY_RATING_IMPORT_CAP = '2000'
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_IMPORT_CAP')).toEqual({ value: 2000, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_RATING_SCAN_CAP')).toEqual({
            value: 2000,
            source: 'bounded',
            boundedBy: 'CUTTLELY_RATING_IMPORT_CAP'
        })
        const warnings = (console.warn as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n')
        expect(warnings).toContain('CUTTLELY_CHECK_COUNT_DEFAULT')
        expect(warnings).toContain('CUTTLELY_RATING_IMPORT_CAP')
        expect(warnings).toContain('CUTTLELY_RATING_SCAN_CAP')
        expect(warnings).not.toContain('CUTTLELY_CHECK_COUNT_MAX')
        expect(warnings).not.toContain('50')
        expect(warnings).not.toContain('8')
        expect(warnings).not.toContain('800')
        expect(warnings).not.toContain('2000')
        expect(warnings).not.toContain('300')
    })

    it('falls the partner back through its own candidates before a host value bounds it', () => {
        const { data, env } = tempEnv()
        save(data, { CUTTLELY_CHECK_COUNT_MAX: '20' })
        env.CUTTLELY_CHECK_COUNT_DEFAULT = '50'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_DEFAULT')).toEqual({ value: 50, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_MAX')).toEqual({ value: 100, source: 'default' })
        resetRuntimeLimitsForTests()
        env.CUTTLELY_CHECK_COUNT_DEFAULT = '400'
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_DEFAULT')).toEqual({ value: 400, source: 'host' })
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_COUNT_MAX')).toEqual({
            value: 400,
            source: 'bounded',
            boundedBy: 'CUTTLELY_CHECK_COUNT_DEFAULT'
        })
        const warnings = (console.warn as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n')
        expect(warnings).toContain('CUTTLELY_CHECK_COUNT_MAX')
        expect(warnings).not.toContain('CUTTLELY_CHECK_COUNT_DEFAULT')
        expect(warnings).not.toContain('400')
        expect(warnings).not.toContain('20')
    })

    it('uses defaults when the settings file is corrupt', () => {
        const { data, env } = tempEnv()
        fs.mkdirSync(path.join(data, 'settings'), { recursive: true })
        fs.writeFileSync(path.join(data, 'settings', 'server.json'), '{', 'utf8')
        expect(() => runtimeSnapshot(env)).not.toThrow()
        expect(runtimeNumber('CUTTLELY_CHECK_MAX_TOKENS', env)).toBe(100000)
        expect(runtimeNumber('CUTTLELY_UI_PAGE_LIMIT_MAX', env)).toBe(3000)
        expect(runtimeSnapshot(env).get('CUTTLELY_CHECK_MAX_TOKENS')?.source).toBe('default')
    })

    it('keeps a cached value until a save or the time limit', () => {
        jest.useFakeTimers({ now: 1_700_000_000_000 })
        const { data, env } = tempEnv()
        save(data, { CUTTLELY_CHECK_CONCURRENCY: '3' })
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(3)
        const file = path.join(data, 'settings', 'server.json')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"3"', '"4"'))
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(3)
        invalidateRuntimeCache()
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(4)
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"4"', '"5"'))
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(4)
        jest.advanceTimersByTime(RUNTIME_CACHE_MS)
        expect(runtimeNumber('CUTTLELY_CHECK_CONCURRENCY', env)).toBe(5)
    })

    it('refuses a partial save that breaks a pair', () => {
        const { data, env } = tempEnv()
        save(data, { CUTTLELY_CHECK_COUNT_MAX: '20' })
        const file = { CUTTLELY_CHECK_COUNT_MAX: '20', CUTTLELY_CHECK_COUNT_DEFAULT: '40' }
        const count = runtimeConflict(env, new Set(), file, new Set(['CUTTLELY_CHECK_COUNT_DEFAULT']))
        expect(count).toEqual({
            code: 'CROSS_FIELD',
            key: 'CUTTLELY_CHECK_COUNT_DEFAULT',
            reason: 'The question count default cannot be above the question cap.',
            min: 1,
            max: 20
        })
        const ratings = runtimeConflict(env, new Set(), { CUTTLELY_RATING_IMPORT_CAP: '2000' }, new Set(['CUTTLELY_RATING_IMPORT_CAP']))
        expect(ratings).toMatchObject({ code: 'CROSS_FIELD', key: 'CUTTLELY_RATING_IMPORT_CAP', min: 50, max: 1000 })
        expect(runtimeConflict(env, new Set(), { CUTTLELY_CHECK_COUNT_DEFAULT: '4' }, new Set(['CUTTLELY_CHECK_COUNT_DEFAULT']))).toBeNull()
    })

    it('registers every runtime limit with a range and the old default', () => {
        const expected: Record<string, { min: number; max: number; defaultValue: string; unit: string }> = {
            CUTTLELY_CHECK_MAX_TOKENS: { min: 1000, max: 2000000, defaultValue: '100000', unit: 'tokens' },
            CUTTLELY_CHECK_MAX_SECONDS: { min: 10, max: 1800, defaultValue: '180', unit: 'seconds' },
            CUTTLELY_CHECK_CONCURRENCY: { min: 1, max: 8, defaultValue: '2', unit: 'count' },
            CUTTLELY_CHECK_RUN_TIMEOUT_MS: { min: 10000, max: 600000, defaultValue: '60000', unit: 'ms' },
            CUTTLELY_CHECK_KEEP_MINUTES: { min: 5, max: 1440, defaultValue: '30', unit: 'minutes' },
            CUTTLELY_CHECK_COUNT_MAX: { min: 1, max: 500, defaultValue: '100', unit: 'count' },
            CUTTLELY_CHECK_COUNT_DEFAULT: { min: 1, max: 500, defaultValue: '4', unit: 'count' },
            CUTTLELY_CHECK_SCAN_CAP: { min: 500, max: 20000, defaultValue: '2000', unit: 'count' },
            CUTTLELY_HARNESS_TURN_SCAN_CAP: { min: 500, max: 5000, defaultValue: '2000', unit: 'count' },
            CUTTLELY_RATING_IMPORT_CAP: { min: 50, max: 5000, defaultValue: '500', unit: 'count' },
            CUTTLELY_RATING_SCAN_CAP: { min: 50, max: 20000, defaultValue: '1000', unit: 'count' },
            CUTTLELY_UI_PAGE_LIMIT_MAX: { min: 100, max: 50000, defaultValue: '3000', unit: 'count' }
        }
        for (const [key, bounds] of Object.entries(expected)) {
            const setting = settingFor(key)
            expect(setting).toMatchObject({ ...bounds, runtime: true, type: 'number' })
            expect((setting?.help.length ?? 0) > 10).toBe(true)
            expect(runtimeNumber(key, { CUTTLELY_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-runtime-')) })).toBe(
                Number(bounds.defaultValue)
            )
        }
    })
})
