// Production entry points with disposable SQLite databases and the real harness runtime.
process.env.INBOUND_ACCESS_V2 = 'on'
process.env.CUTTLELY_VERSIONS = 'false'
process.env.CUTTLELY_DASH_FLOWS = 'false'
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { createRequire } = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const root = mkdtempSync(path.join(tmpdir(), 'cuttlely-access-production-'))
process.env.LOG_PATH = path.join(root, 'logs')
process.env.CUTTLELY_DATA_DIR = root
process.env.CUTTLELY_HERMES_HOME = path.join(root, 'profiles-home')
process.env.FLOWISE_SECRETKEY_OVERWRITE = 'fixture-access-production-pepper'
after(() => rmSync(root, { recursive: true, force: true }))
const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
    }
})
const { DataSource } = serverRequire('typeorm')
const { entities } = serverRequire('./src/database/entities/index.ts')
const { ChatFlow, ApiKey, ApiKeyResource, ApiKeyUsage, ApiKeyCredential, FlowVersionState } = entities
const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
const { hasGrant } = serverRequire('./src/services/accessKeys/authorization.ts')
const appModule = serverRequire('./src/utils/getRunningExpressApp.ts')
const dataModule = serverRequire('./src/services/accessKeys/data.ts')
const dataSourceModule = serverRequire('./src/DataSource.ts')
async function database() {
    const data = new DataSource({ type: 'sqlite', database: ':memory:', entities: Object.values(entities), synchronize: true })
    await data.initialize()
    appModule.getRunningExpressApp = () => ({
        AppDataSource: data,
        nodesPool: { componentNodes: {} },
        cachePool: {},
        usageCacheManager: {},
        identityManager: { getPlatformType: () => 'open_source' }
    })
    dataModule.accessData = async () => data
    dataSourceModule.getDataSource = () => data
    return data
}
async function legacyFlow(data, id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
    await data.getRepository(ApiKey).save({
        id: 'legacy-key',
        apiKey: '',
        apiSecret: '',
        keyName: 'Fixture',
        workspaceId: 'team-a',
        permissions: [],
        harnesses: ['named-independent'],
        accessPolicy: { ...parsePolicy({ scopes: ['predict'] }), legacy: true }
    })
    const flow = await data.getRepository(ChatFlow).save({
        id,
        name: 'Fixture',
        workspaceId: 'team-a',
        type: 'CHATFLOW',
        flowData: '{"nodes":[],"edges":[]}',
        apikeyid: 'legacy-key',
        apiAccessMode: 'private'
    })
    await data.getRepository(ApiKeyResource).save({ principalId: 'legacy-key', resourceType: 'CHATFLOW', resourceId: id })
    return flow
}
const chatflows = serverRequire('./src/services/chatflows/index.ts')
const update = (flow, patch, options) => chatflows.default.updateChatflow(flow, patch, 'org-a', 'team-a', '', options)

test('updateChatflow moves derived grants, unbinds, preserves independent grants, and enforces draft/CAS guards', async () => {
    const data = await database()
    try {
        const { User, Workspace, Organization } = entities
        await data.getRepository(User).save({
            id: 'fixture',
            name: 'Fixture',
            email: 'type-fixture@example.invalid',
            status: 'active',
            createdBy: 'fixture',
            updatedBy: 'fixture'
        })
        await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        let flow = await legacyFlow(data)
        const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
        const key = await data.getRepository(ApiKey).findOneByOrFail({ id: 'legacy-key' })
        const { secret } = await data.transaction((manager) => mintCredential(manager, key))
        const express = serverRequire('express'),
            request = serverRequire('supertest')
        const { authorizePrediction } = serverRequire('./src/utils/authorizeFlowAccess.ts')
        const prediction = express()
        prediction.post('/api/v1/prediction/:id', authorizePrediction, (_req, res) => res.json({ admitted: true }))
        prediction.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const predict = (id) =>
            request(prediction)
                .post('/api/v1/prediction/' + id)
                .set('Authorization', 'Bearer ' + secret)

        await data.getRepository(ApiKey).save({
            id: 'explicit-key',
            apiKey: '',
            apiSecret: '',
            keyName: 'Explicit',
            workspaceId: 'team-a',
            permissions: [],
            accessPolicy: parsePolicy({ scopes: ['predict'] })
        })
        for (const grant of [
            { principalId: 'explicit-key', resourceType: 'CHATFLOW', resourceId: flow.id },
            { principalId: 'legacy-key', resourceType: 'HARNESS', resourceId: 'independent-harness' }
        ])
            await data.getRepository(ApiKeyResource).save(grant)
        await update(flow, { type: 'AGENTFLOW' })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(flow.type, 'AGENTFLOW')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: flow.id }), true)
        assert.equal((await predict(flow.id)).status, 200, 'converted flow still admits K through the real prediction guard')
        await update(flow, { apikeyid: null })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        await update(flow, { type: 'CHATFLOW' })
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(flow.apiAccessMode, 'private')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: flow.id }), false)
        assert.equal(await hasGrant(data, { id: 'explicit-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: 'independent-harness' }), true)
        const usage = await data.getRepository(ApiKeyUsage).find()
        assert.equal((await predict(flow.id)).status, 403, 'unbound, reconverted private flow denies K')
        assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), usage)
        // Exercise the conflict guards on a bound flow, so its existing derived grant must also survive.
        flow = await legacyFlow(data, 'bound-cas')
        // Insert a draft at the actual conditional-write seam, after the earlier draft check.
        chatflows.liveWriteHooks.beforeConditionalWrite = async () => {
            await data.getRepository(FlowVersionState).save({ chatflowId: flow.id, workspaceId: 'team-a', draftFlowData: '{"nodes":[]}' })
        }
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }), { statusCode: 409 })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type, 'CHATFLOW')
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: flow.id }), true)
        await data.getRepository(FlowVersionState).delete({ chatflowId: flow.id })
        chatflows.liveWriteHooks.beforeConditionalWrite = null
        const grants = await data.getRepository(ApiKeyResource).find()
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }, { expectedFlowData: 'stale canvas' }), { statusCode: 409 })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type, 'CHATFLOW')
        assert.deepEqual(await data.getRepository(ApiKeyResource).find(), grants)
    } finally {
        chatflows.liveWriteHooks.beforeConditionalWrite = null
        await data.destroy()
    }
})

