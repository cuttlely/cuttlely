import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { nativeCompatibilityGaps, runNativePrime, runNativeToolLoop, useNativePrime } from '../runtime/native-prime.mjs'
import { managedFilesReady } from '../runtime/native-files.mjs'
import { readPlaybookTool } from '../runtime/native-playbooks.mjs'
import { playbookMarkdown } from '../profile.mjs'
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
test('a native Prime can delegate to every specialist on a large saved team across tool batches', async () => {
    const specialists = Array.from({ length: 14 }, (_, index) => ({ name: 'member-' + index }))
    const delegated = []
    const answer = await runNativePrime({
        roster: { specialists },
        messages: [],
        complete: async () => {
            const next = specialists[delegated.length]
            return next
                ? {
                      content: '',
                      toolCalls: [
                          {
                              id: next.name,
                              function: {
                                  name: 'run_specialist',
                                  arguments: JSON.stringify({ name: next.name, task: 'Read the assigned report.' })
                              }
                          }
                      ]
                  }
                : { content: 'complete', toolCalls: [] }
        },
        delegate: async (specialist) => {
            delegated.push(specialist.name)
            return 'read'
        }
    })
    assert.equal(answer, 'complete')
    assert.deepEqual(
        delegated,
        specialists.map((s) => s.name)
    )
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

test('native preflight lists all affected specialists and excludes endpoint, credential and playbook values', () => {
    const roster = {
        name: 'sample',
        specialists: [
            { name: 'a', shell: true, modules: [{ nodeName: 'customTool', inputs: { url: 'private-endpoint' } }] },
            {
                name: 'b',
                fileAccess: true,
                mcpServers: [{ nodeName: 'customMCP', credential: 'fixture-id' }],
                playbooks: [{ name: 'qa', content: 'private-notes ${HERMES_SKILL_DIR}/scripts/unassigned.py' }]
            },
            { name: 'c', modules: [{ nodeName: 'calculator', inputs: {} }] }
        ]
    }
    const gaps = nativeCompatibilityGaps(roster)
    const fileGaps = managedFilesReady() ? [] : ['workspace files']
    assert.deepEqual(gaps, [
        { specialist: 'a', capabilities: ['shell', 'canvas tool customTool'] },
        { specialist: 'b', capabilities: [...fileGaps, 'unverified playbook file dependency', 'MCP configuration for customMCP'] }
    ])
    assert.throws(
        () => useNativePrime(roster, 'agent', 'native'),
        (error) =>
            error.code === 'native_unsupported' &&
            error.message.includes('customTool') &&
            error.message.includes('workspace files') === Boolean(fileGaps.length) &&
            !/private-|fixture-id/.test(error.message)
    )
})

test('native playbooks list metadata and resolve only the saved content assigned to this specialist', () => {
    const book = { name: 'inventory', description: 'Count stock', content: 'A private instruction.' }
    for (const content of ['Read ${HERMES_SKILL_DIR}', 'Session ${HERMES_SESSION_ID}']) {
        const roster = { name: 'saved', specialists: [{ name: 'math', playbooks: [{ ...book, content }] }] }
        assert.equal(useNativePrime(roster, 'agent', 'native'), true)
        assert.equal(useNativePrime(roster, 'agent', 'hermes'), false)
    }
    const books = [book]
    assert.deepEqual(readPlaybookTool(books, 'skills_list', {}).skills, [
        { name: book.name, description: book.description, category: 'harness-playbooks' }
    ])
    assert.equal(readPlaybookTool(books, 'skills_list', { category: 'other' }).count, 0)
    for (const name of [book.name, 'harness-playbooks/inventory', 'harness-playbooks:inventory']) {
        assert.equal(readPlaybookTool(books, 'skill_view', { name, file_path: 'SKILL.md' }).content, playbookMarkdown(book))
    }
    for (const args of [{ name: 'other' }, { name: '../inventory' }, { name: 'inventory', file_path: '../secrets' }]) {
        assert.equal(readPlaybookTool(books, 'skill_view', args).success, false)
    }
    assert.equal(readPlaybookTool([], 'skill_view', { name: book.name }).success, false)
})

test('playbook page offsets reconstruct escaped Markdown and preserve Unicode at page boundaries', () => {
    const book = { name: 'stock', description: 'Stock', content: '📦'.repeat(20) + '\t"\n'.repeat(200) }
    let text = ''
    let offset = 0
    do {
        const page = readPlaybookTool([book], 'skill_view', { name: 'stock', offset }, 40)
        assert.equal(page.success, true)
        assert.equal(page.offset, offset)
        assert.ok(page.content.isWellFormed())
        assert.ok(page.content.length > 0)
        text += page.content
        offset = page.next_offset
    } while (offset !== null)
    assert.equal(text, playbookMarkdown(book))
    for (const invalid of [-1, '2', 1e8])
        assert.equal(readPlaybookTool([book], 'skill_view', { name: book.name, offset: invalid }, 40).success, false)
})

test('a native specialist can read a long saved playbook without a canvas tool when its context fits', async () => {
    const book = { name: 'inventory', description: 'Inventory rules', content: 'a'.repeat(59000) + 'Verification code 93.' }
    const options = {
        messages: [{ role: 'user', content: 'Read the inventory instructions.' }],
        tools: [{ type: 'function', function: { name: 'skill_view' } }],
        maxCalls: 1,
        limitCode: 'tool_limit',
        complete: async (messages) => {
            const last = messages.at(-1)
            if (last.role === 'tool') {
                assert.ok(JSON.parse(last.content).content.endsWith('Verification code 93.\n'))
                return { content: '93', toolCalls: [] }
            }
            return { content: '', toolCalls: [{ id: 'read', function: { name: 'skill_view', arguments: '{"name":"inventory"}' } }] }
        },
        execute: (tool, args) => JSON.stringify(readPlaybookTool([book], tool, args))
    }
    assert.equal(await runNativeToolLoop({ ...options, budget: 16000 }), '93')
    await assert.rejects(runNativeToolLoop({ ...options, budget: 4000 }), { code: 'context_limit' })
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
    const answerFrames = answerEvents.filter((event) => event.type === 'final' || (event.type === 'partial' && event.phase === 'answer'))
    assert.deepEqual(
        answerFrames.map((event) => [event.type, event.text, !!event.trustedOutput]),
        [
            ['partial', 'The answer is ', false],
            ['final', native.text, false],
            ['partial', '51.', false]
        ]
    )
    assert.deepEqual(
        native.agents.map((s) => [s.name, s.status]),
        [['math', 'completed']]
    )
    assert.ok(native.report.tokens.prompt >= 20)
    assert.equal(readMessages(name, 'one').at(-1).content, native.text)
    // A saved chat provider can lack bindTools. It must still be able to delegate via the public tool-choice JSON contract.
    const choices = []
    class JsonOnlyModel {
        async init() {
            return {
                async invoke(messages) {
                    const last = messages.at(-1)
                    const system = messages.find((message) => message._getType() === 'system').content
                    assert.match(system, /Reply with JSON only/)
                    assert.ok(messages.every((message) => message._getType() !== 'tool' && !message.tool_calls?.length))
                    const finished = last.content.startsWith('{"tool_results":') && JSON.parse(last.content).tool_results[0]
                    const chief = system.includes('- run_specialist:')
                    if (chief) {
                        assert.match(system, /If one specialist fails/)
                        assert.match(system, /Tools: calculator\./)
                    }
                    const response = finished
                        ? { answer: finished.result }
                        : chief
                        ? { tool: 'run_specialist', arguments: { name: 'math', task: '17 * 3' } }
                        : { tool: 'calculator', arguments: { input: '17 * 3' } }
                    choices.push(finished ? finished.result : response.tool)
                    return { content: JSON.stringify(response), usage_metadata: { input_tokens: 9, output_tokens: 4 } }
                }
            }
        }
    }
    const jsonOnly = await runHarness({
        ...args,
        chatId: 'json-model',
        mode: 'agent',
        loadNode: async (node) => (node === 'chatXAI' ? JsonOnlyModel : (await loadFlowiseNode(node)).constructor)
    })
    assert.equal(jsonOnly.text, '51')
    assert.deepEqual(choices, ['run_specialist', 'calculator', '51'])
    assert.equal(jsonOnly.agents[0].status, 'completed')
    assert.ok(jsonOnly.report.tokens.prompt >= 18)
    assert.equal(fs.existsSync(path.join(dir, 'runtime', 'profiles', name, 'config.yaml')), false)
})

test('on-demand native runs keep saved role grants and refuse the selected blocked role before dispatch', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-roles-'))
    const name = 'kraken-' + randomUUID().slice(0, 8)
    const workspaceId = 'fixture-team'
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    for (const [key, value] of Object.entries({
        CUTTLELY_DATA_DIR: dir,
        DATABASE_PATH: dir,
        CUTTLELY_HERMES_HOME: path.join(dir, 'runtime'),
        CUTTLELY_NATIVE_PRIME_TEAMS: name,
        CUTTLELY_NATIVE_ROLE_POLICY: 'strict'
    })) {
        const previous = process.env[key]
        process.env[key] = value
        t.after(() => (previous === undefined ? delete process.env[key] : (process.env[key] = previous)))
    }
    const { rosterFromFlow, rosterForCanvasRun } = await import('../sync-from-flow.mjs')
    const { getHarness, saveHarness } = await import('../store.mjs')
    const { runHarness } = await import('../run.mjs')
    const { listRuns } = await import('../history.mjs')
    const { enqueueHarnessJob, claimJob, executeJob, readJob, setWorkerContext } = await import('../queue.mjs')
    const { loadFlowiseNode } = await import('../bridge.mjs')
    const { readMessages, closeSessions } = await import('../session.mjs')
    const { closeQueueDb } = await import('../lock.mjs')
    t.after(() => {
        setWorkerContext(null)
        closeSessions()
        closeQueueDb()
    })
    const canvas = JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/calculator.canvas.json', import.meta.url)))
    const flow = { name, workspaceId, chatflowId: randomUUID(), flowData: canvas.flowData }
    const record = rosterFromFlow(flow)
    record.specialists.push({
        ...record.specialists[0],
        name: 'legacy',
        modules: [],
        shell: true,
        browser: true,
        codeExecution: true
    })
    record.specialists.push({ ...record.specialists[0], name: 'count', modules: [], codeExecution: true })
    saveHarness(record)
    const original = getHarness(name)
    const expected = [
        { specialist: 'legacy', capabilities: ['shell', 'browser', 'code execution'] },
        { specialist: 'count', capabilities: ['code execution'] }
    ]
    const flowOptions = {
        workspaceId,
        appDataSource: {},
        expectedHarnessChatflowId: flow.chatflowId,
        callerChatflowId: 'parent-flow',
        harnessCaller: { via: 'api_key', apiKeyId: 'fixture', harnesses: [name], harnessIds: { [name]: flow.chatflowId } }
    }
    const roles = []
    let choice = 'math'
    let numericRequest, numericFollowup
    let expectedNumericAnswer = '851'
    const calls = []
    let changeOnRoute
    class FixtureModel {
        async init() {
            return {
                async invoke(messages) {
                    const system = messages[0].content
                    if (system.startsWith('You route work')) {
                        calls.push('router')
                        changeOnRoute?.()
                        return {
                            content: JSON.stringify({
                                steps: (choice === 'batch' ? ['math', 'legacy'] : [choice]).map((specialist) => ({
                                    specialist,
                                    task: '17 * 3'
                                }))
                            })
                        }
                    }
                    const answer = choice === 'count' ? expectedNumericAnswer : '51'
                    assert.ok(messages.some((item) => String(item.content).includes(answer)))
                    return { content: answer }
                },
                bindTools(tools) {
                    const offered = tools.map((entry) => entry.function.name)
                    const chief = offered.includes('run_specialist')
                    if (chief)
                        roles.push(tools.find((entry) => entry.function.name === 'run_specialist').function.parameters.properties.name.enum)
                    const numeric = offered.includes('execute_code')
                    if (!chief) assert.deepEqual(offered, [numeric ? 'execute_code' : 'calculator'])
                    return {
                        async invoke(messages) {
                            calls.push(chief ? 'chief' : numeric ? 'count' : 'math')
                            if (numeric && messages.at(-1)._getType() === 'tool' && numericFollowup) return numericFollowup
                            if (messages.at(-1)._getType() === 'tool')
                                return { content: numeric ? JSON.parse(messages.at(-1).content).output.trim() : messages.at(-1).content }
                            if (numeric)
                                return {
                                    content: '',
                                    tool_calls: numericRequest.map((code, i) => ({ name: 'execute_code', id: 'sum-' + i, args: { code } }))
                                }
                            if (chief && choice === 'reply') return { content: 'Ready.' }
                            const delegates = choice === 'batch' ? ['math', 'legacy'] : [choice]
                            const tool_calls = chief
                                ? delegates.map((name, i) => ({
                                      name: 'run_specialist',
                                      id: 'delegate-' + i,
                                      args: { name, task: '17 * 3' }
                                  }))
                                : [{ name: 'calculator', id: 'calculate', args: { input: '17 * 3' } }]
                            return { content: '', tool_calls }
                        }
                    }
                }
            }
        }
    }
    const loadNode = async (node) => {
        if (node === 'chatXAI') return FixtureModel
        assert.equal(node, 'calculator')
        return (await loadFlowiseNode(node)).constructor
    }
    const events = []
    const args = (mode) => ({
        mode,
        name,
        chatId: randomUUID(),
        input: '17 * 3',
        flowOptions,
        loadNode,
        fetchImpl: assert.fail,
        onEvent: (event) => events.push(event)
    })
    await assert.rejects(runHarness(args('agent')), { code: 'native_unsupported' })
    assert.deepEqual(calls, [])
    const strictJob = enqueueHarnessJob(args('agent'))
    process.env.CUTTLELY_NATIVE_ROLE_POLICY = 'on-demand'
    assert.deepEqual(nativeCompatibilityGaps(getHarness(name)), expected)
    for (const mode of ['router', 'agent']) {
        choice = 'math'
        events.length = 0
        const positive = await runHarness(args(mode))
        assert.equal(positive.text, '51')
        assert.deepEqual(
            positive.agents.map((item) => item.name),
            ['math']
        )
        assert.ok(events.some((e) => e.type === 'tool' && e.phase === 'done'))
        for (choice of ['legacy', 'batch']) {
            events.length = calls.length = 0
            const denied = args(mode)
            await assert.rejects(
                runHarness(denied),
                (e) => e.code === 'native_unsupported' && e.message.includes('selected specialist "legacy": shell, browser, code execution')
            )
            assert.deepEqual(calls, [mode === 'agent' ? 'chief' : 'router'])
            assert.ok(events.every((e) => !['tool', 'specialist', 'final'].includes(e.type)))
            assert.deepEqual(readMessages(name, denied.chatId), [])
            assert.equal(listRuns(name).find((r) => r.chatId === denied.chatId)?.status, 'failed')
        }
    }
    for (const mode of ['router', 'agent']) {
        choice = 'count'
        for (const [source, answer] of [
            ['print(sum([125, 250, 476]))', '851'],
            ['print(sorted([25,-7,23,0,24,25], reverse=True)[:5])', '[25, 25, 24, 23, 0]']
        ]) {
            numericRequest = [source]
            expectedNumericAnswer = answer
            events.length = 0
            const result = await runHarness(args(mode))
            assert.equal(result.text, answer)
            assert.ok(events.some((e) => e.type === 'tool' && e.phase === 'done' && e.name === 'execute_code' && !e.error))
        }
        // A later nonnumeric request invalidates the entire batch before a tool receipt is opened.
        numericRequest.push('print("not a number")')
        events.length = 0
        const denied = args(mode)
        await assert.rejects(runHarness(denied), { code: 'native_unsupported' })
        assert.ok(events.every((e) => !['tool', 'final'].includes(e.type)))
        assert.deepEqual(readMessages(name, denied.chatId), [])
        assert.equal(listRuns(name).find((r) => r.chatId === denied.chatId)?.status, 'failed')
        numericRequest = ['print(sum([125, 250, 476]))']
        for (const [followup, code] of [
            [
                { content: '', tool_calls: [{ name: 'execute_code', id: 'subsequent', args: { code: 'print("plain text")' } }] },
                'native_unsupported'
            ],
            [{ content: '' }, 'empty_output']
        ]) {
            numericFollowup = followup
            events.length = 0
            const partial = args(mode)
            await assert.rejects(runHarness(partial), { code })
            assert.equal(events.filter((e) => e.type === 'tool' && e.phase === 'done').length, 1)
            assert.ok(events.every((e) => e.type !== 'final'))
            assert.equal(listRuns(name).find((r) => r.chatId === partial.chatId)?.status, 'failed')
            assert.deepEqual(readMessages(name, partial.chatId), [])
        }
        numericFollowup = null
    }
    assert.ok(roles.length > 0 && roles.every((offered) => offered.join(',') === 'math,legacy,count'))
    choice = 'reply'
    assert.equal((await runHarness(args('agent'))).text, 'Ready.')
    assert.deepEqual(getHarness(name), original)
    const foreign = args('agent')
    await assert.rejects(runHarness({ ...foreign, flowOptions: { ...flowOptions, workspaceId: 'other' } }), { code: 'wrong_workspace' })
    await assert.rejects(runHarness({ ...foreign, flowOptions: { ...flowOptions, expectedHarnessChatflowId: 'other' } }), {
        code: 'harness_changed'
    })
    // A worker with the opposite local configuration still enforces each admission's pinned policy.
    setWorkerContext(() => ({ componentNodes: {}, loadNode, flowOptions }))
    const runJob = async (id) => {
        const job = claimJob()
        assert.equal(job.id, id)
        await executeJob(job).catch((error) => assert.equal(error.code, readJob(id).errorCode))
        return readJob(id)
    }
    calls.length = 0
    const strict = await runJob(strictJob.id)
    assert.equal(strict.errorCode, 'native_unsupported')
    assert.deepEqual(calls, [])
    choice = 'math'
    const allowedJob = enqueueHarnessJob(args('agent'))
    const deniedJob = enqueueHarnessJob(args('agent'))
    const staleJob = enqueueHarnessJob(args('router'))
    delete process.env.CUTTLELY_NATIVE_ROLE_POLICY
    delete process.env.CUTTLELY_NATIVE_PRIME_TEAMS
    assert.equal((await runJob(allowedJob.id)).result.text, '51')
    choice = 'legacy'
    calls.length = 0
    assert.match((await runJob(deniedJob.id)).errorMessage, /selected specialist "legacy"/)
    assert.deepEqual(calls, ['chief'])
    saveHarness({ ...original, description: 'New revision' }, { overwrite: true })
    calls.length = 0
    assert.equal((await runJob(staleJob.id)).errorCode, 'harness_changed')
    assert.deepEqual(calls, [])
    process.env.CUTTLELY_NATIVE_PRIME_TEAMS = name
    process.env.CUTTLELY_NATIVE_ROLE_POLICY = 'on-demand'
    choice = 'math'
    changeOnRoute = () => saveHarness({ ...original, description: 'Superseding revision' }, { overwrite: true })
    await assert.rejects(runHarness(args('router')), { code: 'harness_changed' })
    assert.deepEqual(calls, ['router'])
    changeOnRoute = undefined
    // A draft has no verified published owner. Even if it has the same names/grants, it stays strict.
    const draft = rosterForCanvasRun(flow, { published: false, tryOwner: 'user:fixture' })
    draft.specialists.push(original.specialists[1])
    await assert.rejects(runHarness({ ...args('agent'), record: draft }), { code: 'native_unsupported' })
    const unsupported = getHarness(name)
    unsupported.specialists[1].modules = [{ nodeName: 'customTool', category: 'Tools' }]
    saveHarness(unsupported, { overwrite: true })
    await assert.rejects(runHarness(args('agent')), (e) => e.code === 'native_unsupported' && e.message.includes('customTool'))
})
