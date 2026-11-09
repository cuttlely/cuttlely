import assert from 'node:assert/strict'
import test from 'node:test'
import { clearCallerWorkspace, noteCallerFlowOptions, pinnedCallContext, setGatewayContext } from './gateway.mjs'

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

test('overlapping runs with different principals fail closed instead of borrowing a caller', async () => {
    const previous = setGatewayContext(async (record) => ({
        componentNodes: {},
        flowOptions: { workspaceId: record.workspaceId }
    }))
    const first = noteCallerFlowOptions('team', {
        workspaceId: 'workspace',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
        nestedFlowDepth: 0
    })
    const second = noteCallerFlowOptions('team', {
        workspaceId: 'workspace',
        harnessCaller: { via: 'api_key', apiKeyId: 'key-2', harnesses: ['team'] },
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-2' },
        nestedFlowDepth: 0
    })
    try {
        await assert.rejects(
            pinnedCallContext({ name: 'team', workspaceId: 'workspace', chatflowId: 'flow-1' }, {}),
            (error) => error?.code === 'wrong_workspace'
        )
    } finally {
        clearCallerWorkspace('team', first)
        clearCallerWorkspace('team', second)
        setGatewayContext(previous)
    }
})
