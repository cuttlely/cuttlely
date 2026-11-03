import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { after, test } from 'node:test'
import { ANSWER_INPUT_BYTES, priorAnswerInputs, answerInputIndex, stageAnswerInputs } from './answer-inputs.mjs'
import { newTurnImageDir, removeTurnImageDir, turnFiles, turnImages } from './images.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-inputs-'))
process.env.CUTTLELY_DATA_DIR = root
process.env.CUTTLELY_HERMES_HOME = path.join(root, 'runtime')
delete process.env.HERMES_API_URL
const { runHarness, recentTurnsText } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { appendTurn, closeSessions, readMessages } = await import('./session.mjs')
after(() => {
    closeSessions()
    fs.rmSync(root, { recursive: true, force: true })
})

const report = (name) =>
    `# ${name} — Executive summary\n\n` +
    '| Item | Value |\n|---|---:|\n| Total | $1,234.56 |\n\n' +
    'Evidence and interpretation. '.repeat(1800) +
    '\n\n| Owner | Ticket |\n|---|---|\n| Example owner | T-123 |\n\nFinal recommendation: preserve this ending.\n'
const manifest = (note) => JSON.parse(note.split('\n').find((line) => line.startsWith('[{"id":"answer-1"')))

test('complete byte-exact inputs bypass both history clipping and artifact discovery', () => {
    const text = report('Example')
    const history = [
        { role: 'user', content: 'Executive summary' },
        { role: 'assistant', content: text }
    ]
    assert(!recentTurnsText(history).includes('Final recommendation'))
    const inputs = priorAnswerInputs(history)
    const index = answerInputIndex(inputs)
    assert(index.includes('Executive summary'))
    assert(!index.includes('Final recommendation'))
    assert(index.length < 1300)
    const dir = newTurnImageDir(root)
    const [document] = manifest(stageAnswerInputs(inputs, dir))
    assert.equal(fs.readFileSync(document.path, 'utf8'), text)
    assert.equal(document.bytes, Buffer.byteLength(text))
    assert.equal(document.sha256, crypto.createHash('sha256').update(text).digest('hex'))
    assert.equal(fs.statSync(document.path).mode & 0o777, 0o600)
    // Even output-looking files under the input folder are never attachments.
    fs.writeFileSync(path.join(path.dirname(document.path), 'source.csv'), 'Item,Value\na,1\n')
    assert.deepEqual(turnFiles(dir, 0), [])
    assert.deepEqual(turnImages(dir, 0), [])
    removeTurnImageDir(dir)
    assert(!fs.existsSync(document.path))
})

test('inputs retain only two recent assistant answers, with fixed names and no silent clipping', () => {
    const inputs = priorAnswerInputs([
        { role: 'assistant', content: 'Old answer' },
        { role: 'system', content: 'Not an answer' },
        { role: 'user', content: 'Compare ../private/source' },
        { role: 'assistant', content: '  Previous answer\n' },
        { role: 'tool', content: 'Not an answer' },
        { role: 'user', content: 'New report' },
        { role: 'assistant', content: '😀'.repeat(ANSWER_INPUT_BYTES / 4 + 1) }
    ])
    assert.equal(inputs.length, 2)
    assert.equal(inputs[0].id, 'answer-1')
    assert.equal(inputs[0].content, undefined)
    assert(inputs[0].unavailable)
    assert.equal(inputs[1].content, '  Previous answer\n')
    const dir = newTurnImageDir(root)
    const docs = manifest(stageAnswerInputs(inputs, dir))
    assert.equal(docs[0].available, false)
    assert.equal(docs[0].path, undefined)
    assert.equal(path.basename(docs[1].path), 'answer-2.md')
    assert.equal(fs.readFileSync(docs[1].path, 'utf8'), '  Previous answer\n')
    const combined = priorAnswerInputs([
        { role: 'assistant', content: 'a'.repeat(ANSWER_INPUT_BYTES / 2 + 1) },
        { role: 'assistant', content: 'b'.repeat(ANSWER_INPUT_BYTES / 2) }
    ])
    assert(combined[0].content)
    assert(combined[1].unavailable)
    removeTurnImageDir(dir)
    assert.equal(answerInputIndex([]), '')
    assert.equal(stageAnswerInputs([], root), '')
})

