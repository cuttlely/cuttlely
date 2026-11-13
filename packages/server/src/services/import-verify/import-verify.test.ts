import { applyCredential, resolveSlot, connectionSlots } from './connections'
import { planDiscovery, valuesFromDiscovery } from './discover'
import { executeVerify, hashFlow, importVerifyPublishBlock } from './job'
import type { VerifyDeps, VerifyRecord } from './job'
import { parseFlow, queryReady, untrustImportedFlow } from './stamps'

const ACCOUNT_SQL = `SELECT o.name
FROM account a
JOIN opportunity o ON o.account_id = a.id
WHERE a.id = :account AND o.id = :opportunity
LIMIT 100`

function pin(extra: Record<string, unknown> = {}) {
    return {
        id: 'pin-1',
        name: 'pq_account_opportunity',
        purpose: 'Opportunity for an account',
        description: 'Made-up rows.',
        sql: ACCOUNT_SQL,
        params: [
            { name: 'account', type: 'text', required: true },
            { name: 'opportunity', type: 'text', required: true }
        ],
        version: 1,
        testedStamp: 'ab'.repeat(32),
        testedAt: '2020-01-01T00:00:00.000Z',
        testedBy: 'other-server',
        testedColumns: [{ name: 'name', type: 'text' }],
        needsRetest: false,
        ...extra
    }
}

function flow(queries = [pin()], credential: unknown = '') {
    return {
        nodes: [
            {
                id: 'pg',
                data: {
                    id: 'pg',
                    name: 'postgreSQLMCP',
                    label: 'PostgreSQL MCP',
                    category: 'Tools (MCP)',
                    inputParams: [{ type: 'credential', credentialNames: ['PostgresUrl'], optional: true }],
                    credential,
                    inputs: {
                        analystRelations: 'account, opportunity',
                        pinnedQueries: JSON.stringify(queries)
                    }
                }
            },
            {
                id: 'model',
                data: {
                    id: 'model',
                    name: 'chatOpenAI',
                    label: 'ChatOpenAI',
                    category: 'Chat Models',
                    inputParams: [{ type: 'credential', credentialNames: ['openAIApi'] }],
                    credential: 'cred-openai',
                    inputs: {}
                }
            }
        ],
        edges: [{ source: 'model', target: 'pg' }]
    }
}

function memoryDeps(overrides: Partial<VerifyDeps> = {}): {
    deps: VerifyDeps
    live: { text: string }
    drafts: string[]
    records: VerifyRecord[]
} {
    const live = { text: JSON.stringify(flow()) }
    const drafts: string[] = []
    const records: VerifyRecord[] = []
    const deps: VerifyDeps = {
        now: () => '2026-11-13T00:00:00.000Z',
        saveFlow: async (flowText) => {
            drafts.push(flowText)
            return flowText
        },
        saveRecord: async (record) => {
            records.push(JSON.parse(JSON.stringify(record)))
        },
        credentials: async () => [
            { id: 'cred-pg', name: 'Warehouse', credentialName: 'PostgresUrl' },
            { id: 'cred-openai', name: 'OpenAI main', credentialName: 'openAIApi' }
        ],
        testPin: async () => ({
            ok: true,
            rowCount: 2,
            statementHash: 'cd'.repeat(32),
            entry: { ...pin(), testedStamp: 'ff'.repeat(32), testedAt: '2026-11-13T00:00:00.000Z', needsRetest: false }
        }),
        discover: async () => ({ rows: [{ account: 'acct-1', opportunity: 'opp-9' }] }),
        pdfAvailable: async () => true,
        renderPdfSample: async () => undefined,
        loadedNodeNames: ['postgreSQLMCP', 'chatOpenAI'],
        pinnedQueriesEnabled: true,
        ...overrides
    }
    return { deps, live, drafts, records }
}

