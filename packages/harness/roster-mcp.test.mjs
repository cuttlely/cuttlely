import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./roster-mcp.mjs', import.meta.url))
const headerPacket = (body) => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

function startRoster(t, apiUrl = '') {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-roster-stdio-'))
    const home = path.join(data, 'hermes')
    const name = 'mixed-fixture'
    const specialist = `${name}--worker`
    const profileDir = (profile) => path.join(home, 'profiles', profile)
    fs.mkdirSync(profileDir(name), { recursive: true })
    fs.mkdirSync(profileDir(specialist), { recursive: true })
    fs.writeFileSync(
        path.join(profileDir(name), 'harness-roster.json'),
        JSON.stringify({
            chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
            specialists: [
                { name: 'worker', profileName: specialist, model: { nodeName: 'fixtureChat', inputs: { modelName: 'worker-model' } } }
            ]
        })
    )
    fs.writeFileSync(path.join(profileDir(specialist), '.env'), 'API_SERVER_KEY=offline-fixture-only\n', { mode: 0o600 })
    const child = spawn(process.execPath, [script, '--harness', name], {
        env: {
            ...process.env,
            HOME: data,
            DATABASE_PATH: data,
            CUTTLELY_DATA_DIR: data,
            CUTTLELY_HERMES_HOME: home,
            HERMES_API_URL: apiUrl,
            CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '5000'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const exited = once(child, 'exit')
    t.after(async () => {
        child.stdin.end()
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
        await exited
        clearTimeout(timer)
        fs.rmSync(data, { recursive: true, force: true })
    })
    const chunks = child.stdout[Symbol.asyncIterator]()
    let buffer = Buffer.alloc(0)
    async function reply(mode = 'line') {
        for (;;) {
            let end = buffer.indexOf('\n') + 1
            if (mode === 'header') {
                const headerEnd = buffer.indexOf('\r\n\r\n')
                if (headerEnd < 0) end = 0
                else {
                    const header = buffer.subarray(0, headerEnd).toString('utf8')
                    assert.match(header, /^Content-Length: \d+$/)
                    end = headerEnd + 4 + Number(header.slice('Content-Length: '.length))
                    if (buffer.length < end) end = 0
                }
            }
            if (end > 0) {
                const packet = buffer.subarray(0, end).toString('utf8')
                buffer = buffer.subarray(end)
                if (mode === 'line') {
                    assert.ok(packet.endsWith('\n'))
                    assert.equal(packet.indexOf('\n'), packet.length - 1, 'one JSON message per line')
                    assert.ok(!packet.startsWith('Content-Length:'))
                    return JSON.parse(packet.slice(0, -1))
                }
                return JSON.parse(packet.slice(packet.indexOf('\r\n\r\n') + 4))
            }
            const next = await chunks.next()
            assert.equal(next.done, false, `Roster closed before replying: ${stderr}`)
            buffer = Buffer.concat([buffer, next.value])
        }
    }
    function send(message, mode = 'line') {
        const body = JSON.stringify({ jsonrpc: '2.0', ...message })
        child.stdin.write(mode === 'header' ? headerPacket(body) : `${body}\n`)
    }
    return { name, specialist, send, reply }
}

test('Hermes newline stdio initializes at id 0, lists tools and delegates to a mixed-model specialist', { timeout: 10000 }, async (t) => {
    const calls = []
    const output = 'Fixture specialist answer.\nSecond line: café.'
    const server = http.createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        calls.push({ method: req.method, url: req.url, body: JSON.parse(body) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ run_id: 'fixture-run', status: 'completed', output }))
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    t.after(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    })
    const roster = startRoster(t, `http://127.0.0.1:${server.address().port}`)
    roster.send({
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }
    })
    assert.deepEqual(await roster.reply(), {
        jsonrpc: '2.0',
        id: 0,
        result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: `cuttlely-${roster.name}-roster`, version: '1.0.0' }
        }
    })
    roster.send({ method: 'notifications/initialized' })
    roster.send({ id: 1, method: 'tools/list', params: {} })
    const listed = await roster.reply()
    assert.equal(listed.jsonrpc, '2.0')
    assert.equal(listed.id, 1, 'initialized notification must not produce a reply')
    assert.ok(listed.result.tools.some((tool) => tool.name === 'run_specialist'))
    roster.send({
        id: 2,
        method: 'tools/call',
        params: { name: 'run_specialist', arguments: { name: 'worker', task: 'Answer the fixture question.' } }
    })
    assert.deepEqual(await roster.reply(), {
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: output }], isError: false }
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, `/p/${roster.specialist}/v1/runs`)
    assert.equal(calls[0].body.input, 'Answer the fixture question.')
})

test('roster still echoes Content-Length framing and can switch back to newline JSON', { timeout: 10000 }, async (t) => {
    const roster = startRoster(t)
    roster.send({ id: 0, method: 'initialize' }, 'header')
    const initialized = await roster.reply('header')
    assert.equal(initialized.id, 0)
    assert.equal(initialized.result.protocolVersion, '2024-11-05')
    assert.equal(initialized.result.serverInfo.name, `cuttlely-${roster.name}-roster`)
    roster.send({ id: 1, method: 'tools/list' })
    const listed = await roster.reply()
    assert.equal(listed.id, 1)
    assert.ok(listed.result.tools.some((tool) => tool.name === 'run_specialist'))
})
