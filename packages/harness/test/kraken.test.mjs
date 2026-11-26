import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runNativePrime, useNativePrime } from '../runtime/native-prime.mjs'
import { executeAgentRun } from '../runtime/agent-run.mjs'

test('cancellation racing admission stops only the admitted ID and waits for cleanup', async () => {
    const controller = new AbortController()
    const stopped = []
    const engine = {
        async start() {
            controller.abort()
            return { run_id: 'this-turn' }
        },
        wait: assert.fail,
        async stop({ runId, signal }) {
            assert.equal(signal, undefined)
            stopped.push(runId)
            return true
        }
    }
    await assert.rejects(executeAgentRun({ request: { signal: controller.signal }, body: {} }, engine), { name: 'AbortError' })
    assert.deepEqual(stopped, ['this-turn'])
})

test('lost status transport cancels the accepted run without repeating admission', async () => {
    const calls = []
    const engine = {
        async start() {
            calls.push('start')
            return { run_id: 'one' }
        },
        async wait({ runId, onEvent }) {
            onEvent(runId)
            throw new Error('lost transport')
        },
        async stop({ runId }) {
            calls.push('stop ' + runId)
            return false
        }
    }
    await assert.rejects(
        executeAgentRun({ request: {}, onEvent: (id) => calls.push(id), onUnconfirmedStop: () => calls.push('unconfirmed') }, engine),
        /lost transport/
    )
    assert.deepEqual(calls, ['start', 'one', 'stop one', 'unconfirmed'])
})

test('native delegation rejects unknown tools, foreign specialists and excess calls before dispatch', async () => {
    const roster = { specialists: [{ name: 'math' }] }
    const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } })
    for (const [calls, code] of [
        [[call('unknown', {})], 'forbidden'],
        [[call('run_specialist', { name: 'other-team', task: '42' })], 'forbidden'],
        [[call('run_specialist', { name: 'math' })], 'bad_task'],
        [Array(9).fill(call('run_specialist', { name: 'math', task: '42' })), 'delegation_limit']
    ]) {
        await assert.rejects(
            runNativePrime({ messages: [], roster, complete: async () => ({ toolCalls: calls }), delegate: assert.fail }),
            { code }
        )
    }
})
test('cancelling a pending native delegation leaves a concurrent turn on the same specialist alone', async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers()
    const roster = { specialists: [{ name: 'math' }] }
    const messages = [{ role: 'user', content: 'Calculate.' }]
    const complete = async (history) =>
        history.at(-1).role === 'tool'
            ? { content: history.at(-1).content, toolCalls: [] }
            : { toolCalls: [{ id: 'tool', function: { name: 'run_specialist', arguments: '{"name":"math","task":"17 * 3"}' } }] }
    const pending = runNativePrime({
        roster,
        messages,
        complete,
        signal: controller.signal,
        delegate: async () => {
            entered.resolve()
            await new Promise((_, reject) =>
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
            )
        }
    })
    await entered.promise
    const sibling = runNativePrime({ roster, messages, complete, delegate: async () => '51' })
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(await sibling, '51')
    assert.equal(messages.length, 1)
})

