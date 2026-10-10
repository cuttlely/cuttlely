// Run by scripts/start-cuttlely.sh before it fills in any default:
//   node packages/server/dist/settings/env-cli.js start
// Prints NAME=VALUE records separated by NUL bytes on stdout for the script to export: the names the host set,
// the settings file values for every other name, CUTTLELY_SETTINGS_ROLLED_BACK (1 when safe boot put back the last
// good settings on this start, else empty) and CUTTLELY_SETTINGS_APPLIED=1. The output goes straight into the
// script's environment through a pipe. It is never written to a file or a log. Messages go to stderr, without values.
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { APPLIED_VAR, IGNORE_VAR, ROLLED_BACK_VAR, isOnValue } from './apply'
import { HOST_KEYS_VAR, SCRIPT_DEFAULTS_VAR, fileValuesToApply, hostSetKeys } from './resolve'
import { beginStart } from './safeboot'
import { encryptionKeySync, readSettingsFile, settingsDir } from './store'

type Env = Record<string, string | undefined>

export function startRecords(processEnv: Env, dotenvText: string | null, log: (line: string) => void): string[] {
    const env: Env = { ...processEnv }
    delete env[HOST_KEYS_VAR]
    delete env[SCRIPT_DEFAULTS_VAR]
    delete env[APPLIED_VAR]
    delete env[ROLLED_BACK_VAR]
    if (dotenvText) Object.assign(env, dotenv.parse(dotenvText))
    const hostKeys = hostSetKeys(env)
    const records = [`${HOST_KEYS_VAR}=${[...hostKeys].sort().join(',')}`]
    if (isOnValue(env[IGNORE_VAR])) {
        log('Server settings file ignored (CUTTLELY_IGNORE_ADMIN_SETTINGS is on).')
        return records
    }
    const dir = settingsDir(env)
    const key = encryptionKeySync(env)
    const boot = beginStart(dir, key)
    if (boot.message) log(boot.message)
    const read = readSettingsFile(dir, key)
    for (const [name, value] of Object.entries(fileValuesToApply(env, read.values, hostKeys))) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.includes('\0')) continue
        records.push(`${name}=${value}`)
    }
    // Always set, so a value left in the host environment can never claim a rollback that did not happen.
    records.push(`${ROLLED_BACK_VAR}=${boot.rolledBack ? '1' : ''}`)
    records.push(`${APPLIED_VAR}=1`)
    return records
}

if (require.main === module) {
    const command = process.argv[2]
    if (command !== 'start') {
        process.stderr.write('Usage: node env-cli.js start\n')
        process.exit(2)
    }
    let dotenvText: string | null = null
    try {
        dotenvText = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8')
    } catch {
        dotenvText = null
    }
    try {
        const records = startRecords(process.env, dotenvText, (line) => process.stderr.write(`${line}\n`))
        process.stdout.write(records.map((record) => `${record}\0`).join(''))
    } catch (error) {
        process.stderr.write(
            `Server settings could not be read (${error instanceof Error ? error.name : 'error'}). Starting without them.\n`
        )
        process.exit(1)
    }
}
