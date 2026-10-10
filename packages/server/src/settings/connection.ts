// Test connection for the Server settings page: tries the database, analyst database, file storage or model list
// with the values on screen (unsaved changes over saved ones, host values always win) before anything is saved.
// Owner only (routes/server-settings). Secret values are used for the test and never returned or logged:
// every message is cleaned of them before it leaves this file.
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SETTINGS, settingFor } from './registry'
import { effectiveValue, resolveSettings } from './resolve'
import { readSettingsFile } from './store'
import { checkValue } from './validate'
import type { ServiceDeps } from './service'

export const TEST_KINDS = ['database', 'analyst', 'storage', 'models'] as const
export type TestKind = (typeof TEST_KINDS)[number]

/** Which sections' values each test may take from the page. */
const TEST_SECTIONS: Record<TestKind, string[]> = {
    database: ['database'],
    analyst: ['analyst', 'database'],
    storage: ['storage'],
    models: ['models']
}

export interface TestCheck {
    label: string
    ok: boolean
    detail?: string
}

/** What the database test found at the target, so the switch flow can say what happens next. */
export interface DatabaseTarget {
    kind: 'empty' | 'cuttlely' | 'other'
    tables: number
}

export interface TestResult {
    kind: TestKind
    ok: boolean
    summary: string
    checks: TestCheck[]
    target?: DatabaseTarget
    tookMs: number
}

export class TestInputError extends Error {
    constructor(message: string, public errors: { key: string; message: string }[] = []) {
        super(message)
    }
}

type Values = Record<string, string>

/** Minimal Postgres client surface (pg.Client). */
export interface PgClient {
    connect(): Promise<unknown>
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
    end(): Promise<unknown>
}

export interface BucketProbe {
    /** Throws when the bucket or container cannot be reached. */
    find(): Promise<void>
    write(name: string, body: string): Promise<void>
    remove(name: string): Promise<void>
}

/** Everything that reaches the network or disk, so tests can swap it. */
export interface TestDrivers {
    pg: (config: Record<string, unknown>) => PgClient
    s3: (values: Values) => BucketProbe
    gcs: (values: Values) => BucketProbe
    azure: (values: Values) => BucketProbe
    fetchText: (url: string, timeoutMs: number, maxBytes: number) => Promise<string>
    isModelList: (data: unknown) => boolean
    /** The analyst rule that refuses the application database (scripts/analyst-postgres.mjs). */
    checkAnalystUrl: (url: string, env: Values) => Promise<void>
    home: () => string
}

export const TEST_TIMEOUT_MS = 8000
const MODEL_LIST_MAX_BYTES = 10 * 1024 * 1024
const PROBE_PREFIX = 'cuttlely-connection-test'

