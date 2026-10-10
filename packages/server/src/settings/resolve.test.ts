import { HOST_KEYS_VAR, effectiveValue, fileValuesToApply, hostSetKeys, isShown, resolveSettings } from './resolve'
import { settingFor } from './registry'

const pick = (rows: ReturnType<typeof resolveSettings>, key: string) => rows.find((row) => row.key === key)!

describe('server settings resolver', () => {
    it('host beats the settings file, and the file beats the default', () => {
        const rows = resolveSettings({
            env: { CUTTLELY_ANALYST: 'auto', LOG_LEVEL: '' },
            file: { CUTTLELY_ANALYST: '', LOG_LEVEL: 'debug', CUTTLELY_DRAFTS: 'off' }
        })
        expect(pick(rows, 'CUTTLELY_ANALYST')).toEqual({ key: 'CUTTLELY_ANALYST', value: 'auto', source: 'host' })
        expect(pick(rows, 'LOG_LEVEL')).toEqual({ key: 'LOG_LEVEL', value: 'debug', source: 'file' })
        expect(pick(rows, 'CUTTLELY_DRAFTS')).toEqual({ key: 'CUTTLELY_DRAFTS', value: 'off', source: 'file' })
        expect(pick(rows, 'TRUST_PROXY')).toEqual({ key: 'TRUST_PROXY', value: '', source: 'default' })
    })

    it('treats blank values from compose as not set', () => {
        const env = { WORKOS_API_KEY: '', CUTTLELY_ANALYST: '   ', TRUST_PROXY: '1' }
        expect([...hostSetKeys(env)]).toEqual(['TRUST_PROXY'])
    })

    it('uses the start script record of host-set names when it is there', () => {
        const env = { [HOST_KEYS_VAR]: 'TRUST_PROXY, NOT_A_SETTING', CUTTLELY_LOCAL_ADMIN: 'true', TRUST_PROXY: '1' }
        const keys = hostSetKeys(env)
        expect([...keys]).toEqual(['TRUST_PROXY'])
        const rows = resolveSettings({ env, file: { CUTTLELY_LOCAL_ADMIN: 'false' } })
        expect(pick(rows, 'CUTTLELY_LOCAL_ADMIN').source).toBe('file')
        expect(pick(rows, 'CUTTLELY_LOCAL_ADMIN').value).toBe('false')
    })

    it('applies only file values the host did not set, and ignores unknown names', () => {
        const env = { CUTTLELY_ANALYST: 'auto' }
        expect(fileValuesToApply(env, { CUTTLELY_ANALYST: '', LOG_LEVEL: 'warn', PORT: '1', FLOWISE_SECRETKEY_OVERWRITE: 'x' })).toEqual({
            LOG_LEVEL: 'warn'
        })
    })

    it('reports the default as the effective value', () => {
        expect(effectiveValue({ key: 'CUTTLELY_HARNESS_TURN_BUDGET_MS', value: '', source: 'default' })).toBe('45000')
        expect(effectiveValue({ key: 'CUTTLELY_HARNESS_TURN_BUDGET_MS', value: '60000', source: 'file' })).toBe('60000')
    })

    it('shows dependent fields only when their condition holds', () => {
        const host = settingFor('DATABASE_HOST')!
        expect(isShown(host, new Map([['DATABASE_TYPE', 'sqlite']]))).toBe(false)
        expect(isShown(host, new Map([['DATABASE_TYPE', 'postgres']]))).toBe(true)
        expect(isShown(settingFor('CUTTLELY_ANALYST')!, new Map())).toBe(true)
    })
})

describe('start script defaults', () => {
    it('never counts a default the start script filled in as host-set', () => {
        const env = { CUTTLELY_LOCAL_ADMIN: 'true', CUTTLELY_SETTINGS_SCRIPT_DEFAULTS: 'CUTTLELY_LOCAL_ADMIN' }
        expect(hostSetKeys(env).has('CUTTLELY_LOCAL_ADMIN')).toBe(false)
        expect(fileValuesToApply(env, { CUTTLELY_LOCAL_ADMIN: 'false' })).toEqual({ CUTTLELY_LOCAL_ADMIN: 'false' })
        const resolved = resolveSettings({ env }).find((setting) => setting.key === 'CUTTLELY_LOCAL_ADMIN')
        expect(resolved).toEqual({ key: 'CUTTLELY_LOCAL_ADMIN', value: 'true', source: 'default' })
        const fromFile = resolveSettings({ env, file: { CUTTLELY_LOCAL_ADMIN: 'false' } }).find((s) => s.key === 'CUTTLELY_LOCAL_ADMIN')
        expect(fromFile?.source).toBe('file')
    })
})
