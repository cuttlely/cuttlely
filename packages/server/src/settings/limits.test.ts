import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyAdminSettings } from './apply'
import { accountLinkSnapshot } from './accountLinks'
import { runSettingsCli } from './cli'
import { startRecords } from './env-cli'
import { describeChanges, readHistory } from './history'
import { HOST_LIMITS_VAR, resolveLimits } from './limits'
import { SETTINGS, settingFor } from './registry'
import { checkValue } from './validate'
import { runtimeSnapshot } from './runtime'
import { ServiceDeps, SettingsError, discardChanges, getView, saveChanges } from './service'
import { readSettingsFile, writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const LIVE = 'CUTTLELY_HARNESS_TURN_BUDGET_MS'
const RESTART = 'CUTTLELY_HARNESS_RUN_TIMEOUT_MS'
const folders: string[] = []

function fixture(host: Record<string, string> = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-limits-'))
    folders.push(data)
    const dir = path.join(data, 'settings')
    const env: Record<string, string | undefined> = { CUTTLELY_DATA_DIR: data, CUTTLELY_SECRETKEY_OVERWRITE: KEY, ...host }
    return { dir, env, start: (): ServiceDeps => ({ env, state: applyAdminSettings(env), key: async () => KEY }) }
}

function row(view: Awaited<ReturnType<typeof getView>>, key: string) {
    return view.settings.find((setting) => setting.key === key)!
}

beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
    for (const data of folders.splice(0)) fs.rmSync(data, { recursive: true, force: true })
})

