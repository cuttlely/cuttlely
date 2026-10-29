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

const { answerDirectDecision, bufferStream, maskWorkspacePaths, runHarness, runSteps } = await import('./run.mjs')
const { hideTurnImageDir, hideWorkspacePaths, scanWorkspaceText, workspaceMaskState } = await import('./images.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { parseAnalystToolDetail } = await import('./context.mjs')
const { recordAnalystResult } = await import('./analyst-capture.mjs')
const { compileProfile, specialistWorkspace } = await import('./profile.mjs')
const { compilePinned } = await import('./runtime/pinned-query.mjs')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const crmUrl = 'https://crm.example.com/accounts/99?ref=acme'
const secret = path.join(path.dirname(specialistWorkspace('_')), 'mask-unit', 'zz-secret-path.csv')

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
        summary: 'returned 13 of 13 rows for period_start..period_end',
        files: { [secret]: 'x'.repeat(1500) }
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
    assert.deepEqual(parsed.files, { 'the workspace': 'x'.repeat(1500) })
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

function pinLoadNode(result, prompts) {
    return async (nodeName) =>
        class {
            async init() {
                if (nodeName === 'postgreSQLMCP') {
                    return [
                        {
                            name: entry.name,
                            description: 'Family fixture',
                            schema: { type: 'object', properties: { threshold_pp: { type: 'string' } } },
                            invoke: async () => JSON.stringify({ ...result, _cuttlelyTraceSql: compilePinned(entry).runText })
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
    assert.equal(maskWorkspacePaths('docs/../../report.md'), 'docs/../../report.md')
    const masked = maskWorkspacePaths(body)
    assert.equal(masked.rows.at(-1).crm_url, crmUrl)
    assert.equal(masked.rows.at(-1).window, 'Q3..Q4')
    assert.equal(masked.rows.at(-1).file, 'the workspace')
    assert.equal(JSON.stringify(masked).includes(secret), false)
})

function streamedAnswer(text) {
    const context = {}
    const chunks = []
    for (const char of text) bufferStream(context, 'answer', char, false, (chunk) => chunks.push(chunk))
    bufferStream(context, 'answer', '', true, (chunk) => chunks.push(chunk))
    return chunks.join('')
}

test('plain-text Markdown links and parenthesized paths are masked through streaming', () => {
    const root = '/var/cuttlely/workspaces'
    for (const file of [root + '/analyst/private.csv', secret]) {
        const fileRoot = file === secret ? path.dirname(specialistWorkspace('_')) : root
        for (const [text, expected] of [
            [`[report](${file})`, '[report](the workspace)'],
            [`See (${file}).`, 'See (the workspace).'],
            [`[report]("${file}")`, '[report]("the workspace")'],
            [`[report](${crmUrl})`, `[report](${crmUrl})`]
        ]) {
            assert.equal(hideWorkspacePaths(text, fileRoot), expected)
            for (const width of [1, text.length]) {
                const context = {}
                let sent = ''
                const send = (chunk) => {
                    sent += chunk
                    assert.ok(expected.startsWith(sent), 'must release only a safe prefix')
                }
                for (let at = 0; at < text.length; at += width)
                    bufferStream(context, 'answer', text.slice(at, at + width), false, send, fileRoot)
                bufferStream(context, 'answer', '', true, send, fileRoot)
                assert.equal(sent, expected)
            }
        }
    }
})

test('Markdown dotted and slash labels hide link and image destinations, including titles', () => {
    const root = path.dirname(specialistWorkspace('_'))
    for (const label of ['x...', 'More...', 'Q3..Q4', 'a//b']) {
        for (const image of ['', '!']) {
            for (const destination of [secret, `"${secret}"`, `<${secret}>`, `${secret} "t"`]) {
                const text = `${image}[${label}](${destination})`
                const shown = hideWorkspacePaths(text, root)
                assert.equal(shown.includes('zz-secret-path.csv'), false)
                if (!label.includes('//')) assert.equal(shown, text.replace(secret, 'the workspace'))
                for (const length of [0, 1500]) {
                    const body = { safe: 'ready', value: text, padding: 'x'.repeat(length) }
                    const expected = JSON.stringify({ ...body, value: shown })
                    const json = JSON.stringify(body)
                    for (const [answer, masked] of [
                        [text, shown],
                        [json, expected],
                        [`Here: ${json}`, `Here: ${expected}`],
                        [`- ${json}`, `- ${expected}`],
                        ['```json\n' + json + '\n```', '```json\n' + expected + '\n```'],
                        [JSON.stringify({ result: json }), JSON.stringify({ result: expected })]
                    ]) {
                        assert.equal(hideWorkspacePaths(answer, root), masked)
                        assert.equal(maskWorkspacePaths(answer), masked)
                        for (const width of [1, 7, 1024]) {
                            const context = {}
                            let sent = ''
                            const send = (chunk) => {
                                sent += chunk
                                assert.ok(masked.startsWith(sent), 'must release only a safe incremental prefix')
                            }
                            for (let at = 0; at < answer.length; at += width)
                                bufferStream(context, 'answer', answer.slice(at, at + width), false, send)
                            bufferStream(context, 'answer', '', true, send)
                            assert.equal(sent, masked)
                        }
                    }
                }
            }
        }
    }
})

test('ordinary slash and dotted labels stay unchanged in plain text, JSON values and streams', () => {
    const prose = [
        'and/or',
        '1/2',
        'Q3/Q4',
        '1.5/2.0',
        'v1.2/v1.3',
        'Q3.1/Q4.2',
        'input/output',
        '10/24/2026',
        'fraction 3/4 (approx)',
        'Revenue (Q3/Q4) rose'
    ]
    const links = []
    for (const label of [
        'and/or',
        '1/2',
        'Q3/Q4',
        '1.5/2.0',
        'v1.2/v1.3',
        'Q3.1/Q4.2',
        'input/output',
        '10/24/2026',
        'Q3..Q4',
        'a.b',
        'More...',
        '"and/or"',
        "'1/2'",
        '`Q3/Q4`'
    ]) {
        for (const image of ['', '!']) {
            for (const destination of ['#x', 'x', 'docs/guide.md', './docs/guide.md', crmUrl]) {
                links.push(`${image}[${label}](${destination})`)
            }
        }
    }
    for (const text of [...prose, 'Ratio [1/2](x) ok', ...links]) {
        for (const length of [0, 1500]) {
            const body = { value: text, padding: 'x'.repeat(length) }
            const json = JSON.stringify(body)
            for (const answer of [text, json, JSON.stringify([text, ...prose]), JSON.stringify({ result: json })]) {
                assert.equal(maskWorkspacePaths(answer), answer)
                for (const width of [1, 7, 1024]) {
                    const context = {}
                    let sent = ''
                    const send = (chunk) => {
                        sent += chunk
                        assert.ok(answer.startsWith(sent), 'must release only an unchanged prefix')
                    }
                    for (let at = 0; at < answer.length; at += width)
                        bufferStream(context, 'answer', answer.slice(at, at + width), false, send)
                    bufferStream(context, 'answer', '', true, send)
                    assert.equal(sent, answer)
                }
            }
        }
    }
})

test('Markdown path labels stay hidden in plain text, JSON values and character streams', () => {
    const root = path.dirname(specialistWorkspace('_'))
    for (const label of [
        secret,
        `file://${secret}`,
        `"${secret}"`,
        `'${secret}'`,
        '`' + secret + '`',
        `${root}/my reports/zz-secret-path.csv`,
        `"${root}/my reports/zz-secret-path.csv"`,
        '../analyst/zz-secret-path.csv',
        '~/analyst/zz-secret-path.csv',
        '"./analyst/zz-secret-path.csv"',
        "'analyst/zz-secret-path.csv'",
        '"./my reports/zz-secret-path.csv"',
        `see ${secret}`,
        `see "${secret}"`,
        `see file://${secret}`,
        `${root}/report(1)/zz-secret-path.csv`
    ]) {
        for (const image of ['', '!']) {
            for (const destination of [secret, `file://${secret}`, crmUrl]) {
                const text = `${image}[${label}](${destination})`
                const shown = hideWorkspacePaths(text, root)
                const keepsTail = /my reports\/|report\(1\)\/|^["']?(?:\.\.?\/|analyst\/)/.test(label)
                assert.equal(shown.includes('zz-secret-path.csv'), keepsTail, text)
                assert.equal(shown.includes(root), false, text)
                assert.equal(shown.includes(secret), false, text)
                for (const length of [0, 1500]) {
                    const body = { safe: 'ready', value: text, padding: 'x'.repeat(length) }
                    const json = JSON.stringify(body)
                    const masked = JSON.stringify({ ...body, value: shown })
                    for (const [answer, expected] of [
                        [text, shown],
                        [json, masked],
                        ['```json\n' + json + '\n```', '```json\n' + masked + '\n```'],
                        [JSON.stringify({ result: json }), JSON.stringify({ result: masked })]
                    ]) {
                        assert.equal(maskWorkspacePaths(answer), expected)
                        const context = {}
                        let sent = ''
                        const send = (chunk) => {
                            sent += chunk
                            assert.ok(expected.startsWith(sent), 'must release only a safe prefix')
                        }
                        for (const char of answer) bufferStream(context, 'answer', char, false, send)
                        bufferStream(context, 'answer', '', true, send)
                        assert.equal(sent, expected)
                    }
                }
            }
        }
    }
})

test('relative path labels keep the whole token for masking and JSON arrays keep their syntax', () => {
    for (const label of [
        'analyst/zz-secret-path.csv',
        './analyst/zz-secret-path.csv',
        'see analyst/zz-secret-path.csv',
        './report(1)/zz-secret-path.csv'
    ]) {
        for (const image of ['', '!']) {
            for (const destination of [secret, `file://${secret}`, crmUrl]) {
                const text = `${image}[${label}](${destination})`
                const shown = maskWorkspacePaths(text)
                assert.ok(shown.startsWith(`${image}[${label}](`), text)
                assert.equal(shown.includes(secret), false, text)
                assert.equal(shown.includes(path.dirname(specialistWorkspace('_'))), false, text)
                assert.equal(streamedAnswer(text), shown)
                const json = JSON.stringify({ value: text, padding: 'x'.repeat(1500) })
                assert.deepEqual(JSON.parse(streamedAnswer(json)), { value: shown, padding: 'x'.repeat(1500) })
            }
        }
    }
    for (const value of [[secret], [1, 2], ['./analyst/private.csv'], ['ready', secret, { value: secret }]]) {
        const json = JSON.stringify(value)
        const expected = JSON.stringify(maskWorkspacePaths(value))
        assert.equal(maskWorkspacePaths(json), expected)
        assert.equal(streamedAnswer(json), expected)
    }
})

test('quoted Markdown and unfinished JSON hide dotted-label destinations', () => {
    for (const text of [`[More...](${secret})`, `![x...](${secret} "t")`, `[Q3..Q4]("${secret}")`, `details..(${secret})`]) {
        const quoted = JSON.stringify(text)
        const partial = `{"safe":"ready","value":${quoted}`
        const cut = partial.indexOf(secret) + secret.length
        for (const answer of [quoted, `${partial},"tail":"`, partial.slice(0, cut)]) {
            const expected = answer.replace(secret, 'the workspace')
            assert.equal(maskWorkspacePaths(answer), expected)
            assert.equal(streamedAnswer(answer), expected)
        }
        for (const length of [1, 2]) {
            const answer = partial.slice(0, cut + length)
            const shown = maskWorkspacePaths(answer)
            assert.equal(shown.includes('zz-secret-path.csv'), false)
            assert.equal(streamedAnswer(answer), shown)
        }
    }
})

test('parentheses within real paths keep the path whole and preserve existing deliverable names', () => {
    const root = path.dirname(specialistWorkspace('_'))
    const file = path.join(root, 'report(1)', 'parenthesized.csv')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'a,b\n1,2\n')
    for (const text of [file, JSON.stringify(file), `[More...](${file})`, `![x...](${file} "t")`]) {
        const expected = text.replace(path.join(root, 'report'), 'the workspace')
        const shown = maskWorkspacePaths(text)
        assert.equal(shown, expected)
        assert.equal(streamedAnswer(text), expected)
        assert.equal(shown.includes(root), false)
        assert.equal(shown.includes(file), false)
    }
    assert.equal(hideWorkspacePaths('/tmp/report(1)/x.csv', root), 'a server path(1)/x.csv')
})

test('short, long and nested JSON masks Markdown paths in keys and values', () => {
    for (const length of [0, 1500]) {
        const body = {
            [`[report](${secret})`]: `[report](${secret}) ${'x'.repeat(length)}`,
            note: `See (${secret}).`,
            quoted: `note:"${secret}"`,
            url: `[report](${crmUrl})`
        }
        const expected = {
            '[report](the workspace)': `[report](the workspace) ${'x'.repeat(length)}`,
            note: 'See (the workspace).',
            quoted: 'note:"the workspace"',
            url: `[report](${crmUrl})`
        }
        const answer = JSON.stringify(body)
        assert.equal(answer.length > 1024, length > 0)
        assert.deepEqual(maskWorkspacePaths(body), expected)
        for (const nested of [false, true]) {
            const text = nested ? JSON.stringify({ result: answer }) : answer
            for (const shown of [maskWorkspacePaths(text), streamedAnswer(text)]) {
                assert.equal(shown.includes('zz-secret-path.csv'), false)
                const parsed = JSON.parse(shown)
                assert.deepEqual(nested ? JSON.parse(parsed.result) : parsed, expected)
            }
        }
    }
})

test('JSON partial events stay valid for complete-reply and character deltas', async () => {
    const name = `mask-events-${++sequence}`
    saveHarness(
        {
            name,
            chief: { model },
            specialists: [
                { name: 'writer', model },
                { name: 'reviewer', model }
            ]
        },
        { overwrite: true }
    )
    const plan = JSON.stringify({ steps: [{ specialist: 'writer', task: 'Report the rows.' }] })
    for (const markdown of [false, true]) {
        const body = {
            url: crmUrl,
            rows: Array.from({ length: 40 }, (_, index) => deal(index)),
            ...(markdown ? { [`[report](${secret})`]: `[report](${secret})` } : {})
        }
        const answer = JSON.stringify(body)
        const expected = markdown ? answer.replaceAll(secret, 'the workspace') : answer
        for (const characters of [false, true]) {
            const events = []
            const reply = (messages) => (String(messages[0]?.content).includes('You route work') ? plan : answer)
            const payload = await runHarness({
                name,
                input: 'Report the rows.',
                chatId: `events-${markdown}-${characters}`,
                flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
                loadNode: async () =>
                    class {
                        async init() {
                            return {
                                invoke: async (messages) => ({ content: reply(messages) }),
                                ...(characters
                                    ? {
                                          async *stream(messages) {
                                              for (const char of reply(messages)) yield { content: char }
                                          }
                                      }
                                    : {})
                            }
                        }
                    },
                onEvent: (event) => events.push(event)
            })
            assert.equal(payload.text, expected)
            for (const phase of ['route', 'specialist', 'answer']) {
                let sent = ''
                const final = phase === 'route' ? plan : expected
                const partials = events.filter((event) => event.type === 'partial' && event.phase === phase)
                assert.ok(partials.length > 0, `missing ${phase} partials`)
                for (const event of partials) {
                    sent += event.text
                    assert.ok(final.startsWith(sent), `unsafe ${phase} prefix`)
                }
                assert.equal(sent, final)
                assert.deepEqual(JSON.parse(sent), JSON.parse(final))
            }
        }
    }
})

test('JSON route prefixes stream before the plan closes', () => {
    const context = {}
    const chunks = []
    const send = (chunk) => chunks.push(chunk)
    bufferStream(context, 'route', '{"steps":[{"task":"check', false, send)
    assert.equal(chunks.join(''), '{"steps":[{"task":"')
    bufferStream(context, 'route', ' routes"}]}', true, send)
    assert.ok(chunks.length >= 2)
    assert.equal(chunks.join(''), '{"steps":[{"task":"check routes"}]}')
})

test('the harness emits route tokens before the model finishes and the route is applied', async () => {
    const name = `mask-route-${++sequence}`
    saveHarness(
        {
            name,
            chief: { model },
            specialists: [
                { name: 'writer', model },
                { name: 'reviewer', model }
            ]
        },
        { overwrite: true }
    )
    const plan = '{"steps":[{"specialist":"writer","task":"check routes"}]}'
    const events = []
    let modelFinished = false
    let streamedBeforeDone = false
    const reply = (messages) => (String(messages[0]?.content).includes('You route work') ? plan : 'Route complete.')
    await runHarness({
        name,
        input: 'Check the routes.',
        chatId: 'route',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => ({ content: reply(messages) }),
                        async *stream(messages) {
                            const content = reply(messages)
                            for (const char of content) yield { content: char }
                            if (content === plan) modelFinished = true
                        }
                    }
                }
            },
        onEvent(event) {
            if (event.type === 'partial' && event.phase === 'route' && !modelFinished) streamedBeforeDone = true
            events.push(event)
        }
    })
    assert.equal(streamedBeforeDone, true)
    const partials = events.filter((event) => event.type === 'partial' && event.phase === 'route')
    assert.ok(partials.length >= 2)
    assert.equal(partials.map((event) => event.text).join(''), plan)
    const done = events.findIndex((event) => event.type === 'route' && event.phase === 'done')
    const specialist = events.findIndex((event) => event.type === 'specialist')
    assert.ok(done >= 0 && done < specialist)
    assert.ok(events.indexOf(partials[0]) < done)
})

test('JSON masking changes only value literals and preserves all other bytes', () => {
    const literal = JSON.stringify(secret)
    const answer = `{\n  "keep\\u005fkey" : "\\u0041", "number":9007199254740993, "rate":1e+006,\n  "file" : ${literal}\n}`
    const expected = answer.replace(literal, '"the workspace"')
    assert.equal(maskWorkspacePaths(answer), expected)
    assert.equal(streamedAnswer(answer), expected)
    assert.equal(JSON.parse(expected).file, 'the workspace')
    const unchanged = '{ "safe": 1, "s\\u0061fe": 2 }'
    assert.equal(maskWorkspacePaths(unchanged), unchanged)
    assert.equal(streamedAnswer(unchanged), unchanged)
})

function assertEmbeddedJson(prefix, suffix) {
    const root = path.dirname(specialistWorkspace('_'))
    for (const length of [0, 1500]) {
        for (const literal of [JSON.stringify(secret), JSON.stringify(secret).replaceAll('/', '\\u002f')]) {
            const answer = `{ "safe\\u005fkey" : "\\u0041", "n":1e+006, "url":${JSON.stringify(crmUrl)},
  ${literal}: {"file":${literal}}, "padding":"${'x'.repeat(length)}" }`
            assert.equal(answer.length > 1024, length > 0)
            for (const body of [answer, `[${answer}]`]) {
                for (const json of [body, body.replaceAll(literal, '"safe"')]) {
                    const text = prefix + json + suffix
                    const expected = prefix + json.replaceAll(literal, '"the workspace"') + suffix
                    assert.equal(hideWorkspacePaths(text, root), expected)
                    assert.equal(maskWorkspacePaths(text), expected)
                    for (const width of [1, 7, 1024]) {
                        const state = workspaceMaskState()
                        let sent = ''
                        for (let at = 0; at < text.length; at += width) {
                            sent += scanWorkspaceText(state, text.slice(at, at + width), root)
                            assert.ok(expected.startsWith(sent), 'must release only a safe incremental prefix')
                        }
                        sent += scanWorkspaceText(state, '', root, true)
                        assert.equal(sent, expected)
                    }
                    assert.equal(streamedAnswer(text), expected)
                }
            }
        }
    }
}

test('short and long fenced JSON masks keys and values while preserving Markdown and JSON bytes', () => {
    for (const fence of ['```', '````', '~~~']) {
        for (const tag of ['', 'json']) {
            assertEmbeddedJson(`${fence}${tag}\n`, `\n${fence}`)
        }
    }
    assertEmbeddedJson('Here is the result:\n\n  ```json\r\n', '\r\n  ```\nDone.')
    assert.equal(streamedAnswer('```json\n{"safe":true}\n```\n~~~\n[]\n~~~'), '```json\n{"safe":true}\n```\n~~~\n[]\n~~~')
})

test('short and long JSON after a same-line lead-in or list marker masks keys and values', () => {
    for (const prefix of ['Here is the result: ', '- ', '* ', '1. ', 'Results:\n- ']) {
        assertEmbeddedJson(prefix, '\nDone.')
    }
})

test('incremental JSON prefixes never release a literal that needs masking', () => {
    const nested = ` { "file" : ${JSON.stringify(secret)} } `
    for (const [literal, replacement] of [
        [JSON.stringify(secret), '"the workspace"'],
        [JSON.stringify(secret).replaceAll('/', '\\u002f'), '"the workspace"'],
        [JSON.stringify(secret).replaceAll('/', '\\/'), '"the workspace"'],
        [JSON.stringify(nested), JSON.stringify(' { "file" : "the workspace" } ')]
    ]) {
        const prefix = '{ "safe": "ready", "file": '
        const suffix = ', "tail": true }'
        const answer = prefix + literal + suffix
        const expected = prefix + replacement + suffix
        const context = {}
        let sent = ''
        const send = (chunk) => {
            sent += chunk
            assert.ok(expected.startsWith(sent), `released unsafe prefix: ${sent}`)
        }
        for (const char of answer) bufferStream(context, 'answer', char, false, send)
        assert.ok(sent.length > 0, 'safe prefix must stream before flush')
        bufferStream(context, 'answer', '', true, send)
        assert.equal(sent, expected)
        assert.equal(JSON.parse(sent).file.includes('zz-secret-path.csv'), false)
    }
})

test('JSON path keys are held through character streaming, including escaped and nested keys', () => {
    for (const literal of [
        JSON.stringify(secret),
        JSON.stringify(secret).replaceAll('/', '\\u002f'),
        JSON.stringify(secret).replaceAll('/', '\\/')
    ]) {
        const answer = `{ "safe": "ready", ${literal} : "${'x'.repeat(1500)}", "nested": [{${literal}: 1}] }`
        const expected = answer.replaceAll(literal, '"the workspace"')
        assert.equal(maskWorkspacePaths(answer), expected)
        const context = {}
        let sent = ''
        const send = (chunk) => {
            sent += chunk
            assert.ok(expected.startsWith(sent), `released unsafe key prefix: ${sent}`)
        }
        for (const char of answer) bufferStream(context, 'answer', char, false, send)
        assert.ok(sent.length > 0, 'safe prefix must stream before flush')
        bufferStream(context, 'answer', '', true, send)
        assert.equal(sent, expected)
        assert.deepEqual(JSON.parse(sent), maskWorkspacePaths(JSON.parse(answer)))
        const nested = JSON.stringify({ result: answer })
        assert.equal(JSON.parse(maskWorkspacePaths(nested)).result, expected)
        assert.equal(JSON.parse(streamedAnswer(nested)).result, expected)
    }
})

test('JSON key collisions keep both values with the same suffixes as parsed object masking', () => {
    const entries = [
        [secret, 'first'],
        [path.join(path.dirname(secret), 'another.csv'), 'second'],
        ['the workspace', 'literal'],
        ['the workspace (2)', 'suffix'],
        ['__proto__', 'plain field']
    ]
    for (const ordered of [entries, entries.toReversed()]) {
        const body = Object.fromEntries(ordered)
        const answer = JSON.stringify({ ...body, nested: [body, { [secret]: 'separate object' }] }, null, 2)
        const expected = maskWorkspacePaths(JSON.parse(answer))
        for (const shown of [maskWorkspacePaths(answer), streamedAnswer(answer)]) {
            assert.deepEqual(JSON.parse(shown), expected)
            assert.equal(shown.includes('zz-secret-path.csv'), false)
        }
    }
})

test('long JSON with exponent numbers preserves URLs and masks paths through character streaming', () => {
    for (const number of ['1e-7', '2E+10', '-1.25e-7', '0E0', '1e7', '1E-7']) {
        for (const gap of ['', '\n  ']) {
            const text = crmUrl + 'x'.repeat(1500)
            const answer = `{${gap}"n":${number},${gap}"text":${JSON.stringify(text)},${gap}"file":${JSON.stringify(secret)}}`
            const expected = answer.replace(JSON.stringify(secret), '"the workspace"')
            for (const shown of [maskWorkspacePaths(answer), streamedAnswer(answer)]) {
                assert.equal(shown, expected)
                assert.deepEqual(JSON.parse(shown), { n: Number(number), text, file: 'the workspace' })
            }
        }
    }
})

test('long JSON answers mask keys and values and stay valid through character streaming', () => {
    for (const spaces of [undefined, 2]) {
        const answer = JSON.stringify(longBody(), null, spaces)
        assert.ok(answer.length > 1024)
        for (const shown of [
            hideTurnImageDir(answer, '', path.dirname(specialistWorkspace('_'))),
            maskWorkspacePaths(answer),
            streamedAnswer(answer)
        ]) {
            assertLongDetail(shown)
            assert.equal(shown, answer.replaceAll(JSON.stringify(secret), '"the workspace"'))
        }
    }
    const short = JSON.stringify({ file: secret, url: crmUrl })
    assert.ok(short.length < 1024)
    assert.deepEqual(JSON.parse(streamedAnswer(short)), { file: 'the workspace', url: crmUrl })
    const unchanged = JSON.stringify({ url: crmUrl, label: 'Q3..Q4', note: 'customer said...', padding: 'x'.repeat(1500) }, null, 2)
    assert.equal(streamedAnswer(unchanged), unchanged)
})

test('JSON string values containing JSON are masked and re-encoded', () => {
    const answer = JSON.stringify({ result: JSON.stringify(longBody()) })
    for (const shown of [maskWorkspacePaths(answer), streamedAnswer(answer)]) {
        assertLongDetail(JSON.parse(shown).result)
        assert.equal(shown.includes('zz-secret-path.csv'), false)
    }
    const short = JSON.stringify({ result: JSON.stringify({ file: secret }) })
    assert.deepEqual(JSON.parse(JSON.parse(streamedAnswer(short)).result), { file: 'the workspace' })
})

test('long JSON tool previews mask keys and values in the log and emitted event', async () => {
    const name = `mask-preview-${++sequence}`
    saveHarness(
        {
            name,
            chief: { model },
            specialists: [{ name: 'writer', model, mcpServers: [{ nodeName: 'fixtureMCP', category: 'Tools (MCP)' }] }]
        },
        { overwrite: true }
    )
    const compiled = compileProfile(getHarness(name))
    for (const nested of [false, true]) {
        const preview = nested ? JSON.stringify({ result: JSON.stringify(longBody()) }) : JSON.stringify(longBody(), null, 2)
        const events = []
        const context = {
            name,
            chatId: `preview-${nested}`,
            roster: compiled.roster,
            userText: 'Summarize the report.',
            calls: [],
            baseUrl: 'http://127.0.0.1:9',
            fetchImpl: async (url, init = {}) => {
                const pathname = new URL(url).pathname
                if (init.method === 'POST' && pathname.endsWith('/v1/runs')) return json({ run_id: 'preview', status: 'started' }, 202)
                if (pathname.endsWith('/events')) {
                    const frame = { event: 'tool.completed', tool: 'fixture_tool', preview }
                    return new Response(`data: ${JSON.stringify(frame)}\n\n: closed\n\n`, {
                        headers: { 'content-type': 'text/event-stream' }
                    })
                }
                return json({ status: 'completed', output: 'Report ready.' })
            },
            onEvent: (event) => events.push(event)
        }
        const results = await runSteps(context, [{ specialist: compiled.roster.specialists[0], task: context.userText }])
        assert.equal(results[0].status, 'completed', results[0].error)
        assert.equal(context.toolLog.length, 1)
        const done = events.filter((event) => event.type === 'tool' && event.phase === 'done')
        assert.equal(done.length, 1)
        for (const detail of [context.toolLog[0].detail, done[0].detail]) {
            assertLongDetail(nested ? JSON.parse(detail).result : detail)
            assert.equal(detail.includes('zz-secret-path.csv'), false)
        }
    }
})

test('pin-first long result stays valid JSON and skips the slower handoff', async () => {
    const body = longBody()
    // Byte fields survive parsed-value masking and must not be masked again as JSON text.
    body.base64 = '/' + 'A'.repeat(1500) + '//x'
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
    assert.equal(parseAnalystToolDetail(done[0].detail).base64, body.base64)
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
    assert.equal(parseAnalystToolDetail(context.toolLog[0].detail).base64, body.base64)
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