// ---------- helpers ----------

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    Object.assign(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds.`), {
                        code: 'CUTTLELY_TIMEOUT'
                    })
                ),
            ms
        )
    })
    return Promise.race([work, timeout]).finally(() => timer && clearTimeout(timer))
}

/** Removes every secret value (and any password in an address) from a message. */
export function cleanMessage(message: string, secrets: string[]): string {
    let text = String(message ?? '')
    for (const secret of secrets.filter((value) => value && value.length >= 3).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[hidden]')
    }
    text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[hidden]@')
    text = text.replace(/(password|pwd|accountkey|sig|secret)=([^;&\s]+)/gi, '$1=[hidden]')
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
}

function errorCode(error: unknown): string {
    const value = error as { code?: unknown; name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } }
    return String(value?.code ?? value?.Code ?? value?.name ?? '')
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message
    return typeof error === 'string' ? error : 'Something went wrong.'
}

/** Plain words for the errors people actually hit. */
export function explainError(error: unknown, where: string): string {
    const code = errorCode(error)
    const status =
        (error as { $metadata?: { httpStatusCode?: number }; statusCode?: number })?.$metadata?.httpStatusCode ??
        (error as { statusCode?: number })?.statusCode
    switch (code) {
        case 'CUTTLELY_TIMEOUT':
            return errorText(error)
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return `No server was found at ${where}. Check the address.`
        case 'ECONNREFUSED':
            return `${where} refused the connection. Check the address and port, and that the service is running.`
        case 'ETIMEDOUT':
        case 'ECONNRESET':
            return `${where} did not answer. A firewall may be blocking it.`
        case '28P01':
        case '28000':
            return 'The user name or password was not accepted.'
        case '3D000':
            return 'That database does not exist on the server. Create it first, or check the name.'
        case 'NoSuchBucket':
        case 'NotFound':
        case 'ContainerNotFound':
            return 'That bucket or container does not exist, or these credentials cannot see it.'
        case 'AccessDenied':
        case 'Forbidden':
        case 'AuthorizationPermissionMismatch':
        case 'AuthorizationFailure':
            return 'The credentials were accepted but do not allow this. Check the permissions.'
        case 'InvalidAccessKeyId':
        case 'SignatureDoesNotMatch':
        case 'AuthenticationFailed':
            return 'The access key or secret was not accepted.'
    }
    if (status === 404) return 'That bucket or container does not exist, or these credentials cannot see it.'
    if (status === 403) return 'The credentials were not accepted, or they do not allow this.'
    const text = errorText(error)
    if (/self[- ]signed|certificate|SSL|TLS/i.test(text)) return `The secure connection failed: ${text}`
    return text
}

// ---------- values ----------

/**
 * Values with the page's unsaved changes on top: host values, then the changes, then saved ones, then defaults.
 * Only settings in the given sections may come from the page.
 */
export async function valuesWithDrafts(
    deps: ServiceDeps,
    sections: string[],
    drafts: Record<string, unknown>
): Promise<{ values: Values; unreadable: string[]; secrets: string[]; changed: string[] }> {
    const errors: { key: string; message: string }[] = []
    const normalized: Values = {}
    for (const [key, raw] of Object.entries(drafts)) {
        const setting = settingFor(key)
        if (!setting || !sections.includes(setting.section)) {
            errors.push({ key, message: `${key} is not used by this test.` })
            continue
        }
        const checked = checkValue(setting, raw)
        if (!checked.ok) errors.push({ key, message: checked.error })
        else normalized[key] = checked.value
    }
    if (errors.length) throw new TestInputError('Some values could not be used for the test.', errors)
    const read = readSettingsFile(deps.state.dir, await deps.key())
    const file: Values = { ...read.values }
    for (const [key, value] of Object.entries(normalized)) {
        if (value === '') delete file[key]
        else file[key] = value
    }
    const hostKeys = new Set(deps.state.hostKeys)
    const rows = resolveSettings({ env: deps.env, hostKeys, file })
    const values: Values = {}
    const secrets: string[] = []
    rows.forEach((row, index) => {
        values[row.key] = effectiveValue(row)
        if (SETTINGS[index].type === 'secret' && row.value) secrets.push(row.value)
    })
    // Paths the host decides (never set from the browser), used by the SQLite and local storage checks.
    for (const key of ['DATABASE_PATH', 'BLOB_STORAGE_PATH']) if (deps.env[key]) values[key] = String(deps.env[key])
    const unreadable = read.unreadable.filter((key) => !hostKeys.has(key) && !(key in normalized))
    return { values, unreadable, secrets, changed: Object.keys(normalized).filter((key) => !hostKeys.has(key)) }
}

/** The values a test runs with. */
export function testValues(deps: ServiceDeps, kind: TestKind, drafts: Record<string, unknown>) {
    return valuesWithDrafts(deps, TEST_SECTIONS[kind], drafts)
}

// ---------- tests ----------

function databaseSsl(values: Values): unknown {
    if (values.DATABASE_SSL_KEY_BASE64) {
        return {
            rejectUnauthorized: values.DATABASE_REJECT_UNAUTHORIZED === 'true',
            ca: Buffer.from(values.DATABASE_SSL_KEY_BASE64, 'base64')
        }
    }
    return values.DATABASE_SSL === 'true' ? true : undefined
}

async function withPg<T>(
    drivers: TestDrivers,
    config: Record<string, unknown>,
    where: string,
    work: (client: PgClient) => Promise<T>
): Promise<T> {
    const client = drivers.pg({
        ...config,
        connectionTimeoutMillis: TEST_TIMEOUT_MS,
        statement_timeout: TEST_TIMEOUT_MS,
        application_name: 'Cuttlely settings test'
    })
    try {
        await withTimeout(client.connect(), TEST_TIMEOUT_MS, where)
        return await withTimeout(work(client), TEST_TIMEOUT_MS, where)
    } finally {
        await client.end().catch(() => undefined)
    }
}

async function testDatabase(values: Values, drivers: TestDrivers): Promise<Omit<TestResult, 'kind' | 'tookMs'>> {
    if ((values.DATABASE_TYPE || 'sqlite') === 'sqlite') {
        const folder = values.DATABASE_PATH || path.join(drivers.home(), '.cuttlely')
        const file = path.join(folder, 'database.sqlite')
        const checks: TestCheck[] = []
        let writable = true
        try {
            fs.mkdirSync(folder, { recursive: true })
            fs.accessSync(folder, fs.constants.W_OK)
        } catch {
            writable = false
        }
        checks.push({
            label: 'The data folder can be written',
            ok: writable,
            detail: writable ? undefined : 'Cuttlely cannot write to its data folder.'
        })
        const exists = fs.existsSync(file)
        checks.push({
            label: 'What is there',
            ok: true,
            detail: exists ? 'Cuttlely data is already there.' : 'Nothing yet. Cuttlely creates it at the next start.'
        })
        return {
            ok: writable,
            summary: writable
                ? 'SQLite keeps its data in a file on this server. Nothing to connect to.'
                : 'Cuttlely cannot write to its data folder.',
            checks,
            target: { kind: exists ? 'cuttlely' : 'empty', tables: 0 }
        }
    }
    const missing = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER'].filter((key) => !values[key])
    if (missing.length) {
        return {
            ok: false,
            summary: `Fill in ${missing.map((key) => settingFor(key)?.label ?? key).join(', ')} first.`,
            checks: []
        }
    }
    const where = `${values.DATABASE_HOST}:${values.DATABASE_PORT || '5432'}`
    const checks: TestCheck[] = []
    try {
        return await withPg(
            drivers,
            {
                host: values.DATABASE_HOST,
                port: parseInt(values.DATABASE_PORT || '5432', 10),
                database: values.DATABASE_NAME,
                user: values.DATABASE_USER,
                password: values.DATABASE_PASSWORD,
                ssl: databaseSsl(values)
            },
            where,
            async (client) => {
                const version = await client.query('select version() as version')
                const name = String(version.rows[0]?.version ?? 'Postgres')
                    .split(' ')
                    .slice(0, 2)
                    .join(' ')
                checks.push({ label: 'Connect and sign in', ok: true, detail: `${name} at ${where}` })
                const create = await client.query("select has_schema_privilege(current_schema(), 'CREATE') as allowed")
                const canCreate = create.rows[0]?.allowed === true
                checks.push({
                    label: 'Create tables',
                    ok: canCreate,
                    detail: canCreate ? undefined : 'This user cannot create tables, which Cuttlely needs the first time it starts there.'
                })
                const tables = await client.query(
                    'select table_name from information_schema.tables where table_schema = current_schema() and table_type = $1',
                    ['BASE TABLE']
                )
                const names = tables.rows.map((row) => String(row.table_name))
                const kind: DatabaseTarget['kind'] = names.length === 0 ? 'empty' : names.includes('chat_flow') ? 'cuttlely' : 'other'
                const detail =
                    kind === 'empty'
                        ? 'The database is empty. Cuttlely sets it up at the next start.'
                        : kind === 'cuttlely'
                        ? 'Cuttlely data is already there.'
                        : `It has ${names.length} table(s) that are not Cuttlely's. Use an empty database or one Cuttlely made.`
                checks.push({ label: 'What is there', ok: kind !== 'other', detail })
                const ok = canCreate && kind !== 'other'
                return {
                    ok,
                    summary: ok
                        ? 'Connected. This database is ready for Cuttlely.'
                        : 'Connected, but this database is not ready for Cuttlely.',
                    checks,
                    target: { kind, tables: names.length }
                }
            }
        )
    } catch (error) {
        checks.push({ label: 'Connect and sign in', ok: false, detail: explainError(error, where) })
        return { ok: false, summary: 'Could not connect to the database.', checks }
    }
}

