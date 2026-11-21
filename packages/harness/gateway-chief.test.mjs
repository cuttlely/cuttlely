import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-chief-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { saveHarness } = await import('./store.mjs')
const { compileProfile, compileTryProfile, readProfileEnv, discardTryProfile } = await import('./profile.mjs')
const { bootHarnessGateway, forgetProfileToken, profileTokenKnown, setGatewayContext, startGateway } = await import('./gateway.mjs')
const { closeQueueDb } = await import('./lock.mjs')
after(() => {
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

const model = (nodeName, modelName) => ({ nodeName, inputs: { modelName } })

test('chief bindings, fallbacks and boot tokens use the gateway without exposing the tool bridge', async () => {
    const gateway = await startGateway({ port: 0 })
    process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
    const calls = []
    const lines = []
    const originalInfo = console.info
    const previous = setGatewayContext(async () => ({
        componentNodes: {},
        flowOptions: {},
        loadNode: async (nodeName) =>
            class {
                async init(data) {
                    return {
                        async invoke() {
                            calls.push({ provider: nodeName, model: data.inputs.modelName })
                            if (nodeName === 'unavailableChat') throw new Error('503 unavailable')
                            return { content: `Answer from ${data.inputs.modelName}` }
                        }
                    }
                }
            }
    }))
    console.info = (line) => lines.push(String(line))
    const request = (token, route, body) =>
        fetch(`http://127.0.0.1:${gateway.port}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body)
        })
    try {
        for (const mixed of [false, true]) {
            const name = mixed ? 'chief-mixed' : 'chief-uniform'
            const record = saveHarness({
                name,
                chief: { model: model('chiefChat', 'chief-model') },
                specialists: [
                    { name: 'reader', model: model('workerChat', 'worker-model') },
                    { name: 'writer', model: model('workerChat', mixed ? 'other-model' : 'worker-model') }
                ]
            })
            const compiled = compileProfile(record)
            const env = readProfileEnv(name)
            assert.equal(env.CUTTLELY_GATEWAY_ROLE, 'chief')
            assert.equal(env.OPENAI_BASE_URL, `http://127.0.0.1:${gateway.port}/v1`)
            assert.equal(env.CUTTLELY_GATEWAY_CREATED, record.createdAt)
            assert.match(env.OPENAI_API_KEY, /^[A-Za-z0-9_-]{43}$/)
            for (const profile of [name, ...compiled.roster.specialists.map((item) => item.profileName)]) {
                const yaml = fs.readFileSync(path.join(dir, 'runtime', 'profiles', profile, 'config.yaml'), 'utf8')
                assert.ok(yaml.includes(`base_url: ${JSON.stringify(env.OPENAI_BASE_URL)}`), profile)
            }
            compileProfile(record)
            assert.equal(readProfileEnv(name).OPENAI_API_KEY, env.OPENAI_API_KEY, 'same record reuses its chief token')
            forgetProfileToken(env.OPENAI_API_KEY)
            assert.equal(profileTokenKnown(env.OPENAI_API_KEY), false)
            bootHarnessGateway()
            assert.equal(profileTokenKnown(env.OPENAI_API_KEY), true, 'chief token ingested without specialist name')
            const response = await request(env.OPENAI_API_KEY, '/v1/chat/completions', {
                model: 'bogus-body-model',
                messages: [{ role: 'user', content: 'Hello' }]
            })
            const payload = await response.json()
            assert.equal(response.status, 200, JSON.stringify(payload))
            assert.equal(payload.choices[0].message.content, 'Answer from chief-model')
            assert.deepEqual(calls.at(-1), { provider: 'chiefChat', model: 'chief-model' })
            for (const route of ['/harness/tools/list', '/harness/tools/call']) {
                const refused = await request(env.OPENAI_API_KEY, route, { name: 'anything' })
                assert.equal(refused.status, 403, route)
                await refused.json()
            }
            const workerName = compiled.roster.specialists[0].profileName
            const workerEnv = readProfileEnv(workerName)
            const workerEnvFile = path.join(dir, 'runtime', 'profiles', workerName, '.env')
            fs.writeFileSync(workerEnvFile, fs.readFileSync(workerEnvFile, 'utf8').replace(/^CUTTLELY_GATEWAY_ROLE=.*\n/m, ''))
            forgetProfileToken(workerEnv.OPENAI_API_KEY)
            bootHarnessGateway()
            const oldWorker = await request(workerEnv.OPENAI_API_KEY, '/harness/tools/list', {})
            assert.equal(oldWorker.status, 200, 'specialist profiles without a role remain valid at boot')
            await oldWorker.json()
            compileProfile(record)
            assert.equal(readProfileEnv(workerName).OPENAI_API_KEY, workerEnv.OPENAI_API_KEY, 'legacy specialist token is reused')
            const expected = `[harness-gateway] completion role=chief harness=${name} profile=${name} provider=chiefChat model=chief-model`
            assert.ok(lines.includes(expected))
            assert.ok(lines.every((line) => !line.includes(env.OPENAI_API_KEY)))
        }
        const fallback = saveHarness({
            name: 'chief-fallback',
            chief: { model: model('unavailableChat', 'primary-model'), fallbackModel: model('backupChat', 'backup-model') },
            specialists: [{ name: 'reader', model: model('workerChat', 'worker-model'), fallbackModel: model('wrongChat', 'wrong-model') }]
        })
        compileProfile(fallback)
        const response = await request(readProfileEnv(fallback.name).OPENAI_API_KEY, '/v1/chat/completions', {
            model: 'another-bogus-model',
            messages: [{ role: 'user', content: 'Hello' }]
        })
        const payload = await response.json()
        assert.equal(response.status, 200, JSON.stringify(payload))
        assert.equal(payload.choices[0].message.content, 'Answer from backup-model')
        assert.deepEqual(calls.slice(-2), [
            { provider: 'unavailableChat', model: 'primary-model' },
            { provider: 'backupChat', model: 'backup-model' }
        ])
        assert.ok(
            lines.includes(
                '[harness-gateway] completion role=chief harness=chief-fallback profile=chief-fallback provider=backupChat model=backup-model'
            )
        )
        const tried = compileTryProfile(fallback, '1234abcd')
        const tryEnv = readProfileEnv('try1234abcd')
        assert.equal(tryEnv.CUTTLELY_GATEWAY_TRY, '1')
        assert.equal(tryEnv.CUTTLELY_GATEWAY_ROLE, 'chief')
        assert.notEqual(tryEnv.OPENAI_API_KEY, readProfileEnv(fallback.name).OPENAI_API_KEY)
        for (const profile of ['try1234abcd', ...tried.roster.specialists.map((item) => item.profileName)]) {
            assert.equal(readProfileEnv(profile).OPENAI_BASE_URL, tryEnv.OPENAI_BASE_URL)
            assert.ok(
                fs
                    .readFileSync(path.join(dir, 'runtime', 'profiles', profile, 'config.yaml'), 'utf8')
                    .includes(`base_url: ${JSON.stringify(tryEnv.OPENAI_BASE_URL)}`)
            )
        }
        await discardTryProfile('1234abcd')
        assert.equal(profileTokenKnown(tryEnv.OPENAI_API_KEY), false)
    } finally {
        console.info = originalInfo
        setGatewayContext(previous)
        await gateway.close()
    }
})
