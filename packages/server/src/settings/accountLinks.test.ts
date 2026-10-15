import fs from 'fs'
import os from 'os'
import path from 'path'
import { StartState } from './apply'
import { ACCOUNT_LINK_CACHE_MS, accountLinkSnapshot, effectiveAccountEnv, resetAccountLinksForTests } from './accountLinks'
import { runSettingsCli } from './cli'
import { resetRuntimeLimitsForTests } from './runtime'
import { ServiceDeps, getView, saveChanges } from './service'
import { writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const FILE_PASSWORD = 'file-secret-mailbox'
const ENV_PASSWORD = 'env-secret-mailbox'

function tempEnv() {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-account-'))
    const dir = path.join(data, 'settings')
    const env: Record<string, string | undefined> = { CUTTLELY_DATA_DIR: data, CUTTLELY_SECRETKEY_OVERWRITE: KEY }
    return { data, dir, env }
}

function deps(env: Record<string, string | undefined>, dir: string, hostKeys: string[] = []): ServiceDeps {
    const state: StartState = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys,
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [],
        rawAtStart: null
    }
    return { env, state, key: async () => KEY }
}

function row(view: Awaited<ReturnType<typeof getView>>, key: string) {
    const found = view.settings.find((setting) => setting.key === key)
    if (!found) throw new Error(`missing ${key}`)
    return found
}

beforeEach(() => {
    resetAccountLinksForTests()
    resetRuntimeLimitsForTests()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
})

