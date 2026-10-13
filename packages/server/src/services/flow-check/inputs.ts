// Recorded inputs for a form, webhook or schedule agentflow, taken from execution records.
// The publish check replays these instead of chat questions. `key` is canonical JSON so the
// same payload counts once. `text` is what a replay runs. A form keeps the stored field order.
import { parseStoredForm } from '../../utils/buildAgentflow'
import { TriggerStart } from './kinds'

export const NO_PAST_RUNS = 'No past runs to replay yet. Run this flow once, then check again.'

// Shown in place of a secret header or query value. The name stays; the value does not.
export const REDACTED = '[REDACTED]'

export const UNREPLAYABLE_FORM =
    'This recorded form cannot be replayed. An older run stored a line break inside a value, so the fields cannot be read back as they were submitted.'

const SENSITIVE_PARTS = ['authorization', 'cookie', 'token', 'secret', 'key', 'password', 'signature']

export interface ReplayCall {
    incoming: {
        question?: string
        form?: Record<string, unknown>
        webhook?: Record<string, unknown>
        streaming: false
        history: never[]
    }
    chatType: 'INTERNAL' | 'WEBHOOK' | 'SCHEDULED'
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return null
        try {
            value = JSON.parse(trimmed)
        } catch {
            return null
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (!value || typeof value !== 'object') return value
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
}

export function canonicalJson(value: unknown): string {
    const text = JSON.stringify(sortKeys(value))
    return text === undefined ? 'null' : text
}

// Header and query names whose values must not appear in a preview or an API response.
export function isSensitiveKey(name: string): boolean {
    const key = name.toLowerCase()
    return SENSITIVE_PARTS.some((part) => key.includes(part))
}

// Headers that change on every delivery and do not change what the flow does.
// Date, request id, trace, user agent, content length, forwarding, and signature or timestamp headers.
export function isVolatileHeader(name: string): boolean {
    const key = name.toLowerCase()
    if (key === 'date' || key === 'user-agent' || key === 'content-length') return true
    if (key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('forwarded-')) return true
    if (key.includes('request-id') || key.includes('requestid')) return true
    if (key.includes('trace')) return true
    if (key.includes('signature') || key.includes('timestamp')) return true
    return false
}

// A sensitive key hides its whole value. Other objects and arrays are walked, so user[password]=s3cret
// (stored as { user: { password } }) does not leak.
function maskValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => maskValue(item))
    if (value && typeof value === 'object') return maskBag(value as Record<string, unknown>)
    return value
}

function maskBag(bag: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(bag)) masked[key] = isSensitiveKey(key) ? REDACTED : maskValue(value)
    return masked
}

// Header names are case-insensitive. Volatile ones are left out so they cannot split two deliveries.
function stableHeaders(value: unknown): Record<string, unknown> {
    const source = asObject(value) || {}
    const headers: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(source)) {
        if (isVolatileHeader(key)) continue
        headers[key.toLowerCase()] = entry
    }
    return headers
}

export interface RecordedRow {
    key: string
    text: string
    preview: string
    date?: string
    // Set for webhook rows so two rows that share a body can show what still differs. Not returned on the API.
    bodyKey: string | null
    rawQuery: Record<string, unknown>
    rawHeaders: Record<string, unknown>
}

