import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-detail-mask-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'hermes')
process.env.CUTTLELY_PINNED_QUERIES = '1'
delete process.env.HERMES_API_URL

const { answerDirectDecision, maskDetail, maskDetailValues, maskWorkspacePaths, runHarness, runSteps } = await import('./run.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { parseAnalystToolDetail } = await import('./context.mjs')
const { recordAnalystResult } = await import('./analyst-capture.mjs')
const { compileProfile, specialistWorkspace } = await import('./profile.mjs')
const { compilePinned } = await import('./runtime/pinned-query.mjs')
const { scanWorkspaceText, workspaceMaskState } = await import('./images.mjs')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const crmUrl = 'https://crm.example.com/accounts/99?ref=acme'
const secret = path.join(path.dirname(specialistWorkspace('_')), 'mask-unit', 'zz-secret-path.csv')

test('Markdown citations preserve HTTPS destinations in batch, JSON and every streaming split', () => {
    const root = path.dirname(specialistWorkspace('_'))
    const values = [
        '[Storage migration guide](https://docs.example.com/product/guide)',
        '[Guide](https://docs.example.com/a_(v2))',
        '[One](https://docs.example.com/a)[Two](https://docs.example.com/b)',
        '[Guide](<https://docs.example.com/a>)',
        '[Guide](https://docs.example.com/a "Migration guide")',
        '[Guide](' + 'https://docs.example.com/a?value=' + 'x'.repeat(1500) + ')'
    ]
    for (const text of values) {
        assert.equal(maskWorkspacePaths(text), text)
        assert.equal(maskDetail(text), text)
        assert.deepEqual(JSON.parse(maskDetail(JSON.stringify({ citation: text }))), { citation: text })
        for (let split = 0; split <= text.length; split++) {
            const state = workspaceMaskState()
            assert.equal(
                scanWorkspaceText(state, text.slice(0, split), root) + scanWorkspaceText(state, text.slice(split), root, true),
                text
            )
        }
    }
})

test('Markdown link boundaries do not exempt local paths in labels, destinations, titles or adjacent links', () => {
    const root = path.dirname(specialistWorkspace('_'))
    const values = [
        `[${secret}](https://docs.example.com/a)`,
        `[Guide](${secret})`,
        `[Guide](file://${secret})`,
        `[Guide](https://docs.example.com/a "See ${secret}")`,
        `[One](https://docs.example.com/a)[${secret}](https://docs.example.com/b)`,
        `[${JSON.stringify([secret])}](https://docs.example.com/a)`
    ]
    for (const text of values) {
        const shown = maskWorkspacePaths(text)
        assert(!shown.includes(secret), text)
        assert(!maskDetail(text).includes(secret), text)
        for (let split = 0; split <= text.length; split++) {
            const state = workspaceMaskState()
            assert.equal(
                scanWorkspaceText(state, text.slice(0, split), root) + scanWorkspaceText(state, text.slice(split), root, true),
                shown
            )
        }
    }
})

function deal(index, extra = {}) {
    return {
        deal_id: `D-${1000 + index}`,
        account: `Account ${index}`,
        owner: 'Kim Lee',
        stage: 'Closed Lost',
        churn_reason: 'Budget cut',
        amount: 12000 + index,
        period: 'Q3 2026',
        ...extra
    }
}

function longBody() {
    return {
        rows: [
            ...Array.from({ length: 12 }, (_, index) => deal(index)),
            deal(99, {
                crm_url: crmUrl,
                note: 'customer said...',
                aside: 'renewal (maybe..) lost',
                window: 'Q3..Q4',
                span: 'period_start..period_end',
                range: '2026-07-01..2026-09-30',
                file: secret
            })
        ],
        summary: 'returned 13 of 13 rows for period_start..period_end'
    }
}

function assertLongDetail(detail) {
    assert.equal(typeof detail, 'string')
    assert.ok(detail.length > 1024, `detail length ${detail?.length}`)
    const parsed = parseAnalystToolDetail(detail)
    assert.ok(parsed)
    assert.equal(typeof parsed.error, 'undefined')
    assert.ok(Array.isArray(parsed.rows))
    const row = parsed.rows.at(-1)
    assert.equal(row.crm_url, crmUrl)
    assert.equal(row.note, 'customer said...')
    assert.equal(row.aside, 'renewal (maybe..) lost')
    assert.equal(row.window, 'Q3..Q4')
    assert.equal(row.span, 'period_start..period_end')
    assert.equal(row.range, '2026-07-01..2026-09-30')
    assert.equal(parsed.summary, 'returned 13 of 13 rows for period_start..period_end')
    assert.equal(row.file, 'the workspace')
    assert.equal(detail.includes(crmUrl), true)
    assert.equal(detail.includes('Q3..Q4'), true)
    assert.equal(detail.includes('period_start..period_end'), true)
    assert.equal(detail.includes('customer said...'), true)
    assert.equal(detail.includes(secret), false)
    assert.equal(detail.includes('zz-secret-path.csv'), false)
}

const entry = {
    id: 'family-change',
    version: 1,
    name: 'pq_mom_change_by_family',
    testedStamp: 'ab'.repeat(32),
    sql: 'SELECT family, count FROM demo WHERE count > :threshold_pp LIMIT 100',
    params: [{ name: 'threshold_pp', type: 'numeric', default: 50 }]
}
const rule = {
    id: 'mom-drop',
    pin: entry.name,
    when: ['dropped more than', 'month.over.month'],
    params: { threshold_pp: { source: 'extract', pattern: '(\\d+(?:\\.\\d+)?)\\s*(?:points?|pp)', fallback: 'default' } },
    answer: {
        heading: '## Family change',
        columns: [
            { key: 'family', header: 'Family' },
            { key: 'count', header: 'Count' }
        ],
        closing: ['Source: demo'],
        errorText: 'Could not run {{pin}}: {{error}}.'
    }
}
const pinQuestion = 'How many units dropped more than 50 points?'
const sqlQuestion = 'Show all rows in the deals table.'
const sqlProse = `Closed lost deals for Q3..Q4 are listed below. See ${crmUrl} for the account. The customer said...`
const model = { nodeName: 'scriptedChat', nodeId: 'chat', inputs: {} }
let sequence = 0
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function pinSpecialist() {
    return {
        name: 'data',
        pinFirst: true,
        pinFirstRules: [rule],
        mcpServers: [
            {
                nodeName: 'postgreSQLMCP',
                category: 'Tools (MCP)',
                credential: 'fixture',
                inputs: { pinnedQueries: JSON.stringify([entry]), analystRowCap: 100 }
            }
        ]
    }
}

function pinLoadNode(result, prompts, failure = null) {
    return async (nodeName) =>
        class {
            async init() {
                if (nodeName === 'postgreSQLMCP') {
                    return [
                        {
                            name: entry.name,
                            description: 'Family fixture',
                            schema: { type: 'object', properties: { threshold_pp: { type: 'string' } } },
                            invoke: async () => {
                                if (failure) throw failure
                                return JSON.stringify({ ...result, _cuttlelyTraceSql: compilePinned(entry).runText })
                            }
                        }
                    ]
                }
                return {
                    invoke: async (messages) => {
                        prompts.push(messages)
                        return {
                            content: String(messages[0]?.content).includes('You route work')
                                ? JSON.stringify({ steps: [{ specialist: 'data', task: pinQuestion }] })
                                : 'Chief reply.'
                        }
                    }
                }
            }
        }
}

test('labels with dot dot stay, and a workspace path is still masked', () => {
    const body = longBody()
    assert.ok(JSON.stringify(body).length > 1024)
    assert.equal(maskWorkspacePaths('Q3..Q4'), 'Q3..Q4')
    assert.equal(maskWorkspacePaths('period_start..period_end'), 'period_start..period_end')
    assert.equal(maskWorkspacePaths('customer said...'), 'customer said...')
    assert.equal(maskWorkspacePaths('renewal (maybe..) lost'), 'renewal (maybe..) lost')
    assert.equal(maskWorkspacePaths('2026-07-01..2026-09-30'), '2026-07-01..2026-09-30')
    assert.equal(maskWorkspacePaths(crmUrl), crmUrl)
    assert.equal(maskWorkspacePaths(secret), 'the workspace')
    assert.equal(maskWorkspacePaths('docs/../../report.md'), 'a server path')
    const masked = maskWorkspacePaths(body)
    assert.equal(masked.rows.at(-1).crm_url, crmUrl)
    assert.equal(masked.rows.at(-1).window, 'Q3..Q4')
    assert.equal(masked.rows.at(-1).file, 'the workspace')
    assert.equal(JSON.stringify(masked).includes(secret), false)
})

test('a JSON string cell in a tool detail is masked inside and stays valid JSON', () => {
    const metadata = JSON.stringify({ path: '/srv/reports/private.csv', file: secret, owner: 'Kim Lee', link: crmUrl })
    const plain = '{"kept": "a/b", "n": 1}'
    const summary = `Loaded from {"path":"${secret}"} today`
    const encoded = JSON.stringify(metadata)
    const body = { rows: [{ id: 'D-1', metadata, plain, summary, encoded, note: `See ${crmUrl} and Q3..Q4`, blob: 'z'.repeat(9000) }] }
    // The shape run.mjs sends for a pinned or captured result.
    const detail = JSON.stringify({ result: JSON.stringify(maskDetailValues(body)) })
    const row = JSON.parse(JSON.parse(detail).result).rows[0]
    const inner = JSON.parse(row.metadata)
    assert.equal(detail.includes('/srv/reports'), false)
    assert.equal(detail.includes('zz-secret-path'), false)
    assert.equal(inner.owner, 'Kim Lee')
    assert.equal(inner.link, crmUrl)
    // JSON inside text and JSON encoded as a string are masked too.
    assert.equal(row.summary, 'Loaded from {"path":"the workspace"} today')
    assert.equal(JSON.parse(JSON.parse(row.encoded)).owner, 'Kim Lee')
    // A JSON cell with nothing to mask keeps its bytes, and the other cells are unchanged.
    assert.equal(row.plain, plain)
    // A repeated key that JSON.parse drops does not keep its path in the raw text.
    const repeated = maskDetailValues({ cell: `{"path":"/srv/reports/private.csv","path":"x"}` }).cell
    assert.equal(repeated.includes('/srv/reports'), false)
    assert.deepEqual(JSON.parse(repeated), { path: 'x' })
    for (const key of ['id', 'note', 'blob']) assert.equal(row[key], body.rows[0][key], key)
})

test('pin-first long result stays valid JSON and skips the slower handoff', async () => {
    const body = longBody()
    const name = `mask-pin-${++sequence}`
    saveHarness({ name, chief: { model, instructions: 'Chief persona.' }, specialists: [pinSpecialist()] }, { overwrite: true })
    const prompts = []
    const requests = []
    const events = []
    const loadNode = pinLoadNode(body, prompts)
    const payload = await runHarness({
        name,
        input: pinQuestion,
        chatId: 'chat',
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        fetchImpl: async (url, init = {}) => {
            if (init.method === 'POST' && new URL(url).pathname.endsWith('/v1/runs')) {
                requests.push(JSON.parse(init.body))
                return json({ output: 'Model fallback.', status: 'completed' }, 202)
            }
            return json({ output: 'Model fallback.', status: 'completed' })
        },
        loadNode,
        onEvent: (event) => events.push(event)
    })
    assert.equal(requests.length, 0)
    assert.equal(prompts.length, 0)
    assert.equal(payload.trace.handoff.reason, 'pinFirst')
    assert.equal(payload.trace.handoff.status, 'skipped')
    const done = events.filter((event) => event.type === 'tool' && event.phase === 'done')
    assert.equal(done.length, 1)
    assertLongDetail(done[0].detail)
    assert.equal(JSON.stringify(events).includes(secret), false)

    const roster = getHarness(name)
    const person = { ...roster.specialists[0], profileName: `${name}--data` }
    const context = {
        name,
        chatId: 'pin-log',
        turnId: 'mask-turn',
        roster,
        userText: pinQuestion,
        calls: [],
        moduleOptions: { loadNode, flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } } }
    }
    const results = await runSteps(context, [{ specialist: person, task: pinQuestion }])
    assert.equal(results[0].status, 'completed')
    assert.equal(results[0].analystOk, true)
    assert.equal(results[0].pinFirst?.pin, entry.name)
    assert.equal(context.toolLog.length, 1)
    assertLongDetail(context.toolLog[0].detail)
    assert.equal(JSON.stringify(results).includes(secret), false)
    assert.equal(JSON.stringify(results).includes('zz-secret-path.csv'), false)
})