async function testAnalyst(values: Values, drivers: TestDrivers): Promise<Omit<TestResult, 'kind' | 'tookMs'>> {
    const url = values.CUTTLELY_POSTGRES_URL
    if (!url) {
        if (values.CUTTLELY_ANALYST === 'auto') {
            return { ok: true, summary: 'Analyst uses its own store on this server. Nothing to connect to.', checks: [] }
        }
        return { ok: false, summary: 'Add an analyst database address, or turn on Auto.', checks: [] }
    }
    const checks: TestCheck[] = []
    try {
        await drivers.checkAnalystUrl(url, values)
        checks.push({ label: 'Not the application database', ok: true })
    } catch (error) {
        checks.push({ label: 'Not the application database', ok: false, detail: errorText(error) })
        return { ok: false, summary: 'Analyst cannot use this database.', checks }
    }
    const where = 'The analyst database'
    try {
        return await withPg(drivers, { connectionString: url }, where, async (client) => {
            await client.query('select 1')
            checks.push({ label: 'Connect and sign in', ok: true })
            const readOnly = await client.query("select current_setting('transaction_read_only') as read_only")
            const isReadOnly = readOnly.rows[0]?.read_only === 'on'
            checks.push({
                label: 'Read only',
                ok: true,
                detail: isReadOnly
                    ? 'This connection is read only.'
                    : 'This user can change data. A read-only user is safer for analyst work.'
            })
            return { ok: true, summary: 'Connected. Analyst can query this database.', checks }
        })
    } catch (error) {
        checks.push({ label: 'Connect and sign in', ok: false, detail: explainError(error, where) })
        return { ok: false, summary: 'Could not connect to the analyst database.', checks }
    }
}

