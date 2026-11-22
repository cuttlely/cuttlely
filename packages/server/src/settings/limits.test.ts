import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyAdminSettings } from './apply'
import { accountLinkSnapshot } from './accountLinks'
import { runSettingsCli } from './cli'
import { startRecords } from './env-cli'
import { readHistory } from './history'
import { HOST_LIMITS_VAR, resolveLimits } from './limits'
import { settingFor } from './registry'
import { runtimeSnapshot } from './runtime'
import { ServiceDeps, SettingsError, getView, saveChanges } from './service'
import { writeSettingsFile } from './store'

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
        expect(row(saved, LIVE)).toMatchObject({ source: 'panel', effective: '90000', running: '60000', changed: false })
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