describe('imported verification', () => {
    test('a stamp from another server is not ready, and the query text stays', () => {
        const original = flow()
        expect(queryReady(pin())).toBe(true)
        const cleared = untrustImportedFlow(original)
        const nodes = cleared.flow.nodes as Array<{ data: { inputs: { pinnedQueries: string } } }>
        const saved = JSON.parse(nodes[0].data.inputs.pinnedQueries)
        expect(saved[0].sql).toBe(ACCOUNT_SQL)
        expect(saved[0].testedStamp).toBeUndefined()
        expect(saved[0].importedVerification).toBe('untrusted')
        expect(queryReady(saved[0])).toBe(false)
        expect(cleared.stripped).toBe(1)
    })

    test('one matching name and type is used, and two matches are not guessed', () => {
        const slots = connectionSlots(
            flow([pin()], { $credential: { name: 'Warehouse', credentialName: 'PostgresUrl' } }) as { nodes?: unknown }
        )
        const rows = [
            { id: 'cred-pg', name: 'Warehouse', credentialName: 'PostgresUrl' },
            { id: 'cred-other', name: 'Warehouse', credentialName: 'openAIApi' }
        ]
        expect(resolveSlot(slots[0], rows).status).toBe('matched')
        expect(resolveSlot(slots[0], rows).credentialId).toBe('cred-pg')
        const ambiguous = resolveSlot(slots[0], [...rows, { id: 'cred-pg-2', name: 'Warehouse', credentialName: 'PostgresUrl' }])
        expect(ambiguous.status).toBe('ambiguous')
        expect(ambiguous.credentialId).toBe('')
        const empty = connectionSlots(flow([pin()], '') as { nodes?: unknown }).find((slot) => slot.nodeId === 'pg')
        expect(empty && resolveSlot(empty, rows).status).toBe('empty')
    })

    test('an existing destination id is reused and a foreign id is not', () => {
        const rows = [{ id: 'cred-pg', name: 'Warehouse', credentialName: 'PostgresUrl' }]
        const local = connectionSlots(flow([pin()], 'cred-pg') as { nodes?: unknown })[0]
        expect(resolveSlot(local, rows).status).toBe('reused')
        const foreign = connectionSlots(flow([pin()], 'from-the-other-server') as { nodes?: unknown })[0]
        expect(resolveSlot(foreign, rows).status).toBe('missing')
        expect(resolveSlot(foreign, rows, 'cred-pg').credentialId).toBe('cred-pg')
        expect(resolveSlot(foreign, rows, 'not-a-row').credentialId).toBe('')
    })

    test('discovery picks an account and an opportunity that belong together', () => {
        const plan = planDiscovery(ACCOUNT_SQL, ['account', 'opportunity'])
        expect('text' in plan).toBe(true)
        if (!('text' in plan)) return
        expect(plan.text).toContain('LIMIT 20')
        expect(plan.text.toLowerCase()).not.toContain('insert')
        expect(plan.text).not.toContain(ACCOUNT_SQL)
        const values = valuesFromDiscovery(pin().params as [], [{ account: 'acct-1', opportunity: 'opp-9' }], plan.bindings)
        expect(values).toEqual({ account: 'acct-1', opportunity: 'opp-9' })
        const refused = planDiscovery(ACCOUNT_SQL, ['account'])
        expect('error' in refused).toBe(true)
    })

    test('a sensitive column is not used as a test value', () => {
        const plan = planDiscovery('SELECT id FROM account a WHERE a.password = :secret LIMIT 10', ['account'])
        expect('error' in plan).toBe(true)
    })

    test('a valid imported harness finishes without sample values and does not publish', async () => {
        const { deps, live, drafts } = memoryDeps()
        const started = JSON.stringify(flow([pin()], { $credential: { name: 'Warehouse', credentialName: 'PostgresUrl' } }))
        const record = await executeVerify({ flowText: started, record: null, deps })
        expect(record.status).toBe('ready')
        expect(record.publishOffered).toBe(true)
        expect(record.phase).toBe('Finished')
        expect(record.queries[0].state).toBe('passed')
        expect(live.text).toBe(JSON.stringify(flow()))
        const saved = parseFlow(drafts.at(-1) || '')
        const queries = JSON.parse((saved?.nodes?.[0] as { data: { inputs: { pinnedQueries: string } } }).data.inputs.pinnedQueries)
        expect(queries[0].testedStamp).toBe('ff'.repeat(32))
        expect(queryReady(queries[0])).toBe(true)
        expect(importVerifyPublishBlock(JSON.stringify(record), drafts.at(-1))).toBeNull()
    })

    test('an empty result is not proof of a report', async () => {
        const { deps, drafts } = memoryDeps({
            testPin: async () => ({
                ok: true,
                rowCount: 0,
                statementHash: 'cd'.repeat(32),
                entry: { ...pin(), testedStamp: 'ff'.repeat(32), needsRetest: false }
            })
        })
        const canvas = flow([pin()], 'cred-pg') as { nodes: Array<{ data: { inputs: Record<string, unknown> } }> }
        canvas.nodes[0].data.inputs.trustedOutputs = JSON.stringify([
            { pin: 'pq_account_opportunity', hash: 'cd'.repeat(32), mode: 'table-payload-csv' }
        ])
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.queries[0].state).toBe('empty')
        expect(record.status).toBe('attention')
        expect(record.smoke.find((item) => item.id === 'csv')?.state).toBe('failed')
        expect(record.publishOffered).toBe(false)
        expect(importVerifyPublishBlock(JSON.stringify(record), drafts.at(-1))).toMatch(/needs attention/)
    })

    test('a failed query can be retried without retesting one that passed', async () => {
        const seen: string[] = []
        let fail = true
        const { deps, drafts } = memoryDeps({
            testPin: async ({ entry }) => {
                seen.push(String(entry.name))
                if (entry.name === 'pq_second' && fail) return { ok: false, message: 'syntax error near FROM', transient: false }
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...entry, testedStamp: 'ff'.repeat(32), needsRetest: false }
                }
            }
        })
        const second = { ...pin({ id: 'pin-2', name: 'pq_second', purpose: 'Second' }), sql: 'SELECT 1 FROM account a LIMIT 5', params: [] }
        const first = await executeVerify({
            flowText: JSON.stringify(flow([pin(), second], 'cred-pg')),
            record: null,
            deps
        })
        expect(first.queries.map((item) => item.state)).toEqual(['passed', 'failed'])
        expect(first.status).toBe('attention')
        fail = false
        const again = await executeVerify({
            flowText: drafts.at(-1) || '',
            record: first,
            retryFailures: true,
            deps
        })
        expect(again.queries.every((item) => item.state === 'passed')).toBe(true)
        expect(seen.filter((name) => name === 'pq_account_opportunity').length).toBe(1)
        expect(seen.filter((name) => name === 'pq_second').length).toBe(2)
    })

    test('resume keeps a passed query and a stop does not claim success', async () => {
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const controller = new AbortController()
        let calls = 0
        const { deps } = memoryDeps({
            signal: controller.signal,
            concurrency: 1,
            testPin: async () => {
                calls += 1
                if (calls === 1) {
                    controller.abort()
                    return {
                        ok: true,
                        rowCount: 1,
                        statementHash: 'cd'.repeat(32),
                        entry: { ...pin(), testedStamp: 'ff'.repeat(32), needsRetest: false }
                    }
                }
                await gate
                return { ok: true, rowCount: 1, entry: pin() }
            }
        })
        const second = { ...pin({ id: 'pin-2', name: 'pq_second', purpose: 'Second' }), sql: 'SELECT 1 FROM account a LIMIT 5', params: [] }
        const record = await executeVerify({
            flowText: JSON.stringify(flow([pin(), second], 'cred-pg')),
            record: null,
            deps
        })
        release?.()
        expect(record.status).toBe('incomplete')
        expect(record.publishOffered).toBe(false)
        expect(record.summary).toContain('Could not fully verify')
    })

    test('saved queries that are turned off are not reported as ready', async () => {
        const { deps } = memoryDeps({ pinnedQueriesEnabled: false })
        const record = await executeVerify({ flowText: JSON.stringify(flow([pin()], 'cred-pg')), record: null, deps })
        expect(record.status).toBe('incomplete')
        expect(record.blockers.some((item) => item.action === 'turn-on-saved-queries')).toBe(true)
        expect(record.queries.every((item) => item.state === 'pending' || item.state === 'failed' || item.state === 'passed')).toBe(true)
    })

    test('a mismatched output contract is attention, not a rewritten hash', async () => {
        const { deps } = memoryDeps()
        const canvas = flow([pin()], 'cred-pg') as { nodes: Array<{ data: { inputs: Record<string, unknown> } }> }
        canvas.nodes[0].data.inputs.trustedOutputs = JSON.stringify([
            { pin: 'pq_account_opportunity', hash: '11'.repeat(32), mode: 'markdown' }
        ])
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.status).toBe('attention')
        expect(record.blockers.some((item) => item.action === 'review-contract')).toBe(true)
        const saved = JSON.stringify(record)
        expect(saved).not.toContain('"hash":"' + 'cd'.repeat(32))
    })

    test('publish stays blocked only for the draft that was verified', () => {
        const draft = JSON.stringify(flow())
        const record = {
            version: 1,
            draftHash: hashFlow(draft),
            status: 'attention',
            queries: []
        }
        expect(importVerifyPublishBlock(JSON.stringify(record), draft)).toMatch(/needs attention/)
        expect(importVerifyPublishBlock(JSON.stringify({ ...record, status: 'ready' }), draft)).toBeNull()
        expect(importVerifyPublishBlock(JSON.stringify(record), JSON.stringify(flow([pin({ sql: 'SELECT 2 LIMIT 5' })])))).toBeNull()
        expect(importVerifyPublishBlock(null, draft)).toBeNull()
    })

    test('choosing a connection writes that id and leaves another empty slot empty', () => {
        const canvas = flow([pin()], '')
        ;(canvas.nodes[1].data as { credential: string }).credential = ''
        const next = applyCredential(canvas, 'pg:credential', 'cred-pg') as typeof canvas
        expect((next.nodes[0].data as { credential: string }).credential).toBe('cred-pg')
        expect((next.nodes[1].data as { credential: string }).credential).toBe('')
    })
})
