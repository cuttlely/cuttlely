// Runs the Publish check (POST /api/v1/flow-drafts/:id/check) and waits for it.
// Talks only to the server named with --server. The API key stays in the environment.
import { writeFileSync } from 'node:fs'

export const API_KEY_ENV = 'CUTTLELY_API_KEY'
export const DEFAULT_SERVER = 'http://127.0.0.1:43117'
export const DEFAULT_TIMEOUT_SECONDS = 300
export const DEFAULT_QUESTION_COUNT = 4
export const POLL_MS = 1000

export const EXIT_PASS = 0
export const EXIT_CHANGED = 1
export const EXIT_ERROR = 2

const ANSWER_CLIP = 240

function redact(text, secret) {
    if (!secret || typeof text !== 'string' || !text.includes(secret)) return text
    return text.split(secret).join('[redacted]')
}

function redactValue(value, secret) {
    if (typeof value === 'string') return redact(value, secret)
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secret))
    if (value && typeof value === 'object') {
        const copy = {}
        for (const [key, item] of Object.entries(value)) copy[key] = redactValue(item, secret)
        return copy
    }
    return value
}

function oneLine(text) {
    const flat = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!flat) return '(empty)'
    if (flat.length <= ANSWER_CLIP) return flat
    return `${flat.slice(0, ANSWER_CLIP - 3)}...`
}

function formatMs(value) {
    return value == null ? 'n/a' : `${value} ms`
}