test('updateChatflow rolls back its conditional row write when derived-grant reconciliation fails', async () => {
    const data = await database()
    try {
        const flow = await legacyFlow(data)
        const before = await data.getRepository(ApiKeyResource).find()
        await data.query(`CREATE TRIGGER refuse_derived_grant BEFORE INSERT ON apikey_resource
            WHEN NEW.resourceType = 'AGENTFLOW' BEGIN SELECT RAISE(ABORT, 'fixture grant failure'); END`)
        await assert.rejects(update({ ...flow }, { type: 'AGENTFLOW' }), /fixture grant failure/)
        assert.equal(
            (await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).type,
            'CHATFLOW',
            'type and grants must commit together'
        )
        assert.deepEqual(await data.getRepository(ApiKeyResource).find(), before)
    } finally {
        await data.destroy()
    }
})

function latch() {
    let release
    const reached = new Promise((resolve) => (release = resolve))
    return { reached, release }
}
const esm = (file) => import(path.join(__dirname, '../packages/harness', file))

for (const entry of [
    'account report',
    'sync',
    'stream',
    'async',
    'prediction card',
    'prediction tool',
    'missing startRun pin',
    'missing background pin',
    'missing runtime pin',
    'missing enqueue pin'
])
    for (const stage of entry.startsWith('missing')
        ? ['missing pin']
        : [
              'unchanged',
              'unchanged queued',
              'after caller',
              'before dispatch',
              'after enqueue',
              'lost queue pin',
              'worker context replacement'
          ]) {
        test(entry + ' Guard → handler → runtime/worker retains authorized canvas: ' + stage, async () => {
            const data = await database()
            const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
            const harnesses = serverRequire('./src/services/harnesses/index.ts')
            const report = serverRequire('./src/services/accessKeys/dashflowReports.ts')
            const dashflows = serverRequire('./src/services/dashflows/index.ts')
            const oldRuntime = dashflows.runtime
            const store = await esm('store.mjs')
            const engine = await esm('run.mjs')
            const queue = await esm('queue.mjs')
            const history = await esm('history.mjs')
            const gateway = await esm('gateway.mjs')
            const fixture = require('./fixtures/access-key-report-node.cjs')
            const before = fixture.executions.length
            const A = '11111111-1111-4111-8111-111111111111'
            const B = '22222222-2222-4222-8222-222222222222'
            const name = entry.replaceAll(' ', '-') + '-' + stage.replaceAll(' ', '-')
            const backgroundEntry = ['account report', 'async'].includes(entry)
            const queued = ['after enqueue', 'unchanged queued', 'lost queue pin', 'worker context replacement'].includes(stage)
            const unchanged = stage.startsWith('unchanged')
            const accountId = '001000000000000000'
            const ready = latch(),
                resume = latch(),
                settled = latch(),
                background = latch()
            const runs = serverRequire('./src/settings/runs.ts')
            const originalTrack = runs.trackBackgroundRun
            runs.trackBackgroundRun = (promise) => originalTrack(promise).finally(() => background.release())
            let entered = false
            const replace = async () => {
                entered = true
                ready.release()
                await resume.reached
                store.deleteHarness(name)
                store.saveHarness(roster(B))
            }
            const roster = (id) => ({
                name,
                chatflowId: id,
                workspaceId: 'team-a',
                chief: { model: { nodeName: 'reportModel' } },
                specialists: [
                    {
                        name: 'writer',
                        instructions: 'Write report.',
                        modules: [{ nodeName: 'reportRetriever', category: 'Retrievers', inputs: { marker: id } }]
                    }
                ]
            })
            try {
                const { User, Workspace, Organization } = entities
                await data.getRepository(User).save({
                    id: 'fixture',
                    name: 'Fixture',
                    email: 'fixture@example.invalid',
                    status: 'active',
                    createdBy: 'fixture',
                    updatedBy: 'fixture'
                })
                await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
                await data
                    .getRepository(Workspace)
                    .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
                for (const id of [A, B])
                    await data.getRepository(ChatFlow).save({ id, name, workspaceId: 'team-a', type: 'HARNESS', flowData: '{}' })
                const key = await data.getRepository(ApiKey).save({
                    id: 'report-key',
                    apiKey: '',
                    apiSecret: '',
                    keyName: 'Report',
                    workspaceId: 'team-a',
                    permissions: ['chatflows:view', 'chatflows:update'],
                    accessPolicy: parsePolicy({ scopes: ['dashflow:report', 'harness:run', 'predict', 'stream'], rpm: 0 }),
                    harnesses: []
                })
                for (const grant of [
                    { resourceType: 'HARNESS', resourceId: A },
                    { resourceType: 'DASHFLOW', resourceId: 'dashboard' },
                    { resourceType: 'CHATFLOW', resourceId: '33333333-3333-4333-8333-333333333333' }
                ])
                    await data.getRepository(ApiKeyResource).save({ principalId: key.id, ...grant })
                const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
                const { secret } = await data.transaction((manager) => mintCredential(manager, key))
                assert.equal((await serverRequire('./src/services/apikey/index.ts').default.getApiKey(secret)).id, key.id)
                setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: ['chatflows:view'] }) })
                const app = appModule.getRunningExpressApp()
                // The production contextFor loads these node classes, including in the worker.
                const { writeFileSync } = require('node:fs')
                const retrieverPath = path.join(root, 'retriever.cjs')
                writeFileSync(
                    retrieverPath,
                    `module.exports.nodeClass = require(${JSON.stringify(
                        path.join(__dirname, 'fixtures/access-key-report-node.cjs')
                    )}).ReportRetriever`
                )
                app.nodesPool.componentNodes.reportModel = { filePath: path.join(__dirname, 'fixtures/access-key-report-node.cjs') }
                app.nodesPool.componentNodes.reportRetriever = { filePath: retrieverPath }
                appModule.getRunningExpressApp = () => app
                // Boot the real gateway on a disposable listener before installing any rosters.
                const listener = await gateway.startGateway({ port: 0 })
                process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(listener.port)
                store.saveHarness(roster(A), { overwrite: true })
                const outerId = '33333333-3333-4333-8333-333333333333'
                await data.getRepository(ChatFlow).save({
                    id: outerId,
                    name: 'Caller',
                    workspaceId: 'team-a',
                    type: 'CHATFLOW',
                    apiAccessMode: 'private',
                    flowData: JSON.stringify({ nodes: [{ data: { inputs: { harnessName: name } } }] })
                })
                dashflows.runtime = async () => ({
                    DashFlowError: class DashFlowError extends Error {},
                    dashStore: () => ({
                        published: () => ({
                            definition: { harness: name },
                            revision: 1,
                            snapshot: { cards: [{ rows: [{ account_id: accountId }] }] }
                        })
                    })
                })
                if (stage === 'after caller' && entry === 'account report') report.reportAdmissionHooks.afterCaller = replace
                if (stage === 'before dispatch' && !entry.startsWith('prediction ')) harnesses.runAdmissionHooks.beforeDispatch = replace
                if (queued)
                    queue.queueHooks.afterEnqueue = async () => {
                        if (!unchanged && stage !== 'lost queue pin' && stage !== 'worker context replacement') await replace()
                        if (stage === 'lost queue pin') {
                            entered = true
                            ready.release()
                        }
                        // Claim before localRuns is installed: exercise the serialized payload, as an external worker does.
                        const job = queue.claimJob()
                        assert.ok(job)
                        assert.equal(job.payload.workspaceId, 'team-a')
                        assert.equal(job.payload.expectedHarnessChatflowId, A)
                        assert.equal(job.payload.caller.harnessIds[name], A)
                        if (stage === 'lost queue pin') delete job.payload.expectedHarnessChatflowId
                        queue.setWorkerContext(
                            stage === 'worker context replacement'
                                ? async (record) => {
                                      await replace()
                                      return harnesses.contextFor(record)
                                  }
                                : harnesses.contextFor
                        )
                        await queue.executeJob(job)
                    }
                process.env.CUTTLELY_HARNESS_QUEUE = queued ? 'external' : 'off'
                // Track the same background lifecycle the handler uses, with no polling sleeps.
                const express = serverRequire('express'),
                    request = serverRequire('supertest')
                const { accessKeyRouteGuard } = serverRequire('./src/services/accessKeys/routes.ts')
                const http = express()
                http.use(serverRequire('express').json())
                http.use('/api/v1', accessKeyRouteGuard)
                if (entry !== 'account report' && !entry.startsWith('prediction ') && stage === 'after caller')
                    http.use(async (_req, _res, next) => {
                        await replace()
                        next()
                    })
                const controller = serverRequire('./src/controllers/harnesses/index.ts').default
                http.post('/api/v1/dashflows/:id/accounts/:accountId/report', report.bearerDashboardReport)
                http.post(
                    '/api/v1/harnesses/:name/runs',
                    entry.startsWith('missing')
                        ? async (req, res, next) => {
                              try {
                                  const caller = await serverRequire('./src/services/harnesses/apiAccess.ts').harnessCallerFor(req)
                                  assert.equal(caller.harnessIds[name], A)
                                  entered = true
                                  ready.release()
                                  const opts = { workspaceId: 'team-a', caller }
                                  if (entry === 'missing startRun pin') await harnesses.default.startRun(name, req.body, opts)
                                  else if (entry === 'missing background pin')
                                      await harnesses.default.startBackgroundRun(name, req.body, opts)
                                  else {
                                      const args = {
                                          name,
                                          chatId: name + '-chat',
                                          input: 'Report',
                                          componentNodes: app.nodesPool.componentNodes,
                                          flowOptions: { workspaceId: 'team-a', harnessCaller: caller }
                                      }
                                      if (entry === 'missing enqueue pin') queue.enqueueHarnessJob(args)
                                      else await engine.runHarness(args)
                                  }
                                  res.json({ erroneouslyAdmitted: true })
                              } catch (error) {
                                  next(error)
                              }
                          }
                        : controller.createRun
                )
                http.post('/api/v1/harnesses/:name/runs/async', controller.startBackgroundRun)
                if (entry.startsWith('prediction ')) {
                    const { authorizePrediction } = serverRequire('./src/utils/authorizeFlowAccess.ts')
                    http.post('/api/v1/prediction/:id', authorizePrediction, async (req, res, next) => {
                        try {
                            const caller = await serverRequire('./src/utils/flowHarnessCaller.ts').flowHarnessCaller(
                                serverRequire('./src/services/accessKeys/authorization.ts').accessContext(req)?.key.id,
                                'team-a',
                                serverRequire('./src/services/accessKeys/authorization.ts').accessContext(req)?.harnessIds
                            )
                            if (['after caller', 'before dispatch'].includes(stage)) await replace()
                            const Harness = serverRequire('../components/nodes/harness/Harness/Harness.ts').nodeClass
                            const node = new Harness()
                            const nodeData = { id: 'harness-card', inputs: { harnessName: name } }
                            const nodeOptions = {
                                ...(await harnesses.contextFor({ chatflowId: outerId, workspaceId: 'team-a' })).flowOptions,
                                chatId: name + '-chat',
                                harnessCaller: caller,
                                componentNodes: app.nodesPool.componentNodes
                            }
                            const outcome =
                                entry === 'prediction tool'
                                    ? await (await node.init(nodeData, 'Report', nodeOptions)).invoke('Report')
                                    : await node.run(nodeData, 'Report', nodeOptions)
                            res.json(outcome)
                        } catch (error) {
                            next(error)
                        }
                    })
                }
                http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
                const pending = request(http)
                    .post(
                        entry.startsWith('prediction ')
                            ? `/api/v1/prediction/${outerId}`
                            : entry === 'account report'
                            ? `/api/v1/dashflows/dashboard/accounts/${accountId}/report`
                            : `/api/v1/harnesses/${name}/runs${entry === 'async' ? '/async' : ''}`
                    )
                    .set('Authorization', 'Bearer ' + secret)
                    .set('Accept', entry === 'stream' ? 'text/event-stream' : 'application/json')
                    .send({ question: 'Report' })
                    .then((response) => {
                        settled.release(response)
                        return response
                    })
                const arrived = unchanged ? true : await Promise.race([ready.reached.then(() => true), settled.reached.then(() => false)])
                if (!arrived) {
                    const early = await settled.reached
                    assert.equal(early.status, 202, early.body.message)
                    assert.equal(
                        await Promise.race([ready.reached.then(() => true), background.reached.then(() => false)]),
                        true,
                        'runtime must reach race seam'
                    )
                }
                resume.release()
                const response = await pending
                if (backgroundEntry) await background.reached
                if (unchanged)
                    assert.ok(
                        fixture.executions.slice(before).some((call) => call.marker === A),
                        'authorized A executes'
                    )
                else assert.ok(entered)
                assert.ok(
                    [200, 202, 403, 409].includes(response.status) ||
                        ((entry.startsWith('prediction ') || entry.startsWith('missing')) &&
                            response.status === 500 &&
                            /changed after authorization|requires its authorized canvas id/.test(response.body.message)),
                    response.body.message
                )
                if (response.status === 409) assert.match(response.body.message, /changed after authorization/)
                const calls = fixture.executions.slice(before)
                if (stage === 'missing pin') {
                    assert.ok([403, 409, 500].includes(response.status))
                    assert.match(response.body.message, /authorized (Harness )?canvas id/)
                    assert.equal(calls.length, 0, 'missing pins refuse even unchanged A')
                }
                if (stage === 'lost queue pin')
                    assert.equal(calls.length, 0, 'a scoped job without an expected id refuses even unchanged A')
                assert.equal(calls.filter((call) => call.marker === B).length, 0, 'ungranted B tool must never execute')
                if (backgroundEntry && response.status === 202) {
                    const run = history.getRun(name, response.body.runId, { apiKeyId: key.id })
                    assert.ok(run, 'history belongs to the presenting principal')
                    assert.equal(history.getRun(name, response.body.runId, { apiKeyId: 'another-key' }), null)
                    assert.ok(calls.some((call) => call.marker === A) || ['failed', 'cancelled'].includes(run.status), JSON.stringify(run))
                }
            } finally {
                resume.release()
                report.reportAdmissionHooks.afterCaller = null
                harnesses.runAdmissionHooks.beforeDispatch = null
                queue.queueHooks.afterEnqueue = null
                queue.setWorkerContext(null)
                dashflows.runtime = oldRuntime
                setTeamPermissionLookup(null)
                runs.trackBackgroundRun = originalTrack
                gateway.stopGateway()
                await data.destroy()
            }
        })
    }

