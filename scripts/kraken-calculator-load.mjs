// On a disposable installation, publish the unmodified Calculator sample as qa-calculator
// with a simulated model binding. Set CUTTLELY_QA_ORIGIN and CUTTLELY_QA_TOKEN from the
// environment. For a scoped token use chatflows:view and harness:run with one HARNESS
// grant. Run: node scripts/kraken-calculator-load.mjs 32
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'

const count = Number(process.argv[2] || 1)
assert.ok([1, 8, 32].includes(count), 'Select 1, 8, or 32 chats.')
const origin = new URL(process.env.CUTTLELY_QA_ORIGIN)
assert.ok(!origin.username && !origin.password && origin.href === origin.origin + '/', 'Supply the origin only.')
const loopback = ['127.0.0.1', '[::1]'].includes(origin.hostname)
assert.ok(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback), 'Use HTTPS or literal loopback HTTP.')
const key = process.env.CUTTLELY_QA_TOKEN
assert.ok(key && !/[\s\x00-\x1f\x7f]/.test(key), 'Supply a dedicated QA bearer token.')
const net = origin.protocol === 'https:' ? https : http
const chatIds = Array.from({ length: count }, () => randomUUID())
const operand = randomInt(10000, 1000000)
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null
const round = (x) => Math.round(x * 10) / 10

async function cohort(turn) {
    let onWire = 0,
        openStreams = 0,
        peakWire = 0,
        peakStreams = 0
    let firstSent = Infinity,
        lastEof = 0,
        pendingPing
    const ports = new Set(),
        pings = []
    let closed = false
    const started = performance.now()
    function ping() {
        if (closed || !onWire || pendingPing) return
        const t = performance.now()
        pendingPing = new Promise((resolve) => {
            let done = false
            const finish = (status) => {
                if (done) return
                done = true
                pings.push({ status, ms: round(performance.now() - t) })
                resolve()
            }
            const req = net.get(
                new URL('/api/v1/ping', origin),
                { agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(10000) },
                (res) => {
                    res.once('end', () => finish(res.statusCode))
                    res.once('error', () => finish(0))
                    res.once('aborted', () => finish(0))
                    res.once('close', () => {
                        if (!res.complete) finish(0)
                    })
                    res.resume()
                }
            )
            req.once('error', () => finish(0))
        }).finally(() => {
            pendingPing = undefined
        })
    }
    const timer = setInterval(ping, 150)
    const jobs = chatIds.map(
        (chatId, index) =>
            new Promise((resolve, reject) => {
                const t = performance.now(),
                    x = operand + turn * count + index
                const body = JSON.stringify({ question: x + ' + 23', mode: 'router', chatId, streaming: true })
                const req = net.request(
                    new URL('/api/v1/harnesses/qa-calculator/runs', origin),
                    {
                        method: 'POST',
                        agent: false,
                        rejectUnauthorized: true,
                        signal: AbortSignal.timeout(120000),
                        headers: {
                            authorization: 'Bearer ' + key,
                            'content-type': 'application/json',
                            'content-length': Buffer.byteLength(body)
                        }
                    },
                    (res) => {
                        const fail = (message) => {
                            res.destroy()
                            reject(new Error(message))
                        }
                        if (res.statusCode !== 200) return fail('Calculator returned HTTP ' + res.statusCode)
                        if (!/^text\/event-stream\b/i.test(res.headers['content-type'] || ''))
                            return fail('Calculator response was not an event stream.')
                        peakStreams = Math.max(peakStreams, ++openStreams)
                        let finalCount = 0,
                            buffer = '',
                            received = 0
                        res.setEncoding('utf8')
                        const interrupted = () => reject(new Error('Calculator response was interrupted.'))
                        res.once('error', interrupted)
                        res.once('aborted', interrupted)
                        res.once('close', () => {
                            if (!res.complete) interrupted()
                        })
                        res.on('data', (chunk) => {
                            try {
                                received += Buffer.byteLength(chunk)
                                assert.ok(received <= 2 * 1024 * 1024, 'Calculator result exceeded the test limit.')
                                buffer += chunk
                                let separator
                                while ((separator = /\r?\n\r?\n/.exec(buffer))) {
                                    const frame = buffer.slice(0, separator.index)
                                    buffer = buffer.slice(separator.index + separator[0].length)
                                    const data = frame
                                        .split(/\r?\n/)
                                        .filter((line) => line.startsWith('data:'))
                                        .map((line) => line.slice(5))
                                        .join('\n')
                                    if (!data) continue
                                    const item = JSON.parse(data)
                                    assert.notEqual(item.event, 'error', 'Calculator emitted an error.')
                                    if (item.event !== 'harness.final') continue
                                    const value = item.data
                                    assert.equal(String(value?.text).trim() === String(x + 23), true, 'Incorrect arithmetic.')
                                    assert.ok(
                                        value.agents?.some((a) => a.name === 'math' && a.status === 'completed'),
                                        'Math specialist did not complete.'
                                    )
                                    assert.ok(
                                        value.trace?.specialists?.some((s) =>
                                            s.tools?.some((tool) => tool.name === 'calculator' && tool.status === 'done')
                                        ),
                                        'Calculator trace missing.'
                                    )
                                    finalCount++
                                }
                            } catch {
                                fail('Arithmetic answer, stream, or Calculator trace failed verification.')
                            }
                        })
                        res.once('end', () => {
                            lastEof = performance.now()
                            onWire--
                            openStreams--
                            if (finalCount !== 1) return reject(new Error('Expected exactly one verified Calculator final.'))
                            resolve(lastEof - t)
                        })
                    }
                )
                req.once('finish', () => {
                    firstSent = Math.min(firstSent, performance.now())
                    ports.add(req.socket.localPort)
                    peakWire = Math.max(peakWire, ++onWire)
                    if (!pings.length) setImmediate(ping)
                })
                req.once('error', () => reject(new Error('Calculator connection failed.')))
                req.end(body)
            })
    )
    try {
        const results = await Promise.allSettled(jobs)
        const total = lastEof - started
        const bad = results.find((r) => r.status === 'rejected')
        if (bad) throw bad.reason
        const times = results.map((r) => r.value)
        await pendingPing
        assert.ok(pings.length > 0 && pings.every((r) => r.status === 200), 'Concurrent /ping failed.')
        const pingMs = pings.map((p) => p.ms)
        return {
            cohort: turn ? 'warm' : 'fresh',
            verified: times.length,
            tcpConnections: ports.size,
            peakRequestsOnWire: peakWire,
            peakOpenSseResponses: peakStreams,
            wireSpanMs: round(lastEof - firstSent),
            wallMs: round(total),
            turnsPerSecond: round((count * 1000) / total),
            p50Ms: round(quantile(times, 0.5)),
            p95Ms: round(quantile(times, 0.95)),
            ping: { http200: pings.length, p50Ms: quantile(pingMs, 0.5), p95Ms: quantile(pingMs, 0.95) }
        }
    } finally {
        closed = true
        clearInterval(timer)
    }
}

console.log(JSON.stringify(await cohort(0)))
await delay(61000)
console.log(JSON.stringify(await cohort(1)))