function stepsOf(executionData: unknown): any[] | null {
    try {
        const parsed = typeof executionData === 'string' ? JSON.parse(executionData) : executionData
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

function startOutput(executionData: unknown): Record<string, unknown> | null {
    const steps = stepsOf(executionData)
    if (!steps) return null
    const start = steps.find((step) => step?.data?.name === 'startAgentflow' || String(step?.nodeId || '').startsWith('startAgentflow'))
    return asObject(start?.data?.output)
}

// A real form run stores `name: value` lines, not the object that was submitted. An object is kept as stored.
// Rows this version writes start with a marker line and may escape a backslash. Older rows have no marker
// and stay literal text. duplicate is set when an older line break inside a value repeats a field name
// or leaves a line with no field name. The check does not replay the shortened object.
function formFromStored(value: unknown): { form: Record<string, unknown>; duplicate: boolean } | null {
    const object = asObject(value)
    if (object) return Object.keys(object).length ? { form: object, duplicate: false } : null
    if (typeof value !== 'string') return null
    const parsed = parseStoredForm(value)
    return Object.keys(parsed.form).length ? { form: parsed.form, duplicate: parsed.duplicateKey } : null
}

function formRow(form: Record<string, unknown>, duplicate: boolean): RecordedRow {
    if (duplicate) {
        const text = canonicalJson({ unreplayable: UNREPLAYABLE_FORM })
        return { key: text, text, preview: UNREPLAYABLE_FORM, bodyKey: null, rawQuery: {}, rawHeaders: {} }
    }
    // key ignores field order so two orders of the same fields count once. text keeps the stored order,
    // which is the order the model and $flow.input saw.
    const key = canonicalJson({ form })
    const text = JSON.stringify({ form })
    return { key, text, preview: plainPreview(text), bodyKey: null, rawQuery: {}, rawHeaders: {} }
}

function plainPreview(text: string): string {
    try {
        const value = JSON.parse(text)
        if (value && typeof value === 'object') {
            if (value.form !== undefined) return canonicalJson(value.form)
            if (typeof value.question === 'string') return JSON.stringify(value.question)
        }
    } catch {
        /* the stored text is already the preview */
    }
    return text
}

function differingHeaders(row: RecordedRow, group: RecordedRow[]): string[] {
    const names = new Set<string>()
    for (const other of group) {
        if (other === row) continue
        const keys = new Set([...Object.keys(row.rawHeaders), ...Object.keys(other.rawHeaders)])
        for (const key of keys) {
            if (canonicalJson(row.rawHeaders[key]) !== canonicalJson(other.rawHeaders[key])) names.add(key)
        }
    }
    return [...names].sort()
}

function formatHeader(name: string, row: RecordedRow): string {
    if (!Object.prototype.hasOwnProperty.call(row.rawHeaders, name)) return name
    if (isSensitiveKey(name)) return `${name}: ${REDACTED}`
    const value = maskValue(row.rawHeaders[name])
    return `${name}: ${typeof value === 'string' ? value : canonicalJson(value)}`
}

// A webhook row whose body also appears on another kept row shows the query or the header names that differ.
function sharedBodyPreview(row: RecordedRow, group: RecordedRow[]): string {
    const parts = [row.bodyKey || '{}']
    const queryDiffers = group.some((other) => other !== row && canonicalJson(other.rawQuery) !== canonicalJson(row.rawQuery))
    if (queryDiffers) parts.push(`query ${canonicalJson(maskBag(row.rawQuery))}`)
    const names = differingHeaders(row, group)
    if (names.length) parts.push(`headers ${names.map((name) => formatHeader(name, row)).join(', ')}`)
    return parts.join(' ')
}

// Fill webhook previews once the kept rows are known. Other kinds already have their preview.
export function applyPreviews(rows: RecordedRow[]): RecordedRow[] {
    const groups = new Map<string, RecordedRow[]>()
    for (const row of rows) {
        if (!row.bodyKey) continue
        const list = groups.get(row.bodyKey) || []
        list.push(row)
        groups.set(row.bodyKey, list)
    }
    return rows.map((row) => {
        if (!row.bodyKey) return row
        const group = groups.get(row.bodyKey) || []
        if (group.length < 2) return row
        return { ...row, preview: sharedBodyPreview(row, group) }
    })
}

// The input that started this run, or null when the execution has nothing of that kind to replay.
// `key` ignores volatile webhook headers. `text` is what the API returns and what a replay runs:
// sensitive header and query values are already masked.
export function recordedDraft(executionData: unknown, kind: TriggerStart): RecordedRow | null {
    const output = startOutput(executionData)
    if (!output) return null
    if (kind === 'formInput') {
        const stored = formFromStored(output.form)
        if (!stored) return null
        return formRow(stored.form, stored.duplicate)
    }
    if (kind === 'webhookTrigger') {
        const webhook = asObject(output.webhook)
        if (!webhook) return null
        const body = webhook.body === undefined ? {} : webhook.body
        const rawQuery = asObject(webhook.query) || {}
        const rawHeaders = stableHeaders(webhook.headers)
        const bodyKey = canonicalJson(body)
        const key = canonicalJson({ body, query: rawQuery, headers: rawHeaders })
        const text = canonicalJson({ webhook: { body, query: maskBag(rawQuery), headers: maskBag(rawHeaders) } })
        return { key, text, preview: bodyKey, bodyKey, rawQuery, rawHeaders }
    }
    const stored = formFromStored(output.form)
    if (stored && Object.keys(stored.form).length) return formRow(stored.form, stored.duplicate)
    if (typeof output.question === 'string') {
        const text = canonicalJson({ question: output.question })
        return { key: text, text, preview: plainPreview(text), bodyKey: null, rawQuery: {}, rawHeaders: {} }
    }
    return null
}

export function recordedQuestion(executionData: unknown, kind: TriggerStart): string | null {
    return recordedDraft(executionData, kind)?.text ?? null
}

// Turn a stored question back into the prediction input. Chat questions stay a question.
// A trigger question is the JSON from recordedQuestion. A form is sent without a question,
// because the engine refuses both at once. Webhook and schedule replays use the chat type those starts require.
export function replayFromQuestion(question: string, kind: TriggerStart | null): ReplayCall {
    const history: never[] = []
    if (!kind) return { incoming: { question, streaming: false, history }, chatType: 'INTERNAL' }
    let recorded: any
    try {
        recorded = JSON.parse(question)
    } catch {
        recorded = null
    }
    if (kind === 'formInput' || (kind === 'scheduleInput' && recorded?.unreplayable)) {
        if (typeof recorded?.unreplayable === 'string') throw new Error(recorded.unreplayable)
    }
    if (kind === 'formInput') {
        const form = asObject(recorded?.form)
        if (!form) throw new Error('This recorded form input could not be read.')
        return { incoming: { form, streaming: false, history }, chatType: 'INTERNAL' }
    }
    if (kind === 'webhookTrigger') {
        const webhook = asObject(recorded?.webhook)
        if (!webhook) throw new Error('This recorded webhook input could not be read.')
        return { incoming: { webhook, streaming: false, history }, chatType: 'WEBHOOK' }
    }
    if (typeof recorded?.unreplayable === 'string') throw new Error(recorded.unreplayable)
    const form = asObject(recorded?.form)
    if (form && Object.keys(form).length) return { incoming: { form, streaming: false, history }, chatType: 'SCHEDULED' }
    const text = typeof recorded?.question === 'string' ? recorded.question : ' '
    return { incoming: { question: text, streaming: false, history }, chatType: 'SCHEDULED' }
}