for (const writer of ['saveLegacyBoundFlow', 'saveFlowPreservingAccess']) {
    test(writer + ' cannot update another workspace through a primary-key collision', async () => {
        const data = await database()
        try {
            const other = await data.getRepository(ChatFlow).save({
                id: 'tenant-collision',
                workspaceId: 'team-b',
                name: 'Other team',
                type: 'CHATFLOW',
                flowData: '{}',
                apiAccessMode: 'private'
            })
            const before = await data.getRepository(ChatFlow).findOneByOrFail({ id: other.id })
            const attempted = { ...before, workspaceId: 'team-a', name: 'Overwritten' }
            const writers = serverRequire('./src/services/accessKeys/legacyBinding.ts')
            await assert.rejects(writers[writer](data, attempted, writer === 'saveFlowPreservingAccess' ? attempted : undefined), {
                statusCode: 409
            })
            assert.deepEqual(await data.getRepository(ChatFlow).findOneByOrFail({ id: other.id }), before)
        } finally {
            await data.destroy()
        }
    })
}

test('SQLite invitationOnly removal uses the production BEGIN IMMEDIATE adapter before any policy reads', async () => {
    const { sqlFromDataSource, deleteOrganizationUser } = serverRequire('./src/identity/directory.ts')
    const data = await database()
    const commands = []
    const original = data.createQueryRunner.bind(data)
    data.createQueryRunner = (...args) => {
        const runner = original(...args)
        const query = runner.query.bind(runner)
        runner.query = (sql, ...params) => {
            commands.push(sql)
            return query(sql, ...params)
        }
        return runner
    }
    try {
        await assert.rejects(
            deleteOrganizationUser(
                sqlFromDataSource(data),
                { id: 'owner', organizationId: 'org-a', workspaceId: 'team-a', permissions: [] },
                'org-a',
                'pending',
                { invitationOnly: true }
            )
        )
        assert.equal(commands[0], 'BEGIN IMMEDIATE')
        assert.ok(commands.at(-1).includes('ROLLBACK'))
        assert.equal(commands.filter((sql) => sql === 'BEGIN IMMEDIATE').length, 1)
    } finally {
        await data.destroy()
    }
})

