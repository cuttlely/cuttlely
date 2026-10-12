import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyAdminSettings } from './apply'
import { HOST_KEYS_VAR } from './resolve'
import { LAST_GOOD_FILE, SETTINGS_FILE, encryptionKeySync, readSettingsFile, saveLastGood, settingsDir, writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const SECRET = 'postgres://reader:pa55-made-up@db.example.invalid:5432/bakery'

function tempData(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-settings-'))
}

describe('server settings file', () => {
    it('lives in the settings folder of the data directory', () => {
        expect(settingsDir({ CUTTLELY_DATA_DIR: '/var/cuttlely' })).toBe(path.join('/var/cuttlely', 'settings'))
        expect(settingsDir({}).endsWith(path.join('.cuttlely', 'settings'))).toBe(true)
    })

    it('writes secrets encrypted, owner-only, and reads them back', () => {
        const dir = path.join(tempData(), 'settings')
        writeSettingsFile(
            dir,
            { CUTTLELY_ANALYST: 'auto', CUTTLELY_POSTGRES_URL: SECRET, LOG_LEVEL: '' },
            { key: KEY, by: 'owner@example.com' }
        )
        const raw = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
        expect(raw).not.toContain(SECRET)
        expect(raw).not.toContain('pa55-made-up')
        expect(raw).not.toContain('LOG_LEVEL')
        if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, SETTINGS_FILE)).mode & 0o777).toBe(0o600)
        const read = readSettingsFile(dir, KEY)
        expect(read.values).toEqual({ CUTTLELY_ANALYST: 'auto', CUTTLELY_POSTGRES_URL: SECRET })
        expect(read.updatedBy).toBe('owner@example.com')
        expect(read.problems).toEqual([])
    })

    it('counts a secret it cannot decrypt as not set, and says so without the value', () => {
        const dir = path.join(tempData(), 'settings')
        writeSettingsFile(dir, { CUTTLELY_POSTGRES_URL: SECRET, LOG_LEVEL: 'warn' }, { key: KEY })
        const read = readSettingsFile(dir, 'a-different-key')
        expect(read.values).toEqual({ LOG_LEVEL: 'warn' })
        expect(read.unreadable).toEqual(['CUTTLELY_POSTGRES_URL'])
        expect(read.problems.join(' ')).toMatch(/could not be read/)
        expect(read.problems.join(' ')).not.toContain('pa55')
        expect(readSettingsFile(dir, null).unreadable).toEqual(['CUTTLELY_POSTGRES_URL'])
    })

    it('ignores a damaged file, unknown names, kept-out names and plain-text secrets', () => {
        const dir = tempData()
        fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{ not json')
        expect(readSettingsFile(dir, KEY)).toMatchObject({
            exists: true,
            values: {},
            problems: ['The settings file is not valid JSON, so it was ignored.']
        })
        fs.writeFileSync(
            path.join(dir, SETTINGS_FILE),
            JSON.stringify({
                version: 1,
                values: { NOPE: 'x', CUSTOM_MCP_ALLOWED_COMMANDS: 'bash', WORKOS_API_KEY: 'sk_test_plain', LOG_LEVEL: 'warn' }
            })
        )
        const read = readSettingsFile(dir, KEY)
        expect(read.values).toEqual({ LOG_LEVEL: 'warn' })
        expect(read.problems).toHaveLength(3)
        expect(read.problems.join(' ')).not.toContain('sk_test_plain')
        fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 9, values: { LOG_LEVEL: 'warn' } }))
        expect(readSettingsFile(dir, KEY).values).toEqual({})
    })

    it('refuses to write a name it does not know', () => {
        expect(() => writeSettingsFile(tempData(), { PORT: '1' }, { key: KEY })).toThrow(/not a setting/)
    })

    it('keeps a byte-for-byte last-good copy', () => {
        const dir = path.join(tempData(), 'settings')
        expect(saveLastGood(dir)).toBe(false)
        writeSettingsFile(dir, { LOG_LEVEL: 'warn' }, { key: KEY })
        expect(saveLastGood(dir)).toBe(true)
        expect(fs.readFileSync(path.join(dir, LAST_GOOD_FILE), 'utf8')).toBe(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))
    })

    it('reads the encryption key from the override or the key file', () => {
        const data = tempData()
        expect(encryptionKeySync({ FLOWISE_SECRETKEY_OVERWRITE: 'override-value' })).toBe('override-value')
        expect(encryptionKeySync({ CUTTLELY_SECRETKEY_OVERWRITE: 'alias-value' })).toBe('alias-value')
        expect(encryptionKeySync({ FLOWISE_SECRETKEY_OVERWRITE: 'same-value', CUTTLELY_SECRETKEY_OVERWRITE: 'same-value' })).toBe(
            'same-value'
        )
        fs.writeFileSync(path.join(data, 'encryption.key'), 'from-file')
        expect(encryptionKeySync({ SECRETKEY_PATH: data })).toBe('from-file')
        expect(encryptionKeySync({ SECRETKEY_PATH: data, FLOWISE_SECRETKEY_OVERWRITE: '   ' })).toBe('from-file')
        expect(() => encryptionKeySync({ FLOWISE_SECRETKEY_OVERWRITE: 'one-value', CUTTLELY_SECRETKEY_OVERWRITE: 'other-value' })).toThrow(
            /both set to different values/
        )
    })
})

