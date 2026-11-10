import assert from 'node:assert/strict'
import test from 'node:test'
import workerNestedAuthorization from '../../scripts/fixtures/harness-worker-nested.cjs'
import { bootHarnessNodePool } from './node-pool.mjs'

test('a worker rebuilds the nested runner from queued caller fields', async () => {
    const captured = []
    const workspaceEntity = class Workspace {}
    const organizationEntity = class Organization {}
    const appDataSource = {
        getRepository(entity) {
            if (entity === workspaceEntity) return { findOneBy: async () => ({ organizationId: 'org-1' }) }
            if (entity === organizationEntity) return { findOneBy: async () => ({ id: 'org-1', subscriptionId: 'sub-1' }) }
            throw new Error('unexpected entity')
        }
    }
    const pool = await bootHarnessNodePool({
        loadServer: async () => ({
            componentNodes: { chat: {} },
            appDataSource,
            databaseEntities: {},
            cachePool: {},
            workspaceEntity,
            organizationEntity,
            nestedFlowNodeOptions: (runtime) => {
                captured.push(runtime)
                return {
                    nestedFlowCaller: runtime.caller,
                    nestedFlowDepth: runtime.depth,
                    runNestedFlow: () => undefined
                }
            },
            telemetry: {},
            usageCacheManager: {},
            sseStreamer: {},
            productId: ''
        })
    })

    assert.equal(pool.ready, true)
    const context = await pool.contextFor(
        { chatflowId: 'harness-flow', workspaceId: 'workspace' },
        { nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' }, nestedFlowDepth: 4 }
    )
    assert.equal(typeof context.flowOptions.runNestedFlow, 'function')
    assert.deepEqual(context.flowOptions.nestedFlowCaller, { via: 'api_key', apiKeyId: 'key-1' })
    assert.equal(context.flowOptions.nestedFlowDepth, 4)
    assert.equal(captured[0].parentFlowId, 'harness-flow')
    assert.equal(captured[0].parentWorkspaceId, 'workspace')
    assert.equal(captured[0].subscriptionId, 'sub-1')
})

test('external worker reauthorizes a pinned private target using its own database without Express', (t) =>
    workerNestedAuthorization(t, bootHarnessNodePool))
