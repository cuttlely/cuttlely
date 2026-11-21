import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-mode-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { runHarness } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { listRuns } = await import('./history.mjs')
const { chiefInstructions, readProfileEnv, tryProfileName } = await import('./profile.mjs')
const { estimateTokens } = await import('./context.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { agentTurn, beginAgentTurn, recordAgentStep, endAgentTurn } = await import('./agent-run-context.mjs')
const { appendTurn, readMessages, closeSessions, draftSessionScope } = await import('./session.mjs')
const { jobPayload, runQueuedHarness } = await import('./queue.mjs')
const { pinnedCallContext, setGatewayContext, startGateway } = await import('./gateway.mjs')
after(() => {
    closeSessions()
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

for (const chiefFails of [false, true])
    test(`agent mode retains roster steps when the chief ${chiefFails ? 'fails' : 'completes'}`, async (t) => {
        const gateway = await startGateway({ port: 0 })
        process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
        const name = chiefFails ? 'agent-failure' : 'agent-fixture'
        const record = saveHarness({
            name,
            workspaceId: 'fixture-workspace',
            chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
            specialists: [{ name: 'worker', codeExecution: true }]
        })
        const calls = []
        let sessionId
        let child
        let childExited
        let chiefResult
        const previous = setGatewayContext(async () => ({ componentNodes: {}, flowOptions: {} }))
        t.after(() => setGatewayContext(previous))
        const server = http.createServer(async (req, res) => {
            try {
                let text = ''
                for await (const chunk of req) text += chunk
                const body = text ? JSON.parse(text) : null
                calls.push({ url: req.url, method: req.method, body, auth: req.headers.authorization })
                if (req.url === `/p/${name}/v1/runs`) {
                    sessionId = body.session_id
                    const caller = await pinnedCallContext(record, record.specialists[0], 'fixture-chat')
                    assert.equal(caller.flowOptions.nestedFlowCaller.apiKeyId, 'fixture-key')
                    assert.equal(caller.flowOptions.workspaceId, record.workspaceId)
                    child = spawn(process.execPath, [fileURLToPath(new URL('./roster-mcp.mjs', import.meta.url)), '--harness', name], {
                        env: { ...process.env, HERMES_API_URL: `http://127.0.0.1:${server.address().port}` },
                        stdio: ['pipe', 'pipe', 'pipe']
                    })
                    childExited = once(child, 'exit')
                    chiefResult = new Promise((resolve, reject) => {
                        let pending = ''
                        child.stdout.on('data', (chunk) => {
                            pending += chunk
                            if (!pending.includes('\n')) return
                            try {
                                resolve(JSON.parse(pending.split('\n')[0]))
                            } catch (error) {
                                reject(error)
                            }
                        })
                        child.once('error', reject)
                        child.once('exit', () => reject(new Error('Roster exited before replying.')))
                    })
                    child.stdin.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'tools/call',
                            params: {
                                name: 'run_specialist',
                                arguments: { name: 'worker', task: 'Read the fixture.', _cuttlelyScope: sessionId }
                            }
                        }) + '\n'
                    )
                    res.setHeader('content-type', 'application/json')
                    res.end(JSON.stringify({ run_id: 'chief-run', status: 'running' }))
                } else if (req.url.endsWith('/events')) {
                    const delegated = await chiefResult
                    assert.equal(delegated.result.isError, false, JSON.stringify(delegated))
                    assert.equal(delegated.result.content[0].text, 'Specialist evidence.')
                    res.setHeader('content-type', 'text/event-stream')
                    res.end('data: {"event":"message.delta","delta":"Chief answer."}\n\n: stream closed\n\n')
                } else if (req.url === `/p/${name}/v1/runs/chief-run`) {
                    res.setHeader('content-type', 'application/json')
                    res.end(
                        JSON.stringify({
                            status: chiefFails ? 'failed' : 'completed',
                            ...(chiefFails ? { error: 'Chief fixture failed.' } : { output: 'Chief answer.' }),
                            usage: { prompt_tokens: 12, completion_tokens: 4 }
                        })
                    )
                } else if (req.url === `/p/${name}--worker/v1/runs`) {
                    res.setHeader('content-type', 'application/json')
                    res.end(
                        JSON.stringify({
                            run_id: 'worker-run',
                            status: 'completed',
                            output: 'Specialist evidence.',
                            usage: { prompt_tokens: 5, completion_tokens: 2 }
                        })
                    )
                } else {
                    res.writeHead(404).end()
                }
            } catch (error) {
                res.writeHead(500).end(JSON.stringify({ error: error.message }))
            }
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        t.after(async () => {
            child?.stdin.end()
            if (childExited) {
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
                await childExited
                clearTimeout(timer)
            }
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        })
        const pendingRun = runHarness({
            name,
            mode: 'agent',
            chatId: 'fixture-chat',
            input: 'Answer the fixture.',
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            timeoutMs: 5000,
            flowOptions: {
                workspaceId: record.workspaceId,
                harnessCaller: { via: 'session' },
                nestedFlowCaller: { via: 'api_key', apiKeyId: 'fixture-key' }
            },
            loadNode: async () => {
                throw new Error('The router must not run in agent mode.')
            }
        })
        if (chiefFails) {
            await assert.rejects(pendingRun, /Chief fixture failed/)
            const runs = listRuns(name)
            assert.equal(runs.length, 1)
            assert.equal(runs[0].mode, 'agent')
            assert.equal(runs[0].status, 'failed')
            assert.equal(runs[0].trace.status, 'failed')
            assert.equal(runs[0].trace.chief.status, 'failed')
            assert.equal(runs[0].trace.specialists.length, 1)
            assert.equal(runs[0].trace.specialists[0].status, 'completed')
            assert.equal(agentTurn(name, sessionId), null)
            return
        }
        const result = await pendingRun
        assert.equal(result.text, 'Chief answer.')
        assert.equal(result.mode, 'agent')
        assert.equal(result.trace.route.status, 'skipped')
        assert.equal(result.trace.handoff.status, 'skipped')
        assert.equal(result.agents.length, 1)
        assert.equal(result.agents[0].name, 'worker')
        assert.equal(result.agents[0].status, 'completed')
        const posts = calls.filter((call) => call.method === 'POST')
        assert.equal(posts.length, 2, 'exactly one chief call and one run_specialist')
        assert.equal(posts[0].auth, `Bearer ${readProfileEnv(name).API_SERVER_KEY}`)
        assert.equal(posts[1].auth, `Bearer ${readProfileEnv(`${name}--worker`).API_SERVER_KEY}`)
        assert.equal(posts[1].body.session_id, sessionId.replace(`${name}:`, `${name}--worker:`))
        assert.equal(agentTurn(name, sessionId), null, 'completed turn journal removed')
        const runs = listRuns(name)
        assert.equal(runs.length, 1)
        assert.equal(runs[0].mode, 'agent')
        assert.equal(runs[0].textPreview, 'Chief answer.')
        assert.equal(runs[0].trace.specialists.length, 1)
    })

test('invalid modes and callers fail before a chief call or a run record', async () => {
    for (const args of [
        { mode: 'invalid', flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } } },
        {
            mode: 'agent',
            flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'api_key', apiKeyId: 'denied', harnesses: [] } }
        }
    ]) {
        const before = listRuns('agent-fixture').length
        await assert.rejects(
            runHarness({
                name: 'agent-fixture',
                chatId: 'refused',
                input: 'Fixture.',
                ...args,
                fetchImpl: () => {
                    throw new Error('No runtime request allowed.')
                }
            }),
            /mode must be|may not run harness/
        )
        assert.equal(listRuns('agent-fixture').length, before)
    }
})

