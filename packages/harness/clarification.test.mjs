import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-clarification-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { parseRouteSteps, parseSteps, runHarness, SCOPE_CLARIFICATIONS } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { closeSessions, readMessages } = await import('./session.mjs')
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
    assert.equal(calls, 1)
    assert.equal(result.text, SCOPE_CLARIFICATIONS.selection)
    assert.deepEqual(result.trace.specialists, [])
    assert.deepEqual(
        readMessages(name, 'new-chat').map((message) => message.content),
        ['Assess these records.', SCOPE_CLARIFICATIONS.selection]
    )
})