for (const [operation, change] of [
    ...['rotate', 'update', 'revoke', 'credential revoke'].flatMap((operation) =>
        ['policy and grants', 'grants only'].map((change) => [operation, change])
    ),
    ['rotate', 'actor permission']
]) {
    test('management ' + operation + ' rechecks ' + change + ' between snapshot and writer lock', async () => {
        const data = await database()
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        const management = serverRequire('./src/services/accessKeys/management.ts')
        const ready = latch(),
            resume = latch()
        try {
            const flow = await data
                .getRepository(ChatFlow)
                .save({ id: 'manageable', workspaceId: 'team-a', name: 'Fixture', type: 'CHATFLOW', flowData: '{}' })
            const key = await data.getRepository(ApiKey).save({
                id: 'managed-key',
                apiKey: '',
                apiSecret: '',
                keyName: 'Manage',
                workspaceId: 'team-a',
                permissions: ['chatflows:view'],
                accessPolicy: parsePolicy({ scopes: ['predict'] }),
                harnesses: []
            })
            await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'CHATFLOW', resourceId: flow.id })
            const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
            const minted = await data.transaction((manager) => mintCredential(manager, key))
            let actorPermissions = ['chatflows:view', 'apikeys:update', 'apikeys:delete']
            setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: actorPermissions }) })
            management.lifecycleHooks.beforeLock = async () => {
                ready.release()
                await resume.reached
            }
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            http.use(express.json())
            http.use((req, _res, next) => {
                req.user = { id: 'actor', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'] }
                next()
            })
            http.post('/keys/:id/rotate', management.rotateAccessKey)
            http.put('/keys/:id', management.updateAccessKey)
            http.delete('/keys/:id', management.revokeAccessKey)
            http.post('/keys/:id/credentials/:credentialId/revoke', management.revokeAccessCredential)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const req =
                operation === 'rotate'
                    ? request(http).post('/keys/managed-key/rotate').send({ graceSeconds: 0 })
                    : operation === 'update'
                    ? request(http)
                          .put('/keys/managed-key')
                          .send({
                              keyName: 'Changed',
                              permissions: ['chatflows:view'],
                              accessPolicy: { scopes: ['predict'] },
                              resources: [{ resourceType: 'CHATFLOW', resourceId: flow.id }],
                              expiresAt: null
                          })
                    : operation === 'revoke'
                    ? request(http).delete('/keys/managed-key')
                    : request(http).post('/keys/managed-key/credentials/' + minted.credential.id + '/revoke')
            const pending = req.then((response) => response)
            await ready.reached
            // Commit the competing administrator change while the request waits at the actual mutation boundary.
            if (change === 'policy and grants')
                await data
                    .getRepository(ApiKey)
                    .update({ id: key.id }, { accessPolicy: parsePolicy({ scopes: ['predict'], allResources: true }) })
            if (change !== 'actor permission')
                await data.getRepository(ApiKeyResource).save({ principalId: key.id, resourceType: 'AGENTFLOW', resourceId: 'admin-added' })
            else actorPermissions = ['apikeys:update', 'apikeys:delete']
            const beforeKey = await data.getRepository(ApiKey).findOneByOrFail({ id: key.id })
            const beforeGrants = await data.getRepository(ApiKeyResource).findBy({ principalId: key.id })
            const beforeCredentials = await data.getRepository(ApiKeyCredential).findBy({ principalId: key.id })
            resume.release()
            const response = await pending
            assert.equal(response.status, change === 'actor permission' ? 403 : 409, response.body.message)
            assert.deepEqual(await data.getRepository(ApiKey).findOneByOrFail({ id: key.id }), beforeKey)
            assert.deepEqual(await data.getRepository(ApiKeyResource).findBy({ principalId: key.id }), beforeGrants)
            assert.deepEqual(await data.getRepository(ApiKeyCredential).findBy({ principalId: key.id }), beforeCredentials)
        } finally {
            resume.release()
            management.lifecycleHooks.beforeLock = null
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })
}

