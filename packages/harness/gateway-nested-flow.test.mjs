import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-run-caller-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const {
    clearCallerWorkspace,
    noteCallerFlowOptions,
    pinnedCallContext,
    setGatewayContext,
    registerProfileToken,
    forgetProfileToken,
    startGateway
} = await import('./gateway.mjs')
const { saveHarness } = await import('./store.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { noteLiveTry, endLiveTry } = await import('./try-live.mjs')
after(() => {
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

const record = { name: 'team', workspaceId: 'workspace', chatflowId: 'flow-1' }
const callerOptions = (apiKeyId, extra = {}) => ({
    workspaceId: 'workspace',
    harnessCaller: { via: 'api_key', apiKeyId, harnesses: ['team'] },
    nestedFlowCaller: { via: 'api_key', apiKeyId },
    nestedFlowDepth: 0,
    ...extra
})
const runtime = async (current, nested) => ({
    componentNodes: {},
    flowOptions: { workspaceId: current.workspaceId, ...nested, runNestedFlow: async () => ({ text: 'rebuilt' }) }
})

test('a scoped specialist context retains its admitted caller and original nested runner', async () => {
    const calls = []
    const originalRunner = async () => ({ text: 'original' })
    const previous = setGatewayContext(async (current, nested) => {
        calls.push(nested)
        return runtime(current, nested)
    })
    const token = noteCallerFlowOptions('team', callerOptions('key-1', { nestedFlowDepth: 2, runNestedFlow: originalRunner }), 'chat-1')
    try {
        const context = await pinnedCallContext(record, {}, 'chat-1')
        assert.deepEqual(calls[0], { nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' }, nestedFlowDepth: 2 })
        assert.deepEqual(context.flowOptions.harnessCaller, callerOptions('key-1').harnessCaller)
        assert.equal(context.flowOptions.runNestedFlow, originalRunner)
        assert.equal(context.flowOptions.nestedFlowDepth, 2)
    } finally {
        clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('a noted caller is a frozen snapshot of the admitted identity', async () => {
    const previous = setGatewayContext(runtime)
    const options = callerOptions('key-1')
    const token = noteCallerFlowOptions('team', options, 'frozen-chat')
    try {
        options.nestedFlowCaller.apiKeyId = 'key-2'
        options.harnessCaller.apiKeyId = 'key-2'
        options.harnessCaller.harnesses.push('other-team')
        const context = await pinnedCallContext(record, {}, 'frozen-chat')
        assert.equal(context.flowOptions.nestedFlowCaller.apiKeyId, 'key-1')
        assert.equal(context.flowOptions.harnessCaller.apiKeyId, 'key-1')
        assert.deepEqual(context.flowOptions.harnessCaller.harnesses, ['team'])
        assert.equal(Object.isFrozen(context.flowOptions.nestedFlowCaller), true)
        assert.equal(Object.isFrozen(context.flowOptions.harnessCaller.harnesses), true)
    } finally {
        clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('concurrent chats retain separate principals and per-chat cancellation closures at different depths', async () => {
    const previous = setGatewayContext(runtime)
    const abortA = new AbortController()
    const abortB = new AbortController()
    const makeRunner = (chatId, signal) => async () => {
        signal.throwIfAborted()
        return { text: chatId }
    }
    const tokens = [
        noteCallerFlowOptions('team', callerOptions('key-1', { runNestedFlow: makeRunner('chat-a', abortA.signal) }), 'chat-a'),
        noteCallerFlowOptions(
            'team',
            callerOptions('key-2', { runNestedFlow: makeRunner('chat-b', abortB.signal), nestedFlowDepth: 1 }),
            'chat-b'
        )
    ]
    try {
        const [a, b] = await Promise.all([pinnedCallContext(record, {}, 'chat-a'), pinnedCallContext(record, {}, 'chat-b')])
        assert.equal(a.flowOptions.nestedFlowCaller.apiKeyId, 'key-1')
        assert.equal(b.flowOptions.nestedFlowCaller.apiKeyId, 'key-2')
        abortB.abort()
        assert.deepEqual(await a.flowOptions.runNestedFlow({}), { text: 'chat-a' })
        await assert.rejects(b.flowOptions.runNestedFlow({}), { name: 'AbortError' })
    } finally {
        for (const token of tokens) clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('the same principal at depths zero and one keeps each chat runner', async () => {
    const previous = setGatewayContext(runtime)
    const tokens = [0, 1].map((depth) =>
        noteCallerFlowOptions(
            'team',
            callerOptions('key-1', { nestedFlowDepth: depth, runNestedFlow: async () => ({ text: `${depth}` }) }),
            `depth-${depth}`
        )
    )
    try {
        for (const depth of [0, 1]) {
            const context = await pinnedCallContext(record, {}, `depth-${depth}`)
            assert.equal(context.flowOptions.nestedFlowDepth, depth)
            assert.deepEqual(await context.flowOptions.runNestedFlow({}), { text: `${depth}` })
        }
    } finally {
        for (const token of tokens) clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

for (const conflict of [callerOptions('key-2'), callerOptions('key-1', { workspaceId: 'other' })])
    test(`an active chat collision refuses only the new ${conflict.workspaceId === 'other' ? 'workspace' : 'principal'}`, async () => {
        const previous = setGatewayContext(runtime)
        const first = noteCallerFlowOptions('team', callerOptions('key-1'), 'occupied')
        let independent
        try {
            assert.throws(
                () => noteCallerFlowOptions('team', conflict, 'occupied'),
                (error) => error?.code === 'caller_collision'
            )
            independent = noteCallerFlowOptions('team', callerOptions('key-2'), 'independent')
            const original = await pinnedCallContext(record, {}, 'occupied')
            const other = await pinnedCallContext(record, {}, 'independent')
            assert.equal(original.flowOptions.nestedFlowCaller.apiKeyId, 'key-1')
            assert.equal(other.flowOptions.nestedFlowCaller.apiKeyId, 'key-2')
        } finally {
            clearCallerWorkspace('team', first)
            clearCallerWorkspace('team', independent)
            setGatewayContext(previous)
        }
    })

test('missing or unknown execution scope cannot borrow a caller', async () => {
    const previous = setGatewayContext(runtime)
    const token = noteCallerFlowOptions('team', callerOptions('key-1'), 'admitted')
    try {
        const discovery = await pinnedCallContext(record, {})
        assert.equal(discovery.flowOptions.workspaceId, 'workspace')
        assert.equal(discovery.flowOptions.nestedFlowCaller, undefined)
        assert.equal(discovery.flowOptions.harnessCaller, undefined)
        await assert.rejects(discovery.flowOptions.runNestedFlow({}), (error) => error?.code === 'caller_required')
        const forged = await pinnedCallContext(record, {}, 'unknown')
        assert.equal(forged.flowOptions.nestedFlowCaller, undefined)
        await assert.rejects(forged.flowOptions.runNestedFlow({}), (error) => error?.code === 'caller_required')
    } finally {
        clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('a scoped chat in another workspace still refuses without affecting a matching chat', async () => {
    const previous = setGatewayContext(runtime)
    const a = noteCallerFlowOptions('team', callerOptions('key-1'), 'here')
    const b = noteCallerFlowOptions('team', callerOptions('key-2', { workspaceId: 'other' }), 'elsewhere')
    try {
        await assert.rejects(pinnedCallContext(record, {}, 'elsewhere'), (error) => error?.code === 'wrong_workspace')
        assert.equal((await pinnedCallContext(record, {}, 'here')).flowOptions.nestedFlowCaller.apiKeyId, 'key-1')
    } finally {
        clearCallerWorkspace('team', a)
        clearCallerWorkspace('team', b)
        setGatewayContext(previous)
    }
})

test('saved and Try-it gateway calls resolve the chat before selecting the principal', async () => {
    const saved = saveHarness({
        name: 'http-team',
        workspaceId: 'workspace',
        chatflowId: 'flow-1',
        chief: { model: { nodeName: 'unused' } },
        specialists: [{ name: 'worker', modules: [{ nodeName: 'nestedTool', inputs: { name: 'nested' } }] }]
    })
    const tryName = 'tryabcdef1234567890'
    const tryDir = path.join(dir, 'runtime', 'profiles', tryName)
    fs.mkdirSync(tryDir, { recursive: true })
    fs.writeFileSync(path.join(tryDir, 'harness-try'), tryName)
    fs.writeFileSync(path.join(tryDir, 'harness-roster.json'), JSON.stringify(saved))
    noteLiveTry(tryName)
    const contexts = []
    const previous = setGatewayContext(async (current, nested) => {
        contexts.push(nested)
        return {
            flowOptions: { workspaceId: current.workspaceId, appDataSource: {} },
            loadNode: async () =>
                class {
                    async init(_data, _input, options) {
                        return { name: 'nested', invoke: async () => (await options.runNestedFlow({})).text }
                    }
                }
        }
    })
    const key = noteCallerFlowOptions(saved.name, callerOptions('key-1', { runNestedFlow: async () => ({ text: 'key-only' }) }), 'key-chat')
    const session = noteCallerFlowOptions(
        saved.name,
        {
            workspaceId: 'workspace',
            harnessCaller: { via: 'session' },
            nestedFlowCaller: { via: 'session' },
            runNestedFlow: async () => ({ text: 'session-only' })
        },
        'try-chat'
    )
    const gateway = await startGateway({ port: 0 })
    const tokens = []
    try {
        for (const [harnessName, chatId, expected, tryProfile] of [
            [saved.name, 'key-chat', 'key-only', false],
            [tryName, 'try-chat', 'session-only', true]
        ]) {
            const token = crypto.randomBytes(32).toString('base64url')
            tokens.push(token)
            const profileName = `${harnessName}--worker`
            registerProfileToken({ token, harnessName, specialistName: 'worker', profileName, tryProfile, modelKey: 'fixture-model' })
            const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
            const list = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/list`, { method: 'POST', headers, body: '{}' })
            const listed = await list.json()
            assert.equal(list.status, 200, JSON.stringify(listed))
            const tools = listed.tools
            assert.deepEqual(contexts.at(-1), { nestedFlowCaller: undefined, nestedFlowDepth: undefined })
            const call = async (scope) => {
                const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: tools[0].name, scope, arguments: {} })
                })
                return { response, body: await response.json() }
            }
            const valid = await call(`${profileName}:${chatId}#turn-one`)
            assert.equal(valid.response.status, 200, JSON.stringify(valid.body))
            assert.equal(valid.body.result, expected)
            for (const scope of [undefined, `${profileName}:unknown#turn-one`]) {
                const missing = await call(scope)
                assert.notEqual(missing.response.status, 200)
                assert.equal(missing.body.error.type, 'caller_required')
            }
        }
    } finally {
        for (const token of tokens) forgetProfileToken(token)
        clearCallerWorkspace(saved.name, key)
        clearCallerWorkspace(saved.name, session)
        endLiveTry(tryName)
        setGatewayContext(previous)
        await gateway.close()
    }
})
