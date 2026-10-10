// Plain words for a database setting, and the previous database kept by Switch database. No side effects.
import { SETTINGS } from './registry'
import { effectiveValue, resolveSettings } from './resolve'
import { readSettingsFile } from './store'

export const DATABASE_KEYS = SETTINGS.filter((setting) => setting.section === 'database').map((setting) => setting.key)
export const PREVIOUS_DATABASE_FILE = 'database.previous.json'

type Values = Record<string, string>
type Env = Record<string, string | undefined>

export interface DatabaseSummary {
    type: 'sqlite' | 'postgres'
    label: string
}

export function describeDatabase(values: Values): DatabaseSummary {
    if ((values.DATABASE_TYPE || 'sqlite') !== 'postgres') return { type: 'sqlite', label: 'SQLite, on this server' }
    const port = values.DATABASE_PORT && values.DATABASE_PORT !== '5432' ? `:${values.DATABASE_PORT}` : ''
    return { type: 'postgres', label: `Postgres, ${values.DATABASE_NAME || 'no name'} on ${values.DATABASE_HOST || 'no host'}${port}` }
}

export function effectiveValues(env: Env, hostKeys: Set<string>, file: Values): Values {
    return Object.fromEntries(resolveSettings({ env, hostKeys, file }).map((row) => [row.key, effectiveValue(row)]))
}

export function previousDatabaseSummary(dir: string, key: string, env: Env, hostKeys: Set<string>): DatabaseSummary | null {
    const read = readSettingsFile(dir, key, PREVIOUS_DATABASE_FILE)
    if (!read.exists) return null
    return describeDatabase(effectiveValues(env, hostKeys, read.values))
}
