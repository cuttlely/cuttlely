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
const { readProfileEnv } = await import('./profile.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { agentTurn } = await import('./agent-run-context.mjs')
const { jobPayload, runQueuedHarness } = await import('./queue.mjs')
const { pinnedCallContext, setGatewayContext, startGateway } = await import('./gateway.mjs')
after(() => {
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
    const controller = new AbortController()
    const calls = []
    let sessionId
    await assert.rejects(
        runHarness({
            name: 'agent-fixture',
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
    assert.equal(agentTurn('agent-fixture', sessionId), null)
    const recorded = listRuns('agent-fixture').find((run) => run.chatId === 'cancelled-chat')
    assert.equal(recorded.mode, 'agent')
    assert.equal(recorded.status, 'cancelled')
})
