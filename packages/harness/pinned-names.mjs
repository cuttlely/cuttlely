// Shared pinned-query names for the harness. The runtime module has its own copy.
// This file does not import that module, so the harness still loads before it exists.

import { HarnessError } from './errors.mjs'

export const PINNED_PREFIX = 'pq_'
export const PINNED_TOOL_RE = /(^|__)pq_[a-z0-9_]+$/
export const PINNED_NAME_RE = /^pq_[a-z0-9_]+$/
export const PINNED_NAME_MAX = 64

export const PINNED_OFF_ERROR = 'Pinned queries are turned off on this server.'
export const PINNED_MISSING_ERROR = 'This pinned query is not offered.'
export const PINNED_AUTO_ERROR = 'Pinned queries need a Postgres URL on this node. Isolated analyst storage cannot run them.'
export const PINNED_QUERY_GUIDANCE =
    'Pinned query tools run SQL a builder wrote and tested. When one fits, call it and report its rows as returned; do not write SQL for that question.'

export const pinnedQueriesEnabled = (env = process.env) => env?.CUTTLELY_PINNED_QUERIES === '1' || env?.CUTTLELY_PINNED_QUERIES === 'true'

const PINNED_TAIL_CHAR = /[a-z0-9_]/

// Same answer as PINNED_TOOL_RE.test(name), in one pass, so a long hostile name cannot make it slow.
export function isPinnedToolName(name) {
    const text = String(name || '')
        .trim()
        .toLowerCase()
    let tail = text.length
    while (tail > 0 && PINNED_TAIL_CHAR.test(text[tail - 1])) tail--
    // A match needs `pq_` (at the start, or right after `__`) followed only by tail characters, at least one.
    if (tail === 0 && text.length > PINNED_PREFIX.length && text.startsWith(PINNED_PREFIX)) return true
    const marker = '__' + PINNED_PREFIX
    const at = text.indexOf(marker, Math.max(0, tail - marker.length))
    return at !== -1 && at + marker.length < text.length
}

export function validPinnedQueryName(name) {
    return typeof name === 'string' && name.length <= PINNED_NAME_MAX && PINNED_NAME_RE.test(name)
}

export function parsePinnedQueries(value) {
    if (value == null || value === '') return []
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            return []
        }
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
}

export function pinnedToolRefusal(toolName, env = process.env) {
    return {
        error: pinnedQueriesEnabled(env) && isPinnedToolName(toolName) ? PINNED_MISSING_ERROR : PINNED_OFF_ERROR,
        cuttlelyOutcome: 'expected'
    }
}

function analystBindings(specialist) {
    return [...(specialist?.modules || []), ...(specialist?.mcpServers || [])].filter((binding) => binding?.nodeName === 'postgreSQLMCP')
}

export function specialistHasStampedPin(specialist) {
    for (const binding of analystBindings(specialist)) {
        for (const entry of parsePinnedQueries(binding?.inputs?.pinnedQueries)) {
            if (validPinnedQueryName(entry?.name) && String(entry?.testedStamp || '').trim()) return true
        }
    }
    return false
}

// A secure value is never stored. Other values are stored only while previews are on.
export function capturePinnedParams(args, secureNames, preview) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null
    const skip = new Set(['cursor', 'page', 'sql', 'statement', 'query', '_cuttlelyscope', '_cuttlelycallid'])
    const secure = new Set((secureNames || []).map((name) => String(name)))
    const out = {}
    for (const key of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(args, key) || skip.has(key.toLowerCase())) continue
        if (secure.has(key)) {
            out[key] = '[redacted]'
            continue
        }
        if (!preview) continue
        const value = args[key]
        if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    }
    return Object.keys(out).length ? out : null
}

export function secureParamNames(binding) {
    const names = new Map()
    for (const entry of parsePinnedQueries(binding?.inputs?.pinnedQueries)) {
        if (!validPinnedQueryName(entry?.name)) continue
        const secure = []
        for (const param of Array.isArray(entry.params) ? entry.params : []) {
            if (param && param.secure && typeof param.name === 'string') secure.push(param.name)
        }
        names.set(entry.name, secure)
    }
    return names
}

function specialistLabel(specialist) {
    const name = typeof specialist?.name === 'string' ? specialist.name.trim() : ''
    return name || 'specialist'
}

