// NODE_OPTIONS=--experimental-vm-modules is required. Jest runs this file in a VM, and the node loads the harness ESM files with import().
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { pathToFileURL } from 'url'
import { Client } from 'pg'
import { getCredentialData, getPinnedQueryKey } from '../../../../src/utils'

const { nodeClass: PostgreSQLMCP } = require('./PostgreSQLMCP')

const OVERWRITE = 'CUTTLELY_SECRETKEY_OVERWRITE'
const SECRET = 'ZZ-TEST-node-key'
const WORKSPACE = 'ZZ-TEST-ws'
const OFF_ERROR = 'Pinned queries are turned off on this server.'
const AUTO_ERROR = 'Pinned queries need a Postgres URL on this node. Isolated analyst storage cannot run them.'
const COLUMN_WARNING = 'The columns from this pinned query differ from the columns recorded when it was tested.'
const SALES_SQL = 'SELECT region, revenue FROM public.demo_sales ORDER BY region LIMIT 10'
const CANONICAL_ROWS = [
    { region: 'east', revenue: 12 },
    { region: 'north', revenue: 7 },
    { region: 'west', revenue: 3 }
]

type PinnedModule = {
    compilePinned: (
        entry: Record<string, unknown>,
        args?: Record<string, unknown>
    ) => {
        runText: string
        statementHash: string
        binds: unknown[] | null
    }
    stampPayload: (input: Record<string, unknown>) => string
    computeStamp: (key: Buffer, payload: string) => string
    sqlTraceFields: (sql: string) => { sqlHash: string }
}

type Sink = { url: string; hits: { n: number }; close: () => Promise<void> }

const root = path.resolve(__dirname, '../../../../../../')
const saved: Record<string, string | undefined> = {}

// The same file the server route test reads (packages/server/src/controllers/pinned-queries/index.test.ts).
const GUARD_PARITY = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/pinned/guard-parity.json'), 'utf8'))

let pq: PinnedModule
let withAnalystScope: (scope: string, fn: () => Promise<string>, options: { timings: Record<string, unknown>[] }) => Promise<string>
// Jest rewrites import() into its own resolver, which cannot load the harness ESM files.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

jest.setTimeout(60000)

beforeAll(async () => {
    for (const key of [
        OVERWRITE,
        'CUTTLELY_PINNED_QUERIES',
        'CUTTLELY_POSTGRES_URL',
        'CUTTLELY_ANALYST',
        'CUTTLELY_ANALYST_TRACE_PREVIEW'
    ]) {
        saved[key] = process.env[key]
    }
    process.env[OVERWRITE] = SECRET
    pq = Object.assign(
        {},
        await importEsm(pathToFileURL(path.join(root, 'packages/harness/runtime/pinned-query.mjs')).href),
        await importEsm(pathToFileURL(path.join(root, 'packages/harness/runtime/pinned-stamp.mjs')).href),
        await importEsm(pathToFileURL(path.join(root, 'packages/harness/analyst-capture.mjs')).href)
    ) as PinnedModule
    const store = (await importEsm(pathToFileURL(path.join(root, 'packages/harness/runtime/analyst-store.mjs')).href)) as {
        withAnalystScope: typeof withAnalystScope
    }
    withAnalystScope = store.withAnalystScope
})

afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await getPinnedQueryKey()
    } catch {
        // The restored key file may be absent. The cache still follows the restored secret.
    }
})

beforeEach(() => {
    delete process.env.CUTTLELY_PINNED_QUERIES
    delete process.env.CUTTLELY_POSTGRES_URL
    delete process.env.CUTTLELY_ANALYST
})

function node() {
    return new PostgreSQLMCP()
}

function listenSink(): Promise<Sink> {
    return new Promise((resolve, reject) => {
        const hits = { n: 0 }
        const server = net.createServer((socket) => {
            hits.n += 1
            socket.destroy()
        })
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                reject(new Error('The pinned query sink did not bind.'))
                return
            }
            resolve({
                hits,
                url: `postgres://postgres@127.0.0.1:${address.port}/zz_test_node_closed`,
                close: () =>
                    new Promise((done) => {
                        server.close(() => done())
                    })
            })
        })
    })
}