test('queued agent runs retain mode for inline and external worker payloads', async () => {
    const args = {
        name: 'agent-fixture',
        mode: 'agent',
        chatId: 'queued-chat',
        input: 'Queued fixture.',
        flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } }
    }
    assert.equal(JSON.parse(JSON.stringify(jobPayload(args))).mode, 'agent')
    assert.equal(jobPayload({ ...args, mode: undefined }).mode, undefined)
    assert.throws(() => jobPayload({ ...args, mode: 'invalid' }), /mode must be/)
    const calls = []
    const result = await runQueuedHarness({
        ...args,
        fetchImpl: async (url) => {
            calls.push(url)
            return new Response(JSON.stringify({ status: 'completed', output: 'Queued chief answer.' }), { status: 200 })
        }
    })
    assert.equal(result.mode, 'agent')
    assert.equal(result.text, 'Queued chief answer.')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /\/p\/agent-fixture\/v1\/runs$/)
    assert.equal(listRuns(args.name).find((run) => run.chatId === args.chatId).mode, 'agent')
})

test('agent cancellation stops its chief run and clears the delegation scope', async () => {
    const name = 'agent-cancellation'
    saveHarness({
        name,
        workspaceId: 'fixture-workspace',
        chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
        specialists: [{ name: 'worker' }]
    })
    const controller = new AbortController()
    const calls = []
    let sessionId
    await assert.rejects(
        runHarness({
            name,
            mode: 'agent',
            chatId: 'cancelled-chat',
            input: 'Cancelled fixture.',
            signal: controller.signal,
            flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
            fetchImpl: async (url, options) => {
                calls.push(url)
                if (url.endsWith('/stop')) return new Response(JSON.stringify({ status: 'cancelled' }))
                if (url.endsWith('/events')) {
                    return new Promise((_resolve, reject) => {
                        options.signal.addEventListener(
                            'abort',
                            () => reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })),
                            { once: true }
                        )
                        controller.abort()
                    })
                }
                sessionId = JSON.parse(options.body).session_id
                return new Response(JSON.stringify({ status: 'running', run_id: 'cancelled-chief' }))
            }
        }),
        (error) => error.code === 'aborted'
    )
    assert.equal(calls.filter((url) => url.endsWith('/cancelled-chief/stop')).length, 1)
    assert.equal(agentTurn(name, sessionId), null)
    const recorded = listRuns(name).find((run) => run.chatId === 'cancelled-chat')
    assert.equal(recorded.mode, 'agent')
    assert.equal(recorded.status, 'cancelled')
    assert.equal(recorded.trace.status, 'cancelled')
    assert.equal(recorded.trace.chief.status, 'cancelled')
})

