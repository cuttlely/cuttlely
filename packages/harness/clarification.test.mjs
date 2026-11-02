import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-clarification-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { parseRouteSteps, parseSteps, parseScopeReview, runHarness, SCOPE_CLARIFICATIONS } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { closeSessions, readMessages, appendTurn } = await import('./session.mjs')
after(() => {
    closeSessions()
    fs.rmSync(dir, { recursive: true, force: true })
})

test('only declared missing-scope kinds can produce a direct clarification', () => {
    const specialists = [{ name: 'data' }]
    for (const kind of Object.keys(SCOPE_CLARIFICATIONS)) {
        assert.deepEqual(parseRouteSteps(JSON.stringify({ clarification: kind }), specialists, 'request'), {
            ok: true,
            steps: [],
            clarification: kind
        })
        assert.deepEqual(parseSteps(JSON.stringify({ clarification: kind }), specialists, 'request'), [])
    }
    for (const value of ['__proto__', 'Your revenue is $999M. Which records?', {}, ['selection']])
        assert.equal(parseRouteSteps(JSON.stringify({ clarification: value }), specialists, 'request').clarification, undefined)
    assert.equal(
        parseRouteSteps(JSON.stringify({ steps: [{ specialist: 'data' }], clarification: 'selection' }), specialists, 'request')
            .clarification,
        undefined
    )
})

test('a missing selection asks a server-owned question without running a specialist or source', async () => {
    const name = 'scope-clarification-test'
    saveHarness({ name, chief: { model: { nodeName: 'fakeScopeModel', inputs: {} } }, specialists: [{ name: 'data' }, { name: 'notes' }] })
    let calls = 0
    const result = await runHarness({
        name,
        chatId: 'new-chat',
        input: 'Assess these records.',
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async () => {
                            calls++
                            return { content: '{"clarification":"selection"}' }
                        }
                    }
                }
            },
        flowOptions: { harnessCaller: { via: 'session' } }
    })
    assert.equal(calls, 2)
    assert.equal(result.text, SCOPE_CLARIFICATIONS.selection)
    assert.deepEqual(result.trace.specialists, [])
    assert.deepEqual(
        readMessages(name, 'new-chat').map((message) => message.content),
        ['Assess these records.', SCOPE_CLARIFICATIONS.selection]
    )
})

test('a reviewed route requires evidence actually present in the request or supplied context', () => {
    const specialists = [{ name: 'data' }, { name: 'notes' }]
    const input = 'Summarize the health of northstarlabs.'
    const reply = (source, quote, specialist = 'data') =>
        JSON.stringify({ scopeEvidence: { source, quote }, steps: [{ specialist, task: input }] })
    assert.equal(parseScopeReview(reply('request', 'northstarlabs'), specialists, input).steps[0].specialist.name, 'data')
    assert.equal(parseScopeReview(reply('request', 'Northstar Labs'), specialists, input).steps[0].specialist.name, 'data')
    assert.equal(parseScopeReview(reply('request', 'Invented Company'), specialists, input), null)
    assert.equal(parseScopeReview(reply('selection', 'record-1'), specialists, input), null)
    assert.equal(
        parseScopeReview(reply('selection', 'record-1'), specialists, input, { selection: 'Selected records: record-1' }).steps[0]
            .specialist.name,
        'data'
    )
    assert.equal(parseScopeReview(reply('conversation', 'Northstar'), specialists, input), null)
    assert.equal(
        parseScopeReview(reply('conversation', 'Northstar'), specialists, input, { conversation: 'Use Northstar.' }).steps.length,
        1
    )
    assert.equal(
        parseScopeReview(reply('defaults', 'latest available snapshot'), specialists, input, {
            defaults: 'The report uses the latest available snapshot.'
        }).steps.length,
        1
    )
    assert.equal(parseScopeReview(reply('defaults', 'latest available snapshot'), specialists, input), null)
    assert.equal(parseScopeReview(reply('__proto__', 'anything'), specialists, input), null)
    assert.equal(parseScopeReview(reply('request', ''), specialists, input), null)
    assert.equal(parseScopeReview(reply('request', 'northstarlabs', 'unknown-role'), specialists, input), null)
    assert.equal(parseScopeReview('{"clarification":"entity"}', specialists, input), null)
    assert.equal(parseScopeReview('not json', specialists, input), null)
})

test('a named entity reaches its source owner after a mistaken router clarification', async () => {
    const name = 'scope-review-delegates'
    saveHarness({
        name,
        chief: { model: { nodeName: 'fakeScopeModel', inputs: {} } },
        specialists: [
            { name: 'data', routingSummary: 'Resolves named accounts and summarizes account health.', answerDirect: true },
            { name: 'notes' }
        ]
    })
    const earlierFact = 'The selected account is Northstar Labs.'
    appendTurn(name, 'named-account', 'Show the selected account.', earlierFact, [])
    appendTurn(name, 'named-account', 'Summarize the current health.', SCOPE_CLARIFICATIONS.entity, [])
    const prompts = []
    const result = await runHarness({
        name,
        chatId: 'named-account',
        input: 'Summarize the current health of northstarlabs.',
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => {
                            prompts.push(messages)
                            if (prompts.length === 1) return { content: '{"clarification":"entity"}' }
                            if (prompts.length === 2)
                                return {
                                    content: JSON.stringify({
                                        scopeEvidence: { source: 'request', quote: 'northstarlabs' },
                                        steps: [{ specialist: 'data', task: 'Resolve northstarlabs and summarize its health.' }]
                                    })
                                }
                            return { content: 'Northstar Labs: current source evidence is available.' }
                        }
                    }
                }
            },
        flowOptions: { harnessCaller: { via: 'session' } }
    })
    assert.equal(result.trace.specialists.length, 1)
    assert.equal(result.trace.specialists[0].name, 'data')
    assert.equal(result.trace.specialists[0].status, 'completed')
    assert(!result.text.includes(SCOPE_CLARIFICATIONS.entity))
    assert(prompts[1][0].content.includes('Do not confuse an unresolved source lookup'))
    assert(prompts[0].some((message) => message.content === SCOPE_CLARIFICATIONS.entity))
    assert(prompts[1].every((message) => message.content !== SCOPE_CLARIFICATIONS.entity))
    assert(prompts[1].some((message) => message.content === earlierFact))
})

test('a failed clarification review preserves the safe question without running a specialist', async () => {
    const name = 'scope-review-fails-closed'
    saveHarness({ name, chief: { model: { nodeName: 'fakeScopeModel', inputs: {} } }, specialists: [{ name: 'data' }, { name: 'notes' }] })
    let calls = 0
    const result = await runHarness({
        name,
        chatId: 'missing-entity',
        input: 'Summarize current health.',
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async () => {
                            if (++calls === 1) return { content: '{"clarification":"entity"}' }
                            throw new Error('Private provider response must not enter the answer')
                        }
                    }
                }
            },
        flowOptions: { harnessCaller: { via: 'session' } }
    })
    assert.equal(result.text, SCOPE_CLARIFICATIONS.entity)
    assert.deepEqual(result.trace.specialists, [])
    assert.equal(calls, 2)
})