test('SQLite quota refuses open primary transactions, retains committed charges, and copies sibling lock settings', async () => {
    const { consume, clearMinuteBuckets } = serverRequire('./src/services/accessKeys/limiter.ts')
    clearMinuteBuckets()
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'quota.sqlite'),
        entities: [ApiKeyUsage],
        synchronize: true,
        busyTimeout: 2345,
        enableWAL: true
    })
    await data.initialize()
    const key = { id: 'quota-fixture', accessPolicy: parsePolicy({ daily: 2, monthly: 2, rpm: 0 }) }
    const initialized = []
    const originalInitialize = DataSource.prototype.initialize
    DataSource.prototype.initialize = function () {
        initialized.push(this.options)
        return originalInitialize.call(this)
    }
    try {
        // Both a read transaction and one holding SQLite's writer reservation fail immediately at the guard.
        for (const write of [false, true]) {
            await assert.rejects(
                data.transaction(async (manager) => {
                    await manager.query('SELECT * FROM apikey_usage')
                    if (write) await manager.query('DELETE FROM apikey_usage')
                    await assert.rejects(consume(data, key, 'predict'), {
                        statusCode: 503,
                        message: 'Access key quota admission cannot run inside a primary SQLite transaction.'
                    })
                    throw new Error('fixture rollback')
                }),
                /fixture rollback/
            )
            assert.equal(await data.getRepository(ApiKeyUsage).count(), 0)
        }
        await consume(data, key, 'predict')
        const sibling = initialized.find((options) => options.database === data.options.database)
        assert.equal(sibling.busyTimeout, 2345)
        assert.equal(sibling.enableWAL, true)
        await assert.rejects(
            data.transaction(async (manager) => {
                await manager.query('DELETE FROM apikey_usage')
                throw new Error('fixture rollback')
            }),
            /fixture rollback/
        )
        assert.ok((await data.getRepository(ApiKeyUsage).find()).every((row) => row.accepted === 1))
        await consume(data, key, 'predict')
        await assert.rejects(consume(data, key, 'predict'), { statusCode: 429 })
    } finally {
        DataSource.prototype.initialize = originalInitialize
        await data.destroy()
    }
})