async function stamped(entry: Record<string, unknown>, { relations = [] as string[], functions = [] as string[], cred = '' } = {}) {
    const compiled = pq.compilePinned(entry)
    const payload = pq.stampPayload({
        workspaceId: WORKSPACE,
        cred,
        statementHash: compiled.statementHash,
        params: Array.isArray(entry.params) ? entry.params : [],
        relations,
        allowedFunctions: functions,
        testedColumns: entry.testedColumns
    })
    const key = await getPinnedQueryKey()
    return { entry: { ...entry, testedStamp: pq.computeStamp(key, payload) }, compiled }
}

function data(inputs: Record<string, unknown>, credential = '') {
    return { inputs, credential }
}

function options() {
    return { workspaceId: WORKSPACE }
}

function namesOf(tools: { name?: string }[]) {
    return tools.map((tool) => tool.name)
}

function viewOf(tools: { name?: string; description?: string; schema?: unknown }[]) {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema }))
}

async function initAt(url: string, inputs: Record<string, unknown>, credential = '') {
    process.env.CUTTLELY_POSTGRES_URL = url
    return node().init(data(inputs, credential), '', options())
}

describe('PostgreSQL MCP pinned queries', () => {
    it('ZZ-TEST-reads the guard settings exactly as the pinned query test route does', async () => {
        const sink = await listenSink()
        const urlTools = jest.spyOn(PostgreSQLMCP.prototype, 'urlTools').mockResolvedValue([])
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { inputs, expected } = GUARD_PARITY
            const pin = {
                id: 'ZZ-TEST-parity',
                name: 'pq_parity',
                version: 1,
                sql: 'SELECT region FROM public.demo_sales LIMIT 5',
                params: []
            }
            // Stamped with what the route stamps for these inputs, so the node accepts it only if it reads them the same.
            const matching = await stamped(pin, { relations: expected.relations, functions: expected.stampFunctions })
            const notes = await stamped(
                { ...pin, id: 'ZZ-TEST-parity-b', name: 'pq_parity_b' },
                { relations: expected.relations, functions: ['public.zz_test_lower(text)'] }
            )
            const tools = await initAt(sink.url, {
                ...inputs,
                mcpActions: ['query'],
                pinnedQueries: JSON.stringify([matching.entry, notes.entry])
            })
            expect(namesOf(tools)).toEqual(['pq_parity'])
            expect(urlTools).toHaveBeenCalledTimes(1)
            expect(urlTools.mock.calls[0].slice(1)).toEqual([expected.requested, expected.relations, expected.allowedFunctions])
            expect(sink.hits.n).toBe(0)
        } finally {
            urlTools.mockRestore()
            warn.mockRestore()
            await sink.close()
        }
    })

    it('ZZ-TEST-refuses a credential id from another workspace before connecting', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            process.env.CUTTLELY_POSTGRES_URL = sink.url
            const count = jest.fn().mockResolvedValue(0)
            const appDataSource = {
                getRepository: (entity: { kind?: string }) =>
                    entity?.kind === 'share'
                        ? { count }
                        : { findOneBy: async () => ({ id: 'ZZ-TEST-cred-team-b', workspaceId: 'ZZ-TEST-ws-b', encryptedData: '' }) },
                entityMetadatas: [{ name: 'WorkspaceShared', target: { kind: 'share' } }]
            }
            await expect(
                node().init(data({ mcpActions: ['query'] }, 'ZZ-TEST-cred-team-b'), '', {
                    workspaceId: WORKSPACE,
                    appDataSource,
                    databaseEntities: { Credential: { kind: 'credential' } }
                })
            ).rejects.toThrow('Credential ZZ-TEST-cred-team-b not found')
            expect(count).toHaveBeenCalledWith({
                where: { workspaceId: WORKSPACE, sharedItemId: 'ZZ-TEST-cred-team-b', itemType: 'credential' }
            })
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('stamp verified without a DB round trip', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS n LIMIT 1',
                params: []
            })
            const tools = await initAt(sink.url, { mcpActions: [], pinnedQueries: JSON.stringify([entry]) })
            expect(namesOf(tools)).toEqual(['pq_revenue'])
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('forged or stale stamp is not offered', async () => {
        const sink = await listenSink()
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            process.env.CUTTLELY_PINNED_QUERIES = '1'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS n LIMIT 1',
                params: []
            })
            const forged = {
                ...entry,
                testedStamp: `${String(entry.testedStamp).slice(0, -1)}${String(entry.testedStamp).endsWith('a') ? 'b' : 'a'}`
            }
            const stale = { ...entry, sql: 'SELECT 2 AS n LIMIT 1' }
            const forgedTools = await initAt(sink.url, { mcpActions: ['query'], pinnedQueries: JSON.stringify([forged]) })
            const staleTools = await initAt(sink.url, { mcpActions: ['query'], pinnedQueries: JSON.stringify([stale]) })
            expect(namesOf(forgedTools).some((name) => String(name).startsWith('pq_'))).toBe(false)
            expect(namesOf(staleTools).some((name) => String(name).startsWith('pq_'))).toBe(false)
            expect(sink.hits.n).toBe(0)
            const warnings = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
            expect(warnings).toContain('pq_revenue')
            expect(warnings).not.toContain('SELECT')
        } finally {
            warn.mockRestore()
            await sink.close()
        }
    })

    it('Auto mode with pins configured errors and registers no pq_ tools', async () => {
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        process.env.CUTTLELY_ANALYST = 'auto'
        const inputs = { mcpActions: ['query'], pinnedQueries: JSON.stringify([{ name: 'pq_revenue', sql: 'SELECT 1 AS n LIMIT 1' }]) }
        let tools: unknown[] | undefined
        try {
            tools = await node().init(data(inputs), '', options())
        } catch (error) {
            expect((error as Error).message).toBe(AUTO_ERROR)
            expect((error as { cuttlelyOutcome?: string }).cuttlelyOutcome).toBe('expected')
        }
        expect(tools).toBeUndefined()
    })

    it('every pinned call site passes readOnlySql: true', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_sleep',
                version: 1,
                sql: 'SELECT pg_sleep(0) LIMIT 1',
                params: []
            })
            const tools = await initAt(sink.url, { mcpActions: [], pinnedQueries: JSON.stringify([entry]) })
            const pin = tools.find((tool: { name?: string }) => tool.name === 'pq_sleep')
            expect(pin).toBeTruthy()
            const text = await pin.invoke({})
            const body = JSON.parse(text)
            expect(body.cuttlelyOutcome).toBe('expected')
            expect(body.error).toBe('Cuttlely refused this query: pg_sleep is not allowed.')
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('flag off: no pq_ tools and calls refused', async () => {
        const sink = await listenSink()
        try {
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS n LIMIT 1',
                params: []
            })
            const inputs = { mcpActions: ['query'], pinnedQueries: JSON.stringify([entry]) }
            for (const value of [undefined, '', 'false', 'yes', 'on', 'TRUE']) {
                if (value === undefined) delete process.env.CUTTLELY_PINNED_QUERIES
                else process.env.CUTTLELY_PINNED_QUERIES = value
                const tools = await initAt(sink.url, inputs)
                expect(namesOf(tools).some((name) => String(name).startsWith('pq_'))).toBe(false)
            }
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const offered = await initAt(sink.url, inputs)
            const pin = offered.find((tool: { name?: string }) => tool.name === 'pq_revenue')
            delete process.env.CUTTLELY_PINNED_QUERIES
            const body = JSON.parse(await pin.invoke({}))
            expect(body).toEqual({ error: OFF_ERROR, cuttlelyOutcome: 'expected' })
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('flag on, no pins: byte-identical tools, prompts, descriptions', async () => {
        const sink = await listenSink()
        try {
            const inputs = { mcpActions: ['query'] }
            delete process.env.CUTTLELY_PINNED_QUERIES
            const off = viewOf(await initAt(sink.url, inputs))
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const on = viewOf(await initAt(sink.url, inputs))
            const empty = viewOf(await initAt(sink.url, { ...inputs, pinnedQueries: '' }))
            const none = viewOf(await initAt(sink.url, { ...inputs, pinnedQueries: '[]' }))
            expect(on).toEqual(off)
            expect(empty).toEqual(off)
            expect(none).toEqual(off)
            expect(off.map((tool) => tool.name)).toEqual(['query'])
            expect(Object.keys((off[0].schema as { properties: Record<string, unknown> }).properties).sort()).toEqual([
                'cursor',
                'page',
                'query',
                'sql',
                'statement'
            ])
            expect(node().version).toBe(1.4)
            const profile = (await importEsm(pathToFileURL(path.join(root, 'packages/harness/profile.mjs')).href)) as {
                specialistSoul: (specialist: unknown, env: Record<string, string>) => string
            }
            const analyst = {
                name: 'analyst',
                instructions: 'ZZ-TEST',
                mcpServers: [{ nodeName: 'postgreSQLMCP', credential: 'ZZ-TEST-cred' }]
            }
            const envOff = { DATABASE_TYPE: 'sqlite', CUTTLELY_POSTGRES_URL: 'postgres://demo/warehouse' }
            const envOn = { ...envOff, CUTTLELY_PINNED_QUERIES: 'true' }
            expect(profile.specialistSoul(analyst, envOn)).toBe(profile.specialistSoul(analyst, envOff))
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('two pins with query unticked are the only tools', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const first = await stamped({
                id: 'ZZ-TEST-pin-a',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS revenue LIMIT 1',
                params: []
            })
            const second = await stamped({
                id: 'ZZ-TEST-pin-b',
                name: 'pq_orders',
                version: 1,
                sql: 'SELECT 2 AS orders LIMIT 1',
                params: []
            })
            const tools = await initAt(sink.url, {
                mcpActions: [],
                pinnedQueries: JSON.stringify([first.entry, second.entry])
            })
            expect(namesOf(tools)).toEqual(['pq_revenue', 'pq_orders'])
            for (const tool of tools) {
                expect(String(tool.description || '')).not.toMatch(/\bsql\b/i)
            }
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('bad parameters are an expected error', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT :region AS region LIMIT 1',
                params: [{ name: 'region', type: 'int8', required: true }]
            })
            const tools = await initAt(sink.url, { mcpActions: [], pinnedQueries: JSON.stringify([entry]) })
            const body = JSON.parse(await tools[0].invoke({ region: 'nope' }))
            expect(body.cuttlelyOutcome).toBe('expected')
            expect(body.error).toContain('Invalid parameter region')
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('a next-page call with only a cursor passes the schema of a pin with required parameters', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT :region AS region LIMIT 1',
                params: [{ name: 'region', type: 'int8', required: true }]
            })
            const tools = await initAt(sink.url, { mcpActions: [], pinnedQueries: JSON.stringify([entry]) })
            expect((tools[0].schema as { required?: unknown }).required).toBeUndefined()
            expect(tools[0].description).toContain('Required on a first call: region.')
            const missing = JSON.parse(await tools[0].invoke({}))
            expect(missing.cuttlelyOutcome).toBe('expected')
            expect(missing.error).toContain('region')
            const next = JSON.parse(await tools[0].invoke({ cursor: 'ZZ-TEST-cursor', page: 2 }))
            expect(next.error || '').not.toContain('region')
        } finally {
            await sink.close()
        }
    })

    it('listActions does not offer pinned tools', async () => {
        const sink = await listenSink()
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS n LIMIT 1',
                params: []
            })
            const pinned = data({ pinnedQueries: JSON.stringify([entry]) })
            const plain = data({})
            process.env.CUTTLELY_POSTGRES_URL = sink.url
            const withPins = await node().loadMethods.listActions(pinned, options())
            const without = await node().loadMethods.listActions(plain, options())
            expect(withPins).toEqual(without)
            expect(withPins.some((item: { name?: string }) => String(item.name).startsWith('pq_'))).toBe(false)
            expect(sink.hits.n).toBe(0)
        } finally {
            await sink.close()
        }
    })

    it('duplicate names on one node are not offered', async () => {
        const sink = await listenSink()
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            const { entry } = await stamped({
                id: 'ZZ-TEST-pin',
                name: 'pq_revenue',
                version: 1,
                sql: 'SELECT 1 AS n LIMIT 1',
                params: []
            })
            const tools = await initAt(sink.url, {
                mcpActions: ['query'],
                pinnedQueries: JSON.stringify([entry, { ...entry, id: 'ZZ-TEST-other' }])
            })
            expect(namesOf(tools).some((name) => String(name).startsWith('pq_'))).toBe(false)
            expect(warn.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('pq_revenue')
            expect(sink.hits.n).toBe(0)
        } finally {
            warn.mockRestore()
            await sink.close()
        }
    })
})

