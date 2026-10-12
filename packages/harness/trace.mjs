import { sourceName } from './context.mjs'

const TASK_LIMIT = 500

const CHIEF_REASONS = {
    'chief.memory': 'Older turns were shortened so Harness Prime stayed inside its context budget.',
    'chief.request': 'The question was shortened so Harness Prime stayed inside its context budget.',
    'chief.instructions': 'Harness Prime instructions were shortened to fit the context budget.',
    'chief.toolResult': 'Specialist tool text was shortened before Harness Prime read it.',
    'chief.sources': 'Source snippets were shortened before Harness Prime read them.'
}

const SPECIALIST_PARTS = {
    instructions: (name) => `Instructions for ${name} were shortened to fit the specialist context budget.`,
    memory: (name) => `Older turns were dropped from ${name}'s prompt to fit the context budget.`,
    task: (name) => `The task for ${name} was shortened to fit the specialist context budget.`,
    toolResult: (name) => `Tool text from ${name} was shortened before Harness Prime read it.`,
    sources: (name) => `Source snippets from ${name} were shortened before Harness Prime read them.`
}

export function publicTask(task) {
    const value = String(task ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    if (value.length <= TASK_LIMIT) return value
    return `${value.slice(0, TASK_LIMIT)}…`
}

export function publicModelLabel(binding) {
    if (!binding || typeof binding !== 'object') return ''
    const label = String(binding.label || binding.nodeName || '').trim()
    const raw = binding.inputs && (binding.inputs.modelName || binding.inputs.model)
    const model = typeof raw === 'string' ? raw.trim() : ''
    const safeModel = model && model.length <= 80 && !/sk-|api[_-]?key|bearer |secret|password/i.test(model) ? model : ''
    if (label && safeModel && label !== safeModel) return `${label} · ${safeModel}`
    return label || safeModel
}

export function publicSourceName(doc) {
    const name = sourceName(doc)
    if (!name) return ''
    const normalized = name.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
        const base = normalized.split('/').filter(Boolean).pop()
        return base || 'source'
    }
    return name.slice(0, 180)
}

export function publicSources(sources) {
    const seen = new Set()
    const list = []
    for (const doc of sources || []) {
        const name = publicSourceName(doc)
        if (!name || seen.has(name)) continue
        seen.add(name)
        list.push({ name })
        if (list.length >= 8) break
    }
    return list
}

export function explainTruncation(field) {
    const key = String(field || '')
    if (CHIEF_REASONS[key]) return CHIEF_REASONS[key]
    const match = /^specialist:([^.]+)\.(.+)$/.exec(key)
    if (match && SPECIALIST_PARTS[match[2]]) return SPECIALIST_PARTS[match[2]](match[1])
    return key ? `${key} was shortened to fit the context budget.` : 'Part of the prompt was shortened to fit the context budget.'
}

export function sumCallTokens(calls) {
    let prompt = 0
    let completion = 0
    let cached = 0
    let seen = false
    let cachedSeen = false
    for (const call of calls || []) {
        if (!call?.tokens) continue
        seen = true
        prompt += Number(call.tokens.prompt) || 0
        completion += Number(call.tokens.completion) || 0
        if (call.tokens.cached != null) {
            cachedSeen = true
            cached += Number(call.tokens.cached) || 0
        }
    }
    if (!seen) return null
    return cachedSeen ? { prompt, completion, cached } : { prompt, completion }
}

export const LOCAL_TOOL_BATCH = /takes exactly one entry for local tools/i

export function routeSummary(trace) {
    if (!trace) return ''
    if (trace.direct) {
        const name = trace.specialists?.[0]?.name || 'one specialist'
        return `Direct to ${name}`
    }
    if (trace.route?.status === 'running' || trace.route?.status === 'pending') return 'Harness Prime is choosing specialists'
    const steps = trace.route?.steps || []
    if (!steps.length) return 'Harness Prime answered directly'
    // A step that waited for another reads "then": "Harness Prime sent work to analyst, then writer".
    return `Harness Prime sent work to ${steps
        .filter((step) => step.specialist)
        .map((step) => (step.after ? `then ${step.specialist}` : step.specialist))
        .join(', ')}`
}

export function toolChipLabel(tool) {
    const status =
        tool?.status === 'running' ? 'running' : tool?.status === 'failed' ? 'failed' : tool?.status === 'retried' ? 'retried' : 'done'
    return `${tool?.name || 'tool'} · ${status}`
}