async function probeBucket(probe: BucketProbe, where: string): Promise<{ ok: boolean; checks: TestCheck[] }> {
    const checks: TestCheck[] = []
    const name = `${PROBE_PREFIX}/${randomUUID()}.txt`
    const step = async (label: string, work: () => Promise<void>): Promise<boolean> => {
        try {
            await withTimeout(work(), TEST_TIMEOUT_MS, where)
            checks.push({ label, ok: true })
            return true
        } catch (error) {
            checks.push({ label, ok: false, detail: explainError(error, where) })
            return false
        }
    }
    const ok =
        (await step('Find it', () => probe.find())) &&
        (await step('Write a small test file', () => probe.write(name, 'Cuttlely connection test. Safe to delete.\n'))) &&
        (await step('Remove the test file', () => probe.remove(name)))
    return { ok, checks }
}

async function testStorage(values: Values, drivers: TestDrivers): Promise<Omit<TestResult, 'kind' | 'tookMs'>> {
    const type = values.STORAGE_TYPE || 'local'
    if (type === 'local') {
        const folder = values.BLOB_STORAGE_PATH || path.join(drivers.home(), '.cuttlely', 'storage')
        const probe = path.join(folder, `.${PROBE_PREFIX}-${randomUUID()}`)
        try {
            fs.mkdirSync(folder, { recursive: true })
            fs.writeFileSync(probe, 'ok', { mode: 0o600 })
            fs.rmSync(probe, { force: true })
            return {
                ok: true,
                summary: 'Files are kept on this server, and Cuttlely can write there.',
                checks: [{ label: 'Write a small test file', ok: true }]
            }
        } catch {
            return {
                ok: false,
                summary: 'Cuttlely cannot write to its storage folder on this server.',
                checks: [{ label: 'Write a small test file', ok: false }]
            }
        }
    }
    const needs: Record<string, string[]> = {
        s3: ['S3_STORAGE_BUCKET_NAME', 'S3_STORAGE_REGION'],
        gcs: ['GOOGLE_CLOUD_STORAGE_BUCKET_NAME'],
        azure: ['AZURE_BLOB_STORAGE_CONTAINER_NAME']
    }
    const missing = (needs[type] ?? []).filter((key) => !values[key])
    if (
        type === 'azure' &&
        !values.AZURE_BLOB_STORAGE_CONNECTION_STRING &&
        !(values.AZURE_BLOB_STORAGE_ACCOUNT_NAME && values.AZURE_BLOB_STORAGE_ACCOUNT_KEY)
    ) {
        missing.push('AZURE_BLOB_STORAGE_CONNECTION_STRING')
    }
    if (missing.length) {
        return { ok: false, summary: `Fill in ${missing.map((key) => settingFor(key)?.label ?? key).join(', ')} first.`, checks: [] }
    }
    const where =
        type === 's3'
            ? values.S3_ENDPOINT_URL || `S3 (${values.S3_STORAGE_REGION})`
            : type === 'gcs'
            ? 'Google Cloud Storage'
            : 'Azure Blob Storage'
    let probe: BucketProbe
    try {
        probe = type === 's3' ? drivers.s3(values) : type === 'gcs' ? drivers.gcs(values) : drivers.azure(values)
    } catch (error) {
        return {
            ok: false,
            summary: 'These storage settings could not be used.',
            checks: [{ label: 'Find it', ok: false, detail: explainError(error, where) }]
        }
    }
    const result = await probeBucket(probe, where)
    return {
        ok: result.ok,
        summary: result.ok ? 'Connected. Cuttlely can keep files here.' : 'Cuttlely cannot keep files here yet.',
        checks: result.checks
    }
}

