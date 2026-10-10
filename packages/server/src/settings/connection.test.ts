import express, { Request } from 'express'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { setTeamPermissionLookup } from '../identity/rbac'
import { StartState } from './apply'
import { BucketProbe, PgClient, TestDrivers, cleanMessage, defaultDrivers, explainError, testConnection } from './connection'
import { SETTINGS_FILE, writeSettingsFile } from './store'

jest.mock('./bootstrap', () => ({
    startState: { dir: '', hostKeys: [], atStart: {}, applied: [], unreadable: [], problems: [] }
}))

import router, { setConnectionDrivers, setServerSettingsDeps } from '../routes/server-settings/index'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const DB_PASSWORD = 'pw-made-up-for-the-bakery-0001'
const S3_SECRET = 'made-up-s3-secret-for-rosas-bakery'
const OWNER = { id: 'owner-1', email: 'owner@example.com', activeWorkspaceId: 'team-a', permissions: [] }
const MEMBER = { id: 'member-1', email: 'baker@example.com', activeWorkspaceId: 'team-a', permissions: ['server:owner'] }

let data: string
let dir: string
let env: Record<string, string | undefined>
let state: StartState
let pgConfigs: Record<string, unknown>[]
let pgRows: Record<string, Record<string, unknown>[]>
let pgError: unknown
let bucketCalls: string[]
let bucketError: { step: string; error: unknown } | null

function fakeDrivers(overrides: Partial<TestDrivers> = {}): TestDrivers {
    const probe = (): BucketProbe => {
        const step = (name: string) => async () => {
            bucketCalls.push(name)
            if (bucketError?.step === name) throw bucketError.error
        }
        return {
            find: step('find'),
            write: async (name: string) => {
                bucketCalls.push(`write ${name.split('/')[0]}`)
                if (bucketError?.step === 'write') throw bucketError.error
            },
            remove: step('remove')
        }
    }
    return {
        pg: (config) => {
            pgConfigs.push(config)
            const client: PgClient = {
                connect: async () => {
                    if (pgError) throw pgError
                },
                query: async (text) => {
                    const key = Object.keys(pgRows).find((part) => text.includes(part))
                    return { rows: key ? pgRows[key] : [] }
                },
                end: async () => undefined
            }
            return client
        },
        s3: () => probe(),
        gcs: () => probe(),
        azure: () => probe(),
        fetchText: async () => JSON.stringify({ chat: [{ name: 'chatOpenAI', models: [] }], llm: [], embedding: [] }),
        isModelList: (value) => Boolean(value && typeof value === 'object' && Array.isArray((value as { chat?: unknown }).chat)),
        checkAnalystUrl: async (url, values) => {
            if (values.DATABASE_TYPE === 'postgres' && url.includes(values.DATABASE_NAME)) {
                throw new Error('PostgreSQL MCP cannot use the application database.')
            }
        },
        home: () => data,
        ...overrides
    }
}

function app(user: object | null = OWNER) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    server.use('/api/v1/server-settings', router)
    return request(server)
}

const test = (body: object, user: object | null = OWNER) => app(user).post('/api/v1/server-settings/test').send(body)

beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-test-conn-'))
    dir = path.join(data, 'settings')
    env = { CUTTLELY_DATA_DIR: data, CUTTLELY_LOCAL_ADMIN: 'true' }
    state = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys: ['CUTTLELY_LOCAL_ADMIN'],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [],
        rawAtStart: null
    }
    pgConfigs = []
    pgRows = {
        'version()': [{ version: 'PostgreSQL 16.4 on x86_64' }],
        has_schema_privilege: [{ allowed: true }],
        'information_schema.tables': [],
        transaction_read_only: [{ read_only: 'on' }]
    }
    pgError = null
    bucketCalls = []
    bucketError = null
    setServerSettingsDeps(() => ({ env, state, key: async () => KEY }))
    setConnectionDrivers(() => fakeDrivers())
    setTeamPermissionLookup({ accessFor: async (userId) => ({ owner: userId === 'owner-1', permissions: [] }) })
})