function formatUsd(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    if (n === 0) return '$0'
    if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`
    return `$${n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`
}

function estimateLine(label, usd, price) {
    if (price === 'no price') return `${label}: estimated cost no price`
    if (price === 'partial') {
        const money = formatUsd(usd)
        return money ? `${label}: estimated ${money} (some models have no price)` : `${label}: estimated cost no price`
    }
    if (price === 'known') {
        const money = formatUsd(usd)
        return money ? `${label}: estimated ${money}` : ''
    }
    return ''
}

export function changedCases(check) {
    return (check?.cases || []).filter((row) => row && row.same === false && row.live && row.draft && !row.live.error && !row.draft.error)
}

function errorCases(check) {
    return (check?.cases || []).filter((row) => row && (row.live?.error || row.draft?.error))
}

export function summaryText(check) {
    const summary = check.summary || {}
    const lines = [
        `Check ${check.id} ${check.status}`,
        `Questions: ${summary.ran ?? 0} ran, ${summary.same ?? 0} same, ${summary.changed ?? 0} changed, ${summary.errors ?? 0} errors`,
        `Live: ${summary.liveTokens ?? 0} tokens, median ${formatMs(summary.liveMedianMs)}`,
        `Draft: ${summary.draftTokens ?? 0} tokens, median ${formatMs(summary.draftMedianMs)}`
    ]
    // The check total, with each model priced once. It is not the sum of the per-answer figures.
    const liveEstimate = estimateLine('Live', summary.liveEstimatedCostUsd, summary.livePrice)
    const draftEstimate = estimateLine('Draft', summary.draftEstimatedCostUsd, summary.draftPrice)
    if (liveEstimate) lines.push(liveEstimate)
    if (draftEstimate) lines.push(draftEstimate)
    if (check.liveEmpty) lines.push('Live has no cards, so only the draft was asked.')
    if (check.stopReason) lines.push(`Stopped: ${check.stopReason}`)
    if (check.error) lines.push(`Error: ${check.error}`)
    const changed = changedCases(check)
    if (changed.length) {
        lines.push('', 'Changed')
        for (const row of changed) {
            lines.push(`  ${oneLine(row.question)}`)
            lines.push(`    Live: ${oneLine(row.live.text)}`)
            lines.push(`    Draft: ${oneLine(row.draft.text)}`)
        }
    }
    const errors = errorCases(check)
    if (errors.length) {
        lines.push('', 'Errors')
        for (const row of errors) {
            const why = [row.live?.error, row.draft?.error].filter(Boolean).join('; ')
            lines.push(`  ${oneLine(row.question)}`)
            lines.push(`    ${oneLine(why)}`)
        }
    }
    return lines.join('\n')
}

// Replay is the only verdict this command runs. A later scored mode (pass or fail
// from a test set) should return the same { code, label } and be selected in selectVerdict.
export function replayVerdict(check, { failOnChanged }) {
    if (!check || typeof check !== 'object') return { code: EXIT_ERROR, label: 'error' }
    if (check.status === 'failed') return { code: EXIT_ERROR, label: 'failed' }
    if (check.status === 'stopped') return { code: EXIT_ERROR, label: 'stopped' }
    if (check.status !== 'done') return { code: EXIT_ERROR, label: 'incomplete' }
    if (check.draftChanged) return { code: EXIT_ERROR, label: 'draft-changed' }
    const changed = Number(check.summary?.changed ?? 0)
    if (!Number.isFinite(changed)) return { code: EXIT_ERROR, label: 'error' }
    if (failOnChanged && changed > 0) return { code: EXIT_CHANGED, label: 'changed' }
    return { code: EXIT_PASS, label: 'pass' }
}

export function selectVerdict(check, options) {
    return replayVerdict(check, options)
}

function deadlineSignal(deadline, now) {
    const remaining = Math.max(1, deadline - now())
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(remaining)
    return undefined
}

async function callApi(fetchImpl, url, { method, headers, body, signal }) {
    let response
    try {
        response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal })
    } catch (error) {
        const name = error && error.name
        if (name === 'AbortError' || name === 'TimeoutError') return { timeout: true }
        return { network: true, message: error instanceof Error ? error.message : String(error) }
    }
    const status = Number(response.status)
    if (status >= 300 && status < 400) {
        return { ok: false, status, message: 'The server sent a redirect, which this command will not follow.' }
    }
    let text = ''
    try {
        text = typeof response.text === 'function' ? await response.text() : ''
    } catch (error) {
        return { network: true, message: error instanceof Error ? error.message : String(error) }
    }
    let json = null
    if (text) {
        try {
            json = JSON.parse(text)
        } catch {
            json = null
        }
    }
    const raw = json && (json.message || json.error)
    const message = typeof raw === 'string' && raw ? raw : text ? text.slice(0, 300) : `The server returned HTTP ${status}.`
    return { ok: status >= 200 && status < 300, status, message, json }
}

function isNoDraft(result) {
    return result.status === 409 && typeof result.message === 'string' && /no unpublished changes/i.test(result.message)
}

// Starting a check needs update. Reading it needs view. A key with only one of those gets 403,
// and the server message does not say which permission is missing.
function permissionDeniedMessage() {
    return 'The API key needs chatflows:view and chatflows:update, or agentflows:view and agentflows:update.'
}

function writeResult(writeFile, jsonPath, check, secret) {
    if (!jsonPath || !check) return
    const safe = redactValue(check, secret)
    writeFile(jsonPath, `${JSON.stringify(safe, null, 4)}\n`)
}

async function stopCheck(fetchImpl, url, headers) {
    try {
        const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
        await fetchImpl(url, { method: 'DELETE', headers, redirect: 'manual', signal })
    } catch {
        // The timeout result stands either way. A stuck stop must not hide it.
    }
}

export async function runCheck(options, io = {}) {
    const out = io.out || ((line) => console.info(line))
    const err = io.err || ((line) => console.error(line))
    const env = io.env || process.env
    const fetchImpl = io.fetch || globalThis.fetch.bind(globalThis)
    const sleep = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const now = io.now || Date.now
    const writeFile = io.writeFile || ((file, text) => writeFileSync(file, text))
    const secret = typeof env[API_KEY_ENV] === 'string' ? env[API_KEY_ENV].trim() : ''
    if (!secret) {
        err(`${API_KEY_ENV} is not set.`)
        return EXIT_ERROR
    }

    const server = options.server || DEFAULT_SERVER
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const flow = options.flow
    const failOnChanged = Boolean(options.failOnChanged)
    const base = `${server}/api/v1/flow-drafts/${encodeURIComponent(flow)}/check`
    const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/json' }
    const deadline = now() + timeoutSeconds * 1000

    const say = (text) => redact(text, secret)

    const fail = (text) => {
        err(say(text))
        return EXIT_ERROR
    }

    // Set once the server has accepted the check. Every later failure tries to stop it.
    let check = null
    const stopIfStarted = async () => {
        if (!check?.id) return
        await stopCheck(fetchImpl, `${base}/${encodeURIComponent(check.id)}`, headers)
    }
    // The stop is best effort. A failed DELETE does not replace the exit code.
    const failRunning = async (text) => {
        await stopIfStarted()
        return fail(text)
    }
    // Signals are armed only after the id is known, and removed on a normal return so a
    // finished check is left alone. process.exit skips the finally, so the handler disarms first.
    const signalTarget = io.signals || process
    let signalExit = false
    const onSignal = () => {
        if (signalExit) return
        signalExit = true
        disarmSignals()
        void (async () => {
            await stopIfStarted()
            err('The check was cancelled.')
            const exit = io.exit || ((code) => process.exit(code))
            exit(EXIT_ERROR)
        })()
    }
    const disarmSignals = () => {
        signalTarget.removeListener('SIGTERM', onSignal)
        signalTarget.removeListener('SIGINT', onSignal)
    }
    const armSignals = () => {
        signalTarget.on('SIGTERM', onSignal)
        signalTarget.on('SIGINT', onSignal)
    }

    try {
        const started = await callApi(fetchImpl, base, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: DEFAULT_QUESTION_COUNT }),
            signal: deadlineSignal(deadline, now)
        })
        if (started.timeout) return fail(`Timed out after ${timeoutSeconds}s before the check started.`)
        if (started.network) return fail(`Could not reach ${server}. ${started.message}`)
        if (!started.ok) {
            if (started.status === 403) return fail(permissionDeniedMessage())
            if (isNoDraft(started)) return fail(`No draft to check. ${started.message}`)
            return fail(`Check failed (${started.status}): ${started.message}`)
        }
        check = started.json
        if (!check || typeof check !== 'object' || !check.id) return fail('The server did not return a check.')
        armSignals()
        out(`Started check ${check.id} for flow ${flow} (${check.total ?? 0} questions).`)

        const giveUp = async () => {
            await stopIfStarted()
            try {
                writeResult(writeFile, options.jsonPath, check, secret)
            } catch (error) {
                err(say(`Could not write ${options.jsonPath}. ${error instanceof Error ? error.message : String(error)}`))
            }
            return fail(`Timed out after ${timeoutSeconds}s waiting for check ${check.id}.`)
        }

        while (check.status === 'running') {
            // Read before sleeping, and once more at the deadline, so a check that
            // finishes in the last poll interval is not reported from a stale body.
            const polled = await callApi(fetchImpl, `${base}/${encodeURIComponent(check.id)}`, {
                method: 'GET',
                headers,
                signal: deadlineSignal(deadline + POLL_MS, now)
            })
            if (polled.timeout) return giveUp()
            if (polled.network) return failRunning(`Could not reach ${server}. ${polled.message}`)
            if (polled.status === 403) return failRunning(permissionDeniedMessage())
            if (!polled.ok) return failRunning(`Check failed (${polled.status}): ${polled.message}`)
            if (!polled.json || typeof polled.json !== 'object') return failRunning('The server did not return a check.')
            const previous = check.completed
            check = polled.json
            if (check.status === 'running' && check.completed !== previous && check.completed != null) {
                out(`Asked ${check.completed} of ${check.total}.`)
            }
            if (check.status !== 'running') break
            const remaining = deadline - now()
            if (remaining <= 0) return giveUp()
            await sleep(Math.min(POLL_MS, remaining))
        }

        try {
            writeResult(writeFile, options.jsonPath, check, secret)
        } catch (error) {
            err(say(`Could not write ${options.jsonPath}. ${error instanceof Error ? error.message : String(error)}`))
            out(say(summaryText(check)))
            await stopIfStarted()
            return EXIT_ERROR
        }
        out(say(summaryText(check)))
        const verdict = selectVerdict(check, { failOnChanged })
        if (verdict.label === 'draft-changed') {
            err('The draft changed while the check was running, so the result is out of date.')
        } else if (verdict.label === 'failed') {
            err(say(check.error ? `The check failed. ${check.error}` : 'The check failed.'))
        } else if (verdict.label === 'stopped') {
            err(`The check stopped${check.stopReason ? ` (${check.stopReason})` : ''} before it finished.`)
        } else if (verdict.label === 'changed') {
            const count = Number(check.summary?.changed ?? 0)
            err(count === 1 ? '1 answer changed.' : `${count} answers changed.`)
        } else if (verdict.code === EXIT_ERROR) {
            err('The check did not finish.')
        }
        if (verdict.code === EXIT_ERROR) await stopIfStarted()
        return verdict.code
    } catch (error) {
        await stopIfStarted()
        return fail(error instanceof Error ? error.message : String(error))
    } finally {
        if (!signalExit) disarmSignals()
    }
}