describe('admin time limits', () => {
    it('keeps saved limits after the base command loads, with matching running values', async () => {
        const f = fixture({ [RESTART]: '60000' })
        writeSettingsFile(f.dir, { [RESTART]: '90000' }, { key: KEY })
        const before = process.env
        process.env = { HOME: before.HOME, DATABASE_PATH: before.DATABASE_PATH, ...f.env }
        jest.doMock('dotenv', () => ({
            __esModule: true,
            default: {
                config: () => {
                    process.env[RESTART] = '60000'
                }
            }
        }))
        jest.doMock('../utils/logger', () => ({ __esModule: true, default: {} }))
        jest.doMock('../identity/initialOwner', () => ({ captureInitialOwnerEnvironment: jest.fn() }))
        try {
            let state: ServiceDeps['state']
            jest.isolateModules(() => {
                state = require('../commands/base').startState
            })
            expect(process.env[RESTART]).toBe('90000')
            const view = await getView({ env: process.env, state: state!, key: async () => KEY })
            expect(row(view, RESTART)).toMatchObject({ effective: '90000', running: process.env[RESTART], source: 'panel' })
        } finally {
            process.env = before
            jest.dontMock('dotenv')
            jest.dontMock('../utils/logger')
            jest.dontMock('../identity/initialOwner')
        }
    })

    it('exposes the original host fallback when a saved limit is cleared', async () => {
        const f = fixture({ [LIVE]: '60000' })
        writeSettingsFile(f.dir, { [LIVE]: '90000' }, { key: KEY })
        expect(row(await getView(f.start()), LIVE)).toMatchObject({ clearValue: '60000', clearSource: 'host' })
        const noHost = fixture()
        expect(row(await getView(noHost.start()), LIVE)).toMatchObject({ clearValue: '45000', clearSource: 'default' })
    })

    it('resolves saved, host, then default and leaves unset defaults out of the environment', () => {
        const f = fixture({ [LIVE]: '60000' })
        writeSettingsFile(f.dir, { [LIVE]: '90000' }, { key: KEY })
        const service = f.start()
        expect(f.env[LIVE]).toBe('90000')
        expect(JSON.parse(f.env[HOST_LIMITS_VAR]!)).toEqual({ [LIVE]: 60000 })
        expect(resolveLimits(f.env, { [LIVE]: '90000' }).get(LIVE)).toEqual({ value: '90000', source: 'panel' })
        expect(resolveLimits(f.env, {}).get(LIVE)).toEqual({ value: '60000', source: 'host' })
        expect(service.state.limitsAtStart?.[LIVE]).toBe('90000')
        const defaults = fixture()
        defaults.start()
        expect(defaults.env[LIVE]).toBeUndefined()
        expect(defaults.env[RESTART]).toBeUndefined()
        expect(resolveLimits(defaults.env, {}).get(LIVE)).toEqual({ value: '45000', source: 'default' })
        const host = fixture({ [LIVE]: '060000' })
        host.start()
        expect(host.env[LIVE]).toBe('060000')
    })

    it('ignores invalid saved raw numbers with a key-only warning', () => {
        const f = fixture({ [RESTART]: '60000' })
        for (const value of ['bad-limit-value', '3600001', '-1', '1234.5']) {
            expect(resolveLimits(f.env, { [RESTART]: value }).get(RESTART)).toEqual({ value: '60000', source: 'host' })
        }
        expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).toContain(RESTART)
        expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).not.toContain('bad-limit-value')
        expect(resolveLimits(fixture().env, { [RESTART]: '-1' }).get(RESTART)?.source).toBe('default')
    })

    it('validates bounds and whole raw milliseconds with the existing error shape', async () => {
        const service = fixture().start()
        for (const value of ['-1', '3600001']) {
            await expect(saveChanges(service, { values: { [RESTART]: value } }, 'operator')).rejects.toMatchObject({
                status: 400,
                code: 'OUT_OF_RANGE',
                key: RESTART,
                min: 0,
                max: 3600,
                errors: [{ key: RESTART, code: 'OUT_OF_RANGE' }]
            })
        }
        await expect(saveChanges(service, { values: { [RESTART]: '1000.5' } }, 'operator')).rejects.toMatchObject({
            status: 400,
            code: 'INVALID',
            key: RESTART
        })
    })

    it('applies live saves and restores the original host after clearing, with sources and history', async () => {
        const f = fixture({ [LIVE]: '60000' })
        const service = f.start()
        expect(row(await getView(service), LIVE)).toMatchObject({ source: 'host', value: '60000', locked: false })
        const saved = await saveChanges(service, { values: { [LIVE]: '90000' } }, 'operator')
        expect(f.env[LIVE]).toBe('90000')
        expect(row(saved, LIVE)).toMatchObject({ source: 'panel', effective: '90000', running: '90000', changed: false })
        expect(saved.restart.changed).not.toContain(LIVE)
        expect(readHistory(f.dir)[0]).toMatchObject({ kind: 'save', by: 'operator', changes: [{ key: LIVE, to: '90000' }] })
        const cleared = await saveChanges(service, { values: { [LIVE]: '' } }, 'operator')
        expect(f.env[LIVE]).toBe('60000')
        expect(row(cleared, LIVE)).toMatchObject({ source: 'host', effective: '60000', locked: false })
        expect(runSettingsCli(['list'], f.env).lines.find((line) => line.startsWith(LIVE))).toContain('host')
        const noHost = fixture()
        const noHostService = noHost.start()
        await saveChanges(noHostService, { values: { [LIVE]: '90000' } }, 'operator')
        expect(noHost.env[LIVE]).toBe('90000')
        const defaults = await saveChanges(noHostService, { values: { [LIVE]: '' } }, 'operator')
        expect(noHost.env[LIVE]).toBeUndefined()
        expect(row(defaults, LIVE)).toMatchObject({ source: 'default', effective: '45000' })
    })

    it('updates process.env through the file-write hook after a plain server start', async () => {
        const f = fixture({ [LIVE]: '60000' })
        const names = [
            'CUTTLELY_DATA_DIR',
            'CUTTLELY_SECRETKEY_OVERWRITE',
            'CUTTLELY_SETTINGS_HOST_KEYS',
            HOST_LIMITS_VAR,
            LIVE,
            'CUTTLELY_ANALYST',
            'CUTTLELY_SETTINGS_SCRIPT_DEFAULTS'
        ]
        const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
        try {
            delete process.env[HOST_LIMITS_VAR]
            delete process.env.CUTTLELY_SETTINGS_HOST_KEYS
            Object.assign(process.env, f.env)
            const service = { env: process.env, state: applyAdminSettings(), key: async () => KEY }
            await saveChanges(service, { values: { [LIVE]: '90000' } }, 'operator')
            expect(process.env[LIVE]).toBe('90000')
            await saveChanges(service, { values: { [LIVE]: '' } }, 'operator')
            expect(process.env[LIVE]).toBe('60000')
        } finally {
            for (const name of names) {
                if (before[name] === undefined) delete process.env[name]
                else process.env[name] = before[name]
            }
        }
    })

    it('restores live values when discarding removes the settings file, including failed history writes', async () => {
        const f = fixture({ [LIVE]: '60000' })
        const service = f.start()
        await saveChanges(service, { values: { [LIVE]: '90000' } }, 'operator')
        await discardChanges(service, 'operator')
        expect(f.env[LIVE]).toBe('60000')
        expect(fs.existsSync(path.join(f.dir, 'server.json'))).toBe(false)
        const append = jest.spyOn(require('./history'), 'appendHistory').mockImplementation(() => {
            throw new Error('fixture history failure')
        })
        try {
            await expect(saveChanges(service, { values: { [LIVE]: '90000' } }, 'operator')).rejects.toMatchObject({
                code: 'HISTORY_FAILED'
            })
            expect(f.env[LIVE]).toBe('60000')
            expect(fs.existsSync(path.join(f.dir, 'server.json'))).toBe(false)
        } finally {
            append.mockRestore()
        }
    })

    it('keeps restart keys at their startup value and lists only effective pending changes', async () => {
        const f = fixture({ [RESTART]: '60000' })
        const service = f.start()
        const saved = await saveChanges(service, { values: { [RESTART]: '90000' } }, 'operator')
        expect(f.env[RESTART]).toBe('60000')
        expect(row(saved, RESTART)).toMatchObject({ changed: true, effective: '90000', running: '60000', locked: false })
        expect(saved.restart.changed).toContain(RESTART)
        const cleared = await saveChanges(service, { values: { [RESTART]: '' } }, 'operator')
        expect(cleared.restart.changed).not.toContain(RESTART)
        expect(row(cleared, RESTART)).toMatchObject({ changed: false, source: 'host' })
    })

    it('clears a restart value that replaced the host at start without changing the running environment', async () => {
        const f = fixture({ [RESTART]: '60000' })
        writeSettingsFile(f.dir, { [RESTART]: '90000' }, { key: KEY })
        const service = f.start()
        expect(f.env[RESTART]).toBe('90000')
        const cleared = await saveChanges(service, { values: { [RESTART]: '' } }, 'operator')
        expect(row(cleared, RESTART)).toMatchObject({ source: 'host', effective: '60000', running: '90000', changed: true, locked: false })
        expect(f.env[RESTART]).toBe('90000')
        expect(cleared.restart.changed).toContain(RESTART)
    })

    it('refuses a caller without operator authorization before writing', async () => {
        const f = fixture()
        const service = f.start()
        service.authorize = async () => {
            throw new SettingsError(403, 'FORBIDDEN', 'Not allowed.')
        }
        await expect(saveChanges(service, { values: { [LIVE]: '90000' } }, 'viewer')).rejects.toMatchObject({
            status: 403,
            code: 'FORBIDDEN'
        })
        expect(fs.existsSync(path.join(f.dir, 'server.json'))).toBe(false)
        expect(readHistory(f.dir)).toEqual([])
    })

    it('exports saved limits over the host and records only original numeric limit values', () => {
        const f = fixture({ [RESTART]: '60000' })
        writeSettingsFile(f.dir, { [RESTART]: '90000' }, { key: KEY })
        const records = startRecords(f.env, null, () => undefined)
        expect(records).toContain(`${RESTART}=90000`)
        expect(records).toContain(`${HOST_LIMITS_VAR}=${JSON.stringify({ [RESTART]: 60000 })}`)
        const applied = {
            ...f.env,
            ...Object.fromEntries(
                records.map((line) => {
                    const i = line.indexOf('=')
                    return [line.slice(0, i), line.slice(i + 1)]
                })
            )
        }
        expect(rowFrom(applied)).toEqual({ value: '60000', source: 'host' })
        expect(startRecords(fixture({ [RESTART]: '060000' }).env, null, () => undefined)).toContain(`${RESTART}=060000`)
        expect(startRecords(fixture().env, null, () => undefined).some((line) => line.startsWith(`${RESTART}=`))).toBe(false)
    })

    it('exposes release-prep bounds and exports a saved tool wait without inventing an unset default', async () => {
        const tool = 'CUTTLELY_HARNESS_TOOL_TIMEOUT_MS'
        const health = 'CUTTLELY_HERMES_HEALTH_TIMEOUT'
        expect(settingFor(tool)).toMatchObject({ min: 1, max: 3660, integer: true, unit: 'ms-as-seconds', applies: 'restart' })
        expect(settingFor(tool)?.defaultValue).toBeUndefined()
        expect(settingFor(health)).toMatchObject({ min: 1, max: 30, defaultValue: '2', applies: 'restart' })
        const f = fixture()
        const service = f.start()
        expect(row(await getView(service), tool)).toMatchObject({ value: '', effective: '', source: 'default', running: '' })
        await saveChanges(service, { values: { [tool]: '3660000', [health]: '30' } }, 'operator')
        const records = startRecords(f.env, null, () => undefined)
        expect(records).toContain(`${tool}=3660000`)
        expect(records).toContain(`${health}=30`)
        const cleared = await saveChanges(service, { values: { [tool]: '' } }, 'operator')
        expect(row(cleared, tool)).toMatchObject({ effective: '', source: 'default', changed: false })
    })

    it('keeps fixed caps outside env, saved settings, exports, and history', async () => {
        const fixed = 'CUTTLELY_FIXED_HERMES_CODE_RPC_WAIT'
        const f = fixture({ [fixed]: '999' })
        writeSettingsFile(f.dir, { [fixed]: '800' }, { key: KEY })
        expect(readSettingsFile(f.dir, KEY).values[fixed]).toBeUndefined()
        // A hand-edited settings file is ignored too.
        fs.writeFileSync(path.join(f.dir, 'server.json'), JSON.stringify({ version: 1, values: { [fixed]: '700' } }))
        const service = f.start()
        expect(f.env[fixed]).toBe('999')
        expect(row(await getView(service), fixed)).toMatchObject({
            fixed: true,
            value: '300',
            effective: '300',
            source: 'default',
            locked: true,
            changed: false
        })
        await expect(saveChanges(service, { values: { [fixed]: '600' } }, 'operator')).rejects.toMatchObject({
            status: 400,
            code: 'READ_ONLY'
        })
        expect(resolveLimits(f.env, { [fixed]: '600' }).has(fixed)).toBe(false)
        expect(describeChanges({}, { [fixed]: '600' })).toEqual([])
        expect(startRecords(f.env, null, () => undefined).some((line) => line.startsWith(`${fixed}=`))).toBe(false)
        expect(readHistory(f.dir)).toEqual([])
    })

    it('validates every limit entry against its displayed bounds and accepts clearing', () => {
        for (const setting of SETTINGS.filter((entry) => entry.limit)) {
            expect(setting.panelFirst).toBe(true)
            expect(['live', 'restart']).toContain(setting.applies)
            const scale = setting.unit === 'ms-as-seconds' ? 1000 : 1
            expect(checkValue(setting, String(setting.min! * scale)).ok).toBe(true)
            expect(checkValue(setting, String(setting.max! * scale)).ok).toBe(true)
            expect(checkValue(setting, String((setting.min! - 1) * scale))).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
            expect(checkValue(setting, String((setting.max! + 1) * scale))).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
            expect(checkValue(setting, '1000.5')).toMatchObject({ ok: false, code: 'INVALID' })
            expect(checkValue(setting, '')).toEqual({ ok: true, value: '' })
        }
    })

    it('keeps limit keys outside invite/mail and runtime snapshots', () => {
        const f = fixture()
        const account = accountLinkSnapshot(f.env)
        expect([...account.keys()]).toEqual([
            'INVITE_TOKEN_EXPIRY_IN_HOURS',
            'PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS',
            'INVITE_DELIVERY',
            'SMTP_HOST',
            'SMTP_PORT',
            'SMTP_SECURE',
            'SMTP_USER',
            'SENDER_EMAIL'
        ])
        expect(runtimeSnapshot(f.env).has(LIVE)).toBe(false)
        expect(settingFor(RESTART)).toMatchObject({ limit: true, panelFirst: true, applies: 'restart' })
    })
})

function rowFrom(env: Record<string, string | undefined>) {
    return resolveLimits(env, {}).get(RESTART)
}