async function testModels(values: Values, drivers: TestDrivers): Promise<Omit<TestResult, 'kind' | 'tookMs'>> {
    const setting = (values.MODEL_LIST_CONFIG_JSON || '').trim()
    if (setting.toLowerCase() === 'bundled') {
        return { ok: true, summary: 'Cuttlely uses the model list that came with this version. Nothing to fetch.', checks: [] }
    }
    const isUrl = /^https?:\/\//i.test(setting) || setting === ''
    const where = setting || 'the Cuttlely model list'
    let text: string
    try {
        if (isUrl) {
            // Same address as MODEL_LIST_URL in packages/components/src/modelLoader.ts.
            const url = setting || 'https://raw.githubusercontent.com/cuttlely/cuttlely/main/packages/components/models.json'
            text = await withTimeout(drivers.fetchText(url, TEST_TIMEOUT_MS, MODEL_LIST_MAX_BYTES), TEST_TIMEOUT_MS + 500, where)
        } else {
            const stat = fs.statSync(setting)
            if (stat.size > MODEL_LIST_MAX_BYTES) throw new Error('The file is larger than 10 MB.')
            text = fs.readFileSync(setting, 'utf8')
        }
    } catch (error) {
        const detail = (error as { code?: string })?.code === 'ENOENT' ? 'No file at that path on the server.' : explainError(error, where)
        return {
            ok: false,
            summary: 'Could not read the model list.',
            checks: [{ label: isUrl ? 'Download it' : 'Read the file', ok: false, detail }]
        }
    }
    const checks: TestCheck[] = [{ label: isUrl ? 'Download it' : 'Read the file', ok: true }]
    let data: unknown
    try {
        data = JSON.parse(text)
    } catch {
        checks.push({ label: 'It is a model list', ok: false, detail: 'It is not valid JSON.' })
        return { ok: false, summary: 'That is not a model list. Cuttlely would keep using the one it came with.', checks }
    }
    const valid = drivers.isModelList(data)
    const record = data as Record<string, unknown[]>
    const count = valid
        ? ['chat', 'llm', 'embedding'].reduce((sum, key) => sum + (Array.isArray(record[key]) ? record[key].length : 0), 0)
        : 0
    checks.push({
        label: 'It is a model list',
        ok: valid,
        detail: valid ? `${count} provider entr${count === 1 ? 'y' : 'ies'}.` : 'It needs chat, llm and embedding lists of providers.'
    })
    return {
        ok: valid,
        summary: valid ? 'The model list can be read.' : 'That is not a model list. Cuttlely would keep using the one it came with.',
        checks
    }
}

