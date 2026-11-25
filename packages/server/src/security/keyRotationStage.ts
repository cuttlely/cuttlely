import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import { forCredentialGeneration, newCredentialGeneration } from '../settings/credentialEnvelope'
import type { CredentialStageDatabase } from '../settings/credentialStage'
import { acceptStagedCredentialGeneration, stageApplicationCredentialRecords } from '../settings/credentialStage'
import { stageAnalystRoleFiles, stageSettingsDocuments } from '../settings/credentialStageFiles'
import { POSTGRES_SETTINGS_FILES, POSTGRES_SETTINGS_URL, settingsPostgresConnection } from '../settings/postgres'
import { POSTGRES_SETTINGS_MARKER, postgresSettingsCodec } from '../settings/postgresCodec'
import { encryptionKeyOverwrite } from '../settings/settingAlias'
import { settingsDir } from '../settings/store'
import { inventoryCredentialKey } from './keyInventory'
import { applicationPostgresOptions, Env, optionalFile, settingsDocuments } from './keyInventorySources'

const stagingDatabase = /^cuttlely_rotation_[a-z0-9_]+$/
const journalName = 'credential-rotation.json'
type PgSession = {
    connect: () => Promise<void>
    end: () => Promise<void>
    query: (sql: string, params?: readonly unknown[]) => Promise<{ rowCount: number; rows: Record<string, unknown>[] }>
}

function isolatedDir(root: string, dir: string | undefined): string {
    if (!dir || !path.isAbsolute(dir)) throw new Error('A staging directory must be explicit.')
    const real = fs.realpathSync(dir)
    if (!real.startsWith(root + path.sep)) throw new Error('A staging directory is outside the staging copy.')
    return real
}

function safeFile(file: string) {
    const info = fs.lstatSync(file, { throwIfNoEntry: false })
    if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('The staging copy must contain independent files.')
}

function writeStaged(file: string, value: string) {
    const temporary = file + '.' + randomUUID()
    try {
        fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx', flush: true })
        fs.renameSync(temporary, file)
    } finally {
        fs.rmSync(temporary, { force: true })
    }
}

async function withOfflinePostgres<T>(options: Record<string, unknown>, work: (session: PgSession) => Promise<T>): Promise<T> {
    const { Client } = require('pg')
    const connection: PgSession = new Client({
        ...options,
        application_name: 'Cuttlely credential rotation staging',
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
        lock_timeout: 2000
    })
    try {
        await connection.connect()
        const [state] = (
            await connection.query(
                'SELECT current_database() AS name, EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS busy'
            )
        ).rows
        if (typeof state?.name !== 'string' || !stagingDatabase.test(state.name) || state.busy !== false) {
            throw new Error('The database is not a dedicated offline staging copy.')
        }
        return await work(connection)
    } finally {
        await connection.end()
    }
}

async function withStagedApplication<T>(env: Env, databaseFile: string | undefined, work: (db: CredentialStageDatabase) => Promise<T>) {
    if (databaseFile) {
        const connection = new DatabaseSync(databaseFile)
        try {
            return await work({
                dialect: 'sqlite',
                select: async (sql, parameters = []) => connection.prepare(sql).all(...parameters),
                execute: async (sql, parameters = []) => Number(connection.prepare(sql).run(...parameters).changes)
            })
        } finally {
            connection.close()
        }
    }
    return withOfflinePostgres(applicationPostgresOptions(env), (client) =>
        work({
            dialect: 'postgres',
            select: async (sql, parameters) => (await client.query(sql, parameters)).rows,
            execute: async (sql, parameters) => (await client.query(sql, parameters)).rowCount
        })
    )
}