test('updateChatflow preserves a legacy Harness name grant using the pre-write name across type change and rename', async () => {
    const data = await database()
    try {
        const initial = await legacyFlow(data)
        await data.getRepository(ChatFlow).update({ id: initial.id }, { type: 'HARNESS', name: 'named-independent' })
        await data.getRepository(ApiKeyResource).delete({ principalId: 'legacy-key', resourceId: initial.id })
        await data.getRepository(ApiKeyResource).save({ principalId: 'legacy-key', resourceType: 'HARNESS', resourceId: initial.id })
        let flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        await update(flow, { type: 'CHATFLOW', name: 'renamed' })
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: initial.id }), true)
        flow = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        await update(flow, { apikeyid: null })
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'HARNESS', resourceId: initial.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: initial.id }), false)
    } finally {
        await data.destroy()
    }
})

test('a compensating flow save restores the legacy grant type with the row after a real updateChatflow', async () => {
    const data = await database()
    try {
        const initial = await legacyFlow(data)
        await update({ ...initial }, { type: 'AGENTFLOW' })
        const current = await data.getRepository(ChatFlow).findOneByOrFail({ id: initial.id })
        const { saveFlowPreservingAccess } = serverRequire('./src/services/accessKeys/legacyBinding.ts')
        await saveFlowPreservingAccess(data, initial, current)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'CHATFLOW', resourceId: initial.id }), true)
        assert.equal(await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: initial.id }), false)
    } finally {
        await data.destroy()
    }
})

