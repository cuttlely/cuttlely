import fs from 'node:fs'
import path from 'node:path'
import { HarnessError } from './errors.mjs'
import { readProfileEnv } from './profile.mjs'
import { beginHermesStream } from './runtime/hermes-stream.mjs'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
// Several specialists poll one Hermes gateway at once; back off so status reads do not crowd its event loop.
const POLL_START_MS = 25
const POLL_MAX_MS = 250

// One prompt-cache scope per profile: Hermes pins requests that share it to one backend, so a
// new chat reuses the cached system prompt and tool schemas instead of starting cold.
export function hermesCacheScope(harnessName) {
    return `cuttlely:${harnessName}`
}

function runHeaders(harnessName, apiKey) {
    return { authorization: `Bearer ${apiKey}`, 'x-hermes-session-key': hermesCacheScope(harnessName) }
}

export function hermesBaseUrl() {
    return process.env.HERMES_API_URL || 'http://127.0.0.1:8642'
}

export function assertLoopback(baseUrl) {
    let url
    try {
        url = new URL(baseUrl)
    } catch {
        throw new HarnessError('bad_host', `Hermes URL "${baseUrl}" is not a valid URL.`)
    }
    if (!LOOPBACK.has(url.hostname)) {
        throw new HarnessError('bad_host', 'Hermes listens on 127.0.0.1 only. Refusing a non-local runs URL.')
    }
    return url
}

function linkSignal(controller, signal) {
    if (!signal) return () => {}
    if (signal.aborted) {
        controller.abort()
        return () => {}
    }
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
}

// Hermes starts a few seconds after the server. A question asked in that window waits for it instead of failing,
// but only while scripts/start-cuttlely.sh is supervising Hermes and has not given up on it.
const START_WAIT_MS = 60000
export function hermesStartWaitMs(env = process.env) {
    const value = Number(env.CUTTLELY_HERMES_START_WAIT_MS)
    return env.CUTTLELY_HERMES_START_WAIT_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : START_WAIT_MS
}

export function hermesStarting(dataDir = process.env.CUTTLELY_DATA_DIR) {
    if (!dataDir) return false
    try {
        const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'hermes-supervisor.json'), 'utf8'))?.state
        return typeof state === 'string' && state !== 'down'
    } catch {
        return false
    }
}

const refused = (error) => error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED'

const pause = (ms, signal) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer)
                resolve()
            },
            { once: true }
        )
    })

export async function createRun({
    harnessName,
    body,
    baseUrl = hermesBaseUrl(),
    fetchImpl = fetch,
    timeoutMs = 20000,
    signal,
    startWaitMs = hermesStartWaitMs(),
    isStarting = hermesStarting,
    retryEveryMs = 1000
} = {}) {
    assertLoopback(baseUrl)
    const env = readProfileEnv(harnessName)
    const apiKey = env.API_SERVER_KEY
    if (!apiKey) {
        throw new HarnessError('missing_profile', `Harness "${harnessName}" has no profile API key. Compile the roster first.`)
    }
    const url = `${baseUrl.replace(/\/$/, '')}/p/${encodeURIComponent(harnessName)}/v1/runs`
    const deadline = Date.now() + startWaitMs
    let response
    let payload
    for (;;) {
        const controller = new AbortController()
        const unlink = linkSignal(controller, signal)
        const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...runHeaders(harnessName, apiKey) },
                body: JSON.stringify(body),
                signal: controller.signal
            })
            payload = await readJson(response)
            break
        } catch (error) {
            if (signal?.aborted) throw error
            if (refused(error) && Date.now() + retryEveryMs <= deadline && isStarting()) {
                await pause(retryEveryMs, signal)
                if (signal?.aborted) throw error
                continue
            }
            throw new HarnessError(
                'hermes_unreachable',
                `Harness "${harnessName}" cannot run: Hermes did not accept POST /v1/runs on localhost (${error.message}).`
            )
        } finally {
            clearTimeout(timer)
            unlink()
        }
    }
    if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || payload?.error || response.statusText
        throw new HarnessError('run_failed', `Harness "${harnessName}" cannot run: ${detail}`)
    }
    return payload
}

