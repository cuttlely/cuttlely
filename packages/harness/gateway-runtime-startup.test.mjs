import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-runtime-startup-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { saveHarness } = await import('./store.mjs')
const { setGatewayContext, startGateway, registerProfileToken, forgetProfileToken } = await import('./gateway.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('startup allows authorized tool discovery while tool calls and chat completions remain unavailable', async () => {
    fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'restarting', restarts: 0 }))
    const name = 'startup-team'
    saveHarness({
        name,
        chief: { model: { nodeName: 'unused' } },
        specialists: [{ name: 'worker', modules: [{ nodeName: 'fixtureTool', inputs: { name: 'startup_tool' } }] }]
    })
    const previous = setGatewayContext(async () => ({ componentNodes: {}, flowOptions: {} }))
    const token = crypto.randomBytes(32).toString('base64url')
    registerProfileToken({ token, harnessName: name, specialistName: 'worker', profileName: `${name}--worker` })
    const gateway = await startGateway({ port: 0 })
    const post = (route, body, authorized = true) =>
        fetch(`http://127.0.0.1:${gateway.port}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body)
        })
    try {
        const unauthorized = await post('/harness/tools/list', {}, false)
        assert.equal(unauthorized.status, 401)
        await unauthorized.json()
        const list = await post('/harness/tools/list', {})
        const listed = await list.json()
        assert.equal(list.status, 200, JSON.stringify(listed))
        assert.equal(listed.tools.length, 1)
        assert.equal(listed.tools[0].name, 'startup_tool')
        for (const [route, body] of [
            ['/harness/tools/call', { name: listed.tools[0].name, arguments: {} }],
            ['/v1/chat/completions', { messages: [{ role: 'user', content: 'Hello' }] }]
        ]) {
            const response = await post(route, body)
            const payload = await response.json()
            assert.equal(response.status, 503, route)
            assert.equal(payload.code, 'RUNTIME_UNAVAILABLE', route)
            assert.equal(payload.error.code, 'RUNTIME_UNAVAILABLE', route)
            assert.match(response.headers.get('Retry-After') || '', /^[1-9]\d*$/)
        }
    } finally {
        forgetProfileToken(token)
        setGatewayContext(previous)
        await gateway.close()
    }
})