test('free-sql long result stays valid JSON and answers directly', async () => {
    const body = longBody()
    const name = `mask-sql-${++sequence}`
    const analyst = {
        name: 'analyst',
        answerDirect: true,
        mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)' }]
    }
    saveHarness({ name, chief: { model, instructions: 'Chief persona.' }, specialists: [analyst] }, { overwrite: true })
    const compiled = compileProfile(getHarness(name))
    const person = compiled.roster.specialists[0]
    const callId = 'call-long-1'
    const events = []
    const fetchImpl = async (url, init = {}) => {
        const pathname = new URL(url).pathname
        if (init.method === 'POST' && pathname.endsWith('/v1/runs')) {
            recordAnalystResult({ harness: name, specialist: 'analyst', chatId: 'chat', callId, result: body })
            return json({ run_id: 'one', status: 'started' }, 202)
        }
        if (pathname.endsWith('/events')) {
            const frame = { event: 'tool.completed', tool: 'mcp__analyst__query', tool_call_id: callId, preview: 'rows ready' }
            return new Response(`data: ${JSON.stringify(frame)}\n\n: closed\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        }
        if (pathname.endsWith('/stop')) return json({ status: 'stopping' })
        return json({ status: 'completed', output: sqlProse })
    }
    const context = {
        name,
        chatId: 'chat',
        turnId: 'sql-turn',
        roster: compiled.roster,
        userText: sqlQuestion,
        calls: [],
        baseUrl: 'http://127.0.0.1:9',
        fetchImpl,
        moduleOptions: { flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } } },
        onEvent: (event) => events.push(event)
    }
    const steps = [{ specialist: person, task: sqlQuestion }]
    const results = await runSteps(context, steps)
    assert.equal(results[0].status, 'completed', results[0].error)
    assert.equal(results[0].dataTask, true)
    assert.equal(results[0].analystOk, true)
    assert.equal(context.toolLog.length, 1)
    assert.equal(context.toolLog[0].callId, callId)
    assertLongDetail(context.toolLog[0].detail)
    assert.equal(context.toolLog[0].detail.includes('rows ready'), false)
    const decision = answerDirectDecision(context, steps, results, sqlQuestion)
    assert.equal(decision.reason, undefined)
    assert.equal(typeof decision.text, 'string')
    assert.equal(decision.text.includes(crmUrl), true)
    assert.equal(decision.text.includes('Q3..Q4'), true)
    assert.equal(JSON.stringify(results).includes(secret), false)
    assert.equal(JSON.stringify(events).includes(secret), false)

    const chief = []
    const requests = []
    const payload = await runHarness({
        name,
        input: sqlQuestion,
        chatId: 'direct',
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        fetchImpl: async (url, init = {}) => {
            const pathname = new URL(url).pathname
            if (init.method === 'POST' && pathname.endsWith('/v1/runs')) {
                requests.push(JSON.parse(init.body))
                recordAnalystResult({ harness: name, specialist: 'analyst', chatId: 'direct', callId, result: body })
                return json({ run_id: 'two', status: 'started' }, 202)
            }
            if (pathname.endsWith('/events')) {
                const frame = { event: 'tool.completed', tool: 'mcp__analyst__query', tool_call_id: callId, preview: 'rows ready' }
                return new Response(`data: ${JSON.stringify(frame)}\n\n: closed\n\n`, { headers: { 'content-type': 'text/event-stream' } })
            }
            if (pathname.endsWith('/stop')) return json({ status: 'stopping' })
            return json({ status: 'completed', output: sqlProse })
        },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => {
                            const system = String(messages[0]?.content || '')
                            if (system.includes('You are Harness Prime')) chief.push(messages)
                            return {
                                content: system.includes('You route work')
                                    ? JSON.stringify({ steps: [{ specialist: 'analyst', task: sqlQuestion }] })
                                    : 'Chief reply.'
                            }
                        }
                    }
                }
            },
        onEvent: () => {}
    })
    assert.equal(requests.length, 1)
    assert.equal(chief.length, 0)
    assert.equal(payload.trace.handoff.reason, 'answerDirect')
    assert.equal(payload.trace.handoff.status, 'skipped')
    assert.equal(payload.text.includes(crmUrl), true)
    assert.equal(payload.text.includes('Q3..Q4'), true)
    assert.equal(payload.text.includes(secret), false)
})

test('a long pinned tool error stays valid JSON with no path in every event and the returned payload', async () => {
    const message = `Query failed... see ${crmUrl} and https://docs.example.com/errors?code=42 for Q3..Q4. ${'More... '.repeat(
        200
    )}read ${secret} and 3/4|/tmp/private.csv`
    const name = `mask-pin-error-${++sequence}`
    saveHarness({ name, chief: { model, instructions: 'Chief persona.' }, specialists: [pinSpecialist()] }, { overwrite: true })
    const events = []
    const payload = await runHarness({
        name,
        input: pinQuestion,
        chatId: 'chat',
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        fetchImpl: async () => json({ output: 'Model fallback.', status: 'completed' }),
        loadNode: pinLoadNode({}, [], new Error(message)),
        onEvent: (event) => events.push(event)
    })
    const details = []
    const collect = (value, where) => {
        if (Array.isArray(value)) value.forEach((item) => collect(item, where))
        else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (key === 'detail' && typeof item === 'string') details.push([where, item])
                else collect(item, where)
            }
        }
    }
    for (const event of events) collect(event, event.type)
    collect(payload, 'payload')
    const places = new Set(details.map(([where]) => where))
    for (const where of ['tool', 'specialist', 'final', 'payload']) assert.ok(places.has(where), `no detail in ${where}`)
    for (const [where, detail] of details) {
        const error = JSON.parse(detail).error
        assert.equal(typeof error, 'string', where)
        assert.equal(maskDetail(detail), detail, where)
        assert.equal(/zz-secret-path|\/tmp\/private|mask-unit/.test(detail), false, where)
    }
    const all = JSON.stringify({ events, payload })
    assert.equal(all.includes(secret), false)
    assert.equal(all.includes('/tmp/private.csv'), false)
})

test('a URL keeps its commas and semicolons, and a workspace path joined after it is still replaced', () => {
    const url = 'https://example.com/export?paths=/reports,/invoices'
    for (const text of [url, `See ${url} and https://example.com/a?b=/c;d=/e#x,/y`, JSON.stringify({ link: url })]) {
        assert.equal(maskDetail(text), text)
    }
    const root = path.dirname(specialistWorkspace('_'))
    for (const joined of [`${url},${secret}`, `${url};${secret}`, `${url},file:///etc/hosts`, `https://example.com/a;${root}/x.csv`]) {
        assert.equal(maskDetail(joined), 'a server path', joined)
        assert.equal(JSON.parse(maskDetail(JSON.stringify({ cell: joined }))).cell, 'a server path', joined)
    }
    // In a query or fragment, a path outside the workspace after `,` or `;` is read as part of the URL.
    assert.equal(maskDetail(`${url},/srv/x.csv`), `${url},/srv/x.csv`)
    // Before the query, `,` and `;` end the URL, so a path joined there replaces the string.
    for (const joined of ['http://[::1]:3000/api,/tmp/private.csv', 'https://example.com/a;~/notes']) {
        assert.equal(maskDetail(joined), 'a server path', joined)
    }
    // Outside a URL, any absolute path that starts after a separator replaces the string.
    assert.equal(maskDetail('3/4|/srv/x.csv'), 'a server path')
})