// The pinned query test route (defaultLoadCredentialUrl in packages/server/src/services/pinned-queries/index.ts) and
// this node load a credential through getCredentialData with the flow's workspace. These run the real loader with the
// options the route builds; only the database is a stand-in. A credential id from another workspace is refused before
// anything is decrypted.
const FLOW_WORKSPACE = WORKSPACE
const OTHER_WORKSPACE = 'ZZ-TEST-ws-b'

function storeWith(row: { id: string; workspaceId: string } | null, shares = 0) {
    const reads = { encryptedData: 0 }
    const credential = row
        ? Object.defineProperty({ ...row }, 'encryptedData', {
              enumerable: true,
              get() {
                  reads.encryptedData += 1
                  return 'ZZ-TEST-not-decryptable'
              }
          })
        : null
    const findOneBy = jest.fn().mockResolvedValue(credential)
    const count = jest.fn().mockResolvedValue(shares)
    const appDataSource = {
        getRepository: jest.fn((entity: { kind?: string }) => (entity?.kind === 'share' ? { count } : { findOneBy })),
        entityMetadatas: [{ name: 'WorkspaceShared', target: { kind: 'share' } }]
    }
    return { appDataSource, databaseEntities: { Credential: { kind: 'credential' } }, findOneBy, count, reads }
}