export const TRACE_ROW_LIMIT = 100

function isAnalystQueryChip(name) {
    const value = String(name || '')
    return value === 'query' || value.endsWith('__query')
}

function rowCell(value) {
    if (value == null) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
}

// The rows an analyst query returned, from the result the trace keeps on that query's chip. Harness Prime gets a
// short handoff and the answer may show only the top rows. The run card shows the whole list, up to the row cap.
export function analystChipRows(tool) {
    if (!tool?.detail || !isAnalystQueryChip(tool.name)) return null
    let body
    try {
        body = JSON.parse(String(tool.detail))?.result
        if (typeof body === 'string') body = JSON.parse(body)
    } catch {
        return null
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.rows)) return null
    const rows = body.rows.slice(0, TRACE_ROW_LIMIT).filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    if (!rows.length) return null
    const columns = []
    for (const row of rows) {
        for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
    }
    return {
        columns,
        rows: rows.map((row) => columns.map((key) => rowCell(row[key]))),
        summary: typeof body.summary === 'string' ? body.summary.trim() : '',
        truncated: body.truncated === true
    }
}

// A batched local tool_call is rejected, then the model sends one call at a time.
// That first rejection is recovered when a later tool in the same turn finishes.
export function settleToolChips(tools) {
    const list = (tools || []).filter((tool) => tool && typeof tool === 'object').map((tool) => ({ ...tool }))
    for (let i = 0; i < list.length; i += 1) {
        const tool = list[i]
        if (tool.status !== 'failed' || tool.name !== 'tool_call') continue
        if (!LOCAL_TOOL_BATCH.test(String(tool.detail || ''))) continue
        const recovered = list.slice(i + 1).some((later) => later.status === 'done' || later.status === 'retried')
        if (recovered) tool.status = 'retried'
    }
    return list
}

export function snapshotSpecialist({ calls, tools, name, configuredModel, failed = false }) {
    const related = (calls || []).filter((call) => call.name === name && (call.role === 'specialist' || call.role === 'fill'))
    const last = [...related].reverse().find((call) => call.model)
    const ownTools = settleToolChips(
        (tools || [])
            .filter((tool) => tool.specialist === name)
            .map((tool) => ({
                name: tool.name,
                status: tool.status === 'running' && failed ? 'failed' : tool.status,
                ...(tool.detail ? { detail: tool.detail } : {})
            }))
    )
    return {
        model: last?.model || configuredModel || '',
        fallback: last?.fallback || '',
        tokens: sumCallTokens(related),
        tools: ownTools
    }
}

export function formatDuration(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return ''
    const value = Math.max(0, Number(ms))
    if (value < 1000) return `${Math.round(value)} ms`
    const seconds = value / 1000
    if (seconds < 10) return `${seconds.toFixed(1)} s`
    return `${Math.round(seconds)} s`
}

export function formatTokens(tokens) {
    if (!tokens || (tokens.prompt == null && tokens.completion == null)) return ''
    const count = (value) => (value == null ? '—' : Number(value).toLocaleString('en-US'))
    const cached = Number(tokens.cached) > 0 ? ` (${count(tokens.cached)} cached)` : ''
    return `${count(tokens.prompt)} in${cached} · ${count(tokens.completion)} out`
}

function blankRoute() {
    return { status: 'pending', ms: null, model: '', fallback: '', tokens: null, steps: [] }
}

function blankHandoff() {
    return { status: 'pending', ms: null, model: '', fallback: '', tokens: null }
}

export function emptyTrace(harness = '') {
    return {
        harness: harness || '',
        status: 'running',
        direct: false,
        wallMs: null,
        error: '',
        timings: { routeMs: 0, specialistsMs: 0, handoffMs: 0, profileMs: 0, profileSkipped: false },
        tokens: { prompt: null, completion: null },
        truncated: [],
        route: blankRoute(),
        specialists: [],
        handoff: blankHandoff()
    }
}

function specialistShell(name) {
    return {
        name,
        task: '',
        status: 'running',
        model: '',
        fallback: '',
        ms: null,
        tokens: null,
        tools: [],
        sources: [],
        error: ''
    }
}

function withSpecialist(trace, name, patch) {
    const specialists = trace.specialists.map((item) => ({ ...item, tools: [...item.tools], sources: [...item.sources] }))
    let index = specialists.findIndex((item) => item.name === name)
    if (index < 0) {
        specialists.push(specialistShell(name))
        index = specialists.length - 1
    }
    const current = specialists[index]
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) next[key] = value
    }
    specialists[index] = next
    return specialists
}

