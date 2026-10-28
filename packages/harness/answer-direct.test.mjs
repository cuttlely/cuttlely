import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-direct-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'hermes')
delete process.env.HERMES_API_URL
const { answerDirectDecision, runHarness, keepClosingLines, maskWorkspacePaths, ANALYST_PAGE_NONE } = await import('./run.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { specialistSoul, specialistWorkspace } = await import('./profile.mjs')
const { readMessages } = await import('./session.mjs')
const { recordAnalystResult } = await import('./analyst-capture.mjs')
const { reduceHarnessEvent } = await import('./trace.mjs')
const { compactAnalystPageText } = await import('./context.mjs')
const { syncHarnessFromFlow } = await import('./sync-from-flow.mjs')
const { ANALYST_PAGE_TTL_MS, ANALYST_CURSOR_ERRORS } = await import('./runtime/analyst-page.mjs')
const { flowiseNodeOptions } = await import('./credential-store.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const question = 'Show all rows in the tickets table.'
const page = 'rows 1-2 of 3 (page 1 of 2, say "show more" for the next page)'
const body = { rows: [{ id: 1 }, { id: 2 }], truncated: true, summary: page }
const prose = `id: 1\nid: 2\n${page}`
const model = { nodeName: 'scriptedChat', nodeId: 'chat', inputs: {} }
const analyst = { name: 'analyst', answerDirect: true, mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)' }] }
const step = { specialist: { ...analyst, profileName: 'unit--analyst' }, task: question }
const result = { name: 'analyst', status: 'completed', text: prose, dataTask: true, analystOk: true, analystPayloads: [body] }
function decide({ context = {}, steps = [step], results = [result], input = question } = {}) {
    return answerDirectDecision({ images: [], ...context }, steps, results, input)
}

test('answer direct decision accepts whole requests and paging prose', () => {
    assert.deepEqual(decide(), { text: prose })
    assert.deepEqual(decide({ steps: [{ ...step, task: 'Read cursor', paging: true }], input: 'show more' }), { text: prose })
    assert.deepEqual(
        decide({ steps: [{ ...step, specialist: { name: 'writer', answerDirect: true } }], results: [{ ...result, dataTask: false }] }),
        { text: prose }
    )
})

const cases = [
    ['off', { steps: [{ ...step, specialist: { ...step.specialist, answerDirect: false } }] }],
    ['steps', { steps: [step, step] }],
    ['steps', { results: [] }],
    ['after', { steps: [{ ...step, after: 'earlier' }] }],
    ['images', { context: { images: [{}] } }],
    ['failed', { results: [{ ...result, status: 'failed' }] }],
    ['ungrounded', { results: [{ ...result, ungrounded: true }] }],
    ['analyst', { results: [{ ...result, analystOk: false }] }],
    ...['codeExecution', 'fileAccess', 'shell'].map((key) => [
        'files',
        { steps: [{ ...step, specialist: { ...step.specialist, [key]: true } }] }
    ]),
    ['toolOutput', { steps: [{ ...step, specialist: { name: 'inline', answerDirect: true, modules: [{}] } }] }],
    ['task', { steps: [{ ...step, task: 'Only part of the request' }] }],
    ['budget', { context: { budgetSignal: { aborted: true } } }],
    ['empty', { results: [{ ...result, text: '', analystPayloads: [] }] }],
    ...['{}', '[]', '42', '<think>notes</think>Answer', '<tool_call>query</tool_call>'].map((text) => [
        'raw',
        { results: [{ ...result, text, analystPayloads: [] }] }
    ]),
    ['length', { results: [{ ...result, finishReason: 'length' }] }]
]
for (const [index, [reason, options]] of cases.entries()) {
    test(`answer direct fallback ${reason} case ${index + 1}`, () => assert.deepEqual(decide(options), { reason }))
}
test('answer direct checks client cancellation before eligibility', () => {
    assert.throws(() => decide({ context: { clientSignal: { aborted: true } } }), { code: 'aborted' })
})
test('answer direct preserves complete rows and closing sources once', () => {
    const text = `${prose}\nSource: tickets`
    const out = decide({ results: [{ ...result, text }] }).text
    assert.equal(out, keepClosingLines(out, [{ text }]))
    assert.equal(out.match(/Source: tickets/g)?.length, 1)
    assert.equal(decide().text, prose)
})

function hermes(plan, requests) {
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    return async (url, init = {}) => {
        const pathname = new URL(url).pathname
        if (init.method === 'POST' && pathname.endsWith('/v1/runs')) {
            requests.push(JSON.parse(init.body))
            return json(202, { run_id: 'one', status: 'started' })
        }
        if (pathname.endsWith('/events')) {
            return new Response((plan.events || []).map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + ': closed\n\n', {
                headers: { 'content-type': 'text/event-stream' }
            })
        }
        if (pathname.endsWith('/stop')) return json(200, { status: 'stopping' })
        return json(200, { status: 'completed', output: plan.output })
    }
}
let sequence = 0
async function run({
    enabled = true,
    plan,
    input = question,
    replay = false,
    harness,
    chatId,
    specialists,
    route,
    images,
    forceSpecialistFailure,
    onEvent,
    budgetMs,
    finishReason
} = {}) {
    const name = harness || `answer-check-${++sequence}`
    if (!harness)
        saveHarness({
            name,
            chief: { model, instructions: 'Chief persona.' },
            specialists: specialists || [{ ...analyst, ...(enabled ? { answerDirect: true } : { answerDirect: undefined }) }]
        })
    const calls = []
    const events = []
    const requests = []
    const runPlan = plan || {
        output: prose,
        events: [{ event: 'tool.completed', tool: 'mcp__analyst__pq_tickets', preview: JSON.stringify(body) }]
    }
    const payload = await runHarness({
        name,
        chatId: chatId || 'chat',
        input,
        replay,
        images,
        forceSpecialistFailure,
        budgetMs,
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { ...flowiseNodeOptions(), harnessCaller: { via: 'session' } },
        fetchImpl: hermes(runPlan, requests),
        loadNode: async (nodeName) =>
            nodeName === 'answerRetriever'
                ? class {
                      async init() {
                          return { getRelevantDocuments: async () => [{ pageContent: 'Retrieved prose.', metadata: {} }] }
                      }
                  }
                : class {
                      async init() {
                          return {
                              invoke: async (messages) => {
                                  const system = String(messages[0]?.content || '')
                                  if (system.includes('You route work'))
                                      return { content: JSON.stringify({ steps: route || [{ specialist: 'analyst', task: input }] }) }
                                  if (system.includes('You are Harness Prime')) calls.push(messages)
                                  return {
                                      content: system.includes('You are Harness Prime') ? 'Chief reply.' : runPlan.output,
                                      ...(finishReason ? { response_metadata: { finish_reason: finishReason } } : {})
                                  }
                              }
                          }
                      }
                  },
        onEvent: (event) => {
            events.push(event)
            onEvent?.(event)
        }
    })
    return { name, payload, calls, events, requests }
}

test('answer direct single analyst skips handoff and streams the final trace', async () => {
    const { payload, calls, events, name } = await run()
    assert.equal(calls.length, 0)
    assert.equal(payload.text, prose)
    assert.equal(payload.trace.direct, false)
    assert.equal(payload.trace.handoff.status, 'skipped')
    assert.equal(payload.trace.handoff.reason, 'answerDirect')
    assert.equal(payload.trace.handoff.tokens, null)
    assert.deepEqual(payload.report.tokens, { prompt: null, completion: null, cached: null })
    assert.ok(payload.timings.handoffMs < 50)
    assert.equal(events.filter((e) => e.type === 'handoff').length, 0)
    const partials = events.filter((e) => e.type === 'partial' && e.phase === 'answer')
    assert.equal(partials.length, 1)
    assert.equal(partials[0].text, payload.text)
    assert.equal(events.at(-1).text, payload.text)
    const done = events.findIndex((e) => e.type === 'specialist' && e.phase === 'done')
    assert.ok(done < events.indexOf(partials[0]))
    assert.equal(events.reduce(reduceHarnessEvent, undefined).handoff.reason, 'answerDirect')
    const messages = readMessages(name, 'chat')
    assert.equal(messages.length, 2)
    assert.equal(messages[0].content, question)
    assert.equal(messages[1].content, payload.text)
})

test('answer direct old records retain the chief handoff and trace shape', async () => {
    const { payload, calls } = await run({ enabled: false })
    assert.equal(calls.length, 1)
    assert.equal(payload.trace.handoff.status, 'done')
    assert.ok(!('reason' in payload.trace.handoff))
    assert.ok(!('answerDirect' in payload.trace))
})

test('answer direct single dependent step retains the chief handoff', async () => {
    // Routing removes a lone dependency; supply it on step objects at the runtime boundary.
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'after')
    Object.defineProperty(Object.prototype, 'after', {
        configurable: true,
        get() {
            return this.specialist?.name === 'analyst' && this.task === question ? 'earlier' : undefined
        }
    })
    try {
        const { payload, calls, requests } = await run()
        assert.equal(payload.trace.route.steps.length, 1)
        assert.equal(payload.trace.route.steps[0].after, 'earlier')
        assert.equal(requests.length, 1)
        assert.equal(calls.length, 1)
        assert.equal(payload.trace.answerDirect, 'after')
        assert.equal(payload.trace.handoff.status, 'done')
        assert.ok(!('reason' in payload.trace.handoff))
    } finally {
        if (previous) Object.defineProperty(Object.prototype, 'after', previous)
        else delete Object.prototype.after
    }
})
for (const [label, event] of [
    ['failed call', { event: 'tool.failed', tool: 'mcp__analyst__query', error: 'Query failed' }],
    ['error body', { event: 'tool.completed', tool: 'mcp__analyst__query', preview: JSON.stringify({ error: 'Query refused' }) }],
    ['unparsed body', { event: 'tool.completed', tool: 'mcp__analyst__query', preview: 'not a parsed payload' }]
]) {
    test(`answer direct ${label} uses the chief`, async () => {
        const { payload, calls } = await run({ plan: { output: 'The query could not run.', events: [event] } })
        assert.equal(calls.length, 1)
        assert.equal(payload.trace.answerDirect, 'analyst')
        assert.ok(!('reason' in payload.trace.handoff))
    })
}

test('answer direct ungrounded results retain the existing short circuit', async () => {
    const { payload, calls } = await run({ plan: { output: 'No evidence.', events: [] } })
    assert.equal(calls.length, 0)
    assert.equal(payload.trace.answerDirect, 'ungrounded')
    assert.ok(!('reason' in payload.trace.handoff))
})

test('answer direct masks paths in answer events trace and stored turns', async () => {
    const name = `answer-check-${++sequence}`
    saveHarness({ name, chief: { model }, specialists: [{ ...analyst }] })
    const privatePath = path.join(specialistWorkspace(`${name}--analyst`), 'report.txt')
    const { payload, events } = await run({
        harness: name,
        plan: {
            output: `Read ${privatePath}`,
            events: [{ event: 'tool.completed', tool: 'mcp__analyst__query', preview: JSON.stringify({ rows: [{ id: 1 }] }) }]
        }
    })
    assert.equal(payload.text, maskWorkspacePaths(`Read ${privatePath}`))
    assert.ok(!JSON.stringify({ payload, events, messages: readMessages(name, 'chat') }).includes(privatePath))
    assert.equal(events.find((e) => e.type === 'partial' && e.phase === 'answer').text, payload.text)
})

test('answer direct replay stores no turns and next prompt compacts page history', async () => {
    const first = await run()
    const second = await run({ harness: first.name, input: 'Say hello', chatId: 'chat' })
    assert.ok(second.requests[0].instructions.includes(compactAnalystPageText(prose)))
    assert.ok(!second.requests[0].instructions.includes('id: 1'))
    assert.equal(readMessages(first.name, 'chat').length, 4)
    const replay = await run({ replay: true })
    assert.equal(readMessages(replay.name, 'chat').length, 0)
})

test('answer direct paging keeps rows last and removes trailing status', async () => {
    const first = await run()
    recordAnalystResult({ harness: first.name, specialist: 'analyst', chatId: 'chat', result: { ...body, cursor: 'page-live' } })
    const next = await run({
        harness: first.name,
        input: 'show more',
        plan: {
            output: `${prose}\nChanged 2 rows`,
            events: [{ event: 'tool.completed', tool: 'mcp__analyst__pq_tickets', preview: JSON.stringify(body) }]
        }
    })
    assert.equal(next.calls.length, 0)
    assert.equal(next.payload.trace.handoff.reason, 'answerDirect')
    assert.ok(next.payload.text.endsWith(page))
    assert.ok(!next.payload.text.includes('Changed 2 rows'))
})

test('answer direct config round trip and soul are opt in', async () => {
    const canvas = JSON.parse(fs.readFileSync(new URL('../../samples/harnesses/research.canvas.json', import.meta.url)))
    const flow = JSON.parse(canvas.flowData)
    const node = flow.nodes.find((node) => node.data?.name === 'harnessSpecialist')
    for (const value of [true, false, undefined, 'garbage']) {
        node.data.inputs.answerDirect = value
        const synced = await syncHarnessFromFlow({
            name: 'answer-config',
            chatflowId: 'answer-config',
            flowData: JSON.stringify(flow),
            caller: { via: 'session' }
        })
        assert.equal(
            synced.specialists.some((s) => s.answerDirect === true),
            value === true
        )
        assert.equal(
            getHarness('answer-config').specialists.some((s) => s.answerDirect === true),
            value === true
        )
        const saved = saveHarness(
            { ...synced, specialists: synced.specialists.map((s) => ({ ...s, answerDirect: value })) },
            { overwrite: true }
        )
        assert.equal(
            saved.specialists.some((s) => 'answerDirect' in s),
            value === true
        )
    }
    assert.ok(specialistSoul(analyst).includes('Your reply is shown to the user as written'))
    assert.ok(!specialistSoul({ ...analyst, answerDirect: false }).includes('Your reply is shown to the user as written'))
    assert.equal(specialistSoul({ name: 'writer', answerDirect: false }), specialistSoul({ name: 'writer' }))
    const source = fs.readFileSync(new URL('../components/nodes/harness/HarnessSpecialist/HarnessSpecialist.ts', import.meta.url), 'utf8')
    assert.ok(source.includes('this.version = 2.3'))
    assert.ok(source.includes('persona and Handoff limit do not apply'))
})

for (const [label, options, reason] of [
    [
        'two steps',
        {
            specialists: [analyst, { name: 'notes', instructions: 'Take notes' }],
            route: [
                { specialist: 'analyst', task: question },
                { specialist: 'notes', task: question }
            ]
        },
        'steps'
    ],
    [
        'inline module',
        { specialists: [{ name: 'analyst', answerDirect: true, modules: [{ nodeName: 'answerRetriever', category: 'Retrievers' }] }] },
        'toolOutput'
    ],
    ['failed step', { forceSpecialistFailure: 'analyst' }, 'failed'],
    ['images', { images: ['https://example.com/receipt.png'] }, 'images'],
    ...['codeExecution', 'fileAccess', 'shell'].map((key) => [key, { specialists: [{ ...analyst, [key]: true }] }, 'files']),
    ['rewritten task', { specialists: [analyst, { name: 'notes' }], route: [{ specialist: 'analyst', task: 'Show the tickets' }] }, 'task'],
    ['empty inline', { specialists: [{ name: 'analyst', answerDirect: true }], plan: { output: '', events: [] } }, 'empty'],
    ['whole JSON inline', { specialists: [{ name: 'analyst', answerDirect: true }], plan: { output: '{"answer":42}', events: [] } }, 'raw'],
    [
        'reasoning inline',
        { specialists: [{ name: 'analyst', answerDirect: true }], plan: { output: '<think>notes</think>Answer', events: [] } },
        'raw'
    ]
]) {
    test(`answer direct runtime fallback for ${label}`, async () => {
        const { payload, calls } = await run(options)
        assert.equal(calls.length, 1)
        assert.equal(payload.trace.answerDirect, reason, JSON.stringify(payload.agents))
        assert.equal(payload.trace.handoff.status, 'done')
        assert.ok(!('reason' in payload.trace.handoff))
    })
}

test('answer direct budget at the gate retains the completed reply unchanged', async () => {
    const timeout = AbortSignal.timeout
    try {
        const texts = []
        for (const enabled of [false, true]) {
            const controller = new AbortController()
            AbortSignal.timeout = () => controller.signal
            const { payload, calls } = await run({
                enabled,
                budgetMs: 45000,
                onEvent(event) {
                    if (event.type === 'specialist' && event.phase === 'done') controller.abort()
                }
            })
            assert.equal(calls.length, 0)
            assert.ok(!('reason' in payload.trace.handoff))
            if (enabled) assert.equal(payload.trace.answerDirect, 'budget')
            else assert.ok(!('answerDirect' in payload.trace))
            texts.push(payload.text)
        }
        assert.equal(texts[0], texts[1])
    } finally {
        AbortSignal.timeout = timeout
    }
})

for (const state of ['none', 'expired', 'owner gone']) {
    test(`answer direct paging ${state} retains the no-step reply`, async () => {
        const first = await run()
        const chatId = `cursor-${state}`
        if (state === 'owner gone') {
            const record = getHarness(first.name)
            record.specialists.push({ ...analyst, name: 'other' })
            saveHarness(record, { overwrite: true })
        }
        if (state !== 'none')
            recordAnalystResult({
                harness: first.name,
                specialist: state === 'owner gone' ? 'missing' : 'analyst',
                chatId,
                result: { cursor: 'old-page' },
                at: state === 'expired' ? Date.now() - ANALYST_PAGE_TTL_MS - 100 : Date.now()
            })
        const next = await run({ harness: first.name, chatId, input: 'show more' })
        assert.equal(next.requests.length, 0)
        assert.equal(next.calls.length, 0)
        assert.equal(next.payload.trace.route.steps.length, 0)
        assert.equal(next.payload.trace.handoff.status, 'skipped')
        assert.ok(!('reason' in next.payload.trace.handoff))
        assert.ok(!('answerDirect' in next.payload.trace))
        if (state === 'none') assert.equal(next.payload.text, ANALYST_PAGE_NONE)
        if (state === 'expired') assert.equal(next.payload.text, ANALYST_CURSOR_ERRORS.expired)
    })
}

test('answer direct inline length completion uses the handoff', async () => {
    const { payload, calls } = await run({ specialists: [{ name: 'analyst', answerDirect: true }], finishReason: 'length' })
    assert.equal(calls.length, 1)
    assert.equal(payload.trace.answerDirect, 'length')
    assert.equal(payload.trace.handoff.status, 'done')
})

test('answer direct rejects whole fenced JSON and accepts prose around a fence', () => {
    for (const language of ['', 'json', 'JSON']) {
        const fenced = `\`\`\`${language}\n{"rows":[{"id":1}]}\n\`\`\``
        assert.deepEqual(decide({ results: [{ ...result, dataTask: false, text: fenced }] }), { reason: 'raw' })
    }
    const fenced = '```json\n{"rows":[{"id":1}]}\n```'
    const text = `Here are the rows:\n${fenced}\nOne row returned.`
    assert.deepEqual(decide({ results: [{ ...result, dataTask: false, text }] }), { text })
})