describe('invite and reset settings', () => {
    it('keeps the cache at or under five seconds', () => {
        expect(ACCOUNT_LINK_CACHE_MS).toBeLessThanOrEqual(5000)
    })

    it('lets a saved value override the environment, then uses the environment, then the default', () => {
        const { dir, env } = tempEnv()
        env.INVITE_TOKEN_EXPIRY_IN_HOURS = '10'
        expect(accountLinkSnapshot(env).get('INVITE_TOKEN_EXPIRY_IN_HOURS')).toEqual({ value: '10', source: 'host' })
        writeSettingsFile(dir, { INVITE_TOKEN_EXPIRY_IN_HOURS: '24' }, { key: KEY })
        resetAccountLinksForTests()
        expect(accountLinkSnapshot(env).get('INVITE_TOKEN_EXPIRY_IN_HOURS')).toEqual({ value: '24', source: 'panel' })
        expect(effectiveAccountEnv(env).INVITE_TOKEN_EXPIRY_IN_HOURS).toBe('24')
    })

    it('brings an out of range number inside the cap and skips a value that is not a whole number', () => {
        const { dir, env } = tempEnv()
        env.INVITE_TOKEN_EXPIRY_IN_HOURS = '9999'
        env.PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS = '1'
        expect(accountLinkSnapshot(env).get('INVITE_TOKEN_EXPIRY_IN_HOURS')).toEqual({ value: '168', source: 'host' })
        expect(accountLinkSnapshot(env).get('PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS')).toEqual({ value: '5', source: 'host' })
        env.SMTP_PORT = 'nope'
        writeSettingsFile(dir, { INVITE_TOKEN_EXPIRY_IN_HOURS: 'nope' }, { key: KEY })
        resetAccountLinksForTests()
        expect(accountLinkSnapshot(env).get('INVITE_TOKEN_EXPIRY_IN_HOURS')).toEqual({ value: '168', source: 'host' })
        expect(accountLinkSnapshot(env).get('SMTP_PORT')).toEqual({ value: '587', source: 'default' })
        const warnings = (console.warn as jest.Mock).mock.calls.map((call) => String(call[0]))
        expect(warnings.some((line) => line.includes('INVITE_TOKEN_EXPIRY_IN_HOURS'))).toBe(true)
        expect(warnings.join('\n')).not.toContain('nope')
        expect(warnings.join('\n')).not.toContain('9999')
    })

    it('ignores the saved file when admin settings are ignored', () => {
        const { dir, env } = tempEnv()
        writeSettingsFile(dir, { SMTP_HOST: 'panel.example.com' }, { key: KEY })
        env.SMTP_HOST = 'host.example.com'
        env.CUTTLELY_IGNORE_ADMIN_SETTINGS = 'true'
        expect(accountLinkSnapshot(env).get('SMTP_HOST')).toEqual({ value: 'host.example.com', source: 'host' })
    })

    it('shows the effective value and source, and does not lock a host value the page can override', async () => {
        const { dir, env } = tempEnv()
        env.CUTTLELY_LOCAL_ADMIN = 'true'
        env.INVITE_TOKEN_EXPIRY_IN_HOURS = '9999'
        env.SMTP_HOST = 'host.example.com'
        env.CUTTLELY_CHECK_CONCURRENCY = '6'
        const service = deps(env, dir, ['CUTTLELY_LOCAL_ADMIN', 'INVITE_TOKEN_EXPIRY_IN_HOURS', 'SMTP_HOST', 'CUTTLELY_CHECK_CONCURRENCY'])
        const before = await getView(service)
        expect(row(before, 'INVITE_TOKEN_EXPIRY_IN_HOURS')).toMatchObject({
            source: 'host',
            effective: '168',
            value: '168',
            locked: false,
            runtime: true,
            range: { min: 1, max: 168 }
        })
        expect(row(before, 'CUTTLELY_CHECK_CONCURRENCY')).toMatchObject({ source: 'host', effective: '6', locked: true })
        await saveChanges(service, { values: { INVITE_TOKEN_EXPIRY_IN_HOURS: '24', SMTP_HOST: 'panel.example.com' } }, 'owner@example.com')
        resetAccountLinksForTests()
        const after = await getView(service)
        expect(row(after, 'INVITE_TOKEN_EXPIRY_IN_HOURS')).toMatchObject({
            source: 'panel',
            effective: '24',
            value: '24',
            locked: false
        })
        expect(row(after, 'SMTP_HOST')).toMatchObject({ source: 'panel', effective: 'panel.example.com', locked: false })
    })

    it('refuses a saved number outside the range', async () => {
        const { dir, env } = tempEnv()
        const service = deps(env, dir)
        await expect(saveChanges(service, { values: { INVITE_TOKEN_EXPIRY_IN_HOURS: '200' } }, 'owner@example.com')).rejects.toMatchObject({
            status: 400,
            code: 'OUT_OF_RANGE',
            key: 'INVITE_TOKEN_EXPIRY_IN_HOURS',
            min: 1,
            max: 168
        })
        await expect(saveChanges(service, { values: { SENDER_EMAIL: 'not-an-email' } }, 'owner@example.com')).rejects.toMatchObject({
            status: 400,
            code: 'INVALID'
        })
        await expect(saveChanges(service, { values: { INVITE_DELIVERY: 'sms' } }, 'owner@example.com')).rejects.toMatchObject({
            status: 400
        })
    })

    it('keeps the mail password in the environment and shows only whether it is set', async () => {
        const { dir, env } = tempEnv()
        writeSettingsFile(dir, { SMTP_PASSWORD: FILE_PASSWORD, SMTP_HOST: 'panel.example.com' }, { key: KEY })
        const hidden = await getView(deps(env, dir))
        const hiddenPassword = row(hidden, 'SMTP_PASSWORD')
        expect(hiddenPassword.secret).toEqual({ set: false, unreadable: false })
        expect(hiddenPassword.locked).toBe(true)
        expect(hiddenPassword.value).toBeUndefined()
        expect(hiddenPassword.effective).toBeUndefined()
        expect(hidden.readOnly.find((item) => item.key === 'SMTP_PASSWORD')).toEqual({
            key: 'SMTP_PASSWORD',
            set: false,
            source: 'unset',
            readOnly: true
        })
        expect(JSON.stringify(hidden)).not.toContain(FILE_PASSWORD)
        env.SMTP_PASSWORD = ENV_PASSWORD
        const shown = await getView(deps(env, dir, ['SMTP_PASSWORD']))
        expect(row(shown, 'SMTP_PASSWORD')).toMatchObject({ source: 'host', locked: true, secret: { set: true, unreadable: false } })
        expect(shown.readOnly.find((item) => item.key === 'SMTP_PASSWORD')).toEqual({
            key: 'SMTP_PASSWORD',
            set: true,
            source: 'env',
            readOnly: true
        })
        expect(JSON.stringify(shown)).not.toContain(ENV_PASSWORD)
        expect(JSON.stringify(shown)).not.toContain(FILE_PASSWORD)
        expect(JSON.stringify(shown.readOnly)).not.toContain(ENV_PASSWORD)
        env.CUTTLELY_LOCAL_ADMIN = 'true'
        await expect(
            saveChanges(deps(env, dir), { values: { SMTP_PASSWORD: 'typed-secret-mailbox' } }, 'owner@example.com')
        ).rejects.toMatchObject({
            status: 400,
            code: 'READ_ONLY',
            errors: [{ key: 'SMTP_PASSWORD', code: 'READ_ONLY', message: 'This setting cannot be changed.' }]
        })
        expect(JSON.stringify(await getView(deps(env, dir)))).not.toContain('typed-secret-mailbox')
        const mail = effectiveAccountEnv(env)
        expect(mail.SMTP_PASSWORD).toBe(ENV_PASSWORD)
        expect(mail.SMTP_HOST).toBe('panel.example.com')
        const listed = runSettingsCli(['list'], env).lines.join('\n')
        expect(listed).toContain('(set, hidden)')
        expect(listed).not.toContain(ENV_PASSWORD)
        expect(listed).not.toContain(FILE_PASSWORD)
    })
})