for (const interruption of ['abort', 'budget'])
    test(`agent ${interruption} retains an in-flight roster call`, { timeout: 15000 }, async (t) => {
        const name = `agent-inflight-${interruption}`
        saveHarness({
            name,
            workspaceId: 'fixture-workspace',
            chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
            specialists: [{ name: 'worker', codeExecution: true }]
        })
        const controller = new AbortController()
        const workerStarted = Promise.withResolvers()
        let sessionId
        let child
        let childExited
        let delegated
        let stopSeen = false
        const server = http.createServer(async (req, res) => {
            try {
                let text = ''
                for await (const chunk of req) text += chunk
                if (req.url === `/p/${name}/v1/runs`) {
                    sessionId = JSON.parse(text).session_id
                    child = spawn(process.execPath, [fileURLToPath(new URL('./roster-mcp.mjs', import.meta.url)), '--harness', name], {
                        env: { ...process.env, HERMES_API_URL: `http://127.0.0.1:${server.address().port}` },
                        stdio: ['pipe', 'pipe', 'pipe']
                    })
                    childExited = once(child, 'exit')
                    delegated = new Promise((resolve) => {
                        let pending = ''
                        child.stdout.on('data', (chunk) => {
                            pending += chunk
                            if (pending.includes('\n')) resolve(JSON.parse(pending.split('\n')[0]))
                        })
                    })
                    child.stdin.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'tools/call',
                            params: {
                                name: 'run_specialist',
                                arguments: { name: 'worker', task: 'Read the fixture.', _cuttlelyScope: sessionId }
                            }
                        }) + '\n'
                    )
                    res.end(JSON.stringify({ run_id: 'chief-run', status: 'running' }))
                } else if (req.url === `/p/${name}--worker/v1/runs`) {
                    workerStarted.resolve()
                    res.end(JSON.stringify({ run_id: 'worker-run', status: 'running' }))
                } else if (req.url === `/p/${name}/v1/runs/chief-run/events`) {
                    await workerStarted.promise
                    if (interruption === 'abort') controller.abort()
                    // Keep both runs in flight until abort or the turn budget expires.
                } else if (req.url === `/p/${name}/v1/runs/chief-run/stop`) {
                    stopSeen = true
                    const [step] = agentTurn(name, sessionId).steps
                    assert.equal(step.status, 'running', 'roster journals admission before the specialist exits')
                    assert.ok(Number.isFinite(step.startedAt))
                    if (interruption === 'abort') {
                        // Stop acknowledgement follows roster cleanup. Its error must reach the saved run.
                        child.stdin.write(
                            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n'
                        )
                        assert.equal((await delegated).result.isError, true)
                    }
                    // In the budget case the roster is still running even after the bounded stop.
                    res.end(JSON.stringify({ status: 'cancelled' }))
                } else if (req.url.endsWith('/stop')) {
                    res.end(JSON.stringify({ status: 'cancelled' }))
                } else if (req.url.endsWith('/events')) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' })
                    res.write(': specialist still working\n\n')
                } else {
                    res.writeHead(404).end()
                }
            } catch (error) {
                res.writeHead(500).end(JSON.stringify({ error: error.message }))
            }
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        t.after(async () => {
            child?.stdin.end()
            if (childExited) {
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
                await childExited
                clearTimeout(timer)
            }
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        })
        await assert.rejects(
            runHarness({
                name,
                mode: 'agent',
                chatId: 'inflight-chat',
                input: 'Delegate this fixture.',
                signal: controller.signal,
                budgetMs: interruption === 'budget' ? 5000 : 0,
                timeoutMs: 0,
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } }
            }),
            (error) => error.code === (interruption === 'abort' ? 'aborted' : 'over_budget')
        )
        assert.equal(stopSeen, true)
        const [saved] = listRuns(name)
        assert.equal(saved.status, interruption === 'abort' ? 'cancelled' : 'failed')
        assert.equal(saved.trace.status, saved.status)
        assert.equal(saved.trace.chief.status, saved.status)
        assert.equal(saved.trace.specialists.length, 1)
        const [step] = saved.trace.specialists
        assert.equal(step.name, 'worker')
        assert.equal(step.task, 'Read the fixture.')
        assert.equal(step.status, 'cancelled')
        if (interruption === 'abort') assert.match(step.error, /abort|cancel/i, 'snapshot includes the completed stop cleanup')
        assert.equal(agentTurn(name, sessionId), null)
        assert.deepEqual(readMessages(name, 'inflight-chat'), [], 'failed turns do not enter conversation history')
    })