describe('ZZ-TEST-pinned query credential scope (the real getCredentialData)', () => {
    it('ZZ-TEST-refuses a canvas credential id that belongs to another workspace', async () => {
        const store = storeWith({ id: 'ZZ-TEST-cred-team-b', workspaceId: OTHER_WORKSPACE })
        await expect(
            getCredentialData('ZZ-TEST-cred-team-b', {
                appDataSource: store.appDataSource,
                databaseEntities: store.databaseEntities,
                workspaceId: FLOW_WORKSPACE
            })
        ).rejects.toThrow('Credential ZZ-TEST-cred-team-b not found')
        expect(store.findOneBy).toHaveBeenCalledWith({ id: 'ZZ-TEST-cred-team-b' })
        // The share check asks about the flow's workspace, and nothing is decrypted.
        expect(store.count).toHaveBeenCalledWith({
            where: { workspaceId: FLOW_WORKSPACE, sharedItemId: 'ZZ-TEST-cred-team-b', itemType: 'credential' }
        })
        expect(store.reads.encryptedData).toBe(0)
    })

    it('ZZ-TEST-refuses an unknown credential id', async () => {
        const store = storeWith(null)
        await expect(
            getCredentialData('ZZ-TEST-cred-missing', {
                appDataSource: store.appDataSource,
                databaseEntities: store.databaseEntities,
                workspaceId: FLOW_WORKSPACE
            })
        ).rejects.toThrow('Credential ZZ-TEST-cred-missing not found')
    })

    it('ZZ-TEST-passes the scope check for its own workspace and for a share into it', async () => {
        for (const store of [
            storeWith({ id: 'ZZ-TEST-cred-team-a', workspaceId: FLOW_WORKSPACE }),
            storeWith({ id: 'ZZ-TEST-cred-team-a', workspaceId: OTHER_WORKSPACE }, 1)
        ]) {
            // The stand-in row cannot be decrypted. Reaching the decrypt step shows the workspace check let it through.
            const outcome = await getCredentialData('ZZ-TEST-cred-team-a', {
                appDataSource: store.appDataSource,
                databaseEntities: store.databaseEntities,
                workspaceId: FLOW_WORKSPACE
            }).then(
                () => '',
                (error: Error) => error.message
            )
            expect(outcome).not.toContain('not found')
            expect(store.reads.encryptedData).toBe(1)
        }
    })
})