test('the unchanged 1.7.15 Calculator canvas runs directly and through native Prime with a simulated model', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-canvas-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    for (const key of ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'CUTTLELY_HERMES_HOME']) {
        const previous = process.env[key]
        process.env[key] = key === 'CUTTLELY_HERMES_HOME' ? path.join(dir, 'runtime') : dir
        t.after(() => (previous === undefined ? delete process.env[key] : (process.env[key] = previous)))
    }
    const { rosterFromFlow } = await import('../sync-from-flow.mjs')
    const { saveHarness } = await import('../store.mjs')
    const { runHarness } = await import('../run.mjs')
    const { loadFlowiseNode } = await import('../bridge.mjs')
    const { readMessages, closeSessions } = await import('../session.mjs')
    const { closeQueueDb } = await import('../lock.mjs')
    const { configureHarnessPostgres } = await import('../side-store-postgres.mjs')
    // The hosted QA job supplies a database created for just this run.
    if (process.env.KRAKEN_TEST_DATABASE_URL) configureHarnessPostgres({ connectionString: process.env.KRAKEN_TEST_DATABASE_URL })
    t.after(() => {
        closeSessions()
        closeQueueDb()
        configureHarnessPostgres(undefined)
    })
    const canvas = JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/calculator.canvas.json', import.meta.url)))
    const name = 'kraken-' + randomUUID().slice(0, 8)
    const workspaceId = 'fixture-team'
    const record = rosterFromFlow({ name, chatflowId: randomUUID(), workspaceId, flowData: canvas.flowData })
    saveHarness(record)
    const flowOptions = { workspaceId, appDataSource: {}, harnessCaller: { via: 'session' } }
    const events = []
    const args = { name, chatId: 'one', input: '17 * 3', flowOptions, onEvent: (e) => events.push(e), fetchImpl: assert.fail }
    await assert.rejects(runHarness({ ...args, flowOptions: { ...flowOptions, workspaceId: 'another-team' } }), { code: 'wrong_workspace' })
    const result = await runHarness(args)
    assert.equal(result.text, '51')
    assert.equal(result.agents[0].name, 'math')
    assert.equal(result.agents[0].status, 'completed')
    assert.deepEqual(
        events.filter((e) => e.type === 'tool').map((e) => e.phase),
        ['start', 'done']
    )
    assert.equal(events.at(-1).type, 'final')
    assert.deepEqual(
        readMessages(name, 'one').map((message) => message.content),
        ['17 * 3', '51']
    )
    const priorCanary = process.env.CUTTLELY_NATIVE_PRIME_TEAMS
    process.env.CUTTLELY_NATIVE_PRIME_TEAMS = name
    t.after(() => {
        if (priorCanary === undefined) delete process.env.CUTTLELY_NATIVE_PRIME_TEAMS
        else process.env.CUTTLELY_NATIVE_PRIME_TEAMS = priorCanary
    })
    assert.throws(() => useNativePrime({ name, specialists: [{ name: 'extra', shell: true }] }, 'agent'), { code: 'native_unsupported' })
    const answerEvents = []
    class FixtureModel {
        async init() {
            return {
                invoke: assert.fail,
                bindTools(tools) {
                    const tool = tools[0].function.name
                    return {
                        async invoke(messages) {
                            const last = messages.at(-1)
                            if (last._getType() === 'tool') {
                                assert.equal(last.content, '51')
                                return { content: 'The answer is 51.', usage_metadata: { input_tokens: 12, output_tokens: 4 } }
                            }
                            const args = tool === 'run_specialist' ? { name: 'math', task: '17 * 3' } : { input: '17 * 3' }
                            return {
                                content: '',
                                tool_calls: [{ name: tool, id: 'call-1', args }],
                                usage_metadata: { input_tokens: 8, output_tokens: 3 }
                            }
                        }
                    }
                }
            }
        }
    }
    const native = await runHarness({
        ...args,
        mode: 'agent',
        onEvent: (event) => answerEvents.push(event),
        loadNode: async (node) => {
            if (node === 'chatXAI') return FixtureModel
            assert.equal(node, 'calculator')
            return (await loadFlowiseNode(node)).constructor
        }
    })
    assert.equal(native.text, 'The answer is 51.')
    assert.equal(native.trace.chief.status, 'completed')
    assert.equal(answerEvents.at(-1).type, 'final')
    assert.ok(answerEvents.some((event) => event.type === 'partial' && event.phase === 'answer'))
    assert.deepEqual(
        native.agents.map((s) => [s.name, s.status]),
        [['math', 'completed']]
    )
    assert.ok(native.report.tokens.prompt >= 20)
    assert.equal(readMessages(name, 'one').at(-1).content, native.text)
    assert.equal(fs.existsSync(path.join(dir, 'runtime', 'profiles', name, 'config.yaml')), false)
})
