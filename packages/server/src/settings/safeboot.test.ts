import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runSettingsCli } from './cli'
import { resetRuntimeLimitsForTests } from './runtime'
import { startRecords } from './env-cli'
import { appendHistory, describeChanges, readHistory } from './history'
import { RESTART_EXIT_CODE, requestRestart, restartInPlaceAvailable, setRestartHandler } from './restart'
import { BOOT_FILE, ROLLED_BACK_FILE, beginStart, finishStart, markStartFinished, readBootState } from './safeboot'
import { HISTORY_FILE, LAST_GOOD_FILE, SETTINGS_FILE, readSettingsFile, writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const SECRET = 'sk-made-up-0000-bakery'

function data(): { data: string; dir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-safeboot-'))
    return { data: root, dir: path.join(root, 'settings') }
}

describe('history', () => {
    it('records secrets as set, replaced or removed, never the value', () => {
        const changes = describeChanges(
            { LOG_LEVEL: 'info', CUTTLELY_POSTGRES_URL: 'old-made-up' },
            { LOG_LEVEL: 'debug', CUTTLELY_POSTGRES_URL: SECRET, DATABASE_PASSWORD: 'pw-made-up' }
        )
        expect(changes).toEqual([
            { key: 'CUTTLELY_POSTGRES_URL', secret: 'changed' },
            { key: 'DATABASE_PASSWORD', secret: 'changed' },
            { key: 'LOG_LEVEL', from: 'info', to: 'debug' }
        ])
        const { dir } = data()
        appendHistory(dir, {
            kind: 'save',
            by: 'owner@example.com',
            changes: [...changes, { key: 'DATABASE_PASSWORD', from: 'x', to: 'leak' }]
        })
        appendHistory(dir, { kind: 'restart', by: 'owner@example.com', outcome: 'ok' })
        const raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
        expect(raw).not.toContain(SECRET)
        expect(raw).not.toContain('leak')
        fs.appendFileSync(path.join(dir, HISTORY_FILE), 'not json\n')
        const entries = readHistory(dir)
        expect(entries.map((entry) => entry.kind)).toEqual(['restart', 'save'])
    })
})

describe('safe boot', () => {
    it('does nothing before there is a settings folder', () => {
        const { dir } = data()
        expect(beginStart(dir, KEY)).toEqual({ rolledBack: false })
        expect(fs.existsSync(dir)).toBe(false)
    })

    it('restores the last good settings after two starts that did not finish', () => {
        const { dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        beginStart(dir, KEY)
        markStartFinished(dir)
        expect(fs.existsSync(path.join(dir, LAST_GOOD_FILE))).toBe(true)
        writeSettingsFile(dir, { LOG_LEVEL: 'debug', CUTTLELY_POSTGRES_URL: SECRET }, { key: KEY })
        expect(beginStart(dir, KEY).rolledBack).toBe(false)
        expect(beginStart(dir, KEY).rolledBack).toBe(false)
        const third = beginStart(dir, KEY)
        expect(third.rolledBack).toBe(true)
        expect(third.message).toMatch(/last 2 starts did not finish/)
        expect(third.message).not.toContain(SECRET)
        expect(readSettingsFile(dir, KEY).values).toEqual({ LOG_LEVEL: 'info' })
        expect(fs.existsSync(path.join(dir, ROLLED_BACK_FILE))).toBe(true)
        const [entry] = readHistory(dir)
        expect(entry.kind).toBe('rollback')
        expect(entry.changes).toEqual([
            { key: 'CUTTLELY_POSTGRES_URL', secret: 'changed' },
            { key: 'LOG_LEVEL', from: 'debug', to: 'info' }
        ])
        expect(readBootState(dir).pending).toBe(1)
    })

    it('sets a file aside when no settings ever started', () => {
        const { dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'debug' }, { key: KEY })
        beginStart(dir, KEY)
        beginStart(dir, KEY)
        expect(beginStart(dir, KEY).rolledBack).toBe(true)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('never rolls back an unchanged file, whatever stopped the start', () => {
        const { dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        markStartFinished(dir)
        for (let i = 0; i < 4; i++) expect(beginStart(dir, KEY).rolledBack).toBe(false)
        expect(JSON.parse(fs.readFileSync(path.join(dir, BOOT_FILE), 'utf8')).pending).toBe(4)
    })
})

describe('a start that cannot open the database', () => {
    it('never makes changed settings the last good copy, stops, and rolls back on the third start', () => {
        const { dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        beginStart(dir, KEY)
        expect(finishStart(dir, true)).toBe('finished')
        const good = fs.readFileSync(path.join(dir, LAST_GOOD_FILE), 'utf8')
        // A saved database host that cannot be reached (made-up values).
        writeSettingsFile(
            dir,
            { LOG_LEVEL: 'info', DATABASE_TYPE: 'postgres', DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '1' },
            { key: KEY }
        )
        for (let start = 1; start <= 2; start++) {
            expect(beginStart(dir, KEY).rolledBack).toBe(false)
            expect(finishStart(dir, false)).toBe('stop')
            expect(fs.readFileSync(path.join(dir, LAST_GOOD_FILE), 'utf8')).toBe(good)
            expect(readBootState(dir).pending).toBe(start)
        }
        const third = beginStart(dir, KEY)
        expect(third.rolledBack).toBe(true)
        expect(readSettingsFile(dir, KEY).values).toEqual({ LOG_LEVEL: 'info' })
        expect(fs.existsSync(path.join(dir, ROLLED_BACK_FILE))).toBe(true)
        expect(finishStart(dir, true)).toBe('finished')
        expect(readBootState(dir).pending).toBe(0)
    })

    it('keeps running as before when the settings are the ones that last worked (no restart loop)', () => {
        const { dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        markStartFinished(dir)
        beginStart(dir, KEY)
        expect(finishStart(dir, false)).toBe('stay')
        expect(readBootState(dir).pending).toBe(1)
    })

    it('keeps running as before with no settings file or folder', () => {
        const { dir } = data()
        expect(finishStart(dir, false)).toBe('stay')
        fs.mkdirSync(dir, { recursive: true })
        expect(finishStart(dir, false)).toBe('stay')
    })
})

describe('start script helper', () => {
    it('records host names first, then hands over file values for the rest', () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'debug', CUTTLELY_ANALYST: 'auto', CUTTLELY_POSTGRES_URL: SECRET }, { key: KEY })
        const logs: string[] = []
        const records = startRecords(
            { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY, LOG_LEVEL: 'warn', CUTTLELY_SETTINGS_HOST_KEYS: 'BOGUS' },
            'CUTTLELY_ANALYST=\n# comment\nCUTTLELY_VERSIONS=off\n',
            (line) => logs.push(line)
        )
        expect(records[0]).toBe('CUTTLELY_SETTINGS_HOST_KEYS=CUTTLELY_VERSIONS,LOG_LEVEL')
        expect(records).toContain('CUTTLELY_ANALYST=auto')
        expect(records).toContain(`CUTTLELY_POSTGRES_URL=${SECRET}`)
        expect(records).not.toContain('LOG_LEVEL=debug')
        expect(records[records.length - 1]).toBe('CUTTLELY_SETTINGS_APPLIED=1')
        expect(logs.join('\n')).not.toContain(SECRET)
        expect(readBootState(dir).pending).toBe(1)
        expect(records).toContain('CUTTLELY_SETTINGS_ROLLED_BACK=')
    })

    it('tells the server when its safe boot put back the last good settings, and never passes on a stale claim', () => {
        const { data: root, dir } = data()
        const env = { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY, CUTTLELY_SETTINGS_ROLLED_BACK: '1' }
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        expect(startRecords(env, null, () => {})).toContain('CUTTLELY_SETTINGS_ROLLED_BACK=')
        markStartFinished(dir)
        writeSettingsFile(dir, { LOG_LEVEL: 'debug', CUTTLELY_POSTGRES_URL: SECRET }, { key: KEY })
        const logs: string[] = []
        expect(startRecords(env, null, (line) => logs.push(line))).toContain('CUTTLELY_SETTINGS_ROLLED_BACK=')
        expect(startRecords(env, null, (line) => logs.push(line))).toContain('CUTTLELY_SETTINGS_ROLLED_BACK=')
        const third = startRecords(env, null, (line) => logs.push(line))
        expect(third).toContain('CUTTLELY_SETTINGS_ROLLED_BACK=1')
        expect(third).toContain('LOG_LEVEL=info')
        expect(third).not.toContain(`CUTTLELY_POSTGRES_URL=${SECRET}`)
        expect(third[third.length - 1]).toBe('CUTTLELY_SETTINGS_APPLIED=1')
        expect(logs.join('\n')).toMatch(/starts did not finish/)
        expect(logs.join('\n')).not.toContain(SECRET)
    })

    it('hands over nothing when the ignore flag is on', () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto' }, { key: KEY })
        const logs: string[] = []
        const records = startRecords({ CUTTLELY_DATA_DIR: root, CUTTLELY_IGNORE_ADMIN_SETTINGS: 'true' }, null, (line) => logs.push(line))
        expect(records).toEqual(['CUTTLELY_SETTINGS_HOST_KEYS='])
        expect(logs[0]).toMatch(/ignored/)
    })
})

describe('pnpm settings', () => {
    it('lists what is set and where it comes from, with secrets hidden', () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'debug', CUTTLELY_POSTGRES_URL: SECRET }, { key: KEY })
        const result = runSettingsCli(['list'], { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY, CUTTLELY_ANALYST: 'auto' })
        const text = result.lines.join('\n')
        expect(text).not.toContain(SECRET)
        expect(text).toMatch(/CUTTLELY_POSTGRES_URL\s+settings file\s+\(set, hidden\)/)
        expect(text).toMatch(/LOG_LEVEL\s+settings file\s+debug/)
        expect(text).toMatch(/CUTTLELY_ANALYST\s+host, locked\s+auto/)
        expect(text).not.toMatch(/CUTTLELY_VERSIONS/)
        expect(runSettingsCli(['list', '--all'], { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY }).lines.join('\n')).toMatch(
            /CUTTLELY_VERSIONS\s+default/
        )
    })

    it('removes one setting and keeps secrets it cannot read', () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_POSTGRES_URL: SECRET }, { key: KEY })
        const result = runSettingsCli(['unset', 'CUTTLELY_LOCAL_ADMIN'], { CUTTLELY_DATA_DIR: root })
        expect(result.code).toBe(0)
        expect(result.lines[0]).toMatch(/Removed CUTTLELY_LOCAL_ADMIN/)
        expect(readSettingsFile(dir, KEY).values).toEqual({ CUTTLELY_POSTGRES_URL: SECRET })
        expect(readHistory(dir)[0]).toMatchObject({ kind: 'unset', by: 'command line' })
        expect(runSettingsCli(['unset', 'CUTTLELY_LOCAL_ADMIN'], { CUTTLELY_DATA_DIR: root }).lines[0]).toMatch(/Nothing changed/)
        expect(runSettingsCli(['unset'], { CUTTLELY_DATA_DIR: root }).code).toBe(2)
    })

    it('removes two settings that are unset at the same time', async () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { LOG_LEVEL: 'debug', CUTTLELY_VERSIONS: 'off' }, { key: KEY })
        await Promise.all([unsetInChild(root, 'LOG_LEVEL'), unsetInChild(root, 'CUTTLELY_VERSIONS')])
        expect(readSettingsFile(dir, KEY).values).toEqual({})
    })

    it('restores the last settings that started', () => {
        const { data: root, dir } = data()
        const env = { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY }
        expect(runSettingsCli(['restore'], env).lines[0]).toMatch(/no settings file/)
        writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY })
        markStartFinished(dir)
        expect(runSettingsCli(['restore'], env).lines[0]).toMatch(/already matches/)
        writeSettingsFile(dir, { LOG_LEVEL: 'debug' }, { key: KEY })
        expect(runSettingsCli(['restore'], env).lines[0]).toMatch(/Restored/)
        expect(readSettingsFile(dir, KEY).values).toEqual({ LOG_LEVEL: 'info' })
        expect(readHistory(dir)[0].changes).toEqual([{ key: 'LOG_LEVEL', from: 'debug', to: 'info' }])
    })

    it('explains itself without an action', () => {
        expect(runSettingsCli([], {}).lines.join('\n')).toMatch(/pnpm settings restore/)
        expect(runSettingsCli([], {}).lines.join('\n')).toMatch(/Runtime limits apply on the next use/)
    })

    it('lists a runtime limit from the resolved snapshot, not the raw host string', () => {
        resetRuntimeLimitsForTests()
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const { data: root, dir } = data()
            writeSettingsFile(dir, { CUTTLELY_CHECK_MAX_SECONDS: '30' }, { key: KEY })
            const env = {
                CUTTLELY_DATA_DIR: root,
                FLOWISE_SECRETKEY_OVERWRITE: KEY,
                CUTTLELY_CHECK_CONCURRENCY: '99'
            }
            const text = runSettingsCli(['list'], env).lines.join('\n')
            expect(text).toMatch(/CUTTLELY_CHECK_CONCURRENCY\s+default\s+2/)
            expect(text).not.toContain('99')
            expect(text).toMatch(/CUTTLELY_CHECK_MAX_SECONDS\s+panel\s+30/)
            const host = runSettingsCli(['list'], { ...env, CUTTLELY_CHECK_CONCURRENCY: '6' }).lines.join('\n')
            expect(host).toMatch(/CUTTLELY_CHECK_CONCURRENCY\s+host\s+6/)
            expect(host).not.toMatch(/CUTTLELY_CHECK_CONCURRENCY\s+host, locked/)
            const raw = runSettingsCli(['list'], { ...env, CUTTLELY_CHECK_CONCURRENCY: '6.0' }).lines.join('\n')
            expect(raw).toMatch(/CUTTLELY_CHECK_CONCURRENCY\s+default\s+2/)
            expect(raw).not.toContain('6.0')
        } finally {
            warn.mockRestore()
            resetRuntimeLimitsForTests()
        }
    })

    it('lists a bounded partner as bounded, naming the host limit', () => {
        resetRuntimeLimitsForTests()
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const { data: root } = data()
            const text = runSettingsCli(['list'], { CUTTLELY_DATA_DIR: root, CUTTLELY_CHECK_COUNT_MAX: '1' }).lines.join('\n')
            expect(text).toMatch(/CUTTLELY_CHECK_COUNT_MAX\s+host\s+1/)
            expect(text).toMatch(/CUTTLELY_CHECK_COUNT_DEFAULT\s+bounded\s+1\s+Limited by CUTTLELY_CHECK_COUNT_MAX/)
            expect(text).not.toMatch(/CUTTLELY_CHECK_COUNT_DEFAULT\s+host/)
        } finally {
            warn.mockRestore()
            resetRuntimeLimitsForTests()
        }
    })

    it('does not wait for the next start when a runtime limit is removed', () => {
        const { data: root, dir } = data()
        writeSettingsFile(dir, { CUTTLELY_CHECK_CONCURRENCY: '4', CUTTLELY_LOCAL_ADMIN: 'false' }, { key: KEY })
        const env = { CUTTLELY_DATA_DIR: root, FLOWISE_SECRETKEY_OVERWRITE: KEY }
        const runtime = runSettingsCli(['unset', 'CUTTLELY_CHECK_CONCURRENCY'], env)
        expect(runtime.code).toBe(0)
        expect(runtime.lines[0]).toMatch(/Removed CUTTLELY_CHECK_CONCURRENCY/)
        expect(runtime.lines[0]).toMatch(/next time that limit is used/)
        expect(runtime.lines[0]).not.toMatch(/next time Cuttlely starts/)
        const restart = runSettingsCli(['unset', 'CUTTLELY_LOCAL_ADMIN'], env)
        expect(restart.lines[0]).toMatch(/next time Cuttlely starts/)
    })
})