test('agent step journal updates concurrent calls at the cap and keeps redaction', () => {
    const name = 'journal-fixture'
    const sessionId = 'journal-turn'
    beginAgentTurn(name, sessionId, 'journal-chat', 'turn-id')
    try {
        const steps = Array.from({ length: 161 }, (_, index) => ({
            name: 'worker',
            task: `Task ${index}`,
            startedAt: Date.now(),
            status: 'running'
        }))
        steps[0].task = 'Read Bearer fixture-journal-task'
        const slots = steps.map((step) => recordAgentStep(name, sessionId, step))
        assert.equal(slots[160], undefined)
        assert.equal(agentTurn(name, sessionId).steps.length, 160)
        assert.equal(agentTurn(name, sessionId).steps[0].task, 'Read Bearer [redacted]')
        recordAgentStep(name, sessionId, { ...steps[159], status: 'failed', error: 'Bearer fixture-journal-token' }, slots[159])
        recordAgentStep(name, sessionId, { ...steps[0], status: 'completed', usage: { prompt_tokens: 3, completion_tokens: 2 } }, slots[0])
        const saved = agentTurn(name, sessionId).steps
        assert.equal(saved.length, 160)
        assert.equal(saved[0].status, 'completed')
        assert.deepEqual(saved[0].tokens, { prompt: 3, completion: 2 })
        assert.equal(saved[1].status, 'running')
        assert.equal(saved[159].status, 'failed')
        assert.equal(saved[159].error, 'Bearer [redacted]')
    } finally {
        endAgentTurn(name, sessionId)
    }
})

