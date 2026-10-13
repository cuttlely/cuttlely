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

// Flow, dataset, and evaluator ids share this shape.
export const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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

function verdictLine(verdict) {
    const rate = verdict.passRate == null ? 'no scored answers' : `${verdict.passRate}%`
    const mark = verdict.threshold == null ? 'n/a' : `${verdict.threshold}%`
    const passed = Number(verdict.passed ?? 0)
    const failed = Number(verdict.failed ?? 0)
    const errored = Number(verdict.errored ?? 0)
    return `Pass rate: ${rate} (threshold ${mark}). ${passed} passed, ${failed} failed, ${errored} errored.`
}

function failingCases(check) {
    return (check?.cases || []).filter((row) => {
        const scores = row?.draft?.scores
        if (!Array.isArray(scores) || !scores.length) return false
        return scores.some((score) => score && score.result !== 'Pass')
    })
}

function failingLines(check) {
    const rows = failingCases(check)
    if (!rows.length) return []
    const lines = ['', 'Failing']
    for (const row of rows) {
        lines.push(`  ${oneLine(row.question)}`)
        for (const score of row.draft.scores) {
            if (!score || score.result === 'Pass') continue
            lines.push(`    ${score.name ? `${score.name}: ${score.result}` : score.result}`)
        }
        if (row.expected) lines.push(`    Expected: ${oneLine(row.expected)}`)
        if (row.draft?.text) lines.push(`    Draft: ${oneLine(row.draft.text)}`)
        else if (row.draft?.error) lines.push(`    ${oneLine(row.draft.error)}`)
    }
    return lines
}

export function summaryText(check) {
    const summary = check.summary || {}
    const lines = [
        `Check ${check.id} ${check.status}`,
        `Questions: ${summary.ran ?? 0} ran, ${summary.same ?? 0} same, ${summary.changed ?? 0} changed, ${summary.errors ?? 0} errors`
    ]
    // Present only when the server finished a dataset check. Diff mode has no verdict.
    if (check.verdict && typeof check.verdict === 'object') lines.push(verdictLine(check.verdict))
    lines.push(
        `Live: ${summary.liveTokens ?? 0} tokens, median ${formatMs(summary.liveMedianMs)}`,
        `Draft: ${summary.draftTokens ?? 0} tokens, median ${formatMs(summary.draftMedianMs)}`
    )
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
    if (check.verdict && typeof check.verdict === 'object') lines.push(...failingLines(check))
    return lines.join('\n')
}

// Replay is the question check. Scored mode reads the server verdict and does not rescore.
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

// Exit 1 is the server's failed verdict. A missing verdict is an error, not a guess from the pass rate.
export function scoredVerdict(check) {
    if (!check || typeof check !== 'object') return { code: EXIT_ERROR, label: 'error' }
    if (check.status === 'failed') return { code: EXIT_ERROR, label: 'failed' }
    if (check.status === 'stopped') return { code: EXIT_ERROR, label: 'stopped' }
    if (check.status !== 'done') return { code: EXIT_ERROR, label: 'incomplete' }
    if (check.draftChanged) return { code: EXIT_ERROR, label: 'draft-changed' }
    const result = check.verdict && check.verdict.result
    if (result === 'passed') return { code: EXIT_PASS, label: 'passed' }
    if (result === 'failed') return { code: EXIT_CHANGED, label: 'score-failed' }
    return { code: EXIT_ERROR, label: 'no-verdict' }
}

