import express from 'express'
import request from 'supertest'

// The harness gate loads the server logger, which constructs a storage provider at import time.
jest.mock(
    '@cuttlely/components',
    () => ({
        StorageProviderFactory: {
            getProvider: () => ({
                getLoggerTransports: () => []
            })
        }
    }),
    { virtual: true }
)

// The audit row goes through the real recordPinnedQueryTest and recordAudit; only the database handle is a stand-in.
const mockAuditSql: { text: string; params: unknown[] }[] = []
jest.mock('../../identity/production', () => ({
    applicationSql: () => ({
        type: 'postgres',
        query: async (text: string, params: unknown[] = []) => {
            mockAuditSql.push({ text, params })
            return []
        },
        transaction: async () => {
            throw new Error('no transaction expected')
        }
    })
}))

import fs from 'fs'
import path from 'path'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { setHarnessFlowLookup } from '../../services/harnesses/apiAccess'
import errorHandlerMiddleware from '../../middlewares/errors'
import pinnedQueriesRouter from '../../routes/pinned-queries'
import { setPinnedQueryDeps } from '../../services/pinned-queries'
import { recordPinnedQueryTest } from '../../services/chatflows/pinnedQueryAudit'

const GUARD_PARITY = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../../scripts/fixtures/pinned/guard-parity.json'), 'utf8')
)
// Credentials the flow's workspace may read: its own and one shared into it. Anything else is refused the way
// getCredentialData refuses it (packages/components/src/pinnedCredentialScope.test.ts runs the real one).
const READABLE: Record<string, string[]> = { 'team-a': ['cred-demo', 'cred-live'] }

const FLOW = '0b5c3a1e-1111-2222-3333-444455556666'
const CRED_URL = 'postgres://demo:secret@127.0.0.1:55451/zz_test_sales'
const SAMPLE = 'postgres://zz-test.example/demo_sales'

const calls = {
    query: [] as any[],
    compile: [] as any[],
    stamps: 0,
    stampFields: [] as any[],
    flows: [] as any[],
    creds: [] as any[],
    limits: [] as any[],
    audits: [] as any[],
    drafts: [] as any[],
    throwQuery: false,
    paramTypes: ['text'] as Array<string | null> | null
}

const user = {
    id: 'user-1',
    activeWorkspaceId: 'team-a',
    activeOrganizationId: 'org-1',
    permissions: [],
    isOrganizationAdmin: false
}

function entry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'pin-1',
        name: 'pq_revenue_by_region',
        purpose: 'Revenue by region',
        description: 'Revenue by region for demo_sales',
        sql: 'SELECT region, sum(amount) AS revenue FROM demo_sales WHERE region = :region LIMIT 2',
        params: [{ name: 'region', type: 'text', required: true }],
        version: 2,
        statementHash: 'forged-hash',
        ...overrides
    }
}

function node(inputs: Record<string, unknown>, credential: string) {
    return {
        id: 'pg_0',
        data: {
            id: 'pg_0',
            name: 'postgreSQLMCP',
            credential,
            inputs
        }
    }
}

function savedPin() {
    return {
        id: 'pin-1',
        name: 'pq_revenue_by_region',
        purpose: 'Revenue by region',
        description: 'old',
        sql: 'SELECT old FROM demo_sales LIMIT 2',
        params: [{ name: 'region', type: 'text', required: true }],
        version: 2
    }
}

let flowType = 'CHATFLOW'

function liveFlow() {
    return {
        id: FLOW,
        type: flowType,
        flowData: JSON.stringify({
            nodes: [
                node(
                    {
                        analystRelations: JSON.stringify(['live_only']),
                        pinnedQueries: [{ ...savedPin(), sql: 'SELECT live FROM demo_sales LIMIT 2', version: 1 }]
                    },
                    'cred-live'
                )
            ],
            edges: []
        })
    }
}

function draftCanvas() {
    return JSON.stringify({
        nodes: [
            node(
                {
                    analystRelations: JSON.stringify(['demo_sales']),
                    analystAllowedFunctions: 'public.lower(text)\n# note',
                    analystRowCap: '40',
                    analystTimeoutSeconds: '8',
                    pinnedQueries: [savedPin()]
                },
                'cred-demo'
            )
        ],
        edges: []
    })
}

