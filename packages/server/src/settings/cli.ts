// pnpm settings list | unset NAME | restore
// The way back in when a saved setting keeps the server from starting or locks you out.
// A runtime limit applies on the next use. Every other change applies at the next start.
// Secret values are never printed.
import fs from 'fs'
import path from 'path'
import { appendHistory, describeChanges } from './history'
import { SettingsBusyError, withSettingsLockSync } from './lock'
import { SETTINGS, settingFor } from './registry'
import { hostSetKeys, resolveSettings } from './resolve'
import { runtimeSnapshot } from './runtime'
import { ROLLED_BACK_FILE } from './safeboot'
import { LAST_GOOD_FILE, SETTINGS_FILE, encryptionKeySync, readSettingsFile, settingsDir, writeFileAtomic } from './store'

type Env = Record<string, string | undefined>

export interface CliResult {
    code: number
    lines: string[]
}

const BY = 'command line'
const NEXT_START = 'It applies the next time Cuttlely starts.'

function appliesLater(name: string): string {
    if (settingFor(name)?.runtime) return 'It applies the next time that limit is used.'
    return NEXT_START
}

function listSettings(env: Env, all: boolean): CliResult {
    const dir = settingsDir(env)
    const read = readSettingsFile(dir, encryptionKeySync(env))
    const rows = resolveSettings({ env, hostKeys: hostSetKeys(env), file: read.values })
    const live = runtimeSnapshot(env)
    const lines = [`Settings file: ${path.join(dir, SETTINGS_FILE)}${read.exists ? '' : ' (none yet)'}`]
    const shown = rows.filter((row) => {
        if (all || read.unreadable.includes(row.key)) return true
        const resolved = live.get(row.key)
        // A host or saved value that does not resolve still belongs on the list, with the value in effect.
        if (resolved) return resolved.source !== 'default' || row.source !== 'default'
        return row.source !== 'default'
    })
    if (!shown.length) lines.push('Nothing is set. Every setting uses its default.')
    for (const row of shown) {
        const setting = settingFor(row.key)
        const resolved = live.get(row.key)
        let value = row.value
        let source: string
        if (resolved) {
            value = String(resolved.value)
            source = resolved.source
            if (resolved.source === 'bounded' && resolved.boundedBy) value = `${value}  Limited by ${resolved.boundedBy}`
        } else {
            const secret = setting?.type === 'secret'
            if (read.unreadable.includes(row.key) && row.source !== 'host') value = '(saved, cannot be read with this key)'
            else if (secret) value = row.value ? '(set, hidden)' : '(not set)'
            else if (!value) value = `(default: ${setting?.defaultLabel ?? 'none'})`
            source = row.source === 'host' ? 'host, locked' : row.source === 'file' ? 'settings file' : 'default'
        }
        lines.push(`${row.key.padEnd(38)} ${source.padEnd(14)} ${value}`)
    }
    for (const problem of read.problems) lines.push(`Note: ${problem}`)
    return { code: 0, lines }
}

function unsetSetting(env: Env, name: string | undefined): CliResult {
    if (!name) return { code: 2, lines: ['Name the setting to remove, for example: pnpm settings unset CUTTLELY_LOCAL_ADMIN'] }
    const dir = settingsDir(env)
    try {
        return withSettingsLockSync(dir, () => {
            const file = path.join(dir, SETTINGS_FILE)
            let parsed: { values?: Record<string, unknown> }
            try {
                parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return { code: 0, lines: [`There is no settings file, so ${name} is not saved there.`] }
                return {
                    code: 1,
                    lines: [
                        'The settings file could not be read. Run pnpm settings restore, or start with CUTTLELY_IGNORE_ADMIN_SETTINGS=1.'
                    ]
                }
            }
            const stored = parsed.values
            if (!stored || !Object.prototype.hasOwnProperty.call(stored, name)) {
                return { code: 0, lines: [`${name} is not saved in the settings file. Nothing changed.`] }
            }
            const before = readSettingsFile(dir, encryptionKeySync(env)).values
            delete stored[name]
            // Edit the stored JSON directly, so secrets this key cannot read are kept as they are.
            writeFileAtomic(
                dir,
                SETTINGS_FILE,
                JSON.stringify({ ...parsed, updatedAt: new Date().toISOString(), updatedBy: BY }, null, 2) + '\n'
            )
            const after = { ...before }
            delete after[name]
            const changes = settingFor(name) ? describeChanges(before, after) : []
            appendHistory(dir, { kind: 'unset', by: BY, changes: changes.length ? changes : [{ key: name }], outcome: 'ok' })
            return { code: 0, lines: [`Removed ${name} from the settings file. ${appliesLater(name)}`] }
        })
    } catch (error) {
        if (error instanceof SettingsBusyError) return { code: 1, lines: [error.message] }
        throw error
    }
}

function restoreLastGood(env: Env): CliResult {
    const dir = settingsDir(env)
    const file = path.join(dir, SETTINGS_FILE)
    if (!fs.existsSync(file)) return { code: 0, lines: ['There is no settings file. Cuttlely starts with host values and defaults.'] }
    const key = encryptionKeySync(env)
    const before = readSettingsFile(dir, key).values
    const current = fs.readFileSync(file, 'utf8')
    const lastGoodPath = path.join(dir, LAST_GOOD_FILE)
    writeFileAtomic(dir, ROLLED_BACK_FILE, current)
    let line: string
    if (fs.existsSync(lastGoodPath)) {
        const lastGood = fs.readFileSync(lastGoodPath, 'utf8')
        if (lastGood === current)
            return { code: 0, lines: ['The settings file already matches the last settings that started. Nothing changed.'] }
        writeFileAtomic(dir, SETTINGS_FILE, lastGood)
        line = `Restored the last settings that started. ${NEXT_START}`
    } else {
        fs.rmSync(file, { force: true })
        line = `No settings have started successfully yet, so the settings file was set aside. ${NEXT_START}`
    }
    const after = fs.existsSync(file) ? readSettingsFile(dir, key).values : {}
    appendHistory(dir, { kind: 'restore', by: BY, changes: describeChanges(before, after), outcome: 'ok' })
    return { code: 0, lines: [line, `The previous file is kept as ${path.join(dir, ROLLED_BACK_FILE)}.`] }
}

export function runSettingsCli(args: string[], env: Env = process.env): CliResult {
    const [action, name] = args
    switch (action) {
        case 'list':
            return listSettings(env, name === '--all' || name === 'all')
        case 'unset':
            return unsetSetting(env, name)
        case 'restore':
            return restoreLastGood(env)
        default:
            return {
                code: 2,
                lines: [
                    'Usage:',
                    '  pnpm settings list [--all]   what is set, and where it comes from (secrets stay hidden)',
                    '  pnpm settings unset NAME     remove one saved setting',
                    '  pnpm settings restore        go back to the last settings that started',
                    `Known settings: ${SETTINGS.length}. Runtime limits apply on the next use. Every other change applies at the next start.`
                ]
            }
    }
}
