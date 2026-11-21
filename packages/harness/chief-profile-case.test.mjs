import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// A harness saved with capitals (NAVI's TigerMom) must reach its chief in agent mode. The runtime serves a named
// profile only from a lowercase-id folder and refuses any other /p/<profile>/ prefix with this 404.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chief-case-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const profilesRoot = path.join(dir, 'runtime', 'profiles')
const { runHarness } = await import('./run.mjs')
const { saveHarness } = await import('./store.mjs')
const { listRuns } = await import('./history.mjs')
const { compileProfile } = await import('./profile.mjs')
const { closeSessions } = await import('./session.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { setGatewayContext, startGateway } = await import('./gateway.mjs')
after(() => {
    closeSessions()
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

// hermes_constants.PROFILE_ID_RE and hermes_cli.profiles.profiles_to_serve: a folder with this id and a config.
const HERMES_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const served = (profile) => HERMES_PROFILE_ID.test(profile) && fs.existsSync(path.join(profilesRoot, profile, 'config.yaml'))

const chief = { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } }

test('a harness compiled into profiles/<Name> before the fix keeps its sessions and gets a profile the runtime serves', () => {
    const legacy = path.join(profilesRoot, 'UpgradeTeam')
    fs.mkdirSync(path.join(legacy, 'memories'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'sessions.sqlite'), 'router history')
    fs.writeFileSync(path.join(legacy, 'memories', 'MEMORY.md'), 'kept')
    fs.writeFileSync(path.join(legacy, 'harness-compiler'), '9\n')
    const record = saveHarness({
        name: 'UpgradeTeam',
        workspaceId: 'fixture-workspace',
        chief,
        specialists: [{ name: 'worker', codeExecution: true }]
    })
    compileProfile(record)
    const names = fs.readdirSync(profilesRoot).filter((entry) => entry.toLowerCase().startsWith('upgradeteam'))
    assert.deepEqual(names.sort(), ['upgradeteam', 'upgradeteam--worker'])
    assert.ok(served('upgradeteam'), 'the chief profile is one the runtime serves')
    assert.equal(fs.readFileSync(path.join(profilesRoot, 'upgradeteam', 'sessions.sqlite'), 'utf8'), 'router history')
    assert.equal(fs.readFileSync(path.join(profilesRoot, 'upgradeteam', 'memories', 'MEMORY.md'), 'utf8'), 'kept')
    assert.equal(fs.readFileSync(path.join(profilesRoot, 'upgradeteam', 'harness-compiler'), 'utf8').trim(), '10')
})

test('agent mode reaches the chief of a harness named with capitals', async (t) => {
    const gateway = await startGateway({ port: 0 })
    process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(gateway.port)
    const name = 'TigerMom'
    const record = saveHarness({ name, workspaceId: 'fixture-workspace', chief, specialists: [{ name: 'worker', codeExecution: true }] })
    const previous = setGatewayContext(async () => ({ componentNodes: {}, flowOptions: {} }))
    t.after(() => setGatewayContext(previous))
    const calls = []
    const server = http.createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        calls.push({ url: req.url, method: req.method })
        const profile = decodeURIComponent((req.url.match(/^\/p\/([^/]+)\//) || [])[1] || '')
        res.setHeader('content-type', 'application/json')
        if (!served(profile)) {
            res.writeHead(404).end(JSON.stringify({ error: 'Unknown or unconfigured profile' }))
            return
        }
        if (req.method === 'POST' && req.url === `/p/${profile}/v1/runs`) {
            res.end(
                JSON.stringify({
                    run_id: 'chief-run',
                    status: 'completed',
                    output: 'Chief answer.',
                    usage: { prompt_tokens: 3, completion_tokens: 2 }
                })
            )
            return
        }
        res.writeHead(404).end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        await gateway.close?.()
    })
    const result = await runHarness({
        name,
        mode: 'agent',
        chatId: 'fixture-chat',
        input: 'Answer the fixture.',
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        timeoutMs: 5000,
        flowOptions: { workspaceId: record.workspaceId, harnessCaller: { via: 'session' } },
        loadNode: async () => {
            throw new Error('The router must not run in agent mode.')
        }
    })
    assert.equal(result.text, 'Chief answer.')
    assert.equal(result.mode, 'agent')
    const posts = calls.filter((call) => call.method === 'POST')
    assert.deepEqual(
        posts.map((call) => call.url),
        ['/p/tigermom/v1/runs']
    )
    const runs = listRuns(name)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].mode, 'agent')
    assert.equal(runs[0].status, 'succeeded')
})
