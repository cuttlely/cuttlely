import assert from 'node:assert/strict'
import test from 'node:test'
import { clearCallerWorkspace, noteCallerFlowOptions, pinnedCallContext, reconcileCallerContexts, setGatewayContext } from './gateway.mjs'

test('specialist gateway context retains the admitted caller and nested runner', async () => {
    const calls = []
    const rebuiltRunner = () => undefined
    const originalRunner = () => undefined
    const previous = setGatewayContext(async (record, nested) => {
        calls.push({ record, nested })
        return {
            componentNodes: {},
            flowOptions: {
                workspaceId: record.workspaceId,
                nestedFlowCaller: nested.nestedFlowCaller,
                nestedFlowDepth: nested.nestedFlowDepth,
                runNestedFlow: rebuiltRunner
            }
        }
    })
    const token = noteCallerFlowOptions('team', {
        workspaceId: 'workspace',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
        nestedFlowDepth: 2,
        runNestedFlow: originalRunner
    })
    try {
        const context = await pinnedCallContext({ name: 'team', workspaceId: 'workspace', chatflowId: 'flow-1' }, {})
        assert.deepEqual(calls[0].nested, {
            nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
            nestedFlowDepth: 2
        })
        assert.deepEqual(context.flowOptions.harnessCaller, {
            via: 'api_key',
            apiKeyId: 'key-1',
            harnesses: ['team']
        })
        assert.equal(context.flowOptions.runNestedFlow, originalRunner)
        assert.equal(context.flowOptions.nestedFlowDepth, 2)
    } finally {
        clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('two keys overlapping on one Harness run public unbound targets anonymously and refuse private or bound targets', async () => {
    const executed = []
    const rebuilt = []
    const ChatFlow = class {}
    const targets = new Map([
        ['public', { workspaceId: 'workspace', apiAccessMode: 'public' }],
        ['private', { workspaceId: 'workspace', apiAccessMode: 'private' }],
        ['bound', { workspaceId: 'workspace', apiAccessMode: 'public', apikeyid: 'key-1' }],
        ['other-workspace', { workspaceId: 'other', apiAccessMode: 'public' }]
    ])
    const borrowedRunner = () => assert.fail('An overlapping caller runner must never be borrowed')
    const previous = setGatewayContext(async (record, nested) => {
        rebuilt.push(nested)
        return {
            componentNodes: {},
            flowOptions: {
                workspaceId: record.workspaceId,
                nestedFlowCaller: nested.nestedFlowCaller,
                nestedFlowDepth: nested.nestedFlowDepth,
                databaseEntities: { ChatFlow },
                appDataSource: {
                    getRepository(entity) {
                        assert.equal(entity, ChatFlow)
                        return { findOneBy: async ({ id }) => targets.get(id) }
                    }
                },
                runNestedFlow: async (request) => {
                    executed.push({ request, caller: nested.nestedFlowCaller })
                    return { text: 'public answer' }
                }
            }
        }
    })
    const first = noteCallerFlowOptions('team', {
        workspaceId: 'workspace',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
        nestedFlowDepth: 3,
        runNestedFlow: borrowedRunner
    })
    const second = noteCallerFlowOptions('team', {
        workspaceId: 'workspace',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-2', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-2' },
        nestedFlowDepth: 0,
        runNestedFlow: borrowedRunner
    })
    try {
        const context = await pinnedCallContext({ name: 'team', workspaceId: 'workspace', chatflowId: 'flow-1' }, {})
        assert.equal(context.flowOptions.workspaceId, 'workspace')
        assert.equal(context.flowOptions.harnessCaller, undefined)
        assert.deepEqual(context.flowOptions.nestedFlowCaller, { via: 'flow' })
        assert.deepEqual(rebuilt, [{ nestedFlowCaller: { via: 'flow' }, nestedFlowDepth: 3 }])
        assert.equal(typeof context.flowOptions.runNestedFlow, 'function')
        const request = { targetFlowId: 'public', question: 'hello' }
        assert.deepEqual(await context.flowOptions.runNestedFlow(request), { text: 'public answer' })
        assert.deepEqual(executed, [{ request, caller: { via: 'flow' } }])
        for (const targetFlowId of ['private', 'bound', 'other-workspace', 'missing']) {
            await assert.rejects(context.flowOptions.runNestedFlow({ targetFlowId, question: 'hello' }), (error) => {
                assert.equal(error?.code, 'ambiguous_caller')
                assert.match(error.message, /Private or key-bound targets are refused immediately/)
                return true
            })
        }
        assert.equal(executed.length, 1)
    } finally {
        clearCallerWorkspace('team', first)
        clearCallerWorkspace('team', second)
        setGatewayContext(previous)
    }
})

test('the same caller at depths zero and one retains its principal and nested runner', async () => {
    const caller = { via: 'api_key', apiKeyId: 'key-1' }
    const calls = []
    const previous = setGatewayContext(async (record, nested) => {
        calls.push(nested)
        return { componentNodes: {}, flowOptions: { workspaceId: record.workspaceId } }
    })
    const tokens = [0, 1].map((nestedFlowDepth) =>
        noteCallerFlowOptions('team', {
            workspaceId: 'workspace',
            harnessCaller: { ...caller, harnesses: ['team'] },
            nestedFlowCaller: caller,
            nestedFlowDepth,
            runNestedFlow: async () => ({ text: `answer at depth ${nestedFlowDepth}` })
        })
    )
    try {
        const context = await pinnedCallContext({ name: 'team', workspaceId: 'workspace', chatflowId: 'flow-1' }, {})
        assert.deepEqual(calls, [{ nestedFlowCaller: caller, nestedFlowDepth: 1 }])
        assert.deepEqual(context.flowOptions.nestedFlowCaller, caller)
        assert.deepEqual(context.flowOptions.harnessCaller, { ...caller, harnesses: ['team'] })
        assert.deepEqual(await context.flowOptions.runNestedFlow({ targetFlowId: 'private' }), { text: 'answer at depth 1' })
    } finally {
        for (const token of tokens) clearCallerWorkspace('team', token)
        setGatewayContext(previous)
    }
})

test('reconciling local and queued overlaps keeps the highest nesting depth without a principal', () => {
    assert.deepEqual(
        reconcileCallerContexts([
            { workspaceId: 'workspace', nestedFlowDepth: 7 },
            { workspaceId: 'workspace', nestedFlowDepth: 1, nestedFlowCaller: { via: 'session' } }
        ]),
        { workspaceId: 'workspace', nestedFlowDepth: 7 }
    )
    assert.deepEqual(
        reconcileCallerContexts([
            { workspaceId: 'workspace', nestedFlowDepth: 7 },
            { workspaceId: 'workspace', nestedFlowDepth: 1 }
        ]),
        { workspaceId: 'workspace', nestedFlowDepth: 7 }
    )
})

test('overlapping runs from different workspaces still fail closed', async () => {
    const previous = setGatewayContext(async (record) => ({
        componentNodes: {},
        flowOptions: { workspaceId: record.workspaceId }
    }))
    const first = noteCallerFlowOptions('team', {
        workspaceId: 'workspace-a',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
        nestedFlowDepth: 0
    })
    const second = noteCallerFlowOptions('team', {
        workspaceId: 'workspace-b',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-2', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-2' },
        nestedFlowDepth: 0
    })
    try {
        await assert.rejects(
            pinnedCallContext({ name: 'team', workspaceId: 'workspace-a', chatflowId: 'flow-1' }, {}),
            (error) => error?.code === 'wrong_workspace'
        )
    } finally {
        clearCallerWorkspace('team', first)
        clearCallerWorkspace('team', second)
        setGatewayContext(previous)
    }
})