// A request may hold an ordinary-save snapshot while a second request commits a type change.
test('updateChatflow stale ordinary save cannot strand a derived grant after conversion and unbind', async () => {
    const data = await database()
    try {
        const stale = await legacyFlow(data)
        await update({ ...stale }, { type: 'AGENTFLOW' })
        let conflict
        try {
            await update({ ...stale }, { category: 'Saved from stale tab' })
        } catch (error) {
            conflict = error
        }
        if (conflict) assert.equal(conflict.statusCode, 409)
        let current = await data.getRepository(ChatFlow).findOneByOrFail({ id: stale.id })
        const family = current.type === 'AGENTFLOW' ? 'AGENTFLOW' : 'CHATFLOW'
        assert.equal(
            await hasGrant(data, { id: 'legacy-key' }, { resourceType: family, resourceId: stale.id }),
            true,
            'committed row and derived grant agree even after an ordinary stale save'
        )
        await update({ ...current }, { apikeyid: null })
        current = await data.getRepository(ChatFlow).findOneByOrFail({ id: stale.id })
        if (current.type !== 'AGENTFLOW') await update({ ...current }, { type: 'AGENTFLOW' })
        assert.equal(
            await hasGrant(data, { id: 'legacy-key' }, { resourceType: 'AGENTFLOW', resourceId: stale.id }),
            false,
            'unbind and reconversion cannot reuse a stranded grant'
        )
    } finally {
        await data.destroy()
    }
})

for (const method of ['put', 'delete']) {
    test('real apikey router refuses missing management id before any principal mutation: ' + method, async () => {
        const data = await database()
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        try {
            await legacyFlow(data)
            const before = await data.getRepository(ApiKey).find()
            const grants = await data.getRepository(ApiKeyResource).find()
            setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            http.use(express.json())
            http.use((req, _res, next) => {
                req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
                next()
            })
            http.use('/api/v1/apikey', serverRequire('./src/routes/apikey/index.ts').default)
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            const response = await request(http)
                [method]('/api/v1/apikey')
                .set('x-request-from', 'internal')
                .send({
                    keyName: 'Unintended replacement',
                    permissions: [],
                    accessPolicy: { scopes: [] },
                    resources: [],
                    expiresAt: null
                })
            assert.equal(response.status, 412, response.body.message)
            assert.deepEqual(await data.getRepository(ApiKey).find(), before)
            assert.deepEqual(await data.getRepository(ApiKeyResource).find(), grants)
        } finally {
            setTeamPermissionLookup(null)
            await data.destroy()
        }
    })
}

for (const entry of ['anonymous private', 'uppercase uuid', 'anonymous public']) {
    test('real preflight refuses unauthorized flow before parser: ' + entry, async () => {
        const data = await database()
        try {
            const { User, Workspace, Organization } = entities
            await data.getRepository(User).save({
                id: 'fixture',
                name: 'Fixture',
                email: 'preflight@example.invalid',
                status: 'active',
                createdBy: 'fixture',
                updatedBy: 'fixture'
            })
            await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
            await data
                .getRepository(Workspace)
                .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
            const flow = await data.getRepository(ChatFlow).save({
                id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                name: 'Private',
                workspaceId: 'team-a',
                type: 'CHATFLOW',
                flowData: '{}',
                apiAccessMode: entry === 'anonymous public' ? 'public' : 'private'
            })
            const key = await data.getRepository(ApiKey).save({
                id: 'preflight-key',
                apiKey: '',
                apiSecret: '',
                keyName: 'Fixture',
                workspaceId: 'team-a',
                permissions: ['chatflows:view'],
                accessPolicy: parsePolicy({ scopes: ['predict', 'upload'], rpm: 0 }),
                harnesses: []
            })
            const { mintCredential } = serverRequire('./src/services/accessKeys/credentials.ts')
            const { secret } = await data.transaction((manager) => mintCredential(manager, key))
            const express = serverRequire('express'),
                request = serverRequire('supertest')
            const http = express()
            let parsed = 0
            http.use(serverRequire('./src/services/accessKeys/preflight.ts').accessKeyPreflight)
            http.use((_req, _res, next) => {
                parsed++
                next()
            })
            http.use(express.json())
            http.post('/api/v1/prediction/:id', (_req, res) => res.json({ parsed: true }))
            http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
            let req = request(http).post('/api/v1/prediction/' + (entry === 'uppercase uuid' ? flow.id.toUpperCase() : flow.id))
            if (entry === 'uppercase uuid') req = req.set('Authorization', 'Bearer ' + secret)
            const response = await req.send({ question: 'Fixture' })
            assert.equal(
                response.status,
                entry === 'anonymous public' ? 200 : entry === 'anonymous private' ? 401 : 403,
                response.body.message
            )
            assert.equal(parsed, entry === 'anonymous public' ? 1 : 0, 'admission precedes body parser')
        } finally {
            await data.destroy()
        }
    })
}

