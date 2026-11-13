import { applyCredential, resolveSlot, connectionSlots } from './connections'
import { planDiscovery, valuesFromDiscovery } from './discover'
import { inspectFlow } from './inspect'
import {
    beginVerification,
    executeVerify,
    hashFlow,
    importVerifyPublishBlock,
    openingVerifyRecord,
    queryFingerprint,
    recoverOrphanedRun
} from './job'
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
        expect(record.queries[0].state).toBe('failed')
        expect(record.queries[0].message).toContain('no rows')
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

    test('a draft with duplicate node ids is refused and the draft is not changed', async () => {
        const canvas = flow([pin()], 'cred-pg') as {
            nodes: Array<{ id: string; data: { inputs: { pinnedQueries: string } } }>
            edges: unknown[]
        }
        const copy = JSON.parse(JSON.stringify(canvas.nodes[0])) as (typeof canvas.nodes)[number]
        copy.data.inputs.pinnedQueries = JSON.stringify([pin({ id: 'pin-2', name: 'pq_second', sql: 'SELECT 2 FROM account a LIMIT 5' })])
        canvas.nodes.push(copy)
        const text = JSON.stringify(canvas)
        let ran = 0
        const { deps, drafts } = memoryDeps({
            testPin: async () => {
                ran += 1
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...pin(), testedStamp: 'ff'.repeat(32), needsRetest: false }
                }
            }
        })
        const record = await executeVerify({ flowText: text, record: null, deps })
        expect(record.status).not.toBe('ready')
        expect(record.publishOffered).toBe(false)
        expect(record.blockers.some((item) => item.id.includes('node-id:') && item.id.includes('duplicate'))).toBe(true)
        expect(ran).toBe(0)
        expect(drafts.every((item) => item === text)).toBe(true)
    })

    test('a duplicate or missing saved-query id cannot become ready or publishable', async () => {
        const calls: string[] = []
        const { deps, drafts } = memoryDeps({
            testPin: async ({ entry }) => {
                calls.push(String(entry.id || ''))
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...entry, testedStamp: 'ff'.repeat(32), needsRetest: false }
                }
            }
        })
        const duplicate = await executeVerify({
            flowText: JSON.stringify(flow([pin(), pin({ sql: 'SELECT 2 FROM account a LIMIT 5', name: 'pq_second' })], 'cred-pg')),
            record: null,
            deps
        })
        expect(duplicate.status).not.toBe('ready')
        expect(duplicate.publishOffered).toBe(false)
        expect(calls).toEqual([])
        const duplicateDraft = drafts.at(-1) || ''
        expect(
            importVerifyPublishBlock(
                JSON.stringify({ ...duplicate, status: 'ready', publishOffered: true, blockers: [], draftHash: hashFlow(duplicateDraft) }),
                duplicateDraft
            )
        ).toMatch(/not verified/)
        const missing = await executeVerify({
            flowText: JSON.stringify(flow([pin({ id: '' })], 'cred-pg')),
            record: null,
            deps
        })
        expect(missing.status).not.toBe('ready')
        expect(missing.publishOffered).toBe(false)
        expect(calls).toEqual([])
        const missingDraft = drafts.at(-1) || ''
        expect(
            importVerifyPublishBlock(
                JSON.stringify({ ...missing, status: 'ready', publishOffered: true, blockers: [], draftHash: hashFlow(missingDraft) }),
                missingDraft
            )
        ).toMatch(/not verified/)
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
        const different = JSON.stringify(flow([pin({ sql: 'SELECT 2 LIMIT 5' })]))
        expect(importVerifyPublishBlock(JSON.stringify(record), different)).toBeNull()
        expect(importVerifyPublishBlock(JSON.stringify({ ...record, status: 'ready' }), different)).toMatch(/different draft/)
        const running = openingVerifyRecord(draft, '2026-11-13T00:00:00.000Z')
        const replaced = JSON.stringify(flow([pin({ sql: 'SELECT 2 LIMIT 5' })]))
        expect(importVerifyPublishBlock(JSON.stringify(running), replaced)).toMatch(/still running/)
        const noQueries = JSON.stringify({
            nodes: [{ id: 'model', data: { name: 'chatOpenAI', inputs: {} } }],
            edges: [],
            importVerification: 'unverified'
        })
        expect(importVerifyPublishBlock(null, noQueries)).toMatch(/has not been verified/)
        expect(importVerifyPublishBlock(null, draft)).toBeNull()
    })

    test('an integer bound compares as a number, so 20 is inside 1 to 100', () => {
        const params = [{ name: 'n', type: 'int8', required: true, min: '1', max: '100' }]
        const binding = [{ param: 'n', table: 'account', column: 'n', op: '=' as const }]
        expect(valuesFromDiscovery(params, [{ n: '20' }], binding).n).toBe('20')
        expect(valuesFromDiscovery(params, [{ n: '200' }], binding).n).toBeUndefined()
        const amount = [{ name: 'amount', type: 'numeric', required: true, min: '1', max: '100' }]
        const amountBinding = [{ param: 'amount', table: 'account', column: 'amount', op: '=' as const }]
        expect(valuesFromDiscovery(amount, [{ amount: '20.5' }], amountBinding).amount).toBe('20.5')
        expect(valuesFromDiscovery(amount, [{ amount: '100.01' }], amountBinding).amount).toBeUndefined()
    })

    test('a specialist contract uses the saved query on the connected card', () => {
        const canvas = {
            nodes: [
                {
                    id: 'pg',
                    data: {
                        name: 'postgreSQLMCP',
                        label: 'PostgreSQL MCP',
                        inputs: { pinnedQueries: JSON.stringify([pin({ testedStamp: undefined, needsRetest: true })]) }
                    }
                },
                {
                    id: 'spec',
                    data: {
                        name: 'harnessSpecialist',
                        label: 'Analyst',
                        inputs: {
                            trustedOutputs: JSON.stringify([{ pin: 'pq_account_opportunity', hash: 'cd'.repeat(32), mode: 'markdown' }])
                        }
                    }
                }
            ],
            edges: [{ source: 'pg', target: 'spec' }]
        }
        const inspected = inspectFlow({
            flow: canvas,
            pinnedQueriesEnabled: true,
            resolutions: [],
            statementHashes: { [`pg\0pin-1`]: 'cd'.repeat(32) }
        })
        expect(inspected.blockers.some((item) => item.action === 'review-contract')).toBe(false)
        expect(inspected.smoke.some((item) => item.id === 'report')).toBe(true)
        const mismatched = inspectFlow({
            flow: canvas,
            pinnedQueriesEnabled: true,
            resolutions: [],
            statementHashes: { [`pg\0pin-1`]: '11'.repeat(32) }
        })
        expect(mismatched.blockers.some((item) => item.id === 'contract:spec:pq_account_opportunity:hash' && item.nodeId === 'pg')).toBe(
            true
        )
        const hashless = JSON.parse(JSON.stringify(canvas)) as typeof canvas
        hashless.nodes[1].data.inputs.trustedOutputs = JSON.stringify([{ pin: 'pq_account_opportunity', mode: 'markdown' }])
        const missingHash = inspectFlow({
            flow: hashless,
            pinnedQueriesEnabled: true,
            resolutions: [],
            statementHashes: { [`pg\0pin-1`]: 'cd'.repeat(32) }
        })
        expect(missingHash.blockers.some((item) => item.id === 'contract:spec:pq_account_opportunity:hash')).toBe(true)
        expect(missingHash.smoke.some((item) => item.id === 'report')).toBe(false)
        const second = {
            id: 'pg-2',
            data: {
                name: 'postgreSQLMCP',
                label: 'Other',
                inputs: { pinnedQueries: JSON.stringify([pin({ id: 'pin-2', testedStamp: undefined, needsRetest: true })]) }
            }
        }
        const both = {
            ...canvas,
            nodes: [canvas.nodes[0], second, canvas.nodes[1]],
            edges: [
                { source: 'pg', target: 'spec' },
                { source: 'pg-2', target: 'spec' }
            ]
        }
        const ambiguous = inspectFlow({
            flow: both,
            pinnedQueriesEnabled: true,
            resolutions: [],
            statementHashes: { [`pg\0pin-1`]: 'cd'.repeat(32), [`pg-2\0pin-2`]: 'cd'.repeat(32) }
        })
        expect(ambiguous.blockers.some((item) => item.id === 'contract:spec:pq_account_opportunity:ambiguous')).toBe(true)
        expect(ambiguous.smoke.some((item) => item.id === 'report')).toBe(false)
        const nameless = JSON.parse(JSON.stringify(canvas)) as typeof canvas
        nameless.nodes[1].data.inputs.trustedOutputs = JSON.stringify([{ mode: 'markdown' }])
        const unnamed = inspectFlow({
            flow: nameless,
            pinnedQueriesEnabled: true,
            resolutions: [],
            statementHashes: { [`pg\0pin-1`]: 'cd'.repeat(32) }
        })
        expect(unnamed.blockers.some((item) => item.id === 'contract:spec:unnamed')).toBe(true)
        expect(unnamed.smoke.some((item) => item.id === 'report')).toBe(false)
    })

    test('resume reads the stored check before the opening record replaces it', async () => {
        const verified = pin({ verifiedHere: true, testedStamp: 'ff'.repeat(32), needsRetest: false })
        const text = JSON.stringify(flow([verified], 'cred-pg'))
        const parsed = JSON.parse(text) as { nodes: Array<Record<string, unknown>> }
        const savedPin = JSON.parse((parsed.nodes[0].data as { inputs: { pinnedQueries: string } }).inputs.pinnedQueries)[0]
        const fingerprint = queryFingerprint(savedPin, parsed.nodes[0], 'cred-pg')
        const passed = {
            version: 1 as const,
            draftHash: hashFlow(text),
            status: 'attention' as const,
            phase: 'Needs attention',
            checked: 1,
            total: 1,
            queries: [
                {
                    nodeId: 'pg',
                    pinId: 'pin-1',
                    name: 'pq_account_opportunity',
                    title: 'Opportunity for an account',
                    state: 'passed' as const,
                    message: 'Tested on this server.',
                    attempts: 1,
                    fingerprint
                }
            ],
            connections: [],
            blockers: [],
            smoke: [],
            summary: '',
            publishOffered: false,
            updatedAt: '2026-11-13T00:00:00.000Z'
        }
        let stored: VerifyRecord | null = passed
        const resume = await beginVerification({
            read: async () => stored,
            write: async (record) => {
                stored = record
            },
            draftText: text,
            now: '2026-11-13T00:00:01.000Z'
        })
        expect(resume?.queries[0].state).toBe('passed')
        expect(stored?.status).toBe('running')
        expect(stored?.queries).toEqual([])
        let ran = 0
        const { deps } = memoryDeps({
            testPin: async () => {
                ran += 1
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...pin(), testedStamp: 'ff'.repeat(32), needsRetest: false }
                }
            }
        })
        const again = await executeVerify({ flowText: text, record: resume, deps })
        expect(ran).toBe(0)
        expect(again.queries[0].state).toBe('passed')
        const changed = pin({
            sql: 'SELECT 2 FROM account a LIMIT 5',
            verifiedHere: true,
            testedStamp: 'ff'.repeat(32),
            needsRetest: false
        })
        const changedText = JSON.stringify(flow([changed], 'cred-pg'))
        const moved = await beginVerification({
            read: async () => passed,
            write: async () => undefined,
            draftText: changedText,
            now: '2026-11-13T00:00:02.000Z'
        })
        expect(moved).toBeNull()
        let reran = 0
        const { deps: againDeps } = memoryDeps({
            testPin: async () => {
                reran += 1
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...changed, testedStamp: 'ee'.repeat(32), needsRetest: false }
                }
            }
        })
        const forged = await executeVerify({
            flowText: changedText,
            record: { ...passed, draftHash: hashFlow(changedText), queries: [{ ...passed.queries[0], statementHash: 'cd'.repeat(32) }] },
            deps: againDeps
        })
        expect(reran).toBe(0)
        expect(forged.queries[0].state).toBe('failed')
        expect(forged.queries[0].statementHash).toBeUndefined()
        expect(forged.publishOffered).toBe(false)
    })

    test('a running check with no live job can be resumed and still blocks publish', () => {
        const running = {
            version: 1 as const,
            draftHash: hashFlow('draft'),
            status: 'running' as const,
            phase: 'Checking this flow.',
            checked: 0,
            total: 1,
            queries: [],
            connections: [],
            blockers: [],
            smoke: [],
            summary: '',
            publishOffered: false,
            updatedAt: '2026-11-13T00:00:00.000Z'
        }
        expect(recoverOrphanedRun(running, true)).toBe(running)
        const recovered = recoverOrphanedRun(running, false)
        expect(recovered?.status).toBe('incomplete')
        expect(recovered?.publishOffered).toBe(false)
        expect(importVerifyPublishBlock(JSON.stringify(recovered), 'draft')).toMatch(/could not be fully verified/)
    })

    test('a newer draft stops the checkpoint instead of being replaced', async () => {
        let saves = 0
        const { deps } = memoryDeps({
            concurrency: 1,
            saveFlow: async (flowText) => {
                saves += 1
                if (saves > 1) throw Object.assign(new Error('moved'), { code: 'draft-moved' })
                return flowText
            }
        })
        const second = { ...pin({ id: 'pin-2', name: 'pq_second', purpose: 'Second' }), sql: 'SELECT 1 FROM account a LIMIT 5', params: [] }
        const record = await executeVerify({
            flowText: JSON.stringify(flow([pin(), second], 'cred-pg')),
            record: null,
            deps
        })
        expect(record.status).toBe('incomplete')
        expect(record.summary).toContain('Could not fully verify')
        expect(record.blockers.some((item) => item.id === 'draft-moved')).toBe(true)
        expect(saves).toBe(2)
    })

    test('a required credential on a tool card blocks publish when the slot is empty', async () => {
        const canvas = flow([pin()], 'cred-pg')
        ;(canvas.nodes as unknown[]).push({
            id: 'api',
            data: {
                id: 'api',
                name: 'requestsGet',
                label: 'GET',
                category: 'Tools',
                inputParams: [{ type: 'credential', credentialNames: ['openAIApi'] }],
                credential: '',
                inputs: {}
            }
        })
        const { deps } = memoryDeps({ loadedNodeNames: ['postgreSQLMCP', 'chatOpenAI', 'requestsGet'] })
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.status).toBe('attention')
        expect(record.publishOffered).toBe(false)
        expect(record.blockers.some((item) => item.nodeId === 'api' && item.action === 'choose-connection')).toBe(true)
    })

    test('an optional empty credential on a tool card does not block publish', async () => {
        const canvas = flow([pin()], 'cred-pg')
        ;(canvas.nodes as unknown[]).push({
            id: 'api',
            data: {
                id: 'api',
                name: 'requestsGet',
                label: 'GET',
                category: 'Tools',
                inputParams: [{ type: 'credential', credentialNames: ['openAIApi'], optional: true }],
                credential: '',
                inputs: {}
            }
        })
        const { deps } = memoryDeps({ loadedNodeNames: ['postgreSQLMCP', 'chatOpenAI', 'requestsGet'] })
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.status).toBe('ready')
        expect(record.publishOffered).toBe(true)
    })

    test('schema-qualified and quoted tables produce a sample lookup', () => {
        const statements = [
            'SELECT o.name FROM public.orders o WHERE o.id = :id LIMIT 20',
            'SELECT o.name FROM "public"."orders" AS o WHERE o.id = :id LIMIT 20'
        ]
        for (const sql of statements) {
            const plan = planDiscovery(sql, ['public.orders'])
            expect(plan).not.toHaveProperty('error')
            if (!('text' in plan)) return
            expect(plan.text).toContain('"public"."orders"')
            expect(plan.bindings[0].table).toBe('public.orders')
            expect(plan.bindings[0].column).toBe('id')
        }
    })

    test('a schema-qualified query finishes without a permanent sample failure', async () => {
        const sql = 'SELECT o.name FROM public.orders o WHERE o.id = :id LIMIT 20'
        const orders = pin({
            id: 'pin-orders',
            name: 'pq_orders',
            sql,
            params: [{ name: 'id', type: 'text', required: true }]
        })
        const canvas = flow([orders], 'cred-pg')
        canvas.nodes[0].data.inputs.analystRelations = 'public.orders'
        const { deps } = memoryDeps({
            discover: async ({ sql: lookup }) => {
                expect(lookup).toContain('"public"."orders"')
                return { rows: [{ id: 'ord-1' }] }
            },
            testPin: async ({ sampleValues }) => {
                expect(sampleValues.id).toBe('ord-1')
                return {
                    ok: true,
                    rowCount: 1,
                    statementHash: 'cd'.repeat(32),
                    entry: { ...orders, testedStamp: 'ff'.repeat(32), needsRetest: false }
                }
            }
        })
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.queries[0].state).toBe('passed')
        expect(record.queries[0].message || '').not.toContain('could not choose')
    })

    test('numeric range samples use numeric order', () => {
        const params = [
            { name: 'from', type: 'numeric', required: true, min: '0', max: '1000' },
            { name: 'to', type: 'numeric', required: true, min: '0', max: '1000' }
        ]
        const bindings = [
            { param: 'from', table: 'orders', column: 'n', op: '>=' as const },
            { param: 'to', table: 'orders', column: 'n', op: '<=' as const }
        ]
        const values = valuesFromDiscovery(params, [{ from: '9' }, { from: '10' }, { from: '100' }], bindings)
        expect(values.from).toBe('9')
        expect(values.to).toBe('100')
    })

    test('a same-named query on another card does not prove the connected report', async () => {
        const shared = pin({ id: 'pin-report', name: 'pq_report' })
        const canvas = flow([shared], 'cred-pg')
        canvas.nodes[0].id = 'pg-connected'
        ;(canvas.nodes[0].data as { id: string }).id = 'pg-connected'
        ;(canvas.nodes as unknown[]).push({
            id: 'pg-other',
            data: {
                id: 'pg-other',
                name: 'postgreSQLMCP',
                label: 'Other',
                category: 'Tools (MCP)',
                inputParams: [{ type: 'credential', credentialNames: ['PostgresUrl'], optional: true }],
                credential: 'cred-pg',
                inputs: {
                    analystRelations: 'account, opportunity',
                    pinnedQueries: JSON.stringify([shared])
                }
            }
        })
        ;(canvas.nodes as unknown[]).push({
            id: 'spec',
            data: {
                id: 'spec',
                name: 'harnessSpecialist',
                label: 'Analyst',
                inputs: {
                    trustedOutputs: JSON.stringify([{ pin: 'pq_report', hash: 'cd'.repeat(32), mode: 'table-payload-csv' }])
                }
            }
        })
        canvas.edges = [{ source: 'pg-connected', target: 'spec' }]
        const { deps } = memoryDeps({
            loadedNodeNames: ['postgreSQLMCP', 'chatOpenAI', 'harnessSpecialist'],
            testPin: async ({ nodeId }) => ({
                ok: true,
                rowCount: nodeId === 'pg-connected' ? 0 : 4,
                statementHash: 'cd'.repeat(32),
                entry: { ...shared, testedStamp: 'ff'.repeat(32), needsRetest: false }
            })
        })
        const record = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(record.queries.find((item) => item.nodeId === 'pg-connected')?.state).toBe('failed')
        expect(record.queries.find((item) => item.nodeId === 'pg-other')?.state).toBe('passed')
        expect(record.smoke.find((item) => item.id === 'csv')?.state).toBe('failed')
        expect(record.publishOffered).toBe(false)
    })

    test('an empty report can be retried after the table has rows', async () => {
        let rows = 0
        const { deps } = memoryDeps({
            testPin: async () => ({
                ok: true,
                rowCount: rows,
                statementHash: 'cd'.repeat(32),
                entry: { ...pin(), testedStamp: 'ff'.repeat(32), needsRetest: false }
            })
        })
        const canvas = flow([pin()], 'cred-pg') as { nodes: Array<{ data: { inputs: Record<string, unknown> } }> }
        canvas.nodes[0].data.inputs.trustedOutputs = JSON.stringify([
            { pin: 'pq_account_opportunity', hash: 'cd'.repeat(32), mode: 'table-payload-csv' }
        ])
        const first = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(first.queries[0].state).toBe('failed')
        expect(first.publishOffered).toBe(false)
        rows = 3
        const second = await executeVerify({ flowText: JSON.stringify(canvas), record: first, retryFailures: true, deps })
        expect(second.queries[0].state).toBe('passed')
        expect(second.publishOffered).toBe(true)
    })

    test('a required model connection blocks Ready when the edge is missing', async () => {
        const canvas = {
            nodes: [
                {
                    id: 'chief',
                    data: {
                        name: 'harnessChief',
                        label: 'Harness Prime',
                        inputAnchors: [{ name: 'chatModel', label: 'Chat Model', type: 'BaseChatModel' }],
                        inputs: {}
                    }
                },
                {
                    id: 'model',
                    data: {
                        name: 'chatOpenAI',
                        label: 'ChatOpenAI',
                        category: 'Chat Models',
                        inputParams: [{ type: 'credential', credentialNames: ['openAIApi'] }],
                        credential: 'cred-openai',
                        inputs: {}
                    }
                }
            ],
            edges: [] as Array<{ source: string; target: string; targetHandle: string }>
        }
        const { deps } = memoryDeps({ loadedNodeNames: ['harnessChief', 'chatOpenAI'] })
        const blocked = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(blocked.status).toBe('attention')
        expect(blocked.publishOffered).toBe(false)
        expect(blocked.blockers.some((item) => item.id === 'edge:chief:chatModel')).toBe(true)
        expect(blocked.summary).not.toContain('Saved queries were tested')
        canvas.edges.push({
            source: 'model',
            target: 'chief',
            targetHandle: 'chief-input-chatModel-BaseChatModel'
        })
        const ready = await executeVerify({ flowText: JSON.stringify(canvas), record: null, deps })
        expect(ready.blockers.some((item) => item.id === 'edge:chief:chatModel')).toBe(false)
        expect(ready.status).toBe('ready')
        expect(ready.summary).toContain('no saved queries')
    })

    test('a check that stops before it reads connections still blocks publish', async () => {
        const records: VerifyRecord[] = []
        const { deps } = memoryDeps({
            credentials: async () => {
                throw new Error('credentials down')
            },
            saveRecord: async (record) => {
                records.push(JSON.parse(JSON.stringify(record)) as VerifyRecord)
            }
        })
        const text = JSON.stringify(flow([pin()], 'cred-pg'))
        const record = await executeVerify({ flowText: text, record: null, deps })
        expect(records[0].status).toBe('running')
        expect(records[0].draftHash).toBe(hashFlow(text))
        expect(record.status).toBe('incomplete')
        expect(importVerifyPublishBlock(JSON.stringify(record), text)).toMatch(/could not be fully verified/)
        expect(importVerifyPublishBlock(null, text)).toBeNull()
        const untrusted = JSON.stringify(untrustImportedFlow(flow([pin()], 'cred-pg')).flow)
        expect(importVerifyPublishBlock(null, untrusted)).toMatch(/has not been verified/)
    })

    test('a failure after the draft is stored blocks publish of that stored draft', async () => {
        let kept = ''
        let calls = 0
        const { deps } = memoryDeps({
            saveFlow: async (flowText) => {
                calls += 1
                if (calls > 1) throw new Error('database down')
                kept = flowText
                return flowText
            }
        })
        const original = JSON.stringify(flow([pin()], 'cred-pg'))
        const record = await executeVerify({ flowText: original, record: null, deps })
        expect(kept).not.toBe('')
        expect(kept).not.toBe(original)
        expect(record.draftHash).toBe(hashFlow(kept))
        expect(record.status).toBe('incomplete')
        expect(importVerifyPublishBlock(JSON.stringify(record), kept)).toMatch(/could not be fully verified|has not been verified/)
    })

    test('an unqualified column on one table can supply a sample', () => {
        const unqualified = planDiscovery('SELECT region FROM demo_sales WHERE month = :month GROUP BY region LIMIT 100', ['demo_sales'])
        expect(unqualified).toMatchObject({ bindings: [{ param: 'month', table: 'demo_sales', column: 'month', op: '=' }] })
        const ambiguous = planDiscovery('SELECT region FROM demo_sales s JOIN other o ON s.id = o.id WHERE month = :month LIMIT 100', [
            'demo_sales',
            'other'
        ])
        expect(ambiguous).toMatchObject({ error: expect.stringContaining('no column comparisons') })
    })

    test('BETWEEN named parameters can supply a sample range', () => {
        const plan = planDiscovery('SELECT o.id FROM public.orders o WHERE o.created BETWEEN :start AND :end LIMIT 20', ['public.orders'])
        expect(plan).not.toHaveProperty('error')
        if (!('text' in plan)) return
        expect(plan.bindings.map((item) => item.param).sort()).toEqual(['end', 'start'])
        expect(plan.text).toContain('"created"')
    })

    test('choosing a connection writes that id and leaves another empty slot empty', () => {
        const canvas = flow([pin()], '')
        ;(canvas.nodes[1].data as { credential: string }).credential = ''
        const next = applyCredential(canvas, 'pg:credential', 'cred-pg') as typeof canvas
        expect((next.nodes[0].data as { credential: string }).credential).toBe('cred-pg')
        expect((next.nodes[1].data as { credential: string }).credential).toBe('')
    })
})
