import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callerFlowOptions, callerFlowOptionsForJob, claimJob, enqueueHarnessJob, finishJob, jobPayload } from './queue.mjs'
import { closeQueueDb } from './lock.mjs'
import { clearCallerWorkspace, noteCallerFlowOptions, pinnedCallContext, setGatewayContext } from './gateway.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-run-caller-'))
process.env.CUTTLELY_DATA_DIR = dir
after(() => {
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

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

test('an external worker gateway selects only the running job with the same Harness and chat', async () => {
    const make = (name, chatId, apiKeyId, depth) => ({
        name,
        chatId,
        input: 'question',
        flowOptions: {
            workspaceId: 'workspace',
            harnessCaller: { via: 'api_key', apiKeyId, harnesses: [name] },
            nestedFlowCaller: { via: 'api_key', apiKeyId },
            nestedFlowDepth: depth
        }
    })
    const jobs = [
        enqueueHarnessJob(make('shared', 'chat-a', 'key-a', 0)),
        enqueueHarnessJob(make('shared', 'chat-b', 'key-b', 1)),
        enqueueHarnessJob(make('other', 'chat-a', 'key-c', 2)),
        enqueueHarnessJob(make('shared', 'pending', 'key-d', 3))
    ]
    const previous = setGatewayContext(async (record, nested) => ({
        flowOptions: {
            workspaceId: record.workspaceId,
            runNestedFlow: async () => ({ text: `${nested.nestedFlowCaller.apiKeyId}:${nested.nestedFlowDepth}` })
        }
    }))
    try {
        for (let index = 0; index < 3; index++) assert.ok(claimJob())
        assert.throws(
            () =>
                noteCallerFlowOptions(
                    'shared',
                    { workspaceId: 'workspace', harnessCaller: { via: 'session' }, nestedFlowCaller: { via: 'session' } },
                    'chat-a'
                ),
            (error) => error.code === 'caller_collision'
        )
        const own = noteCallerFlowOptions('shared', callerFlowOptionsForJob('shared', 'chat-a'), 'chat-a')
        clearCallerWorkspace('shared', own)
        assert.equal(callerFlowOptionsForJob('shared', 'chat-a').nestedFlowCaller.apiKeyId, 'key-a')
        assert.equal(callerFlowOptionsForJob('shared', 'chat-b').nestedFlowCaller.apiKeyId, 'key-b')
        assert.equal(callerFlowOptionsForJob('other', 'chat-a').nestedFlowCaller.apiKeyId, 'key-c')
        assert.equal(callerFlowOptionsForJob('shared', 'pending'), undefined)
        assert.equal(callerFlowOptionsForJob('shared', 'absent'), undefined)
        assert.equal(callerFlowOptionsForJob('shared'), undefined)
        for (const [chatId, expected] of [
            ['chat-a', 'key-a:0'],
            ['chat-b', 'key-b:1']
        ]) {
            const context = await pinnedCallContext({ name: 'shared', workspaceId: 'workspace' }, {}, chatId)
            assert.deepEqual(await context.flowOptions.runNestedFlow({}), { text: expected })
        }
        finishJob(jobs[0].id, { status: 'succeeded', result: {} })
        assert.equal(callerFlowOptionsForJob('shared', 'chat-a'), undefined)
        assert.equal(callerFlowOptionsForJob('shared', 'chat-b').nestedFlowCaller.apiKeyId, 'key-b')
    } finally {
        for (const job of jobs) finishJob(job.id, { status: 'succeeded', result: {} })
        setGatewayContext(previous)
    }
})