test('real scoped metadata writer cannot rename a canvas converted to Harness after its read', async () => {
    const data = await database()
    try {
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        await data.getRepository(ChatFlow).save({ id, name: 'Original', workspaceId: 'team-a', type: 'CHATFLOW', flowData: '{}' })
        const key = await data.getRepository(ApiKey).save({
            id: 'metadata-key',
            keyName: 'Fixture',
            apiKey: '',
            apiSecret: '',
            workspaceId: 'team-a',
            permissions: ['chatflows:update'],
            accessPolicy: parsePolicy({ scopes: ['api:write'] }),
            harnesses: []
        })
        const repo = data.getRepository(ChatFlow),
            read = repo.findOneBy.bind(repo)
        let crossed = false
        repo.findOneBy = async (...args) => {
            const row = await read(...args)
            if (!crossed && row) {
                crossed = true
                await repo.update({ id }, { type: 'HARNESS' })
            }
            return row
        }
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            serverRequire('./src/services/accessKeys/authorization.ts').setAccessContext(req, key)
            next()
        })
        http.put('/api/v1/chatflows/:id', serverRequire('./src/services/accessKeys/managementBoundary.ts').scopedFlowMetadataUpdate)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const response = await request(http)
            .put('/api/v1/chatflows/' + id)
            .send({ name: 'Key rename' })
        assert.equal(response.status, 409, response.body.message)
        assert.equal((await read({ id })).name, 'Original')
    } finally {
        await data.destroy()
    }
})

test('real create handler rechecks resource authority after waiting for writer mutex', async () => {
    const data = await database()
    const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
    const ready = latch(),
        resume = latch()
    try {
        const { Workspace, Organization, User } = entities
        await data.getRepository(User).save({
            id: 'fixture',
            name: 'Fixture',
            email: 'create@example.invalid',
            status: 'active',
            createdBy: 'fixture',
            updatedBy: 'fixture'
        })
        await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team-a', organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
        await data
            .getRepository(ChatFlow)
            .save({ id: 'grant-target', name: 'Original', workspaceId: 'team-a', type: 'CHATFLOW', flowData: '{}' })
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
        // Pause the final pre-lock workspace read, after policyInput has accepted the resource.
        const repo = data.getRepository(Workspace),
            read = repo.findOneBy.bind(repo)
        repo.findOneBy = async (...args) => {
            const row = await read(...args)
            ready.release()
            await resume.reached
            return row
        }
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
            next()
        })
        http.post('/api/v1/apikey', serverRequire('./src/services/accessKeys/management.ts').createAccessKey)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const pending = request(http)
            .post('/api/v1/apikey')
            .send({
                keyName: 'New',
                permissions: ['chatflows:view'],
                accessPolicy: { scopes: ['predict'] },
                resources: [{ resourceType: 'CHATFLOW', resourceId: 'grant-target' }],
                expiresAt: null
            })
            .then((r) => r)
        await ready.reached
        await data.getRepository(ChatFlow).update({ id: 'grant-target' }, { workspaceId: 'team-b' })
        resume.release()
        const response = await pending
        assert.equal(response.status, 403, response.body.message)
        assert.equal(await data.getRepository(ApiKey).count(), 0)
        assert.equal(await data.getRepository(ApiKeyCredential).count(), 0)
        assert.equal(await data.getRepository(ApiKeyResource).count(), 0)
    } finally {
        resume.release()
        setTeamPermissionLookup(null)
        await data.destroy()
    }
})

test('real management create rejects an invalid environment before minting or retiring credentials', async () => {
    const data = await database()
    try {
        const express = serverRequire('express'),
            request = serverRequire('supertest'),
            http = express()
        http.use(express.json())
        http.use((req, _res, next) => {
            req.user = { id: 'owner', activeWorkspaceId: 'team-a', permissions: [] }
            next()
        })
        http.post('/api/v1/apikey', serverRequire('./src/services/accessKeys/management.ts').createAccessKey)
        http.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }))
        const response = await request(http)
            .post('/api/v1/apikey')
            .send({ keyName: 'Invalid', permissions: [], resources: [], accessPolicy: { scopes: [], environment: 'prod' } })
        assert.equal(response.status, 400)
        assert.equal(await data.getRepository(ApiKey).count(), 0)
        assert.equal(await data.getRepository(ApiKeyCredential).count(), 0)
    } finally {
        await data.destroy()
    }
})

test('real updateChatflow commits a mode-only change and permits an unchanged ordinary save', async () => {
    const data = await database()
    try {
        const flow = await data.getRepository(ChatFlow).save({
            id: 'mode-control',
            name: 'Mode',
            workspaceId: 'team-a',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}',
            apiAccessMode: 'public'
        })
        await update({ ...flow }, { apiAccessMode: 'private' })
        const saved = await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })
        assert.equal(saved.apiAccessMode, 'private')
        await update({ ...saved }, { apiAccessMode: 'private' })
        assert.equal((await data.getRepository(ChatFlow).findOneByOrFail({ id: flow.id })).apiAccessMode, 'private')
    } finally {
        await data.destroy()
    }
})