afterEach(() => {
    setTeamPermissionLookup(null)
})

const postgres = {
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: 'db.rosas-bakery.example',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'cuttlely',
    DATABASE_USER: 'cuttlely',
    DATABASE_PASSWORD: DB_PASSWORD
}

describe('who can test', () => {
    it('is owner only and never writes the settings file', async () => {
        expect((await test({ kind: 'database', values: postgres }, MEMBER)).status).toBe(403)
        expect((await test({ kind: 'database', values: postgres }, null)).status).toBe(401)
        expect((await test({ kind: 'database', values: postgres })).status).toBe(200)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('refuses unknown tests and values from other sections', async () => {
        expect((await test({ kind: 'everything' })).status).toBe(400)
        const other = await test({ kind: 'storage', values: { DATABASE_PASSWORD: 'x' } })
        expect(other.status).toBe(400)
        expect(other.body.errors[0].key).toBe('DATABASE_PASSWORD')
        const bad = await test({ kind: 'database', values: { DATABASE_PORT: 'not a port' } })
        expect(bad.status).toBe(400)
    })
})

describe('database', () => {
    it('connects with the values on screen and says the empty database is ready', async () => {
        const res = await test({ kind: 'database', values: postgres })
        expect(res.body).toMatchObject({ kind: 'database', ok: true, target: { kind: 'empty', tables: 0 } })
        expect(res.body.checks.map((check: { label: string }) => check.label)).toEqual([
            'Connect and sign in',
            'Create tables',
            'What is there'
        ])
        expect(pgConfigs[0]).toMatchObject({ host: 'db.rosas-bakery.example', port: 5432, password: DB_PASSWORD })
        expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD)
    })

    it('uses the saved password when the page did not change it', async () => {
        writeSettingsFile(dir, { DATABASE_PASSWORD: DB_PASSWORD }, { key: KEY, by: 'owner' })
        const { DATABASE_PASSWORD, ...rest } = postgres
        void DATABASE_PASSWORD
        await test({ kind: 'database', values: rest })
        expect(pgConfigs[0].password).toBe(DB_PASSWORD)
    })

    it('host values win over the page', async () => {
        env.DATABASE_HOST = 'host-db.example'
        state.hostKeys.push('DATABASE_HOST')
        await test({ kind: 'database', values: postgres })
        expect(pgConfigs[0].host).toBe('host-db.example')
    })

    it('tells existing Cuttlely data from somebody else tables', async () => {
        pgRows['information_schema.tables'] = [{ table_name: 'chat_flow' }, { table_name: 'migrations' }]
        expect((await test({ kind: 'database', values: postgres })).body).toMatchObject({
            ok: true,
            target: { kind: 'cuttlely', tables: 2 }
        })
        pgRows['information_schema.tables'] = [{ table_name: 'orders' }]
        const other = (await test({ kind: 'database', values: postgres })).body
        expect(other).toMatchObject({ ok: false, target: { kind: 'other', tables: 1 } })
        expect(other.checks[2].detail).toMatch(/not Cuttlely's/)
    })

    it('needs a user that can create tables', async () => {
        pgRows.has_schema_privilege = [{ allowed: false }]
        const res = (await test({ kind: 'database', values: postgres })).body
        expect(res.ok).toBe(false)
        expect(res.checks[1]).toMatchObject({ label: 'Create tables', ok: false })
    })

    it('explains a refused password without repeating it', async () => {
        pgError = Object.assign(new Error(`password authentication failed for user "cuttlely" (${DB_PASSWORD})`), { code: '28P01' })
        const res = (await test({ kind: 'database', values: postgres })).body
        expect(res).toMatchObject({ ok: false, summary: 'Could not connect to the database.' })
        expect(res.checks[0].detail).toBe('The user name or password was not accepted.')
        pgError = new Error(`odd failure mentioning ${DB_PASSWORD} and postgres://cuttlely:${DB_PASSWORD}x@db/x`)
        const odd = JSON.stringify((await test({ kind: 'database', values: postgres })).body)
        expect(odd).not.toContain(DB_PASSWORD)
        expect(odd).toContain('[hidden]')
    })

    it('asks for the missing fields first', async () => {
        const res = (await test({ kind: 'database', values: { DATABASE_TYPE: 'postgres' } })).body
        expect(res.ok).toBe(false)
        expect(res.summary).toMatch(/^Fill in /)
        expect(pgConfigs).toHaveLength(0)
    })

    it('checks the SQLite data folder', async () => {
        const res = (await test({ kind: 'database', values: { DATABASE_TYPE: 'sqlite' } })).body
        expect(res).toMatchObject({ ok: true, target: { kind: 'empty' } })
        fs.writeFileSync(path.join(data, '.cuttlely', 'database.sqlite'), '')
        expect((await test({ kind: 'database', values: {} })).body.target.kind).toBe('cuttlely')
    })
})

describe('analyst', () => {
    it('refuses the application database', async () => {
        writeSettingsFile(dir, { ...postgres }, { key: KEY, by: 'owner' })
        const res = (await test({ kind: 'analyst', values: { CUTTLELY_POSTGRES_URL: `postgres://reader:${DB_PASSWORD}@db/cuttlely` } }))
            .body
        expect(res).toMatchObject({ ok: false, summary: 'Analyst cannot use this database.' })
        expect(pgConfigs).toHaveLength(0)
    })

    it('connects and notes a read-only connection', async () => {
        const url = `postgres://reader:${DB_PASSWORD}@reports.rosas-bakery.example/sales`
        const res = (await test({ kind: 'analyst', values: { CUTTLELY_POSTGRES_URL: url } })).body
        expect(res.ok).toBe(true)
        expect(res.checks.find((check: { label: string }) => check.label === 'Read only').detail).toBe('This connection is read only.')
        expect(pgConfigs[0].connectionString).toBe(url)
        expect(JSON.stringify(res)).not.toContain(DB_PASSWORD)
    })

    it('needs nothing with Auto', async () => {
        expect((await test({ kind: 'analyst', values: { CUTTLELY_ANALYST: 'auto' } })).body.ok).toBe(true)
        expect((await test({ kind: 'analyst', values: {} })).body.ok).toBe(false)
    })
})

describe('storage', () => {
    const s3 = {
        STORAGE_TYPE: 's3',
        S3_STORAGE_BUCKET_NAME: 'rosas-bakery-files',
        S3_STORAGE_REGION: 'us-east-2',
        S3_STORAGE_ACCESS_KEY_ID: 'AKIAMADEUPBAKERY0000',
        S3_STORAGE_SECRET_ACCESS_KEY: S3_SECRET
    }

    it('finds the bucket, writes a test file and removes it', async () => {
        const res = (await test({ kind: 'storage', values: s3 })).body
        expect(res.ok).toBe(true)
        expect(bucketCalls).toEqual(['find', 'write cuttlely-connection-test', 'remove'])
    })

    it('stops at the first failing step with plain words', async () => {
        bucketError = { step: 'write', error: Object.assign(new Error(`denied ${S3_SECRET}`), { name: 'AccessDenied' }) }
        const res = (await test({ kind: 'storage', values: s3 })).body
        expect(res.ok).toBe(false)
        expect(res.checks.map((check: { ok: boolean }) => check.ok)).toEqual([true, false])
        expect(res.checks[1].detail).toMatch(/do not allow this/)
        expect(JSON.stringify(res)).not.toContain(S3_SECRET)
    })

    it('covers Google Cloud and Azure, and asks for what is missing', async () => {
        expect((await test({ kind: 'storage', values: { STORAGE_TYPE: 'gcs', GOOGLE_CLOUD_STORAGE_BUCKET_NAME: 'bakery' } })).body.ok).toBe(
            true
        )
        const azure = await test({ kind: 'storage', values: { STORAGE_TYPE: 'azure', AZURE_BLOB_STORAGE_CONTAINER_NAME: 'bakery' } })
        expect(azure.body.ok).toBe(false)
        expect(azure.body.summary).toMatch(/^Fill in /)
        expect((await test({ kind: 'storage', values: { STORAGE_TYPE: 's3' } })).body.summary).toMatch(/^Fill in /)
    })

    it('checks the local folder can be written', async () => {
        const res = (await test({ kind: 'storage', values: { STORAGE_TYPE: 'local' } })).body
        expect(res.ok).toBe(true)
        expect(fs.readdirSync(path.join(data, '.cuttlely', 'storage'))).toEqual([])
    })
})

describe('models', () => {
    it('reads a list from an address or a file and checks its shape', async () => {
        expect(
            (await test({ kind: 'models', values: { MODEL_LIST_CONFIG_JSON: 'https://models.rosas-bakery.example/list.json' } })).body.ok
        ).toBe(true)
        const file = path.join(data, 'models.json')
        fs.writeFileSync(file, '{"not":"a list"}')
        const bad = (await test({ kind: 'models', values: { MODEL_LIST_CONFIG_JSON: file } })).body
        expect(bad.ok).toBe(false)
        expect(bad.checks[1].label).toBe('It is a model list')
        fs.writeFileSync(file, 'nope')
        expect((await test({ kind: 'models', values: { MODEL_LIST_CONFIG_JSON: file } })).body.checks[1].detail).toBe(
            'It is not valid JSON.'
        )
        expect(
            (await test({ kind: 'models', values: { MODEL_LIST_CONFIG_JSON: path.join(data, 'missing.json') } })).body.checks[0].detail
        ).toBe('No file at that path on the server.')
        expect((await test({ kind: 'models', values: { MODEL_LIST_CONFIG_JSON: 'bundled' } })).body.ok).toBe(true)
    })
})

describe('messages', () => {
    it('hides secrets and passwords in addresses and connection strings', () => {
        const text = cleanMessage('a secret-value-1 b postgres://u:p@h/db AccountKey=abc123; password=xyz', ['secret-value-1'])
        expect(text).toBe('a [hidden] b postgres://[hidden]@h/db AccountKey=[hidden]; password=[hidden]')
    })

    it('explains network errors', () => {
        expect(explainError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'db.example:5432')).toMatch(
            /No server was found at db.example:5432/
        )
        expect(explainError({ $metadata: { httpStatusCode: 404 } }, 'S3')).toMatch(/does not exist/)
    })
})

describe('real drivers', () => {
    async function closedPort(): Promise<number> {
        const server = net.createServer()
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as net.AddressInfo).port
        await new Promise((resolve) => server.close(resolve))
        return port
    }

    it('reports a refused Postgres connection quickly, with the real client', async () => {
        const port = await closedPort()
        const deps = { env, state, key: async () => KEY }
        const res = await testConnection(
            deps,
            { kind: 'database', values: { ...postgres, DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(port) } },
            { ...defaultDrivers(), home: () => data }
        )
        expect(res.ok).toBe(false)
        expect(res.checks[0].detail).toMatch(/refused the connection/)
        expect(JSON.stringify(res)).not.toContain(DB_PASSWORD)
    })

    it('reports an unreachable S3 endpoint, with the real client', async () => {
        const port = await closedPort()
        const deps = { env, state, key: async () => KEY }
        const res = await testConnection(
            deps,
            {
                kind: 'storage',
                values: {
                    STORAGE_TYPE: 's3',
                    S3_STORAGE_BUCKET_NAME: 'rosas-bakery-files',
                    S3_STORAGE_REGION: 'us-east-2',
                    S3_ENDPOINT_URL: `http://127.0.0.1:${port}`,
                    S3_FORCE_PATH_STYLE: 'true',
                    S3_STORAGE_ACCESS_KEY_ID: 'AKIAMADEUPBAKERY0000',
                    S3_STORAGE_SECRET_ACCESS_KEY: S3_SECRET
                }
            },
            { ...defaultDrivers(), home: () => data }
        )
        expect(res.ok).toBe(false)
        expect(res.checks[0]).toMatchObject({ label: 'Find it', ok: false })
        expect(JSON.stringify(res)).not.toContain(S3_SECRET)
    }, 20000)
})
