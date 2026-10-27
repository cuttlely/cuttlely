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

import { setTeamPermissionLookup } from '../../identity/rbac'
import { setHarnessFlowLookup } from '../../services/harnesses/apiAccess'
import errorHandlerMiddleware from '../../middlewares/errors'
import pinnedQueriesRouter from '../../routes/pinned-queries'
import { setPinnedQueryDeps } from '../../services/pinned-queries'

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

function installDeps() {
    setPinnedQueryDeps({
        getChatflowByIdForWorkspace: async (id: string, workspaceId: string) => {
            calls.flows.push([id, workspaceId])
            return liveFlow()
        },
        flowDataForTestChat: async (flow: any) => {
            calls.drafts.push(flow)
            return draftCanvas()
        },
        loadCredentialUrl: async (credentialId: string, workspaceId: string) => {
            calls.creds.push([credentialId, workspaceId])
            if (credentialId !== 'cred-demo' || workspaceId !== 'team-a') throw new Error(`unexpected credential ${credentialId}`)
            return CRED_URL
        },
        resolveAnalystConnection: ({ credentialUrl, analystUrl }: { credentialUrl?: string; analystUrl?: string }) => {
            if (!credentialUrl && !analystUrl) return { kind: 'auto' }
            return { kind: 'url', postgresUrl: credentialUrl || analystUrl || '' }
        },
        analystCallLimits: (requested: { rowCap?: number; statementTimeoutMs?: number }) => ({
            rowCap: requested.rowCap || 100,
            timeoutMs: requested.statementTimeoutMs || 15000
        }),
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
        }
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
    calls.audits = []
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
        expect(calls.query[0].options.allowedFunctions).toBe('public.lower(text)')
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
        expect(calls.query[0].options.allowedFunctions).toBe('public.lower(text)')
        expect(calls.stampFields[0].relations).toEqual(['demo_sales', 'demo_regions'])
        // The canvas has no saved copy of this pin yet, so the version is the entry's own.
        expect(res.body.entry.version).toBe(2)

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
})