/** Operates exclusively on an explicitly designated, isolated restore. The running generation remains intact. */
export async function stageCredentialRotation(env: Env) {
    const oldKey = encryptionKeyOverwrite(env)
    const replacement = env.CUTTLELY_ROTATION_NEW_KEY
    const rootInput = env.CUTTLELY_ROTATION_STAGING_ROOT
    if (
        !oldKey?.trim() ||
        !replacement?.trim() ||
        oldKey === replacement ||
        !rootInput ||
        !path.isAbsolute(rootInput) ||
        env.CUTTLELY_POSTGRES_URL ||
        !['sqlite', 'postgres'].includes(env.DATABASE_TYPE ?? '')
    ) {
        throw new Error('Unsupported staging configuration.')
    }
    const root = fs.realpathSync(rootInput)
    if (!/^cuttlely-rotation-[a-z0-9-]+$/.test(path.basename(root))) throw new Error('Use a dedicated rotation staging directory.')
    isolatedDir(root, env.CUTTLELY_DATA_DIR)
    const localSettings = isolatedDir(root, settingsDir(env))
    const secretDir = isolatedDir(root, env.SECRETKEY_PATH)
    const databaseFile = env.DATABASE_TYPE === 'sqlite' ? path.join(isolatedDir(root, env.DATABASE_PATH), 'database.sqlite') : undefined
    const settingsConnection = settingsPostgresConnection(env)
    const settingsUrl = env[POSTGRES_SETTINGS_URL]?.trim()
    const settingsName = settingsUrl ? new URL(settingsUrl).pathname.slice(1) : undefined
    if (
        (settingsName !== undefined && (!stagingDatabase.test(settingsName) || settingsName === env.DATABASE_NAME)) ||
        (env.DATABASE_TYPE === 'postgres' && (!env.DATABASE_HOST || !env.DATABASE_USER || !stagingDatabase.test(env.DATABASE_NAME ?? '')))
    ) {
        throw new Error('Use separate, dedicated staging databases.')
    }
    for (const file of POSTGRES_SETTINGS_FILES) safeFile(path.join(localSettings, file))
    const files = new Map<string, string>()
    for (const name of fs.readdirSync(secretDir).filter((name) => /^analyst-role.*\.enc$/.test(name))) {
        const file = path.join(secretDir, name)
        safeFile(file)
        files.set(name, optionalFile(file)!)
    }
    if (databaseFile) {
        fs.accessSync(databaseFile, fs.constants.R_OK | fs.constants.W_OK)
        for (const suffix of ['', '-wal', '-shm', '-journal']) safeFile(databaseFile + suffix)
    }
    const journal = path.join(root, journalName)
    const generation = newCredentialGeneration()
    const destination = forCredentialGeneration(replacement, generation)
    const source = env.CUTTLELY_CREDENTIAL_GENERATION
        ? { envelope: forCredentialGeneration(oldKey, env.CUTTLELY_CREDENTIAL_GENERATION) }
        : { passphrase: oldKey }
    const before = await inventoryCredentialKey(env)
    if (before.status !== 'inspected') throw new Error('The staging copy did not pass credential inventory.')
    const handle = fs.openSync(journal, 'wx', 0o600)
    try {
        fs.writeFileSync(handle, JSON.stringify({ version: 1, phase: 'staging', generation }) + '\n', { flush: true })
    } finally {
        fs.closeSync(handle)
    }
    try {
        const documents = await settingsDocuments(env, oldKey)
        const settings = stageSettingsDocuments(documents, source, destination)
        const roles = stageAnalystRoleFiles(files, source, destination)
        if (settingsConnection) {
            await withOfflinePostgres(settingsConnection, async (client) => {
                const codec = postgresSettingsCodec(replacement, generation)
                await client.query('BEGIN')
                try {
                    await client.query('LOCK TABLE public.cuttlely_server_settings IN SHARE ROW EXCLUSIVE MODE')
                    await client.query('DELETE FROM public.cuttlely_server_settings')
                    for (const [name, text] of [...settings.staged, [POSTGRES_SETTINGS_MARKER, '1']]) {
                        await client.query('INSERT INTO public.cuttlely_server_settings (name, payload) VALUES ($1, $2)', [
                            name,
                            codec.seal(name, text)
                        ])
                    }
                    await client.query('COMMIT')
                } catch {
                    await client.query('ROLLBACK')
                    throw new Error('Settings staging failed.')
                }
            })
        } else {
            for (const [file, text] of settings.staged) writeStaged(path.join(localSettings, file), text)
            for (const file of documents.keys()) {
                if (!settings.staged.has(file)) fs.rmSync(path.join(localSettings, file), { force: true })
            }
        }
        for (const [file, text] of roles) writeStaged(path.join(secretDir, file), text)

        const database = await withStagedApplication(env, databaseFile, (db) =>
            stageApplicationCredentialRecords(db, source, destination, generation)
        )
        const after = await inventoryCredentialKey({
            ...env,
            CUTTLELY_CREDENTIAL_GENERATION: generation,
            CUTTLELY_SECRETKEY_OVERWRITE: replacement,
            FLOWISE_SECRETKEY_OVERWRITE: replacement
        })
        if (after.status !== 'inspected' || after.consumers.inboundAccessKeys.requiresReissue !== 0) {
            throw new Error('The replacement credential inventory did not pass.')
        }
        for (const kind of [
            'credentials',
            'customMcpAuth',
            'webhookSecrets',
            'serverSettingsSecrets',
            'analystRoleRows',
            'analystRoleFiles'
        ] as const) {
            if (
                before.consumers[kind].readable !== after.consumers[kind].readable ||
                before.consumers[kind].external !== after.consumers[kind].external
            ) {
                throw new Error('The replacement credential inventory did not match the original counts.')
            }
        }
        await withStagedApplication(env, databaseFile, (db) => acceptStagedCredentialGeneration(db, destination, generation))
        const report = {
            version: 1,
            phase: 'ready',
            generation,
            database,
            accessKeysToReissue: before.consumers.inboundAccessKeys.requiresReissue,
            authKitProofsToRetest: settings.requiresRetest,
            inventory: after.consumers
        }
        writeStaged(journal, JSON.stringify(report) + '\n')
        return report
    } catch {
        writeStaged(journal, JSON.stringify({ version: 1, phase: 'discard', generation }) + '\n')
        throw new Error('Credential staging failed. Keep the active generation and restore a fresh staging copy before retrying.')
    }
}
