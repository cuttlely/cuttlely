import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import { matchPinFirst, renderPinResult, validatePinFirstRules } from './pin-first.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-first-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
process.env.CUTTLELY_PINNED_QUERIES = '1'
process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'true'
delete process.env.HERMES_API_URL
const { runHarness } = await import('./run.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { readMessages } = await import('./session.mjs')
const { sqlTraceFields } = await import('./analyst-capture.mjs')
const { compilePinned } = await import('./runtime/pinned-query.mjs')
const { reduceHarnessEvent } = await import('./trace.mjs')
const { wantsAnalystRows } = await import('./context.mjs')
const { specialistSoul } = await import('./profile.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))
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
        thresholdLine: 'Threshold used: {{param.threshold_pp}} points.',
        closing: ['Source: demo', 'Confidence: tested'],
        errorText: 'Could not run {{pin}}: {{error}}.'
    }
}
const specialist = {
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
const question = 'How many units dropped more than 50 points?'
const body = {
    rows: [
        { family: 'alpha', count: 2 },
        { family: 'beta', count: 0 },
        { family: 'Total', count: 2 }
    ],
    summary: 'returned 3 of 3 rows',
    cursor: 'fixture-cursor',
    pinned: { id: entry.id, name: entry.name, version: 1, statementHash: compilePinned(entry).statementHash, tool: entry.name }
}
const clone = (value) => structuredClone(value)
let sequence = 0
async function run({
    person = specialist,
    input = question,
    result = body,
    failure,
    route,
    images,
    people,
    modelPin = false,
    missingTool = false,
    replay = false,
    name
} = {}) {
    name ||= `pin-check-${++sequence}`
    saveHarness(
        { name, chief: { model: { nodeName: 'scriptedChat' }, instructions: 'Chief persona.' }, specialists: people || [clone(person)] },
        { overwrite: true }
    )
    const calls = [],
        prompts = [],
        requests = [],
        events = []
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const loadNode = async (nodeName) =>
        class {
            async init() {
                if (nodeName === 'postgreSQLMCP' && missingTool) return []
                if (nodeName === 'postgreSQLMCP')
                    return [
                        {
                            name: entry.name,
                            description: 'Family fixture',
                            schema: { type: 'object', properties: { threshold_pp: { type: 'string' }, cursor: { type: 'string' } } },
                            invoke: async (args) => {
                                calls.push(args)
                                for (const name of ['sql', 'statement', 'query', 'binds', 'checkText'])
                                    assert.equal(Object.hasOwn(args, name), false)
                                if (failure) throw Error(failure)
                                return JSON.stringify({ ...result, _cuttlelyTraceSql: compilePinned(entry).runText })
                            }
                        }
                    ]
                return {
                    invoke: async (messages) => {
                        prompts.push(messages)
                        return {
                            content: String(messages[0]?.content).includes('You route work')
                                ? JSON.stringify({ steps: route || [{ specialist: 'data', task: input }] })
                                : 'Chief reply.'
                        }
                    }
                }
            }
        }
    const payload = await runHarness({
        name,
        input,
        chatId: 'chat',
        replay,
        images,
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        fetchImpl: async (url, init = {}) => {
            if (init.method === 'POST' && new URL(url).pathname.endsWith('/v1/runs')) {
                requests.push(JSON.parse(init.body))
                if (modelPin) {
                    const { offeredPinnedTools, invokeOfferedPinnedTool } = await import('./gateway.mjs')
                    const record = getHarness(name)
                    const profileName = `${name}--data`
                    const moduleOptions = { loadNode, flowOptions: { appDataSource: {} } }
                    await offeredPinnedTools(record, 'data', moduleOptions, profileName)
                    await invokeOfferedPinnedTool({
                        record,
                        specialistName: 'data',
                        profileName,
                        toolName: entry.name,
                        args: { threshold_pp: '50' },
                        callId: 'model-one',
                        chatId: 'chat',
                        scope: `${name}:chat`,
                        moduleOptions
                    })
                    return json({ run_id: 'model-pin', status: 'started' }, 202)
                }
                return json({ output: 'Model fallback.', status: 'completed' }, 202)
            }
            if (new URL(url).pathname.endsWith('/events'))
                return new Response(
                    [
                        { event: 'tool.started', tool: `mcp__data__${entry.name}`, callId: 'model-one' },
                        { event: 'tool.completed', tool: `mcp__data__${entry.name}`, callId: 'model-one', preview: JSON.stringify(body) }
                    ]
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join('') + ': closed\n\n',
                    {
                        headers: { 'content-type': 'text/event-stream' }
                    }
                )
            return json({ output: 'Model fallback.', status: 'completed' })
        },
        loadNode,
        onEvent: (event) => events.push(event)
    })
    return {
        payload,
        calls,
        prompts,
        requests,
        events,
        stored: readMessages(name, 'chat'),
        name,
        moduleOptions: { loadNode, flowOptions: { appDataSource: {} } }
    }
}

test('happy path renders how-many rows, skips both models and retry, captures hashes and one answer', async () => {
    const out = await run()
    assert.equal(wantsAnalystRows(question), false)
    assert.equal(out.calls.length, 1)
    assert.equal(out.requests.length, 0)
    assert.equal(out.prompts.length, 0)
    assert.equal(out.payload.trace.direct, false)
    assert.deepEqual(out.payload.trace.handoff.rule, { id: rule.id, pin: entry.name })
    assert.equal(out.payload.trace.handoff.reason, 'pinFirst')
    assert.equal(out.payload.trace.handoff.status, 'skipped')
    assert.match(out.payload.text, /\| alpha \| 2 \|/)
    assert.ok(out.payload.text.indexOf('beta') < out.payload.text.indexOf('Total'))
    assert.ok(out.payload.text.indexOf('Total') < out.payload.text.indexOf(body.summary))
    assert.equal(out.payload.text.match(/Source: demo/g).length, 1)
    assert.equal(out.events.filter((e) => e.type === 'handoff').length, 0)
    assert.equal(out.events.filter((e) => e.type === 'partial' && e.phase === 'answer').length, 1)
    const chip = out.payload.trace.specialists[0].tools[0]
    assert.equal(chip.name, `mcp__data__${entry.name}`)
    assert.equal(chip.status, 'done')
    assert.equal(chip.sqlHash, sqlTraceFields(compilePinned(entry).runText).sqlHash)
    assert.equal(chip.pinned.hash, compilePinned(entry).statementHash)
    assert.equal(out.events.find((e) => e.type === 'tool' && e.phase === 'start').detail, undefined)
    assert.equal(out.events.filter((e) => e.type === 'tool').length, 2)
    assert.equal(out.events.reduce(reduceHarnessEvent, null).status, 'completed')
})

test('no-match and ambiguous rules invoke zero times and retain the model path', async () => {
    for (const person of [
        { ...specialist, pinFirstRules: [{ ...rule, when: ['unrelated'] }] },
        { ...specialist, pinFirstRules: [rule, { ...rule, id: 'another' }] }
    ]) {
        const out = await run({ person })
        assert.equal(out.calls.length, 0)
        assert.equal(out.events.filter((event) => event.type === 'tool').length, 0)
        assert.ok(out.requests.length)
        assert.equal(out.payload.trace.handoff.reason, undefined)
    }
})

test('bad and ambiguous parameters fail before invoke; defaults and fixed values validate', () => {
    const match = (params, input = question) => matchPinFirst({ ...specialist, pinFirstRules: [{ ...rule, params }] }, input)
    assert.equal(matchPinFirst(specialist, question).args.threshold_pp, '50')
    assert.equal(matchPinFirst(specialist, 'units dropped more than yesterday').args.threshold_pp, '50')
    assert.equal(matchPinFirst(specialist, 'dropped more than 25 points and 40 pp').reason, 'ambiguous-param')
    for (const value of ['bad', '1; SELECT 2']) {
        assert.equal(match({ threshold_pp: { source: 'fixed', value } }).reason, 'bad-param')
    }
    assert.equal(match({ threshold_pp: { source: 'default' } }).args.threshold_pp, '50')
    assert.equal(match({ threshold_pp: { source: 'extract', pattern: '(bad)' } }, 'dropped more than bad').reason, 'bad-param')
    for (const name of [
        'sql',
        'statement',
        'query',
        'cursor',
        'page',
        'binds',
        'checkText',
        '__proto__',
        'constructor',
        'prototype',
        'extra'
    ]) {
        const params = Object.create(null)
        params[name] = { source: 'fixed', value: 'bad' }
        assert.equal(match(params).reason, 'bad-param')
    }
})

test('error body and thrown refusal invoke once, skip specialist model and use the chief', async () => {
    for (const options of [{ result: { error: 'guard', cuttlelyOutcome: 'expected' } }, { failure: 'guard' }]) {
        const out = await run({ ...options, person: { ...specialist, answerDirect: true } })
        assert.equal(out.calls.length, 1)
        assert.equal(out.requests.length, 0)
        assert.equal(out.payload.trace.handoff.status, 'done')
        assert.equal(out.payload.trace.handoff.reason, undefined)
        assert.equal(out.payload.text, 'Chief reply.')
        assert.ok(out.prompts.some((messages) => JSON.stringify(messages).includes('Could not run')))
    }
})

test('unstamped pins, isolated storage and disabled pins miss', () => {
    const person = clone(specialist)
    person.mcpServers[0].inputs.pinnedQueries = JSON.stringify([{ ...entry, testedStamp: '' }])
    assert.equal(matchPinFirst(person, question).reason, 'missing-pin')
    delete person.mcpServers[0].credential
    assert.equal(matchPinFirst(person, question, { CUTTLELY_PINNED_QUERIES: '1', CUTTLELY_ANALYST: 'auto' }).reason, 'isolated')
    assert.equal(matchPinFirst(specialist, question, {}).reason, 'pins-off')
})

test('long and malformed regexes fail at save and miss at runtime', () => {
    for (const pattern of ['[', 'x'.repeat(201)]) {
        for (const altered of [
            { ...rule, when: [pattern] },
            { ...rule, params: { threshold_pp: { source: 'extract', pattern } } }
        ]) {
            assert.throws(() => validatePinFirstRules([altered]))
            assert.equal(matchPinFirst({ ...specialist, pinFirstRules: [altered] }, question).reason, 'bad-param')
        }
    }
})

test('renderer escapes cells, respects caps, note fill, empty results and thresholds', () => {
    const text = renderPinResult(
        { rows: [{ family: '|<script>`\n&\\', count: 2 }], summary: 'page line' },
        rule,
        { threshold_pp: '25' },
        { defaults: { threshold_pp: 50 } }
    )
    assert.match(text, /\\\|&lt;script&gt;\\` &amp;\\\\/)
    assert.match(text, /Threshold used: 25 points\./)
    assert.doesNotMatch(renderPinResult(body, rule, { threshold_pp: '50' }, { defaults: { threshold_pp: 50 } }), /Threshold used/)
    assert.match(renderPinResult({ rows: [] }, rule, {}), /returned 0 of 0 rows/)
    assert.match(
        renderPinResult({ rows: [] }, { ...rule, answer: { ...rule.answer, emptyText: 'Nothing returned.' } }, {}),
        /Nothing returned/
    )
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`col${i}`, i]))
    const capped = renderPinResult({ rows: Array(120).fill(many) }, { ...rule, answer: { heading: 'Rows' } }, {}, { rowCap: 2 })
    assert.equal(capped.split('\n').filter((line) => line.startsWith('|')).length, 4)
    assert.doesNotMatch(capped, /col16/)
    const hundred = renderPinResult({ rows: Array(120).fill(many) }, { ...rule, answer: { heading: 'Rows' } }, {})
    assert.equal(hundred.split('\n').filter((line) => line.startsWith('|')).length, 102)
    const long = renderPinResult({ rows: [{ family: 'x'.repeat(201), count: 1 }] }, rule, {})
    assert.ok(long.includes('x'.repeat(200)))
    assert.ok(!long.includes('x'.repeat(201)))
    const markup = renderPinResult(body, { ...rule, answer: { ...rule.answer, heading: '<think>heading</think>' } }, {})
    assert.doesNotMatch(markup, /<think>/)
    const note = { column: 'family', value: 'no data', fillColumns: ['count'] }
    assert.match(
        renderPinResult({ rows: [{ family: 'no data', count: 0 }] }, { ...rule, answer: { ...rule.answer, note } }, {}),
        /\| no data \| no data \|/
    )
})

test('replay stores no additional turn and paging and dependent routes do not pre-run', async () => {
    const replay = await run({ replay: true })
    assert.equal(replay.calls.length, 1)
    assert.equal(replay.stored.length, 0)
    const people = [clone(specialist), { name: 'other', instructions: 'Help.' }]
    const multi = await run({
        people,
        route: [
            { specialist: 'data', task: question },
            { specialist: 'other', task: 'Help.', after: 'data' }
        ]
    })
    assert.equal(multi.calls.length, 0)
})

test('config normalization retains true and refuses invalid rules on full save; soul stays unchanged', () => {
    const name = 'config-pin'
    saveHarness({ name, chief: { model: { nodeName: 'scriptedChat' } }, specialists: [clone(specialist)] })
    assert.equal(getHarness(name).specialists[0].pinFirst, true)
    for (const flag of [undefined, false, 'true', 1]) {
        saveHarness(
            { name, chief: { model: { nodeName: 'scriptedChat' } }, specialists: [{ ...clone(specialist), pinFirst: flag }] },
            { overwrite: true }
        )
        assert.equal(Object.hasOwn(getHarness(name).specialists[0], 'pinFirst'), false)
    }
    assert.throws(() =>
        saveHarness(
            {
                name,
                chief: { model: { nodeName: 'scriptedChat' } },
                specialists: [{ ...specialist, pinFirstRules: [{ ...rule, when: ['['] }] }]
            },
            { overwrite: true }
        )
    )
    const plain = clone(specialist)
    delete plain.pinFirst
    delete plain.pinFirstRules
    assert.equal(specialistSoul(plain), specialistSoul(specialist))
    assert.match(
        fs.readFileSync(new URL('../components/nodes/harness/HarnessSpecialist/HarnessSpecialist.ts', import.meta.url), 'utf8'),
        /this.version = 2\.3/
    )
})

test('flag-off golden: absent false and garbage preserve output events prompts tools stored turn and trace byte for byte', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
    t.mock.method(performance, 'now', () => 1000)
    t.mock.method(crypto, 'randomUUID', () => '00000000-0000-4000-8000-000000000000')
    const files = ['trace-golden.json', 'no-pins-golden.json'].map((file) => new URL(`./test/pinned/${file}`, import.meta.url))
    const before = files.map((file) => fs.readFileSync(file))
    const plain = clone(specialist)
    delete plain.pinFirst
    delete plain.pinFirstRules
    const normalize = (value) => {
        if (Array.isArray(value)) return value.map(normalize)
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item)]))
        return typeof value === 'string'
            ? value
                  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'turn')
                  .replace(/pin-check-\d+/g, 'fixture')
                  .replace(/pin-check-\d+--data/g, 'fixture--data')
            : value
    }
    const sample = async (person) => {
        const out = await run({ person, modelPin: true })
        assert.equal(out.stored.length, 2)
        assert.equal(out.calls.length, 1)
        assert.ok(out.payload.trace.specialists[0].tools[0].sqlHash)
        return JSON.stringify(
            normalize({
                text: out.payload.text,
                trace: out.payload.trace,
                events: out.events,
                prompts: out.prompts,
                tools: out.calls,
                requests: out.requests,
                stored: out.stored
            })
        )
    }
    const expected = await sample(plain)
    for (const flag of [undefined, false, 'true', 1, {}]) assert.equal(await sample({ ...specialist, pinFirst: flag }), expected)
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]))
    // Anchor: test/pin-first-flag-off-golden.json was printed by the same script on the commit before Pin first.
    const script = fileURLToPath(new URL('./test/pin-first-flag-off-sample.mjs', import.meta.url))
    const golden = JSON.stringify(JSON.parse(fs.readFileSync(new URL('./test/pin-first-flag-off-golden.json', import.meta.url), 'utf8')))
    for (const variant of ['absent', 'false', 'string', 'number', 'object']) {
        const child = spawnSync(process.execPath, [script, variant], { encoding: 'utf8', timeout: 60000 })
        assert.equal(child.status, 0, child.stderr)
        assert.equal(JSON.stringify(JSON.parse(child.stdout)), golden, `flag ${variant} changed the flag-off output`)
    }
})

test('threshold extraction uses validated value and every how-many row remains in the answer', async () => {
    const out = await run({ input: 'How many units dropped more than 25 points?' })
    assert.equal(out.calls[0].threshold_pp, '25')
    assert.match(out.payload.text, /Threshold used: 25 points\./)
    for (const row of body.rows) assert.ok(out.payload.text.includes(row.family))
})

test('workspace paths are masked in answers events trace and stored turn; secure start has no detail', async () => {
    const out = await run({ result: { ...body, rows: [{ family: '/workspace/fixture/report.csv', count: 2 }] } })
    for (const value of [out.payload, out.events, out.stored]) assert.doesNotMatch(JSON.stringify(value), /\/workspace\/fixture/)
    assert.equal(out.events.find((event) => event.type === 'tool' && event.phase === 'start').detail, undefined)
})

test('secure pin parameters are redacted by the existing capture path', async () => {
    const person = clone(specialist)
    person.mcpServers[0].inputs.pinnedQueries = JSON.stringify([{ ...entry, params: [{ ...entry.params[0], secure: true }] }])
    const out = await run({ person })
    assert.equal(out.payload.trace.specialists[0].tools[0].pinned.params.threshold_pp, '[redacted]')
    const start = out.events.find((event) => event.type === 'tool' && event.phase === 'start')
    assert.equal(start.detail, undefined)
    assert.equal(start.pinned.params.threshold_pp, '[redacted]')
})

test('sync and store round trip rules and strict opt-in without adding a soul instruction', async () => {
    const { syncHarnessFromFlow } = await import('./sync-from-flow.mjs')
    const canvas = JSON.parse(fs.readFileSync(new URL('../../samples/harnesses/research.canvas.json', import.meta.url)))
    const flow = JSON.parse(canvas.flowData)
    const node = flow.nodes.find((node) => node.data?.name === 'harnessSpecialist')
    for (const flag of [true, false, undefined, 'garbage']) {
        node.data.inputs.pinFirst = flag
        node.data.inputs.pinFirstRules = JSON.stringify([rule])
        const synced = await syncHarnessFromFlow({
            name: 'pin-sync',
            chatflowId: 'pin-sync',
            flowData: JSON.stringify(flow),
            caller: { via: 'session' }
        })
        assert.equal(
            synced.specialists.some((person) => person.pinFirst === true),
            flag === true
        )
        assert.deepEqual(getHarness('pin-sync').specialists.find((person) => person.pinFirstRules)?.pinFirstRules, [rule])
    }
    node.data.inputs.pinFirstRules = JSON.stringify([{ ...rule, params: { sql: { source: 'fixed', value: 'bad' } } }])
    await assert.rejects(() =>
        syncHarnessFromFlow({ name: 'pin-sync', chatflowId: 'pin-sync', flowData: JSON.stringify(flow), caller: { via: 'session' } })
    )
})

test('page-2 replay uses the pre-run pin and refuses another pin or tool', async () => {
    const { invokeOfferedPinnedTool, offeredPinnedTools } = await import('./gateway.mjs')
    const first = await run()
    const { applyAnalystPageRoute } = await import('./run.mjs')
    const roster = getHarness(first.name)
    const { latestAnalystCursor } = await import('./analyst-capture.mjs')
    const route = applyAnalystPageRoute('show more', [], roster.specialists, latestAnalystCursor({ harness: first.name, chatId: 'chat' }))
    assert.equal(route.steps[0].paging, true)
    assert.match(route.steps[0].task, /Call the pq_mom_change_by_family tool with cursor fixture-cursor/)
    assert.doesNotMatch(route.steps[0].task, /Call the query tool/)
    const calls = []
    const moduleOptions = {
        flowOptions: { appDataSource: {} },
        loadNode: async () =>
            class {
                async init() {
                    return [
                        {
                            name: entry.name,
                            schema: { type: 'object', properties: { cursor: { type: 'string' } } },
                            invoke: async (args) => {
                                calls.push(args)
                                assert.equal(args.cursor, body.cursor)
                                return JSON.stringify({ rows: [{ family: 'page two' }], pinned: body.pinned })
                            }
                        }
                    ]
                }
            }
    }
    const profileName = `${first.name}--data`
    await offeredPinnedTools(roster, 'data', moduleOptions, profileName)
    const page = JSON.parse(
        await invokeOfferedPinnedTool({
            record: roster,
            specialistName: 'data',
            profileName,
            toolName: entry.name,
            args: { cursor: body.cursor },
            callId: 'page-two',
            chatId: 'chat',
            scope: `${first.name}:chat`,
            moduleOptions
        })
    )
    assert.equal(page.rows[0].family, 'page two')
    assert.equal(calls.length, 1)
    for (const toolName of ['pq_other', 'query']) {
        const refused = JSON.parse(
            await invokeOfferedPinnedTool({
                record: roster,
                specialistName: 'data',
                profileName,
                toolName,
                args: { cursor: body.cursor },
                callId: 'wrong-tool',
                chatId: 'chat',
                scope: `${first.name}:chat`,
                moduleOptions
            })
        )
        assert.equal(typeof refused.error, 'string')
    }
    assert.equal(calls.length, 1)
})

test('selection uses only the original question; missing captures and missing defaults miss', () => {
    assert.equal(matchPinFirst(specialist, 'unrelated router task').reason, 'no-match')
    const change = (params, pin = entry) => {
        const person = clone(specialist)
        person.pinFirstRules[0].params = params
        person.mcpServers[0].inputs.pinnedQueries = JSON.stringify([pin])
        return matchPinFirst(person, question)
    }
    assert.equal(change({ threshold_pp: { source: 'extract', pattern: '\\d+', fallback: 'default' } }).reason, 'bad-param')
    assert.equal(
        change({ threshold_pp: { source: 'default' } }, { ...entry, params: [{ name: 'threshold_pp', type: 'numeric', required: true }] })
            .reason,
        'bad-param'
    )
    assert.equal(change({}).args.threshold_pp, '50')
    const anchored = clone(specialist)
    anchored.pinFirstRules[0].params.threshold_pp.pattern = '^(\\d+)\\s*'
    assert.equal(matchPinFirst(anchored, '25 40 dropped more than yesterday').args.threshold_pp, '25')
    const boolean = change(
        { threshold_pp: { source: 'fixed', value: true } },
        { ...entry, params: [{ name: 'threshold_pp', type: 'bool', default: false }] }
    )
    assert.equal(boolean.args.threshold_pp, true)
    for (const [type, value] of [
        ['int8', Number.MAX_SAFE_INTEGER + 1],
        ['date', '2026-02-30'],
        ['numeric', '1 OR 1=1']
    ])
        assert.equal(
            change({ threshold_pp: { source: 'fixed', value } }, { ...entry, params: [{ name: 'threshold_pp', type, default: null }] })
                .reason,
            'bad-param'
        )
})

test('rule limits and invalid names are refused and case-insensitive matching is fixed', () => {
    assert.ok(matchPinFirst(specialist, question.toUpperCase()).rule)
    for (const rules of [
        Array.from({ length: 9 }, (_, index) => ({ ...rule, id: `rule-${index}` })),
        [{ ...rule, when: Array(9).fill('yes') }],
        [{ ...rule, pin: 'query' }],
        [{ ...rule, id: undefined }],
        [{ ...rule, id: 1 }],
        [rule, rule]
    ])
        assert.throws(() => validatePinFirstRules(rules))
    const bad = clone(specialist)
    bad.pinFirstRules[0].params = JSON.parse('{"__proto__":{"source":"fixed","value":"bad"}}')
    assert.equal(matchPinFirst(bad, question).reason, 'bad-param')
})

test('zero rows remain a successful pin with one stored answer and one answer partial', async () => {
    const out = await run({ result: { ...body, rows: [], summary: 'returned 0 of 0 rows' } })
    assert.equal(out.calls.length, 1)
    assert.equal(out.requests.length, 0)
    assert.equal(out.payload.trace.handoff.reason, 'pinFirst')
    assert.match(out.payload.text, /\| Family \| Count \|/)
    assert.match(out.payload.text, /returned 0 of 0 rows/)
    assert.equal(out.stored.length, 2)
    assert.equal(out.events.filter((event) => event.type === 'partial' && event.phase === 'answer').length, 1)
    const phases = out.events
        .filter((event) => ['specialist', 'tool', 'partial', 'final'].includes(event.type))
        .map((event) => `${event.type}:${event.phase || ''}`)
    assert.deepEqual(phases, ['specialist:start', 'tool:start', 'tool:done', 'specialist:done', 'partial:answer', 'final:'])
})

test('paging and image turns retain the specialist model and invoke zero pre-runs', async () => {
    const person = clone(specialist)
    person.pinFirstRules[0].when.push('show more')
    const first = await run({ person })
    const next = await run({ person, name: first.name, input: 'show more' })
    assert.equal(next.calls.length, 0)
    assert.ok(next.requests.length >= 1)
    assert.equal(next.payload.trace.handoff.reason, undefined)
    const image = await run({ images: [`data:image/png;base64,${Buffer.from('fixture image').toString('base64')}`] })
    assert.equal(image.calls.length, 0)
    assert.equal(image.payload.trace.handoff.reason, undefined)
})

test('client cancellation is checked before selection and over-budget steps never invoke', async () => {
    const { runSteps } = await import('./run.mjs')
    let checks = 0
    const person = {
        ...specialist,
        get pinFirst() {
            checks++
            return true
        }
    }
    const events = []
    const context = {
        name: 'cancel-fixture',
        chatId: 'chat',
        roster: { specialists: [person] },
        userText: question,
        moduleOptions: {
            loadNode: () => {
                throw Error('Unexpected invoke.')
            }
        },
        onEvent: (event) => events.push(event)
    }
    await assert.rejects(() => runSteps({ ...context, clientSignal: { aborted: true } }, [{ specialist: person, task: question }]), {
        code: 'aborted'
    })
    assert.equal(checks, 0)
    assert.equal(events.length, 0)
    const results = await runSteps({ ...context, budgetSignal: { aborted: true }, budgetMs: 1 }, [{ specialist: person, task: question }])
    assert.equal(checks, 0)
    assert.equal(results[0].status, 'failed')
    assert.equal(events.filter((event) => event.type === 'tool').length, 0)
})

test('grounding and analyst status come from the completed pre-run log, with no retry', async () => {
    const { runSteps } = await import('./run.mjs')
    const fixture = await run()
    const roster = getHarness(fixture.name)
    const person = { ...roster.specialists[0], profileName: `${fixture.name}--data` }
    const context = {
        name: fixture.name,
        chatId: 'grounding',
        turnId: 'fixture-turn',
        roster,
        userText: `Query Postgres: ${question}`,
        calls: [],
        moduleOptions: fixture.moduleOptions
    }
    const results = await runSteps(context, [{ specialist: person, task: context.userText }])
    assert.equal(results[0].dataTask, true)
    assert.equal(results[0].analystOk, true)
    assert.deepEqual(results[0].analystPayloads[0].rows, body.rows)
    assert.equal(context.toolLog.length, 1)
    assert.equal(context.toolLog[0].status, 'done')
    assert.match(context.toolLog[0].callId, /^pinfirst:fixture-turn:1$/)
    assert.equal(fixture.calls.length, 2)
    assert.deepEqual(context.calls, [])
    assert.doesNotMatch(JSON.stringify(context.toolLog), /ANALYST_DID_NOT_RUN_PINNED/)
})

test('caller statement material is refused before any database connection', async () => {
    const { queryAnalystUrl, setAnalystPgClientForTests } = await import('./runtime/analyst-store.mjs')
    let connections = 0
    setAnalystPgClientForTests(() => {
        connections++
        throw Error('Unexpected connection.')
    })
    const pinned = { entry, args: { threshold_pp: '50' }, tool: entry.name }
    try {
        for (const extra of [{ binds: [1] }, { checkText: 'SELECT 1' }])
            await assert.rejects(queryAnalystUrl('', null, { readOnlySql: true, pinned, ...extra }), /Caller-supplied/)
        await assert.rejects(queryAnalystUrl('', null, { pinned }), /readOnlySql: true/)
        assert.equal(connections, 0)
    } finally {
        setAnalystPgClientForTests(null)
    }
})

test('a configured stamp that the node does not offer is a miss with no tool events', async () => {
    const out = await run({ missingTool: true })
    assert.equal(out.calls.length, 0)
    assert.ok(out.requests.length >= 1)
    assert.equal(out.events.filter((event) => event.type === 'tool').length, 0)
    assert.equal(out.payload.trace.handoff.reason, undefined)
})

test('a paged how-many result keeps the rendered table, escaping, author columns and closing lines', async () => {
    const summary = 'rows 1-2 of 250 (page 1 of 125, say "show more" for the next page)'
    const paged = {
        ...body,
        rows: [
            { family: '<think>literal</think>', count: 7, hidden: 'extra column' },
            { family: 'beta', count: 0, hidden: 'extra column' }
        ],
        summary
    }
    const out = await run({ result: paged })
    const text = out.payload.text
    assert.equal(out.payload.trace.handoff.reason, 'pinFirst')
    assert.match(text, /## Family change/)
    assert.match(text, /\| Family \| Count \|/)
    assert.ok(text.includes('&lt;think&gt;literal&lt;/think&gt;'))
    assert.doesNotMatch(text, /<think>/)
    assert.doesNotMatch(text, /extra column|hidden/)
    assert.ok(text.includes(summary))
    assert.match(text, /Source: demo\n\nConfidence: tested$/)
    assert.equal(out.stored.at(-1).content, text)
})

test('a page with more rows than the renderer shows says how many rows it shows', () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ family: `f${index}`, count: index }))
    const text = renderPinResult(
        { rows, summary: 'rows 1-150 of 300 (page 1 of 2, say "show more" for the next page)' },
        rule,
        { threshold_pp: '50' },
        { rowCap: 200 }
    )
    assert.ok(text.includes('| f99 | 99 |'))
    assert.ok(!text.includes('| f100 | 100 |'))
    assert.match(text, /Showing the first 100 of the 150 rows returned on this page\./)
    const small = renderPinResult(
        { rows: rows.slice(0, 3), summary: 'returned 3 of 3 rows' },
        rule,
        { threshold_pp: '50' },
        { rowCap: 200 }
    )
    assert.doesNotMatch(small, /Showing the first/)
})

test('a turn budget that runs out while the pin runs fails the step instead of answering', async () => {
    const { runSteps } = await import('./run.mjs')
    const fixture = await run()
    const roster = getHarness(fixture.name)
    const person = { ...roster.specialists[0], profileName: `${fixture.name}--data` }
    const budget = new AbortController()
    let invoked = 0
    const loadNode = async (nodeName) =>
        nodeName === 'postgreSQLMCP'
            ? class {
                  async init() {
                      return [
                          {
                              name: entry.name,
                              schema: { type: 'object', properties: { threshold_pp: { type: 'string' } } },
                              invoke: async () => {
                                  invoked++
                                  budget.abort()
                                  await new Promise((resolve) => setTimeout(resolve, 20))
                                  return JSON.stringify(body)
                              }
                          }
                      ]
                  }
              }
            : fixture.moduleOptions.loadNode(nodeName)
    const events = []
    const context = {
        name: fixture.name,
        chatId: 'budget',
        turnId: 'budget-turn',
        roster,
        userText: question,
        calls: [],
        budgetMs: 5,
        budgetSignal: budget.signal,
        workSignal: budget.signal,
        moduleOptions: { ...fixture.moduleOptions, loadNode },
        onEvent: (event) => events.push(event)
    }
    const results = await runSteps(context, [{ specialist: person, task: question }])
    assert.equal(invoked, 1)
    assert.equal(results[0].status, 'failed')
    assert.match(results[0].error, /turn budget/)
    assert.equal(results[0].pinFirst, undefined)
    assert.ok(events.some((event) => event.type === 'tool' && event.phase === 'failed'))
    assert.deepEqual(context.calls, [])
})

test('a backtracking author pattern is cut off at the time limit and the question takes the usual specialist path', async () => {
    const slow = 'a'.repeat(40) + '!'
    for (const person of [
        { ...specialist, pinFirstRules: [{ ...rule, when: ['(a+)+$'] }] },
        {
            ...specialist,
            pinFirstRules: [
                { ...rule, when: ['a'], params: { threshold_pp: { source: 'extract', pattern: '((a+)+)$', fallback: 'default' } } }
            ]
        }
    ]) {
        const started = Date.now()
        assert.equal(matchPinFirst(person, slow).reason, 'pattern-timeout')
        assert.ok(Date.now() - started < 1000)
    }
    const out = await run({ person: { ...specialist, pinFirstRules: [{ ...rule, when: ['(a+)+$'] }] }, input: slow })
    assert.equal(out.calls.length, 0)
    assert.ok(out.requests.length)
    assert.equal(out.payload.trace.handoff.reason, undefined)
    assert.equal(matchPinFirst(specialist, question).rule.id, 'mom-drop')
})