describe('applying the settings file at start', () => {
    function setup(values: Record<string, string>) {
        const data = tempData()
        writeSettingsFile(path.join(data, 'settings'), values, { key: KEY })
        return data
    }

    it('fills only what the host left unset, decrypting secrets', () => {
        const data = setup({ CUTTLELY_ANALYST: 'auto', LOG_LEVEL: 'debug', CUTTLELY_POSTGRES_URL: SECRET })
        const env: Record<string, string | undefined> = {
            CUTTLELY_DATA_DIR: data,
            FLOWISE_SECRETKEY_OVERWRITE: KEY,
            LOG_LEVEL: 'warn',
            CUTTLELY_ANALYST: ''
        }
        const state = applyAdminSettings(env)
        expect(env.LOG_LEVEL).toBe('warn')
        expect(env.CUTTLELY_ANALYST).toBe('auto')
        expect(env.CUTTLELY_POSTGRES_URL).toBe(SECRET)
        expect(state.applied.sort()).toEqual(['CUTTLELY_ANALYST', 'CUTTLELY_POSTGRES_URL'])
        expect(state.hostKeys).toEqual(['LOG_LEVEL'])
        expect(env[HOST_KEYS_VAR]).toBe('LOG_LEVEL')
    })

    it('does nothing to the environment when the ignore flag is on', () => {
        const data = setup({ CUTTLELY_ANALYST: 'auto' })
        const env: Record<string, string | undefined> = {
            CUTTLELY_DATA_DIR: data,
            FLOWISE_SECRETKEY_OVERWRITE: KEY,
            CUTTLELY_IGNORE_ADMIN_SETTINGS: '1'
        }
        expect(applyAdminSettings(env).ignored).toBe(true)
        expect(env.CUTTLELY_ANALYST).toBeUndefined()
    })

    it('only records what the start script already applied', () => {
        const data = setup({ CUTTLELY_ANALYST: 'auto' })
        const env: Record<string, string | undefined> = {
            CUTTLELY_DATA_DIR: data,
            FLOWISE_SECRETKEY_OVERWRITE: KEY,
            CUTTLELY_SETTINGS_APPLIED: '1',
            CUTTLELY_SETTINGS_HOST_KEYS: '',
            CUTTLELY_ANALYST: 'auto'
        }
        const state = applyAdminSettings(env)
        expect(state.byStartScript).toBe(true)
        expect(state.atStart).toEqual({ CUTTLELY_ANALYST: 'auto' })
        expect(state.hostKeys).toEqual([])
        expect(state.rolledBack).toBe(false)
    })

    it('shows the start script safe boot rollback as this start rolling back', () => {
        const data = setup({ CUTTLELY_ANALYST: 'auto' })
        const env: Record<string, string | undefined> = {
            CUTTLELY_DATA_DIR: data,
            FLOWISE_SECRETKEY_OVERWRITE: KEY,
            CUTTLELY_SETTINGS_APPLIED: '1',
            CUTTLELY_SETTINGS_HOST_KEYS: '',
            CUTTLELY_SETTINGS_ROLLED_BACK: '1'
        }
        expect(applyAdminSettings(env, { start: true }).rolledBack).toBe(true)
        expect(applyAdminSettings({ ...env, CUTTLELY_SETTINGS_ROLLED_BACK: '' }, { start: true }).rolledBack).toBe(false)
    })

    it('ignores a rollback claim when the start script did not run', () => {
        const data = setup({ CUTTLELY_ANALYST: 'auto' })
        const env: Record<string, string | undefined> = {
            CUTTLELY_DATA_DIR: data,
            FLOWISE_SECRETKEY_OVERWRITE: KEY,
            CUTTLELY_SETTINGS_ROLLED_BACK: '1'
        }
        expect(applyAdminSettings(env, { start: true }).rolledBack).toBe(false)
    })
})