const model = { nodeName: 'scriptedChat', nodeId: 'model', inputs: {} }
let serial = 0
async function runExport({ name, chatId, expected, replay = false, fail = false, signal, abort } = {}) {
    const requests = [],
        routed = [],
        paths = [],
        events = []
    const payload = await runHarness({
        name,
        chatId,
        input: 'Save the report as PDF.',
        replay,
        signal,
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => {
                            if (String(messages[0]?.content).includes('You route work')) {
                                routed.push(messages)
                                return {
                                    content: JSON.stringify({ steps: [{ specialist: 'assets', task: 'Export the latest answer as PDF.' }] })
                                }
                            }
                            return { content: 'Export ready.' }
                        }
                    }
                }
            },
        fetchImpl: async (_url, init) => {
            assert.equal(init.method, 'POST')
            const body = JSON.parse(init.body)
            requests.push(body)
            if (expected) {
                const docs = manifest(body.input)
                const doc = docs[0]
                paths.push(doc.path)
                assert.equal(fs.readFileSync(doc.path, 'utf8'), expected)
                assert(!String(body.instructions).includes('Final recommendation'))
                assert(body.input.includes('preserve its full content, tables and final sections'))
                const dir = path.dirname(path.dirname(doc.path))
                const output = path.join(dir, 'summary.pdf')
                fs.writeFileSync(output, '%PDF-1.4\n% test artifact\n%%EOF\n')
                // The in-memory worker completes in the same clock tick; avoid
                // filesystem timestamp rounding making the output predate it.
                const written = new Date(Date.now() + 1000)
                fs.utimesSync(output, written, written)
            } else {
                assert(!body.input.includes('.answer-inputs'))
                assert(!body.input.includes('Complete prior answer inputs'))
            }
            abort?.()
            return new Response(
                JSON.stringify(
                    fail ? { status: 'failed', error: 'Export failed.' } : { status: 'completed', output: 'Created summary.pdf.' }
                ),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        },
        onEvent: (event) => events.push(event)
    })
    for (const file of paths) assert(!fs.existsSync(path.dirname(path.dirname(file))), 'run folder must be removed')
    assert(!JSON.stringify([payload, events]).includes('.answer-inputs'))
    return { payload, requests, routed, paths }
}

function harness(capabilities = { fileAccess: true }) {
    const name = `answer-input-test-${++serial}`
    saveHarness({
        name,
        chief: { model },
        specialists: [
            { name: 'assets', ...capabilities, instructions: 'Create requested files.' },
            { name: 'writer', model, instructions: 'Write answers.' }
        ]
    })
    return name
}

test('native export gets the full saved answer even after chief context fitting, isolated across concurrent chats', async () => {
    const name = harness(),
        a = report('Alpha'),
        b = report('Beta')
    appendTurn(name, 'alpha', 'Executive summary for Alpha.', a)
    appendTurn(name, 'beta', 'Executive summary for Beta.', b)
    const [first, second] = await Promise.all([
        runExport({ name, chatId: 'alpha', expected: a }),
        runExport({ name, chatId: 'beta', expected: b })
    ])
    assert.notEqual(first.paths[0], second.paths[0])
    for (const [out, other] of [
        [first, 'Beta'],
        [second, 'Alpha']
    ]) {
        assert.equal(out.requests.length, 1)
        assert.equal(out.payload.artifacts.length, 1)
        assert.equal(out.payload.artifacts[0].name, 'summary.pdf')
        const route = JSON.stringify(out.routed[0])
        assert(route.includes('Prior answer inputs'))
        assert(!route.includes('Final recommendation'))
        assert(!route.includes(other))
        assert(out.payload.report.truncated.includes('chief.memory'))
    }
})

test('different harnesses, fresh chats and replay never receive another session answer', async () => {
    const name = harness()
    appendTurn(name, 'private-chat', 'Summary.', report('Private'))
    await runExport({ name, chatId: 'new-chat' })
    await runExport({ name: harness(), chatId: 'private-chat' })
    const before = readMessages(name, 'private-chat')
    await runExport({ name, chatId: 'private-chat', replay: true })
    assert.deepEqual(readMessages(name, 'private-chat'), before)
})

test('a specialist without file capabilities retains the short ordinary follow-up context', async () => {
    const name = harness({ browser: true })
    appendTurn(name, 'chat', 'Executive summary.', report('Browser-only'))
    const out = await runExport({ name, chatId: 'chat' })
    assert(!JSON.stringify(out.routed).includes('Prior answer inputs'))
    assert(!JSON.stringify(out.requests).includes('.answer-inputs'))
    assert(String(out.requests[0].instructions).includes('Browser-only'))
    assert(!String(out.requests[0].instructions).includes('Final recommendation'))
})

test('failed and cancelled native exports clean up their complete input files', async () => {
    const name = harness(),
        text = report('Failure')
    appendTurn(name, 'failed', 'Summary.', text)
    const failed = await runExport({ name, chatId: 'failed', expected: text, fail: true })
    assert.equal(failed.payload.artifacts.length, 0)
    const controller = new AbortController()
    appendTurn(name, 'cancelled', 'Summary.', text)
    await assert.rejects(
        runExport({ name, chatId: 'cancelled', expected: text, signal: controller.signal, abort: () => controller.abort() }),
        { code: 'aborted' }
    )
    const folder = path.dirname(path.dirname(failed.paths[0]))
    assert.deepEqual(fs.readdirSync(path.dirname(folder)), [])
})