function unsetInChild(dataDir: string, name: string): Promise<void> {
    const cliFile = path.join(__dirname, 'cli.ts')
    const code = `
        require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, target: 'ES2022' } })
        const { runSettingsCli } = require(${JSON.stringify(cliFile)})
        const result = runSettingsCli(['unset', process.argv[1]], { CUTTLELY_DATA_DIR: process.argv[2] })
        if (result.code !== 0) throw new Error(result.lines.join('\\n'))
    `
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code, name, dataDir], { cwd: path.resolve(__dirname, '../..') })
        let err = ''
        child.stderr.on('data', (chunk) => {
            err += String(chunk)
        })
        child.on('exit', (status) => {
            if (status === 0) resolve()
            else reject(new Error(err || `unset exited ${status}`))
        })
    })
}

describe('restart in place', () => {
    it('is available only under the start script, and runs the handler once', async () => {
        expect(RESTART_EXIT_CODE).toBe(75)
        expect(restartInPlaceAvailable({})).toBe(false)
        expect(requestRestart({ env: {} })).toBe(false)
        const handler = jest.fn(async () => undefined)
        setRestartHandler(handler)
        expect(requestRestart({ env: { CUTTLELY_SUPERVISED: '1' }, delayMs: 1 })).toBe(true)
        expect(requestRestart({ env: { CUTTLELY_SUPERVISED: '1' }, delayMs: 1 })).toBe(false)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(handler).toHaveBeenCalledTimes(1)
        setRestartHandler(null)
    })
})