const running = new Set<TestKind>()

export async function testConnection(deps: ServiceDeps, input: unknown, drivers: TestDrivers = defaultDrivers()): Promise<TestResult> {
    const body = input && typeof input === 'object' ? (input as { kind?: unknown; values?: unknown }) : {}
    const kind = body.kind as TestKind
    if (!TEST_KINDS.includes(kind)) throw new TestInputError(`Choose a test: ${TEST_KINDS.join(', ')}.`)
    const drafts = body.values ?? {}
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) throw new TestInputError('Send the values on screen as values.')
    if (running.has(kind)) throw new TestInputError('This test is already running. Wait for it to finish.')
    running.add(kind)
    const started = Date.now()
    try {
        const { values, unreadable, secrets } = await testValues(deps, kind, drafts as Record<string, unknown>)
        const needed = unreadable.filter((key) => TEST_SECTIONS[kind].includes(settingFor(key)?.section ?? ''))
        if (needed.length) {
            return {
                kind,
                ok: false,
                summary: `${needed
                    .map((key) => settingFor(key)?.label ?? key)
                    .join(', ')} could not be read on this server. Enter it again to test.`,
                checks: [],
                tookMs: Date.now() - started
            }
        }
        const work = kind === 'database' ? testDatabase : kind === 'analyst' ? testAnalyst : kind === 'storage' ? testStorage : testModels
        let result: Omit<TestResult, 'kind' | 'tookMs'>
        try {
            result = await work(values, drivers)
        } catch (error) {
            result = { ok: false, summary: explainError(error, 'The service'), checks: [] }
        }
        return {
            kind,
            ...result,
            summary: cleanMessage(result.summary, secrets),
            checks: result.checks.map((check) => ({ ...check, ...(check.detail ? { detail: cleanMessage(check.detail, secrets) } : {}) })),
            tookMs: Date.now() - started
        }
    } finally {
        running.delete(kind)
    }
}

// ---------- real drivers ----------

const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

function findScript(file: string): string {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'scripts', file)
        if (fs.existsSync(candidate)) return candidate
        dir = path.dirname(dir)
    }
    throw new Error(`${file} was not found.`)
}