for (const draft of [false, true])
    test(`agent ${draft ? 'draft ' : ''}follow-ups send only admitted chat history once`, async () => {
        const name = 'agent-conversation'
        const record = {
            name,
            workspaceId: 'fixture-workspace',
            ...(draft ? { chatflowId: 'draft-canvas', tryId: 'a1713ade' } : {}),
            chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
            specialists: [{ name: 'worker' }]
        }
        if (!draft) saveHarness(record)
        const bodies = []
        let fail = false
        const run = (input, chatId = 'shared-chat', replay = false) =>
            runHarness({
                name,
                ...(draft ? { record } : {}),
                mode: 'agent',
                chatId,
                input,
                replay,
                flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
                fetchImpl: async (_url, options) => {
                    bodies.push(JSON.parse(options.body))
                    return new Response(
                        JSON.stringify(
                            fail ? { status: 'failed', error: 'Fixture failed.' } : { status: 'completed', output: `Answer: ${input}` }
                        )
                    )
                }
            })
        await run('My order is rye.')
        await run('What did I order?')
        assert.deepEqual(bodies[0].conversation_history, [])
        assert.deepEqual(bodies[1].conversation_history, [
            { role: 'user', content: 'My order is rye.' },
            { role: 'assistant', content: 'Answer: My order is rye.' }
        ])
        assert.equal(bodies[1].input, 'What did I order?')
        assert.notEqual(bodies[0].session_id, bodies[1].session_id, 'delegation sessions remain per turn')
        await run('Other conversation.', 'different-chat')
        assert.deepEqual(bodies[2].conversation_history, [])
        fail = true
        await assert.rejects(run('Failed question.'), /Fixture failed/)
        fail = false
        await run('Try again.')
        assert.deepEqual(bodies[4].conversation_history, [
            { role: 'user', content: 'My order is rye.' },
            { role: 'assistant', content: 'Answer: My order is rye.' },
            { role: 'user', content: 'What did I order?' },
            { role: 'assistant', content: 'Answer: What did I order?' }
        ])
        const scope = draft ? draftSessionScope(record) : undefined
        assert.equal(readMessages(name, 'shared-chat', undefined, { scope }).length, 6)
        await run('Replay question.', 'shared-chat', true)
        assert.deepEqual(bodies[5].conversation_history, [])
        assert.equal(bodies[5].instructions, undefined)
        assert.equal(readMessages(name, 'shared-chat', undefined, { scope }).length, 6, 'replay neither loads nor appends history')
    })

test('agent history uses rolling memory, analyst page compaction and the chief context budget', async (t) => {
    const name = 'agent-conversation'
    const chatId = 'bounded-history'
    appendTurn(name, chatId, 'First order.', 'Rye confirmed.')
    appendTurn(name, chatId, 'pin: Collect on Saturday.', 'Saturday confirmed.')
    const page = 'rows 1-2 of 2 (page 1 of 1, last page)'
    appendTurn(name, chatId, 'List orders.', `Large table header\n${'table rows\n'.repeat(500)}${page}`)
    const bodies = []
    const run = () =>
        runHarness({
            name,
            mode: 'agent',
            chatId,
            input: 'Continue.',
            flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
            fetchImpl: async (_url, options) => {
                bodies.push(JSON.parse(options.body))
                return new Response(JSON.stringify({ status: 'completed', output: 'Continued.' }))
            }
        })
    await run()
    assert.equal(bodies[0].conversation_history.length, 4, 'only the last two exchanges are raw')
    assert.equal(bodies[0].conversation_history[3].content, page)
    assert.match(bodies[0].instructions, /First order.*Rye confirmed/)
    assert.match(bodies[0].instructions, /Pins:[\s\S]*Collect on Saturday/)
    const previous = process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS
    t.after(() => {
        if (previous === undefined) delete process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS
        else process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS = previous
    })
    process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS = String(estimateTokens(chiefInstructions({ name })) + 48)
    const result = await run()
    assert.ok(result.report.truncated.includes('chief.memory'))
    const body = bodies[1]
    const prompt = [body.instructions, ...body.conversation_history.map((message) => message.content), body.input].join('\n')
    assert.ok(prompt.length <= 48 * 4, 'history and memory fit the same chief context cap')
})

