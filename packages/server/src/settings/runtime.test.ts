import fs from 'fs'
import os from 'os'
import path from 'path'
import { LoginRateLimit } from '../identity/rateLimit'
import { writeSettingsFile } from './store'
import {
    RUNTIME_STALE_MS,
    bindRuntimeSource,
    drainTimeoutLimit,
    isSecretSettingKey,
    loginFailureLimit,
    publishRuntime,
    sessionAbsoluteHours,
    sessionIdleMinutes,
    unbindRuntimeSource
} from './runtime'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'

function folder(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-runtime-'))
    return path.join(root, 'settings')
}

afterEach(() => {
    unbindRuntimeSource()
    delete process.env.CUTTLELY_LOGIN_FAILURE_LIMIT
    delete process.env.CUTTLELY_SESSION_IDLE_MINUTES
    delete process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS
    delete process.env.CUTTLELY_DRAIN_TIMEOUT_MS
})

describe('runtime settings cache', () => {
    it('shows a saved value at once in the process that saved it', () => {
        const dir = folder()
        const env: Record<string, string | undefined> = {}
        writeSettingsFile(dir, { CUTTLELY_LOGIN_FAILURE_LIMIT: '10' }, { key: KEY })
        publishRuntime(env, new Set(), { CUTTLELY_LOGIN_FAILURE_LIMIT: '10' }, dir, 1_000)
        writeSettingsFile(dir, { CUTTLELY_LOGIN_FAILURE_LIMIT: '25' }, { key: KEY })
        publishRuntime(env, new Set(), { CUTTLELY_LOGIN_FAILURE_LIMIT: '25' }, dir, 1_000)
        bindRuntimeSource(dir, [])
        expect(loginFailureLimit(process.env, 1_000)).toBe(25)
        expect(env.CUTTLELY_LOGIN_FAILURE_LIMIT).toBe('25')
    })

    it('lets another process keep the previous value until the refresh interval', () => {
        const dir = folder()
        writeSettingsFile(dir, { CUTTLELY_SESSION_IDLE_MINUTES: '720' }, { key: KEY })
        bindRuntimeSource(dir, [])
        expect(sessionIdleMinutes(process.env, 5_000)).toBe(720)
        writeSettingsFile(dir, { CUTTLELY_SESSION_IDLE_MINUTES: '30' }, { key: KEY })
        expect(sessionIdleMinutes(process.env, 5_000 + RUNTIME_STALE_MS - 1)).toBe(720)
        expect(sessionIdleMinutes(process.env, 5_000 + RUNTIME_STALE_MS)).toBe(30)
    })

    it('keeps a host value ahead of the file and clamps it into range', () => {
        const dir = folder()
        writeSettingsFile(dir, { CUTTLELY_DRAIN_TIMEOUT_MS: '60000', CUTTLELY_SESSION_ABSOLUTE_HOURS: '2' }, { key: KEY })
        process.env.CUTTLELY_DRAIN_TIMEOUT_MS = '1000'
        bindRuntimeSource(dir, ['CUTTLELY_DRAIN_TIMEOUT_MS'])
        expect(drainTimeoutLimit()).toBe(5000)
        expect(sessionAbsoluteHours()).toBe(2)
        process.env.CUTTLELY_DRAIN_TIMEOUT_MS = '99999999'
        expect(drainTimeoutLimit()).toBe(300000)
    })

    it('treats secret names in one place', () => {
        expect(isSecretSettingKey('WORKOS_API_KEY')).toBe(true)
        expect(isSecretSettingKey('DATABASE_PASSWORD')).toBe(true)
        expect(isSecretSettingKey('REDIS_PASSWORD')).toBe(true)
        expect(isSecretSettingKey('SOME_API_KEY')).toBe(true)
        expect(isSecretSettingKey('CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS')).toBe(false)
        expect(isSecretSettingKey('OAUTH2_ALLOWED_TOKEN_DOMAINS')).toBe(false)
        expect(isSecretSettingKey('CUTTLELY_LOGIN_FAILURE_LIMIT')).toBe(false)
    })

    it('uses the current failure limit on the next check', async () => {
        process.env.CUTTLELY_LOGIN_FAILURE_LIMIT = '3'
        const limit = new LoginRateLimit()
        const ip = '198.51.100.40'
        expect(await limit.blocked(ip, '', 1_000)).toBe(false)
        await limit.recordFailure(ip, '', 1_000)
        await limit.recordFailure(ip, '', 1_000)
        await limit.recordFailure(ip, '', 1_000)
        expect(await limit.blocked(ip, '', 1_000)).toBe(true)
        process.env.CUTTLELY_LOGIN_FAILURE_LIMIT = '10'
        expect(await limit.blocked(ip, '', 1_000)).toBe(false)
    })
})