function compilePinned(value: any, args?: any) {
    calls.compile.push({ sql: value.sql, args, types: (value.params || []).map((param: any) => param.type) })
    const order = (value.params || []).map((param: any) => param.name)
    const castList = (kind: 'run' | 'check') =>
        order
            .map((_name: string, index: number) => {
                const type = value.params[index].type
                return kind === 'run' ? `($${index + 1}::pg_catalog.${type})` : `(NULL::pg_catalog.${type})`
            })
            .join(', ')
    const runText = order.length ? `SELECT ${castList('run')} FROM demo_sales LIMIT 2` : 'SELECT region FROM demo_sales LIMIT 2'
    const checkText = order.length ? `SELECT ${castList('check')} FROM demo_sales LIMIT 2` : runText
    return {
        runText,
        checkText,
        binds: args === undefined ? null : order.map((name: string) => (args as any)[name]),
        order,
        statementHash: 'hash-from-server'
    }
}

function sentPair(options: Record<string, unknown>) {
    const keys = Object.keys(options || {})
    expect(keys).not.toContain('binds')
    expect(keys).not.toContain('checkText')
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    }
    return value
}

function installDeps(extra: Record<string, unknown> = {}) {
    setPinnedQueryDeps({
        getChatflowByIdForWorkspace: async (id: string, workspaceId: string) => {
            calls.flows.push([id, workspaceId])
            // Frozen, so a write to the loaded flow fails the request.
            return deepFreeze(liveFlow())
        },
        flowDataForTestChat: async (flow: any) => {
            calls.drafts.push(flow)
            return draftCanvas()
        },
        loadCredentialUrl: async (credentialId: string, workspaceId: string) => {
            calls.creds.push([credentialId, workspaceId])
            if (!(READABLE[workspaceId] || []).includes(credentialId)) throw new Error(`Credential ${credentialId} not found`)
            return CRED_URL
        },
        resolveAnalystConnection: ({ credentialUrl, analystUrl }: { credentialUrl?: string; analystUrl?: string }) => {
            if (!credentialUrl && !analystUrl) return { kind: 'auto' }
            return { kind: 'url', postgresUrl: credentialUrl || analystUrl || '' }
        },
        analystCallLimits: (requested: { rowCap?: number; statementTimeoutMs?: number }) => {
            calls.limits.push(requested)
            return {
                rowCap: Math.floor(requested.rowCap || 100),
                timeoutMs: requested.statementTimeoutMs || 15000
            }
        },
        compilePinned,
        validateArgs: () => {
            throw new Error('compile already returned binds')
        },
        stampPayload: (fields: unknown) => {
            calls.stampFields.push(fields)
            return JSON.stringify(fields)
        },
        computeStamp: () => {
            calls.stamps += 1
            return 'ab'.repeat(32)
        },
        pinnedToolDefinition: (value: any) => ({
            name: value.name,
            description: value.description || value.purpose,
            inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
        }),
        getPinnedQueryKey: async () => Buffer.from('zz-test-key'),
        queryAnalystUrl: async (url: string, input: any, options: any) => {
            const sql = typeof input === 'string' ? input : input?.sql
            calls.query.push({ url, sql, options })
            if (calls.throwQuery) throw new Error(`Cuttlely refused this query: add a LIMIT to the query, such as LIMIT 100. ${CRED_URL}`)
            if (options?.suggestTypesSql) return { paramTypes: calls.paramTypes }
            const entrySql = typeof options?.pinned?.entry?.sql === 'string' ? options.pinned.entry.sql : ''
            if (entrySql.includes('pg_typeof') || String(sql || '').includes('pg_typeof')) {
                return { rows: [{ region: 'text' }], truncated: false, total: 1 }
            }
            return { rows: [{ region: 'east' }, { region: 'west' }], truncated: false, total: 2 }
        },
        recordTest: async (event: any) => {
            calls.audits.push(event)
        },
        ...extra
    })
}