export async function stopRun({ harnessName, runId, baseUrl = hermesBaseUrl(), fetchImpl = fetch, timeoutMs = 2000 } = {}) {
    if (!runId) return
    assertLoopback(baseUrl)
    const env = readProfileEnv(harnessName)
    const url = `${baseUrl.replace(/\/$/, '')}/p/${encodeURIComponent(harnessName)}/v1/runs/${encodeURIComponent(runId)}/stop`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        await fetchImpl(url, { method: 'POST', headers: runHeaders(harnessName, env.API_SERVER_KEY), signal: controller.signal })
    } catch {
        return
    } finally {
        clearTimeout(timer)
    }
}

export async function waitForRun({
    harnessName,
    runId,
    baseUrl = hermesBaseUrl(),
    fetchImpl = fetch,
    timeoutMs = 20000,
    onEvent,
    signal
} = {}) {
    assertLoopback(baseUrl)
    const env = readProfileEnv(harnessName)
    const url = `${baseUrl.replace(/\/$/, '')}/p/${encodeURIComponent(harnessName)}/v1/runs/${encodeURIComponent(runId)}`
    const headers = runHeaders(harnessName, env.API_SERVER_KEY)
    const started = Date.now()
    const deadline = timeoutMs > 0 ? started + timeoutMs : Infinity
    const controller = new AbortController()
    const unlink = linkSignal(controller, signal)
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    try {
        await waitForRunEnd(`${url}/events`, headers, fetchImpl, deadline, onEvent, controller.signal)
        let delay = POLL_START_MS
        while (Date.now() < deadline) {
            if (controller.signal.aborted) throw Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' })
            const response = await fetchImpl(url, { headers, signal: controller.signal })
            const payload = await readJson(response)
            if (!response.ok) {
                const detail = payload?.error?.message || payload?.message || response.statusText
                throw new HarnessError('run_failed', `Harness "${harnessName}" cannot run: ${detail}`)
            }
            if (!payload.status || ['completed', 'failed', 'error', 'cancelled'].includes(payload.status)) return payload
            await sleep(delay, controller.signal)
            delay = Math.min(delay * 2, POLL_MAX_MS)
        }
    } catch (error) {
        if (signal?.aborted || !controller.signal.aborted) throw error
        // The caller can still cancel an unlimited run. Only our own deadline becomes run_timeout.
    } finally {
        clearTimeout(timer)
        unlink()
    }
    throw new HarnessError('run_timeout', `Harness "${harnessName}" did not finish the Hermes run in time.`)
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' }))
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' }))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function sseJson(frame) {
    const lines = String(frame)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
    if (!lines.length) return null
    const raw = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n')
    if (!raw) return null
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

// Hermes closes a run's event stream when the run ends, so the status read that follows finds it
// finished without a polling delay. Data frames are forwarded as they arrive. Any stream failure falls back to polling.
async function waitForRunEnd(url, headers, fetchImpl, deadline, onEvent, callerSignal) {
    const controller = new AbortController()
    const unlink = linkSignal(controller, callerSignal)
    const timer = Number.isFinite(deadline) ? setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now())) : undefined
    let endStream = () => {}
    try {
        const response = await fetchImpl(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal })
        if (!response.ok || !response.body) return
        try {
            endStream = beginHermesStream()
        } catch {
            endStream = () => {}
        }
        const decoder = new TextDecoder()
        let pending = ''
        for await (const chunk of response.body) {
            pending += decoder.decode(chunk, { stream: true })
            const frames = pending.split('\n\n')
            pending = frames.pop() ?? ''
            let closed = false
            for (const frame of frames) {
                if (frame.includes(': stream closed')) closed = true
                const data = sseJson(frame)
                if (data && !callerSignal?.aborted) {
                    try {
                        if (typeof onEvent === 'function') onEvent(data)
                    } catch {
                        // The listener must not stop the run from finishing.
                    }
                }
            }
            if (closed) return
        }
    } catch (error) {
        // A caller abort must not fall through to polling. A stream timeout still does.
        if (callerSignal?.aborted) throw error
    } finally {
        endStream()
        clearTimeout(timer)
        controller.abort()
        unlink()
    }
}

async function readJson(response) {
    const text = await response.text()
    if (!text) return {}
    try {
        return JSON.parse(text)
    } catch {
        return { message: text }
    }
}