export function selectVerdict(check, options) {
    if (options && options.scored) return scoredVerdict(check)
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
function permissionDeniedMessage(scored) {
    const flow = 'The API key needs chatflows:view and chatflows:update, or agentflows:view and agentflows:update.'
    if (!scored) return flow
    return `${flow} Scored mode also needs datasets:view and evaluators:view.`
}

function scoreFailedLine(verdict) {
    const rate = !verdict || verdict.passRate == null ? 'no scored answers' : `${verdict.passRate}%`
    const mark = !verdict || verdict.threshold == null ? 'n/a' : `${verdict.threshold}%`
    return `The test set failed at ${rate} (threshold ${mark}).`
}

// --gate copies the dataset, evaluators, and threshold the flow already saved.
function gateSettings(body) {
    const gate = body && body.publishGate
    if (!gate || gate.enabled !== true) {
        return { ok: false, message: 'This flow has no saved test set. Turn the passing test set on, or pass --dataset.' }
    }
    if (typeof gate.datasetId !== 'string' || !RESOURCE_ID_RE.test(gate.datasetId)) {
        return { ok: false, message: 'The saved test set has no dataset id.' }
    }
    const rawIds = gate.evaluatorIds
    if (rawIds != null && !Array.isArray(rawIds)) {
        return { ok: false, message: 'The saved test set has no evaluator list.' }
    }
    const evaluatorIds = []
    const seen = new Set()
    for (const id of rawIds || []) {
        if (typeof id !== 'string' || !RESOURCE_ID_RE.test(id)) {
            return { ok: false, message: 'The saved test set has an evaluator id this command cannot use.' }
        }
        if (seen.has(id)) continue
        seen.add(id)
        evaluatorIds.push(id)
    }
    let threshold = null
    if (gate.threshold != null) {
        if (typeof gate.threshold !== 'number' || !Number.isInteger(gate.threshold) || gate.threshold < 0 || gate.threshold > 100) {
            return { ok: false, message: 'The saved pass mark is not a whole number from 0 to 100.' }
        }
        threshold = gate.threshold
    }
    return { ok: true, datasetId: gate.datasetId, evaluatorIds, threshold }
}

function requestBody({ scored, datasetId, evaluatorIds, threshold }) {
    if (!scored) return { count: DEFAULT_QUESTION_COUNT }
    const body = { datasetId }
    if (evaluatorIds && evaluatorIds.length) body.evaluatorIds = evaluatorIds
    if (threshold != null) body.threshold = threshold
    return body
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
    const scored = Boolean(options.scored || options.gate)
    let datasetId = options.datasetId
    let evaluatorIds = options.evaluatorIds || []
    let threshold = options.threshold ?? null
    const flowUrl = `${server}/api/v1/flow-drafts/${encodeURIComponent(flow)}`
    const base = `${flowUrl}/check`
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
        if (options.gate) {
            const loaded = await callApi(fetchImpl, flowUrl, {
                method: 'GET',
                headers,
                signal: deadlineSignal(deadline, now)
            })
            if (loaded.timeout) return fail(`Timed out after ${timeoutSeconds}s before the check started.`)
            if (loaded.network) return fail(`Could not reach ${server}. ${loaded.message}`)
            if (!loaded.ok) {
                if (loaded.status === 403) return fail(permissionDeniedMessage(true))
                return fail(`Check failed (${loaded.status}): ${loaded.message}`)
            }
            const parsed = gateSettings(loaded.json)
            if (!parsed.ok) return fail(parsed.message)
            datasetId = parsed.datasetId
            evaluatorIds = parsed.evaluatorIds
            threshold = parsed.threshold
        }
        const started = await callApi(fetchImpl, base, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody({ scored, datasetId, evaluatorIds, threshold })),
            signal: deadlineSignal(deadline, now)
        })
        if (started.timeout) return fail(`Timed out after ${timeoutSeconds}s before the check started.`)
        if (started.network) return fail(`Could not reach ${server}. ${started.message}`)
        if (!started.ok) {
            if (started.status === 403) return fail(permissionDeniedMessage(scored))
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
            if (polled.status === 403) return failRunning(permissionDeniedMessage(scored))
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
        const verdict = selectVerdict(check, { failOnChanged, scored })
        if (verdict.label === 'draft-changed') {
            err('The draft changed while the check was running, so the result is out of date.')
        } else if (verdict.label === 'failed') {
            err(say(check.error ? `The check failed. ${check.error}` : 'The check failed.'))
        } else if (verdict.label === 'stopped') {
            err(`The check stopped${check.stopReason ? ` (${check.stopReason})` : ''} before it finished.`)
        } else if (verdict.label === 'changed') {
            const count = Number(check.summary?.changed ?? 0)
            err(count === 1 ? '1 answer changed.' : `${count} answers changed.`)
        } else if (verdict.label === 'score-failed') {
            err(scoreFailedLine(check.verdict))
        } else if (verdict.label === 'no-verdict') {
            err('The server did not return a verdict for this test set.')
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