export function defaultDrivers(): TestDrivers {
    return {
        pg: (config) => {
            const { Client } = require('pg')
            return new Client(config)
        },
        s3: (values) => {
            const { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
            const credentials =
                values.S3_STORAGE_ACCESS_KEY_ID && values.S3_STORAGE_SECRET_ACCESS_KEY
                    ? { accessKeyId: values.S3_STORAGE_ACCESS_KEY_ID, secretAccessKey: values.S3_STORAGE_SECRET_ACCESS_KEY }
                    : undefined
            const client = new S3Client({
                region: values.S3_STORAGE_REGION,
                forcePathStyle: values.S3_FORCE_PATH_STYLE === 'true',
                maxAttempts: 1,
                ...(values.S3_ENDPOINT_URL ? { endpoint: values.S3_ENDPOINT_URL } : {}),
                ...(credentials ? { credentials } : {})
            })
            const Bucket = values.S3_STORAGE_BUCKET_NAME
            return {
                find: async () => void (await client.send(new HeadBucketCommand({ Bucket }))),
                write: async (Key, Body) =>
                    void (await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'text/plain' }))),
                remove: async (Key) => void (await client.send(new DeleteObjectCommand({ Bucket, Key })))
            }
        },
        gcs: (values) => {
            const { Storage } = require('@google-cloud/storage')
            const storage = new Storage({
                ...(values.GOOGLE_CLOUD_STORAGE_PROJ_ID ? { projectId: values.GOOGLE_CLOUD_STORAGE_PROJ_ID } : {}),
                ...(values.GOOGLE_CLOUD_STORAGE_CREDENTIAL ? { keyFilename: values.GOOGLE_CLOUD_STORAGE_CREDENTIAL } : {}),
                retryOptions: { autoRetry: false }
            })
            const bucket = storage.bucket(values.GOOGLE_CLOUD_STORAGE_BUCKET_NAME)
            return {
                find: async () => {
                    const [exists] = await bucket.exists()
                    if (!exists) throw Object.assign(new Error('not found'), { code: 'NotFound' })
                },
                write: async (name, body) => void (await bucket.file(name).save(body, { contentType: 'text/plain', resumable: false })),
                remove: async (name) => void (await bucket.file(name).delete({ ignoreNotFound: true }))
            }
        },
        azure: (values) => {
            const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob')
            const options = { retryOptions: { maxTries: 1 } }
            const service = values.AZURE_BLOB_STORAGE_CONNECTION_STRING
                ? BlobServiceClient.fromConnectionString(values.AZURE_BLOB_STORAGE_CONNECTION_STRING, options)
                : new BlobServiceClient(
                      `https://${values.AZURE_BLOB_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
                      new StorageSharedKeyCredential(values.AZURE_BLOB_STORAGE_ACCOUNT_NAME, values.AZURE_BLOB_STORAGE_ACCOUNT_KEY),
                      options
                  )
            const container = service.getContainerClient(values.AZURE_BLOB_STORAGE_CONTAINER_NAME)
            return {
                find: async () => {
                    if (!(await container.exists())) throw Object.assign(new Error('not found'), { code: 'ContainerNotFound' })
                },
                write: async (name, body) => void (await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body))),
                remove: async (name) => void (await container.getBlockBlobClient(name).deleteIfExists())
            }
        },
        fetchText: async (url, timeoutMs, maxBytes) => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            try {
                const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
                if (!response.ok) throw new Error(`The address answered with ${response.status} ${response.statusText}.`)
                const length = Number(response.headers.get('content-length') ?? 0)
                if (length > maxBytes) throw new Error('The model list is larger than 10 MB.')
                const text = await response.text()
                if (Buffer.byteLength(text) > maxBytes) throw new Error('The model list is larger than 10 MB.')
                return text
            } catch (error) {
                if ((error as Error)?.name === 'AbortError')
                    throw Object.assign(new Error(`${url} did not answer in time.`), { code: 'CUTTLELY_TIMEOUT' })
                const cause = (error as { cause?: { code?: string } })?.cause
                if (cause?.code) throw Object.assign(new Error(errorText(error)), { code: cause.code })
                throw error
            } finally {
                clearTimeout(timer)
            }
        },
        isModelList: (data) => require('flowise-components').isModelList(data),
        checkAnalystUrl: async (url, env) => {
            const module = await importEsm(require('url').pathToFileURL(findScript('analyst-postgres.mjs')).href)
            module.resolveAnalystPostgresUrl({ analystUrl: url, env })
        },
        home: () => process.env.HOME || process.env.USERPROFILE || os.homedir()
    }
}
