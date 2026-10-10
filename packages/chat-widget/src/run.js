// Folds the harness.* stream events into a small run summary for the run card.
// Event shapes come from Cuttlely's harness runtime (route, specialist, tool, handoff, final).

export function emptyRun(harness = '') {
    return { harness, phase: 'planning', specialists: [], startedAt: Date.now(), totalMs: null, failed: '' }
}

function upsert(list, name, patch) {
    const label = typeof name === 'string' && name ? name : 'specialist'
    const index = list.findIndex((item) => item.name === label)
    if (index === -1) return [...list, { name: label, status: 'queued', ms: null, task: '', ...patch }]
    const next = list.slice()
    next[index] = { ...next[index], ...patch }
    return next
}

export function reduceRun(run, type, event = {}) {
    const current = run || emptyRun(event.harness)
    const next = { ...current, harness: event.harness || current.harness }
    if (type === 'route' && event.phase === 'done') {
        next.phase = 'working'
        for (const step of Array.isArray(event.steps) ? event.steps : []) {
            next.specialists = upsert(next.specialists, step.specialist, { task: typeof step.task === 'string' ? step.task : '' })
        }
        if (event.direct) next.phase = 'writing'
    } else if (type === 'specialist' && event.phase === 'start') {
        next.phase = 'working'
        next.specialists = upsert(next.specialists, event.name, { status: 'running' })
    } else if (type === 'specialist' && (event.phase === 'done' || event.phase === 'failed')) {
        next.specialists = upsert(next.specialists, event.name, {
            status: event.phase === 'failed' || event.status === 'failed' ? 'failed' : 'done',
            ms: typeof event.ms === 'number' ? event.ms : null
        })
    } else if (type === 'handoff' && event.phase === 'start') {
        next.phase = 'writing'
    } else if (type === 'partial' && event.phase === 'answer') {
        next.phase = 'writing'
    } else if (type === 'final') {
        next.phase = 'done'
        const traced = event.trace && Array.isArray(event.trace.specialists) ? event.trace.specialists : null
        if (traced) {
            next.specialists = traced.map((item) => ({
                name: String(item.name || 'specialist'),
                status: item.status === 'failed' ? 'failed' : 'done',
                ms: typeof item.ms === 'number' ? item.ms : null,
                task: typeof item.task === 'string' ? item.task : ''
            }))
        } else {
            next.specialists = next.specialists.map((item) => (item.status === 'failed' ? item : { ...item, status: 'done' }))
        }
        const wall = event.trace?.wallMs ?? event.timings?.totalMs
        next.totalMs = typeof wall === 'number' ? wall : Date.now() - current.startedAt
    } else if (type === 'error') {
        next.phase = 'failed'
        next.failed = typeof event.message === 'string' ? event.message : 'The run stopped.'
    }
    return next
}

export function formatMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
    const seconds = ms / 1000
    return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}
