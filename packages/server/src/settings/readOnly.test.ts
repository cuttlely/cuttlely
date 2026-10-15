jest.mock('../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => {
        throw new Error('no app in this test')
    }
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import settingsService from '../services/settings'
import { setupState } from './server-setup'
import { READ_ONLY_SETTINGS } from './registry'
import { listReadOnlyStatus, readOnlyStatusFor } from './readOnly'
import { getView } from './service'
import { StartState } from './apply'

const SECRET = 'fake-langsmith-key-b3'
const REDIS = 'redis://fake-user:fake-pass-b3@example.invalid:6399/0'
const JWT = 'fake-jwt-auth-token-b3'
const FIELDS = ['key', 'readOnly', 'set', 'source']

function byKey(env: Record<string, string | undefined>) {
    return new Map(listReadOnlyStatus(env).map((row) => [row.key, row]))
}

describe('read-only setting status', () => {
    it('returns only key, set, source, and readOnly, in the registry order', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ro-'))
        const rows = listReadOnlyStatus({
            PORT: '43117',
            HOST: '  ',
            CUTTLELY_DATA_DIR: dir,
            MODE: 'queue',
            SECRETKEY_PATH: dir,
            SECRETKEY_STORAGE_TYPE: 'aws',
            LANGSMITH_API_KEY: SECRET,
            LANGSMITH_TRACING: 'true',
            LANGSMITH_PROJECT: 'visible-project',
            LANGSMITH_ENDPOINT: 'https://langsmith.example.com',
            LANGSMITH_SOMETHING_ELSE: SECRET,
            REDIS_URL: REDIS,
            REDIS_HOST: '   ',
            REDIS_PORT: 'nope',
            REDIS_PASSWORD: '   ',
            REDIS_TLS: 'TRUE',
            REDIS_CERT: '!!!!',
            JWT_AUTH_TOKEN_SECRET: `  ${JWT}  `,
            TOKEN_HASH_SECRET: '',
            HTTP_SECURITY_CHECK: 'false',
            PATH_TRAVERSAL_SAFETY: '1',
            CUSTOM_MCP_ALLOWED_COMMANDS: '  ',
            BLOB_STORAGE_PATH: ''
        })
        expect(rows.map((row) => row.key)).toEqual(READ_ONLY_SETTINGS.map((setting) => setting.key))
        const text = JSON.stringify(rows)
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain(REDIS)
        expect(text).not.toContain('fake-pass-b3')
        expect(text).not.toContain('example.invalid')
        expect(text).not.toContain(JWT)
        expect(text).not.toContain(dir)
        expect(text).not.toContain('visible-project')
        expect(text).not.toContain('43117')
        expect(text).not.toContain('"value"')
        expect(text).not.toContain('"length"')
        expect(text).not.toContain('"hash"')
        for (const row of rows) expect(Object.keys(row).sort()).toEqual([...FIELDS].sort())
        const status = byKey({
            PORT: '43117',
            HOST: '  ',
            CUTTLELY_DATA_DIR: dir,
            MODE: 'queue',
            SECRETKEY_PATH: dir,
            SECRETKEY_STORAGE_TYPE: 'aws',
            LANGSMITH_API_KEY: SECRET,
            LANGSMITH_TRACING: 'true',
            REDIS_URL: REDIS,
            REDIS_HOST: '   ',
            REDIS_PORT: 'nope',
            REDIS_PASSWORD: '   ',
            REDIS_TLS: 'TRUE',
            REDIS_CERT: '!!!!',
            JWT_AUTH_TOKEN_SECRET: `  ${JWT}  `,
            TOKEN_HASH_SECRET: '',
            HTTP_SECURITY_CHECK: 'false',
            PATH_TRAVERSAL_SAFETY: '1',
            CUSTOM_MCP_ALLOWED_COMMANDS: '  ',
            BLOB_STORAGE_PATH: ''
        })
        expect(status.get('PORT')).toEqual({ key: 'PORT', set: true, source: 'env', readOnly: true })
        expect(status.get('HOST')).toEqual({ key: 'HOST', set: false, source: 'unset', readOnly: true })
        expect(status.get('CUTTLELY_DATA_DIR')).toEqual({ key: 'CUTTLELY_DATA_DIR', set: true, source: 'env', readOnly: true })
        expect(status.get('MODE')).toEqual({ key: 'MODE', set: true, source: 'env', readOnly: true })
        expect(status.get('SECRETKEY_PATH')).toEqual({ key: 'SECRETKEY_PATH', set: true, source: 'env', readOnly: true })
        expect(status.get('SECRETKEY_STORAGE_TYPE')).toEqual({ key: 'SECRETKEY_STORAGE_TYPE', set: true, source: 'env', readOnly: true })
        expect(status.get('LANGSMITH_API_KEY')).toEqual({ key: 'LANGSMITH_API_KEY', set: true, source: 'env', readOnly: true })
        expect(status.get('LANGSMITH_TRACING')).toEqual({ key: 'LANGSMITH_TRACING', set: true, source: 'env', readOnly: true })
        expect(status.get('REDIS_URL')).toEqual({ key: 'REDIS_URL', set: true, source: 'env', readOnly: true })
        expect(status.get('REDIS_HOST')).toEqual({ key: 'REDIS_HOST', set: false, source: 'default', readOnly: true })
        expect(status.get('REDIS_PORT')).toEqual({ key: 'REDIS_PORT', set: false, source: 'unset', readOnly: true })
        expect(status.get('REDIS_PASSWORD')).toEqual({ key: 'REDIS_PASSWORD', set: false, source: 'unset', readOnly: true })
        expect(status.get('REDIS_TLS')).toEqual({ key: 'REDIS_TLS', set: false, source: 'unset', readOnly: true })
        expect(status.get('REDIS_CERT')).toEqual({ key: 'REDIS_CERT', set: false, source: 'unset', readOnly: true })
        expect(status.get('JWT_AUTH_TOKEN_SECRET')).toEqual({ key: 'JWT_AUTH_TOKEN_SECRET', set: true, source: 'env', readOnly: true })
        expect(status.get('TOKEN_HASH_SECRET')).toEqual({ key: 'TOKEN_HASH_SECRET', set: false, source: 'unset', readOnly: true })
        expect(status.get('HTTP_SECURITY_CHECK')).toEqual({ key: 'HTTP_SECURITY_CHECK', set: true, source: 'env', readOnly: true })
        expect(status.get('PATH_TRAVERSAL_SAFETY')).toEqual({ key: 'PATH_TRAVERSAL_SAFETY', set: false, source: 'unset', readOnly: true })
        expect(status.get('CUSTOM_MCP_ALLOWED_COMMANDS')).toEqual({
            key: 'CUSTOM_MCP_ALLOWED_COMMANDS',
            set: false,
            source: 'unset',
            readOnly: true
        })
        expect(status.get('BLOB_STORAGE_PATH')).toEqual({ key: 'BLOB_STORAGE_PATH', set: false, source: 'default', readOnly: true })
        expect(rows.some((row) => row.key === 'LANGSMITH_PROJECT' || row.key === 'LANGSMITH_SOMETHING_ELSE')).toBe(false)
        expect(readOnlyStatusFor({}, 'NOPE')).toBeUndefined()
    })

    it('treats a missing directory, a blank secret file, and a real secret file without returning either', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ro-'))
        const missing = path.join(root, 'missing')
        const empty = path.join(root, 'empty')
        const filled = path.join(root, 'filled')
        fs.mkdirSync(empty)
        fs.mkdirSync(filled)
        fs.writeFileSync(path.join(empty, 'token-hash.secret'), ' \n\t')
        fs.writeFileSync(path.join(filled, 'jwt-auth-token.secret'), JWT)
        const absent = byKey({ SECRETKEY_PATH: missing, TOKEN_HASH_SECRET: '   ' })
        expect(absent.get('SECRETKEY_PATH')).toEqual({ key: 'SECRETKEY_PATH', set: false, source: 'unset', readOnly: true })
        expect(absent.get('TOKEN_HASH_SECRET')?.set).toBe(false)
        const blankFile = byKey({ SECRETKEY_PATH: empty })
        expect(blankFile.get('TOKEN_HASH_SECRET')).toEqual({ key: 'TOKEN_HASH_SECRET', set: false, source: 'unset', readOnly: true })
        expect(blankFile.get('JWT_AUTH_TOKEN_SECRET')?.source).toBe('unset')
        const fromFile = byKey({ SECRETKEY_PATH: filled })
        expect(fromFile.get('JWT_AUTH_TOKEN_SECRET')).toEqual({ key: 'JWT_AUTH_TOKEN_SECRET', set: true, source: 'file', readOnly: true })
        expect(JSON.stringify(fromFile.get('JWT_AUTH_TOKEN_SECRET'))).not.toContain(JWT)
        expect(JSON.stringify(fromFile.get('SECRETKEY_PATH'))).not.toContain(filled)
        const noPath = byKey({})
        expect(noPath.get('JWT_AUTH_TOKEN_SECRET')).toEqual({ key: 'JWT_AUTH_TOKEN_SECRET', set: false, source: 'unset', readOnly: true })
        expect(noPath.get('MODE')).toEqual({ key: 'MODE', set: false, source: 'default', readOnly: true })
        expect(noPath.get('REDIS_PORT')).toEqual({ key: 'REDIS_PORT', set: false, source: 'default', readOnly: true })
        expect(noPath.get('SECRETKEY_STORAGE_TYPE')).toEqual({
            key: 'SECRETKEY_STORAGE_TYPE',
            set: false,
            source: 'default',
            readOnly: true
        })
        expect(byKey({ SECRETKEY_STORAGE_TYPE: 'local' }).get('SECRETKEY_STORAGE_TYPE')?.source).toBe('unset')
        expect(byKey({ REDIS_CERT: Buffer.from('cert').toString('base64') }).get('REDIS_CERT')).toEqual({
            key: 'REDIS_CERT',
            set: true,
            source: 'env',
            readOnly: true
        })
        expect(byKey({ PORT: '0' }).get('PORT')?.set).toBe(false)
        expect(byKey({ PORT: '70000' }).get('PORT')?.source).toBe('unset')
        expect(byKey({ REDIS_URL: 'http://example.invalid' }).get('REDIS_URL')).toEqual({
            key: 'REDIS_URL',
            set: false,
            source: 'unset',
            readOnly: true
        })
    })

    it('keeps the same facts off the public settings payload and the setup page', async () => {
        const previous = process.env.LANGSMITH_API_KEY
        process.env.LANGSMITH_API_KEY = SECRET
        try {
            const listed = await settingsService.getSettings()
            expect(JSON.stringify(listed)).not.toContain(SECRET)
            expect(listed).not.toHaveProperty('readOnly')
            expect(listed).not.toHaveProperty('LANGSMITH_API_KEY')
        } finally {
            if (previous === undefined) delete process.env.LANGSMITH_API_KEY
            else process.env.LANGSMITH_API_KEY = previous
        }
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ro-'))
        const dir = path.join(data, 'settings')
        const env = { CUTTLELY_DATA_DIR: data, LANGSMITH_API_KEY: SECRET, REDIS_URL: REDIS }
        const state: StartState = {
            dir,
            ignored: false,
            byStartScript: false,
            hostKeys: [],
            atStart: {},
            applied: [],
            unreadable: [],
            problems: [],
            rawAtStart: null
        }
        const setup = await setupState({
            service: { env, state, key: async () => 'test-key-not-a-real-secret-0123456789abcdef' },
            users: () => ({
                countUsers: async () => 0,
                createOwner: async () => {
                    throw new Error('not used')
                }
            })
        })
        const setupText = JSON.stringify(setup)
        expect(setupText).not.toContain(SECRET)
        expect(setupText).not.toContain(REDIS)
        expect(setupText).not.toContain('fake-pass-b3')
        expect(setup).not.toHaveProperty('readOnly')
        expect(setup.settings.some((setting) => setting.key === 'LANGSMITH_API_KEY' || setting.key === 'PORT')).toBe(false)
        const view = await getView({ env, state, key: async () => 'test-key-not-a-real-secret-0123456789abcdef' })
        const level = view.settings.find((setting) => setting.key === 'LOG_LEVEL')
        expect(level).toHaveProperty('value')
        expect(view.readOnly.find((row) => row.key === 'LOG_LEVEL')).toBeUndefined()
        const apiKey = view.readOnly.find((row) => row.key === 'LANGSMITH_API_KEY')
        expect(apiKey).toEqual({ key: 'LANGSMITH_API_KEY', set: true, source: 'env', readOnly: true })
        expect(JSON.stringify(view.readOnly)).not.toContain(SECRET)
        expect(view.settings.find((setting) => setting.key === 'LANGSMITH_PROJECT')).toMatchObject({ value: '' })
    })
})
