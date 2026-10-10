// The restart screen: what Cuttlely is doing while it restarts, read from /api/v1/ping.
// While Cuttlely starts, the start-up page answers 503 with { status: 'starting', step }; before that the server
// may not answer at all. Back means it answered again after it was seen stopping or starting.

export const POLL_MS = 1000
export const SLOW_AFTER_MS = 3 * 60 * 1000

/** What one ping told us: up, starting (with the step Cuttlely is on), or down. */
export function readProbe(result) {
    if (!result || result.error) return { kind: 'down' }
    if (result.status === 200) return { kind: 'up' }
    if (result.status === 503 && result.body && result.body.status === 'starting') {
        return { kind: 'starting', step: typeof result.body.step === 'string' ? result.body.step : '' }
    }
    if (result.status >= 500) return { kind: 'down' }
    return { kind: 'up' }
}

export function initialRestart({ saved = 0, waitingFor = 0, startedAt = 0 } = {}) {
    return { saved, waitingFor, startedAt, stopped: false, back: false, step: '', slow: false, outcome: 'checking' }
}

/**
 * Once back: did the new settings start, or did safe boot put back the last settings that worked? rolledBack comes
 * from the server settings view of the new start; null (could not ask) counts as applied.
 */
export function withOutcome(state, rolledBack) {
    if (!state.back) return state
    return { ...state, outcome: rolledBack ? 'rolled-back' : 'applied' }
}

export const restartFailed = (state) => state.back && state.outcome === 'rolled-back'

export function restartTitle(state) {
    if (restartFailed(state)) return 'The new settings did not start'
    return state.back ? 'Cuttlely is back' : 'Restarting Cuttlely'
}

/** Folds one ping into the restart state. */
export function nextRestart(state, probe, now) {
    if (state.back) return state
    const next = { ...state, slow: now - state.startedAt > SLOW_AFTER_MS }
    if (probe.kind === 'down') return { ...next, stopped: true }
    if (probe.kind === 'starting') return { ...next, stopped: true, step: probe.step || next.step }
    // up: only counts once the old server was seen going away
    if (next.stopped) return { ...next, back: true, slow: false }
    return next
}

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`
}

/** The steps on screen, each done, active or waiting. */
export function restartSteps(state) {
    const steps = []
    const savedLabel = state.saved ? `Saved ${plural(state.saved, 'setting', 'settings')}` : 'Saved'
    steps.push({ id: 'saved', label: savedLabel, status: 'done' })
    if (state.waitingFor) {
        steps.push({
            id: 'runs',
            label: `Let ${plural(state.waitingFor, 'run', 'runs')} finish`,
            status: state.stopped || state.back ? 'done' : 'active'
        })
    }
    steps.push({
        id: 'stopping',
        label: 'Stopping',
        status: state.stopped || state.back ? 'done' : state.waitingFor ? 'waiting' : 'active'
    })
    if (restartFailed(state)) {
        steps.push({ id: 'starting', label: 'Starting with the new settings', status: 'failed' })
        steps.push({ id: 'rollback', label: 'Put back the last settings that worked', status: 'done' })
        steps.push({ id: 'back', label: 'Back', status: 'done' })
        return steps
    }
    steps.push({
        id: 'starting',
        label: state.step && !state.back ? `Starting: ${state.step}` : 'Starting',
        status: state.back ? 'done' : state.stopped ? 'active' : 'waiting'
    })
    steps.push({ id: 'back', label: 'Back', status: state.back ? 'done' : 'waiting' })
    return steps
}

/** One line under the steps. */
export function restartSummary(state) {
    if (restartFailed(state)) {
        return 'Cuttlely could not get ready with the new settings, so safe boot put back the last settings that worked. Your changes are kept aside: see what changed, fix it, and try again.'
    }
    if (state.back) {
        return state.saved
            ? `Running with ${plural(state.saved, 'new setting', 'new settings')} applied.`
            : 'Running with the saved settings.'
    }
    if (state.slow) {
        return 'This is taking longer than usual. Check the server log; Cuttlely keeps the last settings that started if the new ones do not.'
    }
    if (state.stopped) return 'Cuttlely is starting with the saved settings. This page carries on when it is back.'
    if (state.waitingFor) return 'New runs wait until Cuttlely is back. Runs in progress get to finish first.'
    return 'Cuttlely is stopping to apply the saved settings.'
}
