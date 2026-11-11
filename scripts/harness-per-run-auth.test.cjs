// Real gateway and Chatflow Tool calls use the server's current nested-target authorization and SQLite grants.
process.env.INBOUND_ACCESS_V2 = 'on'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-per-chat-auth-'))
process.env.LOG_PATH = path.join(fixtureRoot, 'logs')
process.env.BLOB_STORAGE_PATH = path.join(fixtureRoot, 'blobs')
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
const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
const { authorizeNestedFlowCaller } = serverRequire('./src/utils/nestedFlowCall.ts')
const { nodeClass: ChatflowTool } = require('../packages/components/nodes/tools/ChatflowTool/ChatflowTool.ts')
const appModule = serverRequire('./src/utils/getRunningExpressApp.ts')

test('concurrent Harness chats use their own principals through the actual nested-target gate', async (t) => {
    const root = fixtureRoot
    const encryptionKey = crypto.randomBytes(32).toString('base64url')
    fs.writeFileSync(path.join(root, 'encryption.key'), encryptionKey, { mode: 0o600 })
    process.env.SECRETKEY_PATH = root
    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_HERMES_HOME = path.join(root, 'runtime')
    const gatewayModule = await import('../packages/harness/gateway.mjs')
    const { saveHarness } = await import('../packages/harness/store.mjs')
    const { closeQueueDb } = await import('../packages/harness/lock.mjs')
    const { enqueueHarnessJob, claimJob, finishJob } = await import('../packages/harness/queue.mjs')
    const { noteLiveTry, endLiveTry } = await import('../packages/harness/try-live.mjs')
    const { ApiKey, ApiKeyResource, ChatFlow, Credential, Organization, Workspace, User } = entities
    const data = new DataSource({ type: 'sqlite', database: ':memory:', entities: Object.values(entities), synchronize: true })
    await data.initialize()
    appModule.getRunningExpressApp = () => ({ AppDataSource: data })
    const ids = {
        private: '22222222-2222-4222-8222-222222222222',
        public: '33333333-3333-4333-8333-333333333333',
        other: '44444444-4444-4444-8444-444444444444',
        harness: '11111111-1111-4111-8111-111111111111'
    }
    await data.getRepository(User).save({
        id: 'fixture',
        name: 'Fixture',
        email: 'per-chat@example.invalid',
        status: 'active',
        createdBy: 'fixture',
        updatedBy: 'fixture'
    })
    await data.getRepository(Organization).save({ id: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
    for (const id of ['team-a', 'team-b'])
        await data
            .getRepository(Workspace)
            .save({ id, organizationId: 'org-a', name: 'Fixture', createdBy: 'fixture', updatedBy: 'fixture' })
    for (const kind of ['private', 'public', 'other'])
        await data.getRepository(ChatFlow).save({
            id: ids[kind],
            name: kind,
            workspaceId: kind === 'other' ? 'team-b' : 'team-a',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}',
            apiAccessMode: kind === 'public' ? 'public' : 'private'
        })
    for (const id of ['key-a', 'key-b']) {
        await data.getRepository(ApiKey).save({
            id,
            apiKey: '',
            apiSecret: '',
            keyName: 'Fixture',
            workspaceId: 'team-a',
            permissions: ['chatflows:view'],
            accessPolicy: parsePolicy({ scopes: ['predict', 'harness:run'] })
        })
        await data.getRepository(ApiKeyResource).save({ principalId: id, resourceType: 'HARNESS', resourceId: ids.harness })
    }
    await data.getRepository(ApiKeyResource).save({ principalId: 'key-a', resourceType: 'CHATFLOW', resourceId: ids.private })
    const componentRequire = createRequire(path.join(__dirname, '../packages/components/package.json'))
    const { AES } = componentRequire('crypto-js')
    await data.getRepository(Credential).save({
        id: 'fixture-card',
        name: 'Fixture',
        credentialName: 'chatflowApi',
        workspaceId: 'team-a',
        encryptedData: AES.encrypt(JSON.stringify({ chatflowApiKey: 'fixture-card-value' }), encryptionKey).toString()
    })
    let httpFallbacks = 0
    const fallbackServer = http.createServer((_req, res) => {
        httpFallbacks += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: 'card fallback' }))
    })
    await new Promise((resolve) => fallbackServer.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${fallbackServer.address().port}`
    const selected = []
    const runner = (caller, depth) => async (request) => {
        const target = await data.getRepository(ChatFlow).findOneByOrFail({ id: request.targetFlowId })
        await authorizeNestedFlowCaller(caller, 'team-a', target)
        selected.push({ caller, depth, target: target.id })
        return { text: `${caller.apiKeyId || caller.via}:${depth}:${target.name}` }
    }
    const previous = gatewayModule.setGatewayContext(async (record, nested) => ({
        flowOptions: {
            workspaceId: record.workspaceId,
            appDataSource: data,
            databaseEntities: entities,
            baseURL,
            ...(nested.nestedFlowCaller ? { runNestedFlow: runner(nested.nestedFlowCaller, nested.nestedFlowDepth) } : {})
        },
        loadNode: async () => ChatflowTool
    }))
    const record = saveHarness({
        name: 'shared-team',
        workspaceId: 'team-a',
        chatflowId: ids.harness,
        chief: { model: { nodeName: 'unused' } },
        specialists: [
            {
                name: 'worker',
                modules: ['private', 'public', 'other'].map((kind) => ({
                    nodeId: kind,
                    nodeName: 'ChatflowTool',
                    credential: 'fixture-card',
                    inputs: { selectedChatflow: ids[kind], name: `${kind}_tool`, description: kind }
                }))
            }
        ]
    })
    const gateway = await gatewayModule.startGateway({ port: 0 })
    const token = crypto.randomBytes(32).toString('base64url')
    const profileName = `${record.name}--worker`
    gatewayModule.registerProfileToken({
        token,
        harnessName: record.name,
        specialistName: 'worker',
        profileName,
        modelKey: 'fixture-model'
    })
    const bindings = []
    const note = (chatId, caller, depth = 0) => {
        const harnessCaller = caller.via === 'api_key' ? { ...caller, harnesses: [record.name] } : caller
        const options = {
            workspaceId: 'team-a',
            harnessCaller,
            nestedFlowCaller: caller,
            nestedFlowDepth: depth,
            runNestedFlow: runner(caller, depth)
        }
        const binding = gatewayModule.noteCallerFlowOptions(record.name, options, chatId)
        bindings.push(binding)
        return options
    }
    const request = async (name, chatId, options = {}) => {
        const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${options.token || token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                ...(chatId === undefined ? {} : { scope: `${options.profileName || profileName}:${chatId}#turn-one` }),
                arguments: { input: 'hello' }
            })
        })
        return { status: response.status, body: await response.json() }
    }
    try {
        note('a', { via: 'api_key', apiKeyId: 'key-a' })
        note('b', { via: 'api_key', apiKeyId: 'key-b' })
        await t.test('two keys keep their own target grants during overlap', async () => {
            const [a, b] = await Promise.all([request('private_tool', 'a'), request('private_tool', 'b')])
            assert.equal(a.status, 200, JSON.stringify(a.body))
            assert.equal(a.body.result, 'key-a:0:private')
            assert.equal(b.status, 403, JSON.stringify(b.body))
            assert.match(b.body.error.message, /resource grant/)
        })
        await t.test('a session Try-it does not lend authority to an external key', async () => {
            note('try-chat', { via: 'session' })
            const tryName = 'tryabcdef1234567890'
            const tryDir = path.join(root, 'runtime', 'profiles', tryName)
            fs.mkdirSync(tryDir, { recursive: true })
            fs.writeFileSync(path.join(tryDir, 'harness-try'), tryName)
            fs.writeFileSync(path.join(tryDir, 'harness-roster.json'), JSON.stringify(record))
            noteLiveTry(tryName)
            const tryToken = crypto.randomBytes(32).toString('base64url')
            const tryProfileName = `${tryName}--worker`
            gatewayModule.registerProfileToken({
                token: tryToken,
                harnessName: tryName,
                specialistName: 'worker',
                profileName: tryProfileName,
                tryProfile: true,
                modelKey: 'fixture-model'
            })
            try {
                const [session, key] = await Promise.all([
                    request('private_tool', 'try-chat', { token: tryToken, profileName: tryProfileName }),
                    request('private_tool', 'b')
                ])
                assert.equal(session.status, 200, JSON.stringify(session.body))
                assert.equal(session.body.result, 'session:0:private')
                assert.equal(key.status, 403, JSON.stringify(key.body))
            } finally {
                gatewayModule.forgetProfileToken(tryToken)
                endLiveTry(tryName)
            }
        })
        await t.test('the same caller succeeds at depths zero and one', async () => {
            note('a-deep', { via: 'api_key', apiKeyId: 'key-a' }, 1)
            const [a, deep] = await Promise.all([request('private_tool', 'a'), request('private_tool', 'a-deep')])
            assert.equal(a.status, 200, JSON.stringify(a.body))
            assert.equal(deep.status, 200, JSON.stringify(deep.body))
            assert.equal(deep.body.result, 'key-a:1:private')
        })
        await t.test('public unbound targets remain available during overlap', async () => {
            note('public-chat', { via: 'flow' })
            const result = await request('public_tool', 'public-chat')
            assert.equal(result.status, 200, JSON.stringify(result.body))
            assert.equal(result.body.result, 'flow:0:public')
        })
        await t.test('a new principal cannot reuse an active chat', async () => {
            assert.throws(
                () =>
                    gatewayModule.noteCallerFlowOptions(
                        record.name,
                        { workspaceId: 'team-a', harnessCaller: { via: 'session' }, nestedFlowCaller: { via: 'session' } },
                        'b'
                    ),
                (error) => error.code === 'caller_collision'
            )
            assert.equal((await request('private_tool', 'b')).status, 403)
            assert.equal((await request('private_tool', 'a')).status, 200)
        })
        await t.test('missing and unknown scope cannot reach a target or use card HTTP', async () => {
            const count = selected.length
            for (const scope of [undefined, 'unknown-chat']) {
                const result = await request('private_tool', scope)
                assert.notEqual(result.status, 200)
                assert.equal(result.body.error.type, 'caller_required')
            }
            assert.equal(selected.length, count)
            assert.equal(httpFallbacks, 0)
        })
        await t.test('an external queued job rebuilds only its own chat principal', async () => {
            const jobs = ['key-a', 'key-b'].map((apiKeyId, index) =>
                enqueueHarnessJob({
                    name: record.name,
                    chatId: `queued-${index}`,
                    input: 'hello',
                    flowOptions: {
                        workspaceId: 'team-a',
                        harnessCaller: { via: 'api_key', apiKeyId, harnesses: [record.name] },
                        nestedFlowCaller: { via: 'api_key', apiKeyId },
                        nestedFlowDepth: 2
                    }
                })
            )
            try {
                assert.ok(claimJob())
                assert.ok(claimJob())
                const [a, b] = await Promise.all([request('private_tool', 'queued-0'), request('private_tool', 'queued-1')])
                assert.equal(a.status, 200, JSON.stringify(a.body))
                assert.equal(a.body.result, 'key-a:2:private')
                assert.equal(b.status, 403, JSON.stringify(b.body))
            } finally {
                for (const job of jobs) finishJob(job.id, { status: 'succeeded', result: {} })
            }
        })
        await t.test('a session still cannot call a target in another workspace', async () => {
            const result = await request('other_tool', 'try-chat')
            assert.equal(result.status, 403, JSON.stringify(result.body))
            assert.match(result.body.error.message, /parent workspace/)
        })
        await t.test('a remote Base URL keeps HTTP and the card credential', async () => {
            const previousLocalhost = process.env.HTTP_ALLOW_LOCALHOST
            process.env.HTTP_ALLOW_LOCALHOST = 'true'
            const received = []
            const remote = http.createServer((req, res) => {
                const chunks = []
                req.on('data', (chunk) => chunks.push(chunk))
                req.on('end', () => {
                    received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) })
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ text: 'remote result' }))
                })
            })
            await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
            const before = selected.length
            try {
                const tool = await new ChatflowTool().init(
                    {
                        credential: 'fixture-card',
                        inputs: {
                            selectedChatflow: ids.private,
                            name: 'remote_tool',
                            description: 'Remote',
                            baseURL: `http://127.0.0.1:${remote.address().port}`
                        }
                    },
                    'hello',
                    {
                        appDataSource: data,
                        databaseEntities: entities,
                        workspaceId: 'team-a',
                        baseURL,
                        runNestedFlow: runner({ via: 'api_key', apiKeyId: 'key-b' }, 0)
                    }
                )
                assert.equal(await tool.invoke({ input: 'remote question' }), 'remote result')
                assert.equal(received.length, 1)
                assert.equal(received[0].authorization, 'Bearer fixture-card-value')
                assert.equal(received[0].url, `/api/v1/prediction/${ids.private}`)
                assert.equal(received[0].body.question, 'remote question')
                assert.equal(selected.length, before)
            } finally {
                if (previousLocalhost === undefined) delete process.env.HTTP_ALLOW_LOCALHOST
                else process.env.HTTP_ALLOW_LOCALHOST = previousLocalhost
                await new Promise((resolve) => remote.close(resolve))
            }
        })
        assert.equal(httpFallbacks, 0)
    } finally {
        for (const binding of bindings) gatewayModule.clearCallerWorkspace(record.name, binding)
        gatewayModule.forgetProfileToken(token)
        gatewayModule.setGatewayContext(previous)
        closeQueueDb()
        await gateway.close()
        await new Promise((resolve) => fallbackServer.close(resolve))
        await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