function noteTool(specialists, event) {
    const name = event.specialist || ''
    const next = withSpecialist({ specialists }, name, {})
    const specialist = next.find((item) => item.name === name)
    const tools = [...specialist.tools]
    if (event.phase === 'start') {
        tools.push({ name: event.name || 'tool', status: 'running' })
    } else {
        const open = [...tools].reverse().find((tool) => tool.name === event.name && tool.status === 'running')
        const status = event.error ? 'failed' : 'done'
        const detail = event.detail ? String(event.detail) : ''
        if (open) {
            open.status = status
            if (detail) open.detail = detail
        } else tools.push({ name: event.name || 'tool', status, ...(detail ? { detail } : {}) })
    }
    return withSpecialist({ specialists: next }, name, { tools: settleToolChips(tools) })
}

export function reduceHarnessEvent(trace, event) {
    const current = trace || emptyTrace(event?.harness)
    if (!event || typeof event !== 'object') return current
    if (event.type === 'final') {
        if (event.trace?.specialists && event.trace?.route) {
            return event.trace.status === 'running' ? { ...event.trace, status: 'completed' } : event.trace
        }
        return traceFromPayload(event) || current
    }
    const next = {
        ...current,
        harness: event.harness || current.harness,
        tokens: { ...current.tokens },
        timings: { ...current.timings },
        truncated: [...current.truncated],
        route: { ...current.route, steps: [...(current.route.steps || [])] },
        specialists: current.specialists.map((item) => ({
            ...item,
            tools: item.tools.map((tool) => ({ ...tool })),
            sources: item.sources.map((source) => ({ ...source }))
        })),
        handoff: { ...current.handoff }
    }
    if (event.type === 'route' && event.phase === 'start') {
        next.route = { ...next.route, status: 'running' }
        return next
    }
    if (event.type === 'route' && event.phase === 'done') {
        next.direct = Boolean(event.direct)
        next.route = {
            ...next.route,
            status: 'done',
            ms: event.ms ?? next.route.ms,
            model: event.model || next.route.model,
            fallback: event.fallback || next.route.fallback || '',
            tokens: event.tokens === undefined ? next.route.tokens : event.tokens,
            steps: Array.isArray(event.steps)
                ? event.steps.map((step) => ({
                      specialist: step.specialist,
                      task: step.task || '',
                      ...(step.after ? { after: step.after } : {})
                  }))
                : next.route.steps
        }
        return next
    }
    if (event.type === 'specialist' && event.phase === 'start') {
        next.specialists = withSpecialist(next, event.name, {
            status: 'running',
            task: event.task || '',
            model: event.model || ''
        })
        return next
    }
    if (event.type === 'specialist' && (event.phase === 'done' || event.phase === 'failed')) {
        next.specialists = withSpecialist(next, event.name, {
            status: event.status || (event.phase === 'failed' ? 'failed' : 'completed'),
            ms: event.ms ?? null,
            model: event.model || undefined,
            fallback: event.fallback || '',
            tokens: event.tokens === undefined ? undefined : event.tokens,
            tools: Array.isArray(event.tools) ? settleToolChips(event.tools) : undefined,
            sources: event.sources || undefined,
            error: event.error || '',
            task: event.task || undefined
        })
        return next
    }
    if (event.type === 'tool') {
        next.specialists = noteTool(next.specialists, event)
        return next
    }
    if (event.type === 'handoff' && event.phase === 'start') {
        next.handoff = { ...next.handoff, status: 'running', model: event.model || next.handoff.model }
        return next
    }
    if (event.type === 'handoff' && event.phase === 'done') {
        next.handoff = {
            ...next.handoff,
            status: 'done',
            ms: event.ms ?? next.handoff.ms,
            model: event.model || next.handoff.model,
            fallback: event.fallback || next.handoff.fallback || '',
            tokens: event.tokens === undefined ? next.handoff.tokens : event.tokens
        }
        return next
    }
    return next
}