test('agent images reach the chief as multipart input without entering follow-up history', async () => {
    const name = 'agent-images'
    saveHarness({
        name,
        workspaceId: 'fixture-workspace',
        chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
        specialists: [{ name: 'worker' }]
    })
    const images = ['data:image/png;base64,iVBORw0KGgo=', 'https://example.com/fixture.png']
    const bodies = []
    const run = (attachments) =>
        runHarness({
            name,
            mode: 'agent',
            chatId: 'image-chat',
            input: 'What is in this picture?',
            images: attachments,
            flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
            fetchImpl: async (_url, options) => {
                bodies.push(JSON.parse(options.body))
                return new Response(JSON.stringify({ status: 'completed', output: 'A loaf of bread.' }))
            }
        })
    await run(images)
    assert.deepEqual(bodies[0].input, [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'What is in this picture?' },
                ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
        }
    ])
    assert.deepEqual(bodies[0].conversation_history, [])
    await run()
    assert.equal(bodies[1].input, 'What is in this picture?')
    assert.deepEqual(bodies[1].conversation_history, [
        { role: 'user', content: 'What is in this picture?' },
        { role: 'assistant', content: 'A loaf of bread.' }
    ])
})

for (const draft of [false, true])
    test(`agent ${draft ? 'draft ' : ''}history reserves the compiled chief prompt from its text budget`, async (t) => {
        const name = draft ? 'agent-draft-prompt-budget' : 'agent-prompt-budget'
        const base = {
            name,
            workspaceId: 'fixture-workspace',
            ...(draft ? { chatflowId: 'budget-canvas', tryId: 'b1713ade' } : {}),
            chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
            specialists: [{ name: 'worker' }]
        }
        const previous = process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS
        t.after(() => {
            if (previous === undefined) delete process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS
            else process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS = previous
        })
        const bodies = []
        const run = async (instructions, chatId, budget = 900) => {
            process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS = String(budget)
            const record = { ...base, chief: { ...base.chief, instructions } }
            if (!draft) saveHarness(record, { overwrite: true })
            const scope = draft ? draftSessionScope(record) : undefined
            for (let turn = 0; turn < 2; turn++)
                appendTurn(name, chatId, `Question ${turn}: ${'q'.repeat(580)}`, `Answer ${turn}: ${'a'.repeat(580)}`, [], undefined, {
                    scope
                })
            return runHarness({
                name,
                ...(draft ? { record } : {}),
                mode: 'agent',
                chatId,
                input: 'Continue.',
                flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
                fetchImpl: async (_url, options) => {
                    const body = JSON.parse(options.body)
                    const soul = chiefInstructions({ ...record, name: draft ? tryProfileName(record.tryId) : name })
                    bodies.push({ ...body, soul })
                    return new Response(JSON.stringify({ status: 'completed', output: 'Continued.' }))
                }
            })
        }
        await run('', 'small-prompt')
        const result = await run('Check the order. '.repeat(100), 'large-prompt')
        const [small, large] = bodies
        assert.equal(small.conversation_history.length, 4)
        assert.ok(large.conversation_history.length < small.conversation_history.length)
        assert.ok(result.report.truncated.includes('chief.memory'))
        const prompt = [large.instructions, ...large.conversation_history.map((message) => message.content), large.input].join('\n')
        assert.ok(estimateTokens(large.soul) + estimateTokens(prompt) <= 900)
        assert.equal(large.instructions, undefined, 'compiled instructions are loaded by the runtime, not sent twice')
        await run('Check the order. '.repeat(100), 'unlimited-prompt', 0)
        assert.equal(bodies[2].conversation_history.length, 4, 'zero keeps the unlimited text budget')
    })
