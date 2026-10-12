import { HarnessError } from './errors.mjs'

// A primary call that is still running after this switches to the fallback model, when one is connected.
const DEFAULT_FALLBACK_MS = 8000

export function modelFallbackMs() {
    const raw = process.env.CUTTLELY_HARNESS_MODEL_FALLBACK_MS
    if (raw == null || String(raw).trim() === '') return DEFAULT_FALLBACK_MS
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return DEFAULT_FALLBACK_MS
    return Math.floor(n)
}

export function isFallbackTrigger(error) {
    if (!error || error.code === 'aborted' || error.code === 'over_budget') return false
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return false
    if (error.code === 'model_slow') return true
    const text = String(error.message || '')
    if (/\b50[234]\b/.test(text)) return true
    return /unavailable|overloaded/i.test(text)
}

export function sameModelBinding(left, right) {
    if (!left?.nodeName || !right?.nodeName) return false
    if (left.nodeId && right.nodeId) return left.nodeId === right.nodeId
    return left.nodeName === right.nodeName && String(left.credential || '') === String(right.credential || '')
}

function noFallbackError(error) {
    const message = String(error.message || 'The chat model failed.')
    const note = message.includes('No fallback chat model is connected.') ? message : `${message} No fallback chat model is connected.`
    return new HarnessError(error.code === 'model_slow' ? 'model_failed' : error.code || 'model_failed', note)
}

function fallbackFailed(error) {
    if (error?.code === 'aborted' || error?.code === 'over_budget') return error
    return new HarnessError('model_failed', `Fallback chat model failed: ${error?.message || error}`)
}

function cancellableDelay(ms) {
    let timer
    let finish = () => {}
    const promise = new Promise((resolve) => {
        finish = resolve
        timer = setTimeout(resolve, ms)
        if (typeof timer.unref === 'function') timer.unref()
    })
    return {
        promise,
        cancel() {
            clearTimeout(timer)
            finish()
        }
    }
}

// `run(binding, windowMs, controlSignal)`. windowMs 0 does not abort on the clock.
// controlSignal aborts the loser of a hedge. A connected fallback starts in parallel
// after the window; the primary keeps running until it finishes or the fallback returns.
async function runFallback(fallback, run, onUse, error) {
    if (onUse) onUse(error)
    try {
        return await run(fallback, 0)
    } catch (next) {
        throw fallbackFailed(next)
    }
}

async function hedgeModels({ primary, fallback, run, onUse, windowMs }) {
    const primaryCtl = new AbortController()
    let primaryState = null
    const primaryTask = run(primary, 0, primaryCtl.signal).then(
        (value) => {
            primaryState = { ok: true, value }
            return primaryState
        },
        (error) => {
            primaryState = { ok: false, error }
            return primaryState
        }
    )
    const delay = cancellableDelay(windowMs)
    await Promise.race([primaryTask, delay.promise])
    delay.cancel()
    if (primaryState?.ok) return primaryState.value
    if (primaryState && !primaryState.ok) {
        if (!isFallbackTrigger(primaryState.error)) throw primaryState.error
        return runFallback(fallback, run, onUse, primaryState.error)
    }
    const fallbackCtl = new AbortController()
    let fallbackState = null
    const fallbackTask = run(fallback, 0, fallbackCtl.signal).then(
        (value) => {
            fallbackState = { ok: true, value }
            return fallbackState
        },
        (error) => {
            fallbackState = { ok: false, error }
            return fallbackState
        }
    )
    const winner = await Promise.race([primaryTask, fallbackTask])
    if (winner?.ok && winner === primaryState) {
        fallbackCtl.abort()
        return winner.value
    }
    if (winner?.ok && winner === fallbackState) {
        primaryCtl.abort()
        if (onUse) onUse(primaryState?.error)
        return winner.value
    }
    if (winner === primaryState) {
        if (!isFallbackTrigger(winner.error)) {
            fallbackCtl.abort()
            throw winner.error
        }
        const other = await fallbackTask
        if (other.ok) {
            if (onUse) onUse(winner.error)
            return other.value
        }
        throw fallbackFailed(other.error)
    }
    const other = await primaryTask
    if (other.ok) return other.value
    if (!isFallbackTrigger(other.error)) throw other.error
    throw fallbackFailed(winner.error)
}

export async function withModelFallback({ primary, fallback, run, onUse }) {
    const windowMs = fallback?.nodeName && !sameModelBinding(primary, fallback) ? modelFallbackMs() : 0
    if (windowMs > 0) return hedgeModels({ primary, fallback, run, onUse, windowMs })
    try {
        return await run(primary, 0)
    } catch (error) {
        if (!isFallbackTrigger(error)) throw error
        if (!fallback?.nodeName || sameModelBinding(primary, fallback)) throw noFallbackError(error)
        return runFallback(fallback, run, onUse, error)
    }
}
