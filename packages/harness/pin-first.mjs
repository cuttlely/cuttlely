import { validateArgs, compilePinned } from './runtime/pinned-query.mjs'
import { pinnedQueriesEnabled, parsePinnedQueries, validPinnedQueryName, findIsolatedPinnedQuery } from './pinned-names.mjs'

const reserved = new Set(['sql', 'statement', 'query', 'cursor', 'page', 'binds', 'checktext', '__proto__', 'constructor', 'prototype'])
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
function regex(pattern) {
    if (typeof pattern !== 'string' || !pattern.length || pattern.length > 200) throw Error('Invalid pin-first pattern.')
    return new RegExp(pattern, 'i')
}
function hasCapture(pattern) {
    let bracket = false
    for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] === '\\') {
            index++
            continue
        }
        if (pattern[index] === '[') bracket = true
        if (pattern[index] === ']') bracket = false
        if (
            !bracket &&
            pattern[index] === '(' &&
            (pattern[index + 1] !== '?' || (pattern[index + 2] === '<' && !['=', '!'].includes(pattern[index + 3])))
        )
            return true
    }
    return false
}

export function parsePinFirstRules(value) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value)
        } catch {
            throw Error('Invalid pin-first rules.')
        }
    }
    return value
}
export function validatePinFirstRules(rules) {
    if (!Array.isArray(rules) || !rules.length) return []
    if (rules.length > 8) throw Error('At most eight pin-first rules are allowed.')
    const ids = new Set()
    for (const rule of rules) {
        if (object(rule) && Object.getOwnPropertyNames(rule).some((name) => reserved.has(name.toLowerCase())))
            throw Error('Invalid pin-first rule.')
        if (
            !object(rule) ||
            typeof rule.id !== 'string' ||
            !/^[a-z0-9-]{1,40}$/.test(rule.id) ||
            ids.has(rule.id) ||
            !validPinnedQueryName(rule.pin)
        )
            throw Error('Invalid pin-first rule.')
        ids.add(rule.id)
        if (!Array.isArray(rule.when) || !rule.when.length || rule.when.length > 8) throw Error('Invalid pin-first conditions.')
        rule.when.forEach(regex)
        if (rule.params !== undefined && !object(rule.params)) throw Error('Invalid pin-first parameters.')
        for (const name of Object.getOwnPropertyNames(rule.params || {})) {
            const param = rule.params[name]
            if (reserved.has(name.toLowerCase()) || !object(param) || !['fixed', 'default', 'extract'].includes(param.source))
                throw Error('Invalid pin-first parameter.')
            if (param.source === 'extract') regex(param.pattern)
        }
        if (!object(rule.answer)) throw Error('Invalid pin-first answer.')
        const answer = rule.answer
        for (const name of ['heading', 'preamble', 'thresholdLine', 'emptyText', 'errorText', 'noMatchText']) {
            if (answer[name] != null && typeof answer[name] !== 'string') throw Error('Invalid pin-first answer text.')
        }
        if (answer.closing !== undefined && (!Array.isArray(answer.closing) || answer.closing.some((line) => typeof line !== 'string')))
            throw Error('Invalid pin-first closing lines.')
        if (
            answer.columns !== undefined &&
            (!Array.isArray(answer.columns) ||
                answer.columns.some(
                    (col) => !object(col) || typeof col.key !== 'string' || (col.header !== undefined && typeof col.header !== 'string')
                ))
        )
            throw Error('Invalid pin-first columns.')
        if (
            answer.note !== undefined &&
            (!object(answer.note) ||
                typeof answer.note.column !== 'string' ||
                !Array.isArray(answer.note.fillColumns) ||
                answer.note.fillColumns.some((name) => typeof name !== 'string'))
        )
            throw Error('Invalid pin-first note.')
    }
    return rules
}