export function findDuplicatePinnedQuery(specialists) {
    for (const specialist of specialists || []) {
        const seen = new Set()
        for (const binding of analystBindings(specialist)) {
            for (const entry of parsePinnedQueries(binding?.inputs?.pinnedQueries)) {
                if (!validPinnedQueryName(entry?.name)) continue
                if (seen.has(entry.name)) return { name: entry.name, specialist: specialistLabel(specialist) }
                seen.add(entry.name)
            }
        }
    }
    return null
}

function bindingIsIsolated(binding, env) {
    const cred = typeof binding?.credential === 'string' ? binding.credential.trim() : ''
    if (cred) return false
    if (String(env?.CUTTLELY_POSTGRES_URL || '').trim()) return false
    return (
        String(env?.CUTTLELY_ANALYST || '')
            .trim()
            .toLowerCase() === 'auto'
    )
}

export function findIsolatedPinnedQuery(specialists, env = process.env) {
    if (!pinnedQueriesEnabled(env)) return null
    for (const specialist of specialists || []) {
        for (const binding of analystBindings(specialist)) {
            if (!bindingIsIsolated(binding, env)) continue
            const configured = parsePinnedQueries(binding?.inputs?.pinnedQueries).some((entry) => validPinnedQueryName(entry?.name))
            if (configured) return specialistLabel(specialist)
        }
    }
    return null
}

// With the flag on, refuses a roster that would offer the same pq_ name twice, or a pinned query on isolated storage.
// A draft save does not call this. With the flag off no pq_ tools register, so stored names are left in place and nothing is refused.
export function assertPinnedQueryRoster(roster, env = process.env) {
    if (!pinnedQueriesEnabled(env)) return
    const specialists = roster?.specialists || []
    const duplicate = findDuplicatePinnedQuery(specialists)
    if (duplicate) {
        throw new HarnessError(
            'duplicate_pinned_query',
            `Pinned query "${duplicate.name}" is on more than one PostgreSQL MCP node for specialist "${duplicate.specialist}". Rename one of them.`
        )
    }
    if (findIsolatedPinnedQuery(specialists, env)) {
        throw new HarnessError('pinned_query_auto', PINNED_AUTO_ERROR)
    }
}

// A pin parameter as a model passes it: int8 and numeric take a number, bool a boolean, anything else a string.
function hintType(type) {
    if (type === 'int8' || type === 'numeric' || type === 'number' || type === 'integer') return 'number'
    if (type === 'bool' || type === 'boolean') return 'boolean'
    return 'string'
}

// "pq_name(param: type, ...)", so a model can call a pin by its own name with named arguments.
export function pinnedToolHint(name, params = []) {
    const list = (params || [])
        .filter((param) => param && typeof param.name === 'string' && param.name)
        .map((param) => `${param.name}: ${hintType(param.type)}`)
    return `${name}(${list.join(', ')})`
}

function offersFreeQuery(binding) {
    let actions = binding?.inputs?.mcpActions
    if (typeof actions === 'string') {
        try {
            actions = JSON.parse(actions)
        } catch {
            actions = []
        }
    }
    return Array.isArray(actions) && actions.includes('query')
}

// The pins a specialist offers when none of its PostgreSQL MCP nodes offers the free query tool. Empty when the
// flag is off, when any node offers query, or when no stamped pin is configured.
export function pinnedOnlyTools(specialist, env = process.env) {
    if (!pinnedQueriesEnabled(env)) return []
    const bindings = analystBindings(specialist)
    if (bindings.some(offersFreeQuery)) return []
    const pins = []
    for (const binding of bindings) {
        for (const entry of parsePinnedQueries(binding?.inputs?.pinnedQueries)) {
            if (!validPinnedQueryName(entry?.name) || !String(entry?.testedStamp || '').trim()) continue
            if (pins.some((pin) => pin.name === entry.name)) continue
            pins.push({ name: entry.name, params: Array.isArray(entry.params) ? entry.params : [] })
        }
    }
    return pins
}

// A call by a node's own name on a node that offers only pinned queries. A pin never stands in for another name.
export function pinnedOnlyRefusal(hints) {
    return {
        error: `This node offers pinned queries only, with no free SQL tool. Call ${hints.join(
            ' or '
        )} by its own name, with its parameters as named arguments, not SQL.`,
        cuttlelyOutcome: 'expected'
    }
}
