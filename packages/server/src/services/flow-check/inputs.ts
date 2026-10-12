// Recorded inputs for a form, webhook or schedule agentflow, taken from execution records.
// The publish check replays these instead of chat questions. The text is canonical JSON so the
// same payload counts once, and so the replay can rebuild the input the run was started with.
import { TriggerStart } from './kinds'

export const NO_PAST_RUNS = 'No past runs to replay yet. Run this flow once, then check again.'

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
    return JSON.stringify(sortKeys(value))
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

// The input that started this run, or null when the execution has nothing of that kind to replay.
export function recordedQuestion(executionData: unknown, kind: TriggerStart): string | null {
    const output = startOutput(executionData)
    if (!output) return null
    if (kind === 'formInput') {
        const form = asObject(output.form)
        return form ? canonicalJson({ form }) : null
    }
    if (kind === 'webhookTrigger') {
        const webhook = asObject(output.webhook)
        return webhook ? canonicalJson({ webhook }) : null
    }
    const form = asObject(output.form)
    if (form && Object.keys(form).length) return canonicalJson({ form })
    if (typeof output.question === 'string') return canonicalJson({ question: output.question })
    return null
}

// Turn a stored question back into the prediction input. Chat questions stay a question.
// A trigger question is the canonical JSON from recordedQuestion. A form is sent without a question,
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
    const form = asObject(recorded?.form)
    if (form && Object.keys(form).length) return { incoming: { form, streaming: false, history }, chatType: 'SCHEDULED' }
    const text = typeof recorded?.question === 'string' ? recorded.question : ' '
    return { incoming: { question: text, streaming: false, history }, chatType: 'SCHEDULED' }
}
