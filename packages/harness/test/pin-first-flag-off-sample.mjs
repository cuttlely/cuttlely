// Prints one deterministic harness turn per scenario as JSON. The checked-in golden next to this file was produced by
// this script on the commit before Pin first existed; pin-first.test.mjs runs it with the setting absent, false, or a
// non-boolean and requires the same bytes. The script only imports modules that existed before the setting.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const variant = process.argv[2] || 'absent'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-first-off-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
process.env.CUTTLELY_PINNED_QUERIES = '1'
process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'true'
delete process.env.HERMES_API_URL
let clock = 1800000000000
Date.now = () => (clock += 1)
performance.now = () => 1000
let ids = 0
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
console.info = () => {}

const { runHarness } = await import('../run.mjs')
const { saveHarness } = await import('../store.mjs')
const { readMessages } = await import('../session.mjs')
const { compilePinned } = await import('../runtime/pinned-query.mjs')

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
    when: ['dropped more than'],
    params: { threshold_pp: { source: 'extract', pattern: '(\\d+)\\s*points?', fallback: 'default' } },
    answer: { heading: '## Family change', closing: ['Source: demo'] }
}
const flag = { absent: undefined, false: false, string: 'true', number: 1, object: {} }[variant]
const data = {
    name: 'data',
    ...(variant === 'absent' ? {} : { pinFirst: flag, pinFirstRules: [rule] }),
    mcpServers: [
        {
            nodeName: 'postgreSQLMCP',
            category: 'Tools (MCP)',
            credential: 'fixture',
            inputs: { pinnedQueries: JSON.stringify([entry]), analystRowCap: 100 }
        }
    ]
}
const body = {
    rows: [
        { family: 'alpha', count: 2 },
        { family: 'beta', count: 0 }
    ],
    summary: 'returned 2 of 2 rows',
    pinned: { id: entry.id, name: entry.name, version: 1, statementHash: compilePinned(entry).statementHash, tool: entry.name }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function turn(scenario, index) {
    const name = `flag-off-${index}`
    saveHarness(
        { name, chief: { model: { nodeName: 'scriptedChat' }, instructions: 'Chief persona.' }, specialists: [structuredClone(data)] },
        { overwrite: true }
    )
    const calls = []
    const prompts = []
    const requests = []
    const events = []
    const loadNode = async (nodeName) =>
        class {
            async init() {
                if (nodeName === 'postgreSQLMCP')
                    return [
                        {
                            name: entry.name,
                            schema: { type: 'object', properties: { threshold_pp: { type: 'string' } } },
                            invoke: async (args) => {
                                calls.push(args)
                                return JSON.stringify(body)
                            }
                        }
                    ]
                return {
                    invoke: async (messages) => {
                        prompts.push(messages)
                        return {
                            content: String(messages[0]?.content).includes('You route work')
                                ? JSON.stringify({ steps: [{ specialist: 'data', task: scenario.input }] })
                                : 'Chief reply.'
                        }
                    }
                }
            }
        }
    const payload = await runHarness({
        name,
        input: scenario.input,
        chatId: 'chat',
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        fetchImpl: async (url, init = {}) => {
            const pathname = new URL(url).pathname
            if (init.method === 'POST' && pathname.endsWith('/v1/runs')) {
                requests.push(JSON.parse(init.body))
                if (scenario.toolEvents) return json({ run_id: 'model-run', status: 'started' }, 202)
                return json({ output: scenario.output, status: 'completed' }, 202)
            }
            if (pathname.endsWith('/events'))
                return new Response(
                    [
                        { event: 'tool.started', tool: `mcp__data__${entry.name}`, callId: 'model-one' },
                        { event: 'tool.completed', tool: `mcp__data__${entry.name}`, callId: 'model-one', preview: JSON.stringify(body) }
                    ]
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join('') + ': closed\n\n',
                    { headers: { 'content-type': 'text/event-stream' } }
                )
            return json({ output: scenario.output, status: 'completed' })
        },
        loadNode,
        onEvent: (event) => events.push(event)
    })
    return { text: payload.text, trace: payload.trace, events, prompts, requests, calls, stored: readMessages(name, 'chat') }
}

const scenarios = [
    { input: 'How many units dropped more than 30 points?', output: 'Model fallback.' },
    { input: 'How many units dropped more than 30 points?', output: 'Two families.', toolEvents: true },
    { input: 'Summarize last week for the team.', output: 'A short summary.' }
]
const out = []
for (const [index, scenario] of scenarios.entries()) out.push(await turn(scenario, index))
fs.rmSync(dir, { recursive: true, force: true })
const text = JSON.stringify(out, null, 1)
    .replace(/"(startedAt|finishedAt|at|time|createdAt|updatedAt|ts)": ?\d{10,}/g, '"$1": 0')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, 'TIME')
process.stdout.write(`${text}\n`)
