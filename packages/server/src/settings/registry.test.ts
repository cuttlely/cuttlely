import fs from 'fs'
import path from 'path'
import { KEPT_OUT, READ_ONLY_SETTINGS, SECTIONS, SETTINGS, isKeptOut, isReadOnly, settingFor } from './registry'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')

// Never read by the server. They must not come back into the example files.
const UNREAD = new Set([
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_SECURE',
    'SENDER_EMAIL',
    'ALLOW_UNAUTHORIZED_CERTS',
    'JWT_TOKEN_EXPIRY_IN_MINUTES',
    'JWT_REFRESH_TOKEN_EXPIRY_IN_MINUTES',
    'PASSWORD_SALT_HASH_ROUNDS',
    'PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS',
    'INVITE_TOKEN_EXPIRY_IN_HOURS',
    'SECURE_COOKIES',
    'EXPIRE_AUTH_TOKENS_ON_RESTART',
    'WORKSPACE_INVITE_TEMPLATE_PATH',
    'LICENSE_URL',
    'OFFLINE'
])

/** Variable names an example file mentions as NAME= (commented or not). */
function exampleNames(file: string): string[] {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const names = new Set<string>()
    for (const match of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)) names.add(match[1])
    return [...names]
}

/** environment: keys in a compose file, and envVars keys in render.yaml. */
function yamlNames(file: string): string[] {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const names = new Set<string>()
    for (const match of text.matchAll(/^\s{12}([A-Z][A-Z0-9_]+):/gm)) names.add(match[1])
    for (const match of text.matchAll(/-\s+key:\s+([A-Z][A-Z0-9_]+)/g)) names.add(match[1])
    return [...names]
}

describe('server settings registry', () => {
    it('has unique keys, known sections and complete field definitions', () => {
        const keys = SETTINGS.map((setting) => setting.key)
        expect(new Set(keys).size).toBe(keys.length)
        const sections = new Set(SECTIONS.map((section) => section.id))
        for (const setting of SETTINGS) {
            expect(sections.has(setting.section)).toBe(true)
            expect(setting.label.length).toBeGreaterThan(2)
            expect(setting.help.length).toBeGreaterThan(10)
            expect(setting.defaultLabel.length).toBeGreaterThan(0)
            if (setting.type === 'switch') {
                expect(setting.on).toBeDefined()
                expect(setting.off).toBeDefined()
                expect(setting.on).not.toBe(setting.off)
            }
            if (setting.type === 'select') expect(setting.options?.length).toBeGreaterThan(1)
            if (setting.showWhen) expect(settingFor(setting.showWhen.key)).toBeDefined()
            if (setting.min !== undefined && setting.max !== undefined) expect(setting.min).toBeLessThan(setting.max)
        }
    })

    it('every section has at least one setting', () => {
        for (const section of SECTIONS) expect(SETTINGS.some((setting) => setting.section === section.id)).toBe(true)
    })

    it('never lists a setting as both editable and kept out', () => {
        for (const setting of SETTINGS) expect(isKeptOut(setting.key)).toBe(false)
        for (const group of KEPT_OUT) expect(group.why.length).toBeGreaterThan(10)
    })

    it('lists env-only values as read-only entries and keeps them out of the panel', () => {
        const keys = READ_ONLY_SETTINGS.map((setting) => setting.key)
        expect(new Set(keys).size).toBe(keys.length)
        expect(keys.some((key) => key.includes('*'))).toBe(false)
        for (const setting of READ_ONLY_SETTINGS) {
            expect(setting.readOnly).toBe(true)
            expect(settingFor(setting.key)).toBeUndefined()
            expect(isKeptOut(setting.key)).toBe(true)
            expect(isReadOnly(setting.key)).toBe(true)
        }
        expect(isReadOnly('LANGSMITH_PROJECT')).toBe(false)
        expect(isReadOnly('LANGSMITH_ENDPOINT')).toBe(false)
        expect(isKeptOut('LANGSMITH_PROJECT')).toBe(false)
        expect(settingFor('LANGSMITH_PROJECT')?.type).toBe('text')
        expect(settingFor('LANGSMITH_ENDPOINT')?.type).toBe('text')
        expect(settingFor('LOG_SANITIZE_BODY_FIELDS')?.type).toBe('list')
        expect(settingFor('LOG_SANITIZE_HEADER_FIELDS')?.type).toBe('list')
        expect(isKeptOut('LOG_SANITIZE_BODY_FIELDS')).toBe(false)
        expect(isReadOnly('LANGSMITH_SOMETHING_ELSE')).toBe(false)
    })

    it('keeps encryption keys, paths and code-execution switches out of the panel', () => {
        for (const key of [
            'FLOWISE_SECRETKEY_OVERWRITE',
            'CUTTLELY_SECRETKEY_OVERWRITE',
            'SECRETKEY_AWS_ACCESS_KEY',
            'PORT',
            'CUTTLELY_DATA_DIR',
            'CUSTOM_MCP_ALLOWED_COMMANDS',
            'TOOL_FUNCTION_EXTERNAL_DEP',
            'HTTP_SECURITY_CHECK',
            'CUTTLELY_ETL_ROOTS',
            'CUTTLELY_NODE_PACKS',
            'REDIS_PASSWORD'
        ]) {
            expect(settingFor(key)).toBeUndefined()
            expect(isKeptOut(key)).toBe(true)
        }
    })

    it('knows every variable the example files, compose and render.yaml name', () => {
        const files = ['.env.example', 'docker/.env.example', 'packages/server/.env.example']
        const names = [
            ...files.flatMap(exampleNames),
            ...yamlNames('docker-compose.yml'),
            ...yamlNames('docker/docker-compose.yml'),
            ...yamlNames('render.yaml')
        ]
        const unknown = [...new Set(names)].filter((name) => !settingFor(name) && !isKeptOut(name))
        expect(unknown).toEqual([])
        expect(names.filter((name) => UNREAD.has(name))).toEqual([])
    })

    it('leaves the database and storage type out of compose, so they can be changed in Server settings', () => {
        for (const file of ['docker-compose.yml', 'docker/docker-compose.yml']) {
            const names = yamlNames(file)
            expect(names).not.toContain('DATABASE_TYPE')
            expect(names).not.toContain('STORAGE_TYPE')
            expect(names).toContain('CUTTLELY_INSTALL')
        }
    })

    it('uses no section mark and no version-control words in what people read', () => {
        const words = /\u00a7|\b(commit|branch|merge|rebase|repo|repository|git)\b/i
        for (const setting of SETTINGS) {
            expect(setting.label).not.toMatch(words)
            expect(setting.help).not.toMatch(words)
        }
        for (const section of SECTIONS) {
            expect(section.summary).not.toMatch(words)
            expect(section.afterRestart).not.toMatch(words)
        }
    })
})
