import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { POSTGRES_SETTINGS_FILES, POSTGRES_SETTINGS_URL } from '../settings/postgres'
import { POSTGRES_SETTINGS_MARKER, postgresSettingsCodec } from '../settings/postgresCodec'
import { settingsDir } from '../settings/store'

export type Env = Record<string, string | undefined>
type Row = Record<string, unknown>
type PostgresConnection = { query: (sql: string) => Promise<{ rows: Row[] }>; connect: () => Promise<void>; end: () => Promise<void> }
export type Rows = (sql: string) => Promise<Row[]>

export async function withPostgres<T>(options: Record<string, unknown>, work: (rows: Rows) => Promise<T>): Promise<T> {
    const { Client } = require('pg')
    const client: PostgresConnection = new Client({
        ...options,
        application_name: 'Cuttlely key inventory',
        connectionTimeoutMillis: 3000,
        statement_timeout: 10000,
        query_timeout: 12000
    })
    try {
        await client.connect()
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return await work(async (sql) => (await client.query(sql)).rows)
    } finally {
        await client.end()
    }
}

export function optionalFile(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return null
    }
}

export async function settingsDocuments(env: Env, key: string): Promise<Map<string, string>> {
    const url = env[POSTGRES_SETTINGS_URL]?.trim()
    if (!url) {
        const docs = new Map<string, string>()
        for (const file of POSTGRES_SETTINGS_FILES) {
            const text = optionalFile(path.join(settingsDir(env), file))
            if (text !== null) docs.set(file, text)
        }
        return docs
    }
    return withPostgres({ connectionString: url }, async (rows) => {
        const { unseal } = postgresSettingsCodec(key, env.CUTTLELY_CREDENTIAL_GENERATION)
        const docs = new Map<string, string>()
        let verified = false
        for (const { name, payload } of await rows('SELECT name, payload FROM public.cuttlely_server_settings')) {
            if (typeof name !== 'string' || !Buffer.isBuffer(payload)) throw new Error('Invalid settings document')
            const text = unseal(name, payload)
            if (name === POSTGRES_SETTINGS_MARKER && text === '1') verified = true
            else if (POSTGRES_SETTINGS_FILES.has(name)) docs.set(name, text)
            else throw new Error('Unknown settings document')
        }
        if (!verified) throw new Error('Invalid settings marker')
        return docs
    })
}

export async function scanApplicationDatabase<T>(env: Env, work: (rows: Rows, postgres: boolean) => Promise<T>): Promise<T> {
    if (env.DATABASE_TYPE === 'postgres') {
        return withPostgres(applicationPostgresOptions(env), (rows) => work(rows, true))
    }
    const home = env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] ?? process.cwd()
    const file = path.resolve(env.DATABASE_PATH ?? path.join(home, '.cuttlely'), 'database.sqlite')
    const client = new DatabaseSync(file, { readOnly: true })
    try {
        client.exec('BEGIN')
        return await work(async (sql) => client.prepare(sql).all(), false)
    } finally {
        client.close()
    }
}

export function applicationPostgresOptions(env: Env) {
    return {
        host: env.DATABASE_HOST,
        port: parseInt(env.DATABASE_PORT || '5432'),
        user: env.DATABASE_USER,
        password: env.DATABASE_PASSWORD,
        database: env.DATABASE_NAME,
        ssl: env.DATABASE_SSL_KEY_BASE64
            ? { rejectUnauthorized: env.DATABASE_REJECT_UNAUTHORIZED === 'true', ca: Buffer.from(env.DATABASE_SSL_KEY_BASE64, 'base64') }
            : env.DATABASE_SSL === 'true' || undefined
    }
}