export function failTrace(trace, message) {
    if (!trace) return trace
    const text = typeof message === 'string' ? message : message?.message || message?.error || 'The harness run stopped.'
    const reason = String(text).slice(0, 300)
    return {
        ...trace,
        status: 'failed',
        error: reason,
        specialists: (trace.specialists || []).map((item) =>
            item.status === 'running' ? { ...item, status: 'failed', error: item.error || 'Stopped before it finished.' } : item
        ),
        route: trace.route?.status === 'running' ? { ...trace.route, status: 'failed' } : trace.route,
        handoff: trace.handoff?.status === 'running' ? { ...trace.handoff, status: 'failed' } : trace.handoff
    }
}

export function buildRunTrace({
    harness,
    direct = false,
    steps = [],
    agents = [],
    timings = {},
    report = {},
    profileSkipped = false,
    wallMs = null,
    routeModel = '',
    routeTokens = null,
    routeFallback = '',
    handoffModel = '',
    handoffTokens = null,
    handoffFallback = '',
    handoffStatus = '',
    directDetail = null
} = {}) {
    const routeMs = timings.routeMs ?? 0
    const specialistsMs = timings.specialistsMs ?? timings.toolMs ?? 0
    const handoffMs = direct ? 0 : timings.handoffMs ?? 0
    const truncated = (report?.truncated || []).filter(Boolean).map((field) => ({ field, reason: explainTruncation(field) }))
    return {
        harness: harness || '',
        status: (agents || []).some((agent) => agent.status === 'failed') ? 'partial' : 'completed',
        direct: Boolean(direct),
        wallMs,
        error: '',
        timings: {
            routeMs,
            specialistsMs,
            handoffMs,
            profileMs: timings.profileMs ?? 0,
            profileSkipped: Boolean(profileSkipped)
        },
        tokens: {
            prompt: report?.tokens?.prompt ?? null,
            completion: report?.tokens?.completion ?? null,
            cached: report?.tokens?.cached ?? null
        },
        truncated,
        route: {
            status: 'done',
            ms: routeMs,
            model: routeModel || '',
            fallback: routeFallback || '',
            tokens: routeTokens,
            steps: (steps || []).map((step) => ({
                specialist: step.specialist || step.name || '',
                task: publicTask(step.task),
                ...(step.after ? { after: step.after } : {})
            }))
        },
        specialists: (agents || []).map((agent) => ({
            name: agent.name,
            task: publicTask(agent.task),
            status: agent.status || 'completed',
            model: agent.model || '',
            fallback: agent.fallback || '',
            ms: agent.ms ?? null,
            tokens: agent.tokens || null,
            tools: settleToolChips(agent.tools || []),
            sources: agent.sources || [],
            error: agent.error || ''
        })),
        handoff:
            direct || handoffStatus === 'skipped'
                ? { status: 'skipped', ms: null, model: '', fallback: '', tokens: null }
                : {
                      status: 'done',
                      ms: handoffMs,
                      model: handoffModel || '',
                      fallback: handoffFallback || '',
                      tokens: handoffTokens
                  },
        ...(direct && directDetail ? { directDetail } : {})
    }
}

export function traceFromPayload(payload) {
    let value = payload
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value)
        } catch {
            return null
        }
    }
    if (!value || typeof value !== 'object') return null
    if (value.trace?.specialists && value.trace?.route) {
        return value.trace.status === 'running' ? { ...value.trace, status: 'completed' } : value.trace
    }
    if (!value.harness && !Array.isArray(value.agents)) return null
    const rawTimings = value.timings || {}
    const reportTimings = value.report?.timings || {}
    const direct = rawTimings.fillMs != null || rawTimings.toolMs != null || rawTimings.prepareMs != null
    const timings = {
        routeMs: reportTimings.routeMs ?? rawTimings.routeMs ?? 0,
        specialistsMs: reportTimings.specialistsMs ?? rawTimings.specialistsMs ?? rawTimings.toolMs ?? 0,
        handoffMs: reportTimings.handoffMs ?? rawTimings.handoffMs ?? 0,
        profileMs: reportTimings.profileMs ?? rawTimings.profileMs ?? 0
    }
    const agents = (value.agents || []).map((agent) => ({
        ...agent,
        sources: Array.isArray(agent.sources) ? agent.sources : []
    }))
    return buildRunTrace({
        harness: value.harness || '',
        direct,
        steps: agents.map((agent) => ({ specialist: agent.name, task: agent.task || '' })),
        agents,
        timings,
        report: value.report || {},
        profileSkipped: timings.profileMs === 0,
        wallMs: timings.routeMs + timings.specialistsMs + timings.handoffMs
    })
}