export function matchPinFirst(specialist, question, env = process.env) {
    if (specialist?.pinFirst !== true) return { reason: 'off' }
    if (!pinnedQueriesEnabled(env)) return { reason: 'pins-off' }
    try {
        if (findIsolatedPinnedQuery([specialist], env)) return { reason: 'isolated' }
        const rules = validatePinFirstRules(specialist.pinFirstRules)
        const matches = rules.filter((rule) => rule.when.some((pattern) => regex(pattern).test(question)))
        if (matches.length !== 1) return { reason: matches.length ? 'ambiguous' : 'no-match' }
        const rule = matches[0]
        const bindings = [...(specialist.modules || []), ...(specialist.mcpServers || [])]
        const found = bindings.flatMap((binding) =>
            binding.nodeName === 'postgreSQLMCP'
                ? parsePinnedQueries(binding.inputs?.pinnedQueries)
                      .filter((entry) => entry.name === rule.pin && String(entry.testedStamp || '').trim())
                      .map((entry) => ({ entry, binding }))
                : []
        )
        if (found.length !== 1) return { reason: 'missing-pin' }
        const { entry, binding } = found[0]
        const raw = Object.create(null)
        for (const name of Object.getOwnPropertyNames(rule.params || {})) {
            if (reserved.has(name.toLowerCase())) return { reason: 'bad-param' }
            const spec = entry.params?.find((param) => param.name === name)
            if (!spec) return { reason: 'bad-param' }
            const param = rule.params[name]
            if (param.source === 'fixed') raw[name] = param.value
            else if (param.source === 'default') raw[name] = spec.default
            else {
                const re = regex(param.pattern)
                if (!hasCapture(param.pattern)) return { reason: 'bad-param' }
                const captures = new Set()
                const text = String(question)
                let offset = 0
                let matched = false
                while (offset <= text.length) {
                    // Keep anchors and lookarounds relative to the whole question.
                    const search = offset ? new RegExp(`^[\\s\\S]{${offset}}[\\s\\S]*?(?:${re.source})`, 'i') : re
                    const hit = search.exec(text)
                    if (!hit) break
                    matched = true
                    if (hit.length < 2 || hit[1] === undefined) return { reason: 'bad-param' }
                    captures.add(hit[1])
                    if (captures.size > 1) return { reason: 'ambiguous-param' }
                    const end = offset ? hit[0].length : hit.index + hit[0].length
                    offset = Math.max(offset + 1, end)
                }
                if (matched) raw[name] = [...captures][0]
                else if (param.fallback === 'default') raw[name] = spec.default
                else return { reason: 'bad-param' }
            }
        }
        const values = validateArgs(entry, raw)
        const args = Object.create(null)
        compilePinned(entry).order.forEach((name, index) => {
            if (reserved.has(name.toLowerCase()) || !entry.params?.some((param) => param.name === name))
                throw Error('Invalid pin-first parameter.')
            const spec = entry.params.find((param) => param.name === name)
            args[name] = spec.type === 'bool' && values[index] !== null ? values[index] === 'true' : values[index]
        })
        const defaults = Object.create(null)
        for (const param of entry.params || []) {
            if (param.default === undefined) continue
            const values = validateArgs(entry, Object.assign(Object.create(null), args, { [param.name]: param.default }))
            defaults[param.name] = values[compilePinned(entry).order.indexOf(param.name)]
        }
        return { rule, entry, binding, args, defaults }
    } catch {
        return { reason: 'bad-param' }
    }
}

export function escapePinText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/&/g, '&amp;')
        .replace(/\|/g, '\\|')
        .replace(/`/g, '\\`')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\r\n]/g, ' ')
}
const authored = (text) =>
    String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
const interpolate = (text, args) =>
    authored(text).replace(/\{\{param\.([a-zA-Z0-9_]+)\}\}/g, (_, name) => (Object.hasOwn(args, name) ? escapePinText(args[name]) : ''))
export function renderPinError(rule, error) {
    return authored(rule.answer.errorText || 'Pinned tool {{pin}} failed: {{error}}.').replace(/\{\{(pin|error)\}\}/g, (_, name) =>
        escapePinText(name === 'pin' ? rule.pin : error)
    )
}
export function renderPinResult(body, rule, args, { rowCap = 100, defaults = {} } = {}) {
    const answer = rule.answer
    const rows = Array.isArray(body.rows) ? body.rows : []
    const columns = (answer.columns || Object.getOwnPropertyNames(rows[0] || {}).map((key) => ({ key, header: key }))).slice(0, 16)
    const cell = (value) => escapePinText(String(value ?? '').slice(0, 200))
    const shownRows = Math.max(1, Math.min(100, rowCap))
    const lines = []
    if (!rows.length && answer.emptyText?.trim()) lines.push(authored(answer.emptyText))
    else {
        if (answer.preamble) lines.push(authored(answer.preamble))
        lines.push(interpolate(answer.heading, args) || '## Pinned query result')
        if (columns.length) {
            const table = []
            table.push(`| ${columns.map((col) => cell(col.header || col.key)).join(' | ')} |`)
            table.push(`| ${columns.map(() => '---').join(' | ')} |`)
            for (const row of rows.slice(0, shownRows)) {
                table.push(
                    `| ${columns
                        .map((col) =>
                            cell(
                                answer.note && row?.[answer.note.column] === answer.note.value && answer.note.fillColumns?.includes(col.key)
                                    ? answer.note.value
                                    : row?.[col.key]
                            )
                        )
                        .join(' | ')} |`
                )
            }
            lines.push(table.join('\n'))
            if (rows.length > shownRows) lines.push(`Showing the first ${shownRows} of the ${rows.length} rows returned on this page.`)
        }
    }
    if (answer.thresholdLine) {
        const names = [...answer.thresholdLine.matchAll(/\{\{param\.([a-zA-Z0-9_]+)\}\}/g)].map((hit) => hit[1])
        if (names.some((name) => String(args[name]) !== String(defaults[name]))) lines.push(interpolate(answer.thresholdLine, args))
    }
    lines.push(escapePinText(body.summary || `returned ${rows.length} of ${rows.length} rows`))
    for (const line of answer.closing || []) lines.push(interpolate(line, args))
    return lines.filter(Boolean).join('\n\n')
}