function app() {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        ;(req as any).user = user
        next()
    })
    server.use('/api/v1/pinned-queries', pinnedQueriesRouter)
    server.use(errorHandlerMiddleware)
    return server
}

function resetCalls() {
    calls.query = []
    calls.compile = []
    calls.stamps = 0
    calls.stampFields = []
    calls.flows = []
    calls.creds = []
    calls.limits = []
    calls.audits = []
    mockAuditSql.length = 0
    calls.drafts = []
    calls.throwQuery = false
    calls.paramTypes = ['text']
    flowType = 'CHATFLOW'
}

describe('pinned query test route', () => {
    const previous = process.env.CUTTLELY_PINNED_QUERIES

    beforeAll(() => {
        setHarnessFlowLookup(async () => null)
    })

    beforeEach(() => {
        resetCalls()
        process.env.CUTTLELY_PINNED_QUERIES = '1'
        setTeamPermissionLookup({
            async accessFor() {
                return { owner: false, permissions: ['chatflows:update'] }
            }
        })
        installDeps()
    })

    afterEach(() => {
        setPinnedQueryDeps(null)
        setTeamPermissionLookup(null)
    })

    afterAll(() => {
        setHarnessFlowLookup(null)
        if (previous === undefined) delete process.env.CUTTLELY_PINNED_QUERIES
        else process.env.CUTTLELY_PINNED_QUERIES = previous
    })

    it('per-flow-type permission', async () => {
        flowType = 'AGENTFLOW'
        const denied = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' } })
        expect(denied.status).toBe(403)
        expect(denied.body.message).toContain('permission')
        expect(calls.query).toHaveLength(0)
        expect(calls.stamps).toBe(0)

        setTeamPermissionLookup({
            async accessFor() {
                return { owner: false, permissions: ['agentflows:update'] }
            }
        })
        const allowed = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: SAMPLE } })
        expect(allowed.status).toBe(200)
        expect(allowed.body.ok).toBe(true)

        flowType = 'CHATFLOW'
        setTeamPermissionLookup({
            async accessFor() {
                return { owner: false, permissions: ['chatflows:update'] }
            }
        })
        const chat = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' } })
        expect(chat.status).toBe(200)
        expect(calls.flows.every((pair) => pair[0] === FLOW && pair[1] === 'team-a')).toBe(true)
    })

    it('flag off refuses', async () => {
        delete process.env.CUTTLELY_PINNED_QUERIES
        const missing = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/test`).send({ nodeId: 'pg_0' })
        expect(missing.status).toBe(404)
        expect(missing.body.message).toBe('Pinned queries are off on this server.')

        process.env.CUTTLELY_PINNED_QUERIES = 'TRUE'
        const upper = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/test`).send({ postgresUrl: CRED_URL })
        expect(upper.status).toBe(404)

        process.env.CUTTLELY_PINNED_QUERIES = 'yes'
        const word = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/suggest`).send({ sql: 'SELECT 1' })
        expect(word.status).toBe(404)
        expect(calls.query).toHaveLength(0)
        expect(calls.flows).toHaveLength(0)
        expect(calls.stamps).toBe(0)
    })

    it('refuses a caller URL', async () => {
        const refused = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' }, postgresUrl: CRED_URL })
        expect(refused.status).toBe(400)
        expect(refused.body.message).toBe(
            'The test uses the node on this canvas and its credential. Do not send a connection URL or settings for other nodes.'
        )
        expect(JSON.stringify(refused.body)).not.toContain(CRED_URL)
        expect(calls.query).toHaveLength(0)
        expect(calls.flows).toHaveLength(0)
        expect(calls.creds).toHaveLength(0)

        const suggest = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/suggest`)
            .send({ nodeId: 'pg_0', sql: 'SELECT 1 FROM demo_sales LIMIT 1', relations: ['demo_sales'] })
        expect(suggest.status).toBe(400)
        expect(calls.query).toHaveLength(0)
    })

    it('returns the guard message and does not stamp a refused run', async () => {
        calls.throwQuery = true
        const refused = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' } })
        expect(refused.status).toBe(400)
        expect(refused.body.message).toContain('add a LIMIT')
        expect(refused.body.message).not.toContain('postgres://')
        expect(refused.body.message).not.toContain('secret')
        expect(calls.stamps).toBe(0)
        expect(calls.audits).toHaveLength(0)
        expect(calls.query).toHaveLength(1)
        expect(calls.query[0].options.readOnlySql).toBe(true)
    })

    it('tests an unsaved edit with the draft connection and guards', async () => {
        const body = entry({ rowCap: 20 })
        const res = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: body, sampleValues: { region: SAMPLE } })
        expect(res.status).toBe(200)
        expect(calls.drafts[0].flowData).toContain('live_only')
        expect(calls.creds).toEqual([['cred-demo', 'team-a']])
        expect(calls.compile[0].sql).toBe(body.sql)
        expect(calls.compile[0].sql).not.toContain('SELECT old')
        expect(calls.query[0].url).toBe(CRED_URL)
        expect(calls.query[0].options.relations).toEqual(['demo_sales'])
        expect(calls.query[0].options.allowedFunctions).toBe('public.lower(text)\n# note')
        expect(calls.query[0].options.rowCap).toBe(20)
        expect(calls.query[0].options.statementTimeoutMs).toBe(8000)
        expect(calls.query[0].sql).toBeUndefined()
        sentPair(calls.query[0].options)
        expect(Object.keys(calls.query[0].options.pinned).sort()).toEqual(['args', 'entry', 'tool'])
        expect(calls.query[0].options.pinned).toEqual({
            entry: expect.objectContaining({
                id: 'pin-1',
                name: 'pq_revenue_by_region',
                sql: body.sql,
                version: 3
            }),
            args: { region: SAMPLE },
            tool: 'pq_revenue_by_region'
        })
        expect(calls.query[0].options.pinned.entry.sql).not.toContain('::pg_catalog')
        expect(calls.query[1].options.pinned.entry.sql).toContain('pg_typeof')
        expect(calls.query[1].options.pinned.entry.sql).toContain(':region')
        expect(calls.query[1].sql).toBeUndefined()
        sentPair(calls.query[1].options)
        expect(calls.stampFields).toEqual([
            {
                workspaceId: 'team-a',
                cred: 'cred-demo',
                statementHash: 'hash-from-server',
                params: [{ name: 'region', type: 'text', required: true }],
                relations: ['demo_sales'],
                allowedFunctions: ['public.lower(text)', '# note'],
                testedColumns: [{ name: 'region', type: 'text' }]
            }
        ])

        expect(res.body.statementHash).toBe('hash-from-server')
        expect(res.body.rowCount).toBe(2)
        expect(res.body.timeMs).toEqual(expect.any(Number))
        expect(res.body.possiblyTruncated).toBe(true)
        expect(res.body.truncated).toBe(false)
        expect(res.body.columns).toEqual([{ name: 'region', type: 'text' }])
        expect(res.body.rows).toEqual([{ region: 'east' }, { region: 'west' }])
        expect(res.body.guard.join(' ')).toContain('possibly truncated')
        expect(res.body.guard.join(' ')).toContain('tables and views ticked')
        expect(res.body.guard.join(' ')).toContain('allowed list')
        expect(res.body.entry.version).toBe(3)
        expect(res.body.entry.sql).toBe(body.sql)
        expect(res.body.entry.testedStamp).toBe('ab'.repeat(32))
        expect(res.body.entry.needsRetest).toBe(false)
        expect(res.body.entry.statementHash).toBeUndefined()
        expect(res.body.entry.rowCap).toBe(20)
        expect(res.body.tool.name).toBe('pq_revenue_by_region')
        expect(calls.stamps).toBe(1)
        expect(calls.audits).toEqual([
            {
                organizationId: 'org-1',
                workspaceId: 'team-a',
                userId: 'user-1',
                flow: FLOW,
                node: 'pg_0',
                pin: 'pq_revenue_by_region',
                version: 3,
                hash: 'hash-from-server',
                cred: 'cred-demo',
                paramNames: ['region']
            }
        ])
        const packed = JSON.stringify(res.body) + JSON.stringify(calls.audits)
        expect(packed).not.toContain('postgres://')
        expect(packed).not.toContain(SAMPLE)
        expect(packed).not.toContain('forged-hash')
    })

    it('tests the unsaved canvas values for the node', async () => {
        // The real audit writer, so the row checked below is the one recordAudit would insert.
        installDeps({
            recordTest: async (event: any) => {
                calls.audits.push(event)
                await recordPinnedQueryTest(event)
            }
        })
        const res = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({
                nodeId: 'pg_0',
                entry: entry(),
                sampleValues: { region: 'east' },
                canvas: {
                    credential: 'cred-demo',
                    inputs: { analystRelations: JSON.stringify(['demo_sales', 'demo_regions']), analystRowCap: '10', pinnedQueries: [] }
                }
            })
        expect(res.status).toBe(200)
        expect(calls.flows).toEqual([[FLOW, 'team-a']])
        expect(calls.creds).toEqual([['cred-demo', 'team-a']])
        expect(calls.query[0].options.relations).toEqual(['demo_sales', 'demo_regions'])
        expect(calls.query[0].options.rowCap).toBe(10)
        expect(calls.query[0].options.allowedFunctions).toBe('public.lower(text)\n# note')
        expect(calls.stampFields[0].relations).toEqual(['demo_sales', 'demo_regions'])
        // The canvas has no saved copy of this pin yet, so the version is the entry's own.
        expect(res.body.entry.version).toBe(2)

        // Nothing from canvas is kept: the only database statements are the audit row (and its retention delete),
        // the loaded flow is frozen and unchanged, and the returned entry holds no canvas inputs.
        expect(mockAuditSql.map((call) => call.text.replace(/\s+/g, ' ').split(' ').slice(0, 3).join(' '))).toEqual([
            'DELETE FROM "audit_event"',
            'INSERT INTO "audit_event"'
        ])
        expect(calls.drafts[0].flowData).toBe(liveFlow().flowData)
        expect(Object.keys(res.body.entry).sort()).toEqual(
            [
                'description',
                'id',
                'name',
                'needsRetest',
                'params',
                'purpose',
                'sql',
                'testedAt',
                'testedBy',
                'testedColumns',
                'testedStamp',
                'version'
            ].sort()
        )
        const row = mockAuditSql[1].params
        expect(row[1]).toBe('pinned_query_change')
        expect(row[2]).toBe('org-1')
        expect(row[3]).toBe('team-a')
        expect(row[6]).toBe('Pinned query pq_revenue_by_region tested')
        // The route's stand-in hash is not a statement hash, so the writer drops it.
        expect(JSON.parse(String(row[7]))).toEqual({
            kind: 'test',
            flow: FLOW,
            node: 'pg_0',
            pin: 'pq_revenue_by_region',
            version: 2,
            cred: 'cred-demo',
            paramNames: ['region'],
            user: 'user-1'
        })
        const written = JSON.stringify(mockAuditSql)
        for (const value of ['demo_regions', 'demo_sales', 'postgres://', 'secret', 'east', 'lower(text)', 'SELECT']) {
            expect(written).not.toContain(value)
        }

        const suggest = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/suggest`)
            .send({
                nodeId: 'pg_0',
                sql: 'SELECT id FROM demo_regions WHERE region = :region LIMIT 1',
                canvas: { inputs: { analystRelations: JSON.stringify(['demo_regions']) } }
            })
        expect(suggest.status).toBe(200)
        expect(calls.query[calls.query.length - 1].options.relations).toEqual(['demo_regions'])

        for (const canvas of [
            { credential: 'cred-demo', postgresUrl: CRED_URL },
            { inputs: { postgresUrl: CRED_URL } },
            { credential: 7 },
            { inputs: [] },
            'cred-demo'
        ]) {
            const before = calls.query.length
            const refused = await request(app())
                .post(`/api/v1/pinned-queries/${FLOW}/test`)
                .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' }, canvas })
            expect(refused.status).toBe(400)
            expect(JSON.stringify(refused.body)).not.toContain(CRED_URL)
            expect(calls.query).toHaveLength(before)
        }
    })

    it('suggested types', async () => {
        calls.paramTypes = ['text', 'date']
        const sql = 'SELECT region, month FROM demo_sales WHERE region = :region AND month = :month LIMIT 5'
        const suggested = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/suggest`).send({ nodeId: 'pg_0', sql })
        expect(suggested.status).toBe(200)
        expect(suggested.body.params).toEqual([
            { name: 'region', type: 'text' },
            { name: 'month', type: 'date' }
        ])
        expect(calls.compile[0].types).toEqual(['text', 'text'])
        expect(calls.query[0].options.readOnlySql).toBe(true)
        expect(calls.query[0].sql).toBeUndefined()
        expect(calls.query[0].options.suggestTypesSql).toBe('SELECT ($1), ($2) FROM demo_sales LIMIT 2')
        expect(calls.query[0].options.pinned.entry.params).toEqual([
            { name: 'region', type: 'text' },
            { name: 'month', type: 'text' }
        ])
        sentPair(calls.query[0].options)
        expect(calls.creds[0]).toEqual(['cred-demo', 'team-a'])

        const names = Array.from({ length: 10 }, (_item, index) => `p${index + 1}`)
        const wide = `SELECT ${names.map((name) => `:${name}`).join(', ')} FROM demo_sales LIMIT 5`
        calls.paramTypes = names.map(() => 'int8')
        const ten = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/suggest`).send({ nodeId: 'pg_0', sql: wide })
        expect(ten.status).toBe(200)
        expect(ten.body.params.map((param: { name: string }) => param.name)).toEqual(names)
        const uncast = calls.query.at(-1).options.suggestTypesSql as string
        expect(uncast).toBe(`SELECT ${names.map((_name, index) => `($${index + 1})`).join(', ')} FROM demo_sales LIMIT 2`)
        expect(uncast).toContain('($10)')
        expect(uncast).not.toContain('$10::')
        sentPair(calls.query.at(-1).options)

        calls.throwQuery = true
        const failed = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/suggest`).send({ nodeId: 'pg_0', sql })
        expect(failed.status).toBe(200)
        expect(failed.body.params).toEqual([
            { name: 'region', type: null },
            { name: 'month', type: null }
        ])
    })

    it('ZZ-TEST- never sends binds or checkText', async () => {
        const tested = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({ nodeId: 'pg_0', entry: entry(), sampleValues: { region: 'east' } })
        expect(tested.status).toBe(200)
        const sql = 'SELECT region FROM demo_sales WHERE region = :region LIMIT 5'
        const suggested = await request(app()).post(`/api/v1/pinned-queries/${FLOW}/suggest`).send({ nodeId: 'pg_0', sql })
        expect(suggested.status).toBe(200)
        expect(calls.query.length).toBeGreaterThanOrEqual(3)
        for (const call of calls.query) {
            sentPair(call.options)
            expect(call.options.readOnlySql).toBe(true)
            expect(call.sql).toBeUndefined()
        }
        expect(calls.query[0].options.pinned).toEqual({
            entry: expect.objectContaining({ id: 'pin-1', sql: entry().sql, version: 3 }),
            args: { region: 'east' },
            tool: 'pq_revenue_by_region'
        })
        expect(calls.query[0].options.pinned.statementHash).toBeUndefined()
        expect(calls.query[1].options.pinned.entry.sql).toContain('pg_typeof')
        expect(calls.query[1].options.suggestTypesSql).toBeUndefined()
        const suggestion = calls.query.at(-1)
        expect(suggestion.options.suggestTypesSql).toBe('SELECT ($1) FROM demo_sales LIMIT 2')
        expect(suggestion.options.pinned.entry).toEqual({
            sql,
            params: [{ name: 'region', type: 'text' }]
        })
        expect(suggestion.options.pinned.args).toBeUndefined()
    })

    it('ZZ-TEST-reads the guard settings exactly as the node does', async () => {
        // scripts/fixtures/pinned/guard-parity.json: comma-separated tables, a decimal row cap and timeout, and a
        // function list with a note and a CRLF. PostgreSQLMCP.pinned.test.ts feeds the same file through the node.
        const { inputs, expected, pin } = GUARD_PARITY
        const send = (body: Record<string, unknown>) =>
            request(app())
                .post(`/api/v1/pinned-queries/${FLOW}/test`)
                .send({
                    nodeId: 'pg_0',
                    entry: entry(body),
                    sampleValues: { region: 'east' },
                    canvas: { inputs: { ...inputs, pinnedQueries: [] } }
                })
        const res = await send({})
        expect(res.status).toBe(200)
        expect(calls.limits[0]).toEqual(expected.requested)
        for (const call of calls.query) {
            expect(call.options.relations).toEqual(expected.relations)
            expect(call.options.allowedFunctions).toBe(expected.allowedFunctions)
            expect(call.options.rowCap).toBe(expected.limits.rowCap)
            expect(call.options.statementTimeoutMs).toBe(expected.limits.timeoutMs)
        }
        expect(calls.stampFields[0].relations).toEqual(expected.relations)
        expect(calls.stampFields[0].allowedFunctions).toEqual(expected.stampFunctions)
        expect(res.body.guard.join(' ')).toContain('tables and views ticked')

        resetCalls()
        const capped = await send({ rowCap: pin.rowCap })
        expect(capped.status).toBe(200)
        expect(calls.limits[0]).toEqual(pin.requested)
        expect(calls.query[0].options.rowCap).toBe(pin.limits.rowCap)

        resetCalls()
        const suggest = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/suggest`)
            .send({ nodeId: 'pg_0', sql: 'SELECT region FROM demo_sales WHERE region = :region LIMIT 1', canvas: { inputs } })
        expect(suggest.status).toBe(200)
        expect(calls.limits[0]).toEqual(expected.requested)
        expect(calls.query[0].options.relations).toEqual(expected.relations)
        expect(calls.query[0].options.allowedFunctions).toBe(expected.allowedFunctions)
    })

    it('ZZ-TEST-refuses a canvas credential from another workspace', async () => {
        const refused = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/test`)
            .send({
                nodeId: 'pg_0',
                entry: entry(),
                sampleValues: { region: 'east' },
                canvas: { credential: 'ZZ-TEST-cred-team-b' }
            })
        expect(refused.status).toBe(400)
        expect(refused.body.message).toBe('Credential ZZ-TEST-cred-team-b not found')
        // The id is looked up in the flow's workspace, never one the request names.
        expect(calls.creds).toEqual([['ZZ-TEST-cred-team-b', 'team-a']])
        expect(calls.query).toHaveLength(0)
        expect(calls.stamps).toBe(0)
        expect(calls.audits).toHaveLength(0)

        const suggest = await request(app())
            .post(`/api/v1/pinned-queries/${FLOW}/suggest`)
            .send({ nodeId: 'pg_0', sql: 'SELECT 1 FROM demo_sales LIMIT 1', canvas: { credential: 'ZZ-TEST-cred-team-b' } })
        expect(suggest.status).toBe(400)
        expect(calls.query).toHaveLength(0)
    })

    it('ZZ-TEST-refuses unknown keys inside a pin entry and inside a parameter', async () => {
        const message =
            'The test uses the node on this canvas and its credential. Do not send a connection URL or settings for other nodes.'
        const bodies = [
            entry({ postgresUrl: CRED_URL }),
            entry({ readOnlySql: false }),
            entry({ params: [{ name: 'region', type: 'text', required: true, postgresUrl: CRED_URL }] }),
            entry({ params: [{ name: 'region', type: 'text', required: true, relations: ['public.other'] }] })
        ]
        for (const body of bodies) {
            const refused = await request(app())
                .post(`/api/v1/pinned-queries/${FLOW}/test`)
                .send({ nodeId: 'pg_0', entry: body, sampleValues: { region: 'east' } })
            expect(refused.status).toBe(400)
            expect(refused.body.message).toBe(message)
            expect(JSON.stringify(refused.body)).not.toContain(CRED_URL)
        }
        expect(calls.flows).toHaveLength(0)
        expect(calls.creds).toHaveLength(0)
        expect(calls.query).toHaveLength(0)
        expect(calls.stamps).toBe(0)
        expect(calls.audits).toHaveLength(0)
    })
})
