import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { closeQueueDb, database } from './lock.mjs'
import { repoRoot } from './paths.mjs'
import { callerFlowOptions, callerFlowOptionsForJob, jobPayload } from './queue.mjs'

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

test('running queued jobs compare callers independently of depth and retain depth on different-key overlap', (t) => {
    const previousDataDir = process.env.CUTTLELY_DATA_DIR
    const scratchRoot = path.join(repoRoot(), '.verify')
    fs.mkdirSync(scratchRoot, { recursive: true })
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'queue-nested-'))
    closeQueueDb()
    process.env.CUTTLELY_DATA_DIR = scratch
    t.after(() => {
        closeQueueDb()
        if (previousDataDir === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previousDataDir
        fs.rmSync(scratch, { recursive: true, force: true })
    })
    const db = database()
    const payloadFor = (apiKeyId, nestedFlowDepth) =>
        jobPayload({
            name: 'team',
            chatId: `chat-${nestedFlowDepth}`,
            flowOptions: {
                workspaceId: 'workspace',
                harnessCaller: { via: 'api_key', apiKeyId, harnesses: ['team'] },
                nestedFlowCaller: { via: 'api_key', apiKeyId },
                nestedFlowDepth
            }
        })
    const insert = db.prepare(
        "INSERT INTO jobs (id, session_key, status, payload, created_at, updated_at) VALUES (?, ?, 'running', ?, 0, 0)"
    )
    insert.run('job-1', 'chat-0', JSON.stringify(payloadFor('key-1', 0)))
    insert.run('job-2', 'chat-1', JSON.stringify(payloadFor('key-1', 1)))
    const sameCaller = callerFlowOptionsForJob('team')
    assert.deepEqual(sameCaller.nestedFlowCaller, { via: 'api_key', apiKeyId: 'key-1' })
    assert.equal(sameCaller.harnessCaller.apiKeyId, 'key-1')

    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify(payloadFor('key-2', 7)), 'job-2')
    assert.deepEqual(callerFlowOptionsForJob('team'), { workspaceId: 'workspace', nestedFlowDepth: 7 })
})
