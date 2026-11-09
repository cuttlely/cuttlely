import assert from 'node:assert/strict'
import test from 'node:test'
import { callerFlowOptions, jobPayload } from './queue.mjs'

test('queued Harness jobs retain nested caller and depth without serializing the runner', () => {
    const payload = jobPayload({
        name: 'team',
        chatId: 'chat',
        input: 'question',
        flowOptions: {
            workspaceId: 'workspace',
            harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['team'], harnessIds: { team: 'canvas-1' } },
            expectedHarnessChatflowId: 'canvas-1',
            nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
            nestedFlowDepth: 3,
            runNestedFlow: () => undefined
        }
    })

    assert.deepEqual(payload.nestedFlowCaller, { via: 'api_key', apiKeyId: 'key-1' })
    assert.equal(payload.nestedFlowDepth, 3)
    assert.equal(Object.hasOwn(payload, 'runNestedFlow'), false)

    const runNestedFlow = () => undefined
    const rebuilt = callerFlowOptions(payload, { runNestedFlow })
    assert.equal(rebuilt.runNestedFlow, runNestedFlow)
    assert.deepEqual(rebuilt.nestedFlowCaller, payload.nestedFlowCaller)
    assert.equal(rebuilt.nestedFlowDepth, 3)
})

test('queued Harness jobs derive a serializable nested caller from the admitted Harness caller', () => {
    const payload = jobPayload({
        name: 'team',
        chatId: 'chat',
        input: 'question',
        flowOptions: { harnessCaller: { via: 'session' } }
    })

    assert.deepEqual(payload.nestedFlowCaller, { via: 'session' })
    assert.equal(payload.nestedFlowDepth, 0)
})