// The fixture database comes from CUTTLELY_TEST_PG_URL (an admin login that may create a database).
// Without it these tests are skipped, unless CUTTLELY_TEST_PG_REQUIRED=1 says the database must be there.
const fixtureAdminUrl = process.env.CUTTLELY_TEST_PG_URL || ''
const describeFixture = fixtureAdminUrl || process.env.CUTTLELY_TEST_PG_REQUIRED === '1' ? describe : describe.skip

describeFixture('PostgreSQL MCP pinned queries against a fixture database', () => {
    let url = ''
    let admin: Client | undefined
    let database = ''

    beforeAll(async () => {
        if (!fixtureAdminUrl) throw new Error('CUTTLELY_TEST_PG_URL is required when CUTTLELY_TEST_PG_REQUIRED=1.')
        admin = new Client({ connectionString: fixtureAdminUrl })
        await admin.connect()
        database = `zz_test_node_${crypto.randomBytes(4).toString('hex')}`
        await admin.query(`CREATE DATABASE ${database}`)
        const connection = new URL(fixtureAdminUrl)
        connection.pathname = `/${database}`
        url = connection.href
        const db = new Client({ connectionString: url })
        await db.connect()
        await db.query('CREATE TABLE public.demo_sales (region text NOT NULL, revenue integer NOT NULL)')
        await db.query("INSERT INTO public.demo_sales (region, revenue) VALUES ('east', 12), ('north', 7), ('west', 3)")
        await db.query('CREATE TABLE public.demo_regions (region text NOT NULL)')
        await db.end()
    })

    afterAll(async () => {
        if (!admin || !database) return
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
            database
        ])
        await admin.query(`DROP DATABASE ${database}`)
        await admin.end()
    })

    it('1.3 query flow is unchanged', async () => {
        delete process.env.CUTTLELY_PINNED_QUERIES
        const tools = await initAt(url, { mcpActions: ['query'] })
        expect(namesOf(tools)).toEqual(['query'])
        const timings: Record<string, unknown>[] = []
        const text = await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-chat', () => tools[0].invoke({ sql: SALES_SQL }), { timings })
        const body = JSON.parse(text)
        expect(body.rows).toEqual(CANONICAL_ROWS)
        expect(body.pinned).toBeUndefined()
        expect(typeof timings[0].dbMs).toBe('number')
        expect(typeof timings[0].guardMs).toBe('number')
        expect(typeof timings[0].roundTrips).toBe('number')
        expect(typeof timings[0].serializeMs).toBe('number')
    })

    it('pinned-only fixture returns canonical rows and the server hash', async () => {
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        const relations = ['public.demo_sales']
        const testedColumns = [
            { name: 'region', type: 'text' },
            { name: 'revenue', type: 'int4' }
        ]
        const correct = await stamped(
            {
                id: 'ZZ-TEST-pin',
                name: 'pq_sales',
                version: 3,
                sql: SALES_SQL,
                params: [],
                testedColumns
            },
            { relations }
        )
        const drifted = await stamped(
            {
                id: 'ZZ-TEST-drift',
                name: 'pq_drift',
                version: 1,
                sql: SALES_SQL,
                params: [],
                testedColumns: [{ name: 'region', type: 'text' }]
            },
            { relations }
        )
        const tools = await initAt(url, {
            mcpActions: [],
            analystRelations: JSON.stringify(relations),
            pinnedQueries: JSON.stringify([correct.entry, drifted.entry])
        })
        expect(namesOf(tools)).toEqual(['pq_sales', 'pq_drift'])
        const timings: Record<string, unknown>[] = []
        const text = await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-chat', () => tools[0].invoke({}), { timings })
        const body = JSON.parse(text)
        expect(body.rows).toEqual(CANONICAL_ROWS)
        expect(body.pinned).toEqual({ id: 'ZZ-TEST-pin', name: 'pq_sales', version: 3, hash: correct.compiled.statementHash })
        expect(body.sqlHash).toBe(pq.sqlTraceFields(correct.compiled.runText).sqlHash)
        expect(body.sqlHash).not.toBe(body.pinned.hash)
        expect(body._cuttlelyTraceSql).toBe(correct.compiled.runText)
        expect(body.columnsChanged).toBeUndefined()
        expect(body.warning).toBeUndefined()
        expect(typeof timings[0].dbMs).toBe('number')
        expect(typeof timings[0].guardMs).toBe('number')
        expect(typeof timings[0].roundTrips).toBe('number')
        expect(typeof timings[0].serializeMs).toBe('number')
        const driftTimings: Record<string, unknown>[] = []
        const drift = JSON.parse(
            await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-chat', () => tools[1].invoke({}), { timings: driftTimings })
        )
        expect(drift.rows).toEqual(CANONICAL_ROWS)
        expect(drift.columnsChanged).toBe(true)
        expect(drift.warning).toBe(COLUMN_WARNING)
        expect(typeof driftTimings[0].serializeMs).toBe('number')
    })

    it('pins do not change guard round trips', async () => {
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        const relations = ['public.demo_sales']
        const { entry } = await stamped(
            {
                id: 'ZZ-TEST-pin',
                name: 'pq_sales',
                version: 1,
                sql: SALES_SQL,
                params: [],
                testedColumns: [
                    { name: 'region', type: 'text' },
                    { name: 'revenue', type: 'int4' }
                ]
            },
            { relations }
        )
        const tools = await initAt(url, {
            mcpActions: ['query'],
            analystRelations: JSON.stringify(relations),
            pinnedQueries: JSON.stringify([entry])
        })
        const query = tools.find((tool: { name?: string }) => tool.name === 'query')
        const pin = tools.find((tool: { name?: string }) => tool.name === 'pq_sales')
        const freeTimings: Record<string, unknown>[] = []
        const pinTimings: Record<string, unknown>[] = []
        const freeText = await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-free', () => query.invoke({ sql: SALES_SQL }), {
            timings: freeTimings
        })
        const pinText = await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-pin', () => pin.invoke({}), { timings: pinTimings })
        expect(JSON.parse(freeText).rows).toEqual(CANONICAL_ROWS)
        expect(JSON.parse(pinText).rows).toEqual(CANONICAL_ROWS)
        expect(pinTimings[0].roundTrips).toBe(freeTimings[0].roundTrips)
        expect(typeof pinTimings[0].guardMs).toBe('number')
        expect(typeof freeTimings[0].guardMs).toBe('number')
    })

    it('ZZ-TEST-a decimal row cap and a pin row cap give the rows the test route reports', async () => {
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        const { inputs, expected, pin: capped } = GUARD_PARITY
        const base = { version: 1, sql: SALES_SQL, params: [] }
        const nodeCap = await stamped(
            { ...base, id: 'ZZ-TEST-node-cap', name: 'pq_node_cap' },
            { relations: expected.relations, functions: expected.stampFunctions }
        )
        const pinCap = await stamped(
            { ...base, id: 'ZZ-TEST-pin-cap', name: 'pq_pin_cap', rowCap: capped.rowCap },
            { relations: expected.relations, functions: expected.stampFunctions }
        )
        const tools = await initAt(url, {
            ...inputs,
            mcpActions: [],
            pinnedQueries: JSON.stringify([nodeCap.entry, pinCap.entry])
        })
        expect(namesOf(tools)).toEqual(['pq_node_cap', 'pq_pin_cap'])
        const run = async (index: number) =>
            JSON.parse(await withAnalystScope('ZZ-TEST-harness:ZZ-TEST-cap', () => tools[index].invoke({}), { timings: [] }))
        // analystRowCap "2.5" is two rows here and in the route; the pin's own cap of 1 lowers it to one.
        expect((await run(0)).rows).toEqual(CANONICAL_ROWS.slice(0, expected.limits.rowCap))
        expect((await run(1)).rows).toEqual(CANONICAL_ROWS.slice(0, capped.limits.rowCap))
    })
})
