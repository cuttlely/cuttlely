import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

test('bridge HTTP request allows a tool call beyond 130 seconds with the explicit setting', async (t) => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-bridge-wait-'))
    const saved = { ...process.env }
    const listeners = process.stdin.listeners('data')
    Object.assign(process.env, {
        HOME: top,
        DATABASE_PATH: top,
        CUTTLELY_DATA_DIR: top,
        CUTTLELY_HARNESS_GATEWAY_URL: 'http://127.0.0.1:43118',
        CUTTLELY_HARNESS_GATEWAY_TOKEN: 'fixture-only'
    })
    delete process.env.CUTTLELY_ANALYST_BRIDGE
    let requestTimeout
    // Advance virtual time to 131 s. No real listener or long wait is needed.
    t.mock.method(http, 'request', (options, callback) => {
        requestTimeout = options.timeout
        const req = new EventEmitter()
        req.write = () => {}
        req.destroy = () => {}
        req.end = () =>
            queueMicrotask(() => {
                if (options.timeout <= 131000) return req.emit('timeout')
                const res = new EventEmitter()
                res.statusCode = 200
                callback(res)
                res.emit('data', Buffer.from(JSON.stringify({ result: 'slow tool completed' })))
                res.emit('end')
            })
        return req
    })
    let reply
    const write = fs.writeSync
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (fd !== 1) return write(fd, ...args)
        reply = JSON.parse(String(args[0]))
        return Buffer.byteLength(args[0])
    })
    try {
        const { bridgeWaitMs } = await import('./mcp-bridge.mjs')
        for (const [raw, expected] of [
            [undefined, 130000],
            ['invalid', 130000],
            ['3660001', 130000],
            ['3660000', 3720000]
        ]) {
            delete process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS
            if (raw !== undefined) process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS = raw
            assert.equal(bridgeWaitMs(), expected)
            reply = undefined
            process.stdin.emit(
                'data',
                Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }) + '\n')
            )
            await new Promise((resolve) => setImmediate(resolve))
            assert.equal(requestTimeout, expected)
            assert.equal(reply.result.isError, expected === 130000)
            if (expected > 130000) {
                assert.ok(requestTimeout > 131000)
                assert.equal(reply.result.content[0].text, 'slow tool completed')
            }
        }
    } finally {
        t.mock.restoreAll()
        for (const listener of process.stdin.listeners('data')) if (!listeners.includes(listener)) process.stdin.off('data', listener)
        process.stdin.pause()
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
        Object.assign(process.env, saved)
        fs.rmSync(top, { recursive: true, force: true })
    }
})