test('a long run of backslashes is masked in linear time', () => {
    const text = '\\'.repeat(40000) + 'x'
    for (const value of [text, JSON.stringify({ cell: text })]) {
        maskDetail(value.slice(-200))
        // The fastest of three runs, so a busy machine does not fail the check.
        const times = [0, 1, 2].map(() => {
            const started = performance.now()
            maskDetail(value)
            return performance.now() - started
        })
        assert.ok(Math.min(...times) < 50, `${Math.min(...times)} ms`)
    }
})

test('fenced public code remains intact while local paths inside code and inline spans stay hidden across chunks', () => {
    const root = path.dirname(specialistWorkspace('_'))
    const code =
        '```bash\nvault auth enable oidc\nvault write auth/oidc/config \\\n  oidc_discovery_url="https://example.okta.com" \\\n  allowed_redirect_uris="http://localhost:8250/oidc/callback"\n```'
    assert.equal(maskWorkspacePaths(code), code)
    const privateCode = '```bash\ncat "' + secret + '"\n```'
    const masked = maskWorkspacePaths(privateCode)
    assert(!masked.includes(secret))
    assert(masked.includes('```bash\ncat "'))
    const inline = '```' + path.dirname(secret) + '/My private.txt```'
    assert(!maskWorkspacePaths(inline).includes('private.txt'))
    for (const input of [code, privateCode, inline, JSON.stringify({ text: code })]) {
        const expected = maskWorkspacePaths(input)
        for (let i = 0; i <= input.length; i++) {
            const state = workspaceMaskState()
            assert.equal(scanWorkspaceText(state, input.slice(0, i), root) + scanWorkspaceText(state, input.slice(i), root, true), expected)
        }
    }
})
