// The live status line on a running harness run card.
// Every line comes from an event the run already streamed (route, specialist, tool, handoff).
// packages/chat-widget/src/live-status.js is a byte-for-byte copy so the app chat and the embedded widget say the same thing.
// The optional enhanced lines are display only. They are never stored in a trace, chat history, or export.

export const LIVE_ANNOUNCE_GAP_MS = 4000
export const ENHANCED_DELAY_MS = 4000
export const ENHANCED_ROTATE_MS = 3500

// Generic on purpose: an enhanced line never names a specialist, tool, table, query, or data source.
export const ENHANCED_LINES = {
    tool: ['Cross-checking the numbers…', 'Lining up the joins…'],
    thinking: ['Weighing a few angles…'],
    handoff: ['Polishing the wording…', 'Double-checking the totals…']
}

const TOOL_PHRASES = {
    query: 'a SQL query',
    describe: 'a table description',
    list_tables: 'a table listing',
    list_relations: 'a table listing',
    pin_definition: 'a saved query lookup'
}

const SAVED_QUERY = /^pq_[a-z0-9_]+$/i

function shortToolName(name) {
    const text = String(name || '').trim()
    const match = /^mcp__(.+?)__(.+)$/.exec(text)
    return match ? match[2] : text
}

// "a SQL query" for the known analyst tools. Any other tool is named by the label the caller passes
// (the app chat passes its tool chip label), else by the tool's own name.
export function toolPhrase(tool, toolLabel) {
    const short = shortToolName(tool?.name)
    if (TOOL_PHRASES[short]) return TOOL_PHRASES[short]
    if (SAVED_QUERY.test(short)) return 'a saved query'
    const label = typeof toolLabel === 'function' ? toolLabel(tool) : ''
    return `${label || short || 'a tool'}`
}

function specialistStatus(specialist, toolLabel) {
    const tools = Array.isArray(specialist?.tools) ? specialist.tools : []
    const last = tools[tools.length - 1]
    if (last && last.status === 'running') {
        const phrase = toolPhrase(last, toolLabel)
        return { phase: 'tool', row: `Running ${phrase}…`, verb: `is running ${phrase}…` }
    }
    if (last) return { phase: 'thinking', row: 'Thinking about the results…', verb: 'is thinking about the results…' }
    return { phase: 'working', row: 'Working…', verb: 'is working…' }
}

/**
 * The status of a running trace: { line, phase, perSpecialist } or null once the run has ended.
 * trace: { status, route: { status }, handoff: { status }, specialists: [{ name, status, tools: [{ name, status }] }] }.
 * phase is one of start, route, working, tool, thinking, handoff, waiting.
 */
export function liveStatus(trace, { toolLabel } = {}) {
    if (!trace || trace.status !== 'running') return null
    const specialists = Array.isArray(trace.specialists) ? trace.specialists : []
    const perSpecialist = {}
    let main = null
    for (const specialist of specialists) {
        if (specialist?.status !== 'running') continue
        const status = specialistStatus(specialist, toolLabel)
        perSpecialist[specialist.name] = status.row
        // A specialist running a tool is the most specific thing to say; otherwise the latest one to start.
        if (!main || status.phase === 'tool' || main.status.phase !== 'tool') main = { name: specialist.name, status }
    }
    const handoff = trace.handoff?.status
    if (handoff === 'running' || handoff === 'done') {
        return { line: 'Pulling it together and writing the answer…', phase: 'handoff', perSpecialist }
    }
    if (main) return { line: `${main.name} ${main.status.verb}`, phase: main.status.phase, perSpecialist }
    const route = trace.route?.status
    const started = specialists.some((item) => item && item.status !== 'running' && item.status !== 'queued')
    if (route === 'running' || (route === 'done' && !started)) return { line: 'Picking specialists…', phase: 'route', perSpecialist }
    if (route === 'done' || started) return { line: 'Working…', phase: 'waiting', perSpecialist }
    return { line: 'Starting…', phase: 'start', perSpecialist }
}

// The enhanced line for a phase that has shown the same real line for sinceMs, or '' when there is none.
export function enhancedLine(phase, sinceMs, enabled = true) {
    const list = ENHANCED_LINES[phase]
    if (!enabled || !list || !Number.isFinite(sinceMs) || sinceMs < ENHANCED_DELAY_MS) return ''
    return list[Math.floor((sinceMs - ENHANCED_DELAY_MS) / ENHANCED_ROTATE_MS) % list.length]
}

// Screen readers hear a new status line at most once per gap. The timer and enhanced lines are never announced.
export function nextAnnouncement(previous, line, now, gap = LIVE_ANNOUNCE_GAP_MS) {
    const prev = previous || { text: '', at: -Infinity }
    if (!line || line === prev.text || now - prev.at < gap) return prev
    return { text: line, at: now }
}

// "0:07", "1:05", "1:02:03" for the ticking timer.
export function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
