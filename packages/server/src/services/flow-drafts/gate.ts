// The optional rule that Publish waits for a passing dataset check. Pure: no database and no answers.
import crypto from 'crypto'

function refuse(message: string): never {
    const error = new Error(message) as Error & { statusCode: number }
    error.statusCode = 400
    throw error
}

export const PUBLISH_GATE_TYPES = new Set(['CHATFLOW', 'AGENTFLOW'])

export interface GateSettings {
    enabled: boolean
    datasetId: string | null
    evaluatorIds: string[]
    threshold: number | null
}

export interface GateResult {
    draftHash: string
    datasetId: string
    evaluatorIds: string[]
    threshold: number
    passRate: number | null
    passed: number
    failed: number
    errored: number
    verdict: 'passed' | 'failed'
    checkedAt: string
    // Hash of the rows the check asked and of each evaluator's type and config. Not the rows or the answers.
    contentHash: string
    // Hash of chatbotConfig.postProcessing at the time of the check. Not the function text in the clear.
    postProcessHash: string
    // The check run that stored this result. Absent on a result stored before runs were marked.
    checkId?: string
}

export interface GateStatus extends GateSettings {
    result: GateResult | null
    // Why Publish is refused, or null when the gate is off or the latest result still passes.
    block: string | null
}

export function publishGateApplies(type?: string | null): boolean {
    return PUBLISH_GATE_TYPES.has(type || 'CHATFLOW')
}

// A draft status keeps the verdict, the threshold, the block, and the counts. Dataset and evaluator
// ids stay out unless the caller can view them, the same way a check hides evaluator ids.
export function redactDraftStatus<T extends { publishGate?: GateStatus | null }>(
    status: T,
    reveal: { datasets: boolean; evaluators: boolean }
): T {
    const gate = status?.publishGate
    if (!gate) return status
    const result = gate.result
        ? {
              ...gate.result,
              datasetId: reveal.datasets ? gate.result.datasetId : '',
              evaluatorIds: reveal.evaluators ? gate.result.evaluatorIds : []
          }
        : gate.result
    return {
        ...status,
        publishGate: {
            ...gate,
            datasetId: reveal.datasets ? gate.datasetId : null,
            evaluatorIds: reveal.evaluators ? gate.evaluatorIds : [],
            result
        }
    }
}

export function emptyGateStatus(): GateStatus {
    return { enabled: false, datasetId: null, evaluatorIds: [], threshold: null, result: null, block: null }
}

export function normalizeEvaluatorIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id.trim())) {
        refuse('Choose at least one evaluator before requiring a passing test set.')
    }
    const ids = [...new Set(value.map((id) => String(id).trim()))].sort()
    return ids
}

export function parseGateInput(value: unknown): {
    enabled: boolean
    datasetId: string | null
    evaluatorIds: string[]
    threshold: number | null
} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        refuse('publishGate is an object with enabled true or false.')
    }
    const body = value as Record<string, unknown>
    if (typeof body.enabled !== 'boolean') {
        refuse('publishGate.enabled is true or false.')
    }
    if (!body.enabled) return { enabled: false, datasetId: null, evaluatorIds: [], threshold: null }
    if (typeof body.datasetId !== 'string' || !body.datasetId.trim()) {
        refuse('Choose a dataset before requiring a passing test set.')
    }
    const evaluatorIds = normalizeEvaluatorIds(body.evaluatorIds)
    const threshold = parseStoredThreshold(body.threshold)
    return { enabled: true, datasetId: body.datasetId.trim(), evaluatorIds, threshold }
}

function parseStoredThreshold(value: unknown): number {
    if (value === undefined || value === null) return 100
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
        refuse('threshold is a whole number from 0 to 100.')
    }
    return value
}

export interface AskedRow {
    // Used only to order ties. It is not part of the stored hash.
    id?: string
    input: string
    expected: string
    sequence: number
}

export interface EvaluatorShape {
    id: string
    type: string
    config: string
}

function stableConfig(config: string): string {
    try {
        const parsed = JSON.parse(config)
        const sort = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(sort)
            if (!value || typeof value !== 'object') return value
            return Object.keys(value as Record<string, unknown>)
                .sort()
                .reduce<Record<string, unknown>>((acc, key) => {
                    acc[key] = sort((value as Record<string, unknown>)[key])
                    return acc
                }, {})
        }
        return JSON.stringify(sort(parsed))
    } catch {
        return String(config ?? '')
    }
}

function compareAsked(a: AskedRow, b: AskedRow): number {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    const left = a.id || ''
    const right = b.id || ''
    if (left !== right) return left < right ? -1 : 1
    if (a.input !== b.input) return a.input < b.input ? -1 : 1
    if (a.expected !== b.expected) return a.expected < b.expected ? -1 : 1
    return 0
}

// Evaluator order does not matter. Row ties break by id, then by the text, so the hash does not depend on read order.
export function testSetHash(rows: AskedRow[], evaluators: EvaluatorShape[]): string {
    const body = {
        rows: [...rows].sort(compareAsked).map((row) => ({ input: row.input, expected: row.expected, sequence: row.sequence })),
        evaluators: [...evaluators]
            .map((item) => ({ id: item.id, type: item.type, config: stableConfig(item.config) }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function settingsKey(datasetId: string | null, evaluatorIds: string[], threshold: number | null): string {
    return JSON.stringify({
        datasetId: datasetId || '',
        evaluatorIds: [...evaluatorIds].sort(),
        threshold
    })
}

export function sameGateSettings(
    left: { datasetId: string | null; evaluatorIds: string[]; threshold: number | null },
    right: { datasetId: string | null; evaluatorIds: string[]; threshold: number | null }
): boolean {
    return (
        settingsKey(left.datasetId, left.evaluatorIds, left.threshold) === settingsKey(right.datasetId, right.evaluatorIds, right.threshold)
    )
}

const INSTANT_ON = 'Turn off Publish instantly before requiring a passing test set.'
const GATE_ON = 'Turn off the passing test set before turning on Publish instantly.'

export function conflictingSettingsMessage(turningGateOn: boolean): string {
    return turningGateOn ? INSTANT_ON : GATE_ON
}

export function publishBlockReason(settings: GateSettings, result: GateResult | null, draftHash: string | null): string | null {
    if (!settings.enabled || settings.threshold == null) return null
    const need = `Publish needs a passing test set at ${settings.threshold}%.`
    if (!result) return `${need} There is no result for this draft yet.`
    const rate = result.passRate == null ? 'unscored' : `${result.passRate}%`
    const last = `The last result was ${rate} and ${result.verdict}.`
    const settingsMatch = sameGateSettings(settings, result)
    const draftMatch = Boolean(draftHash) && result.draftHash === draftHash
    if (!settingsMatch) return `${need} ${last} The test set settings have changed since that check.`
    if (!draftMatch) return `${need} ${last} The draft has changed since that check.`
    if (result.verdict !== 'passed') return `${need} ${last}`
    return null
}

// Hash of chatbotConfig.postProcessing. Missing or unreadable config hashes as empty.
export function postProcessHash(chatbotConfig: string | null | undefined): string {
    let raw = ''
    try {
        const parsed = chatbotConfig ? JSON.parse(chatbotConfig) : null
        const post = parsed && typeof parsed === 'object' ? (parsed as { postProcessing?: unknown }).postProcessing : null
        raw = post && typeof post === 'object' ? stableConfig(JSON.stringify(post)) : ''
    } catch {
        raw = ''
    }
    return crypto.createHash('sha256').update(raw).digest('hex')
}

// A row, an evaluator's check, or a missing dataset or evaluator. Same shape as the settings message.
export function testSetChangedReason(threshold: number, result: GateResult): string {
    const need = `Publish needs a passing test set at ${threshold}%.`
    const rate = result.passRate == null ? 'unscored' : `${result.passRate}%`
    return `${need} The last result was ${rate} and ${result.verdict}. The test set has changed since that check.`
}

export function postProcessChangedReason(threshold: number, result: GateResult): string {
    const need = `Publish needs a passing test set at ${threshold}%.`
    const rate = result.passRate == null ? 'unscored' : `${result.passRate}%`
    return `${need} The last result was ${rate} and ${result.verdict}. The answer post-processing has changed since that check.`
}

export function readEvaluatorIdList(stored: string | null | undefined): string[] {
    if (!stored) return []
    try {
        const parsed = JSON.parse(stored)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    } catch {
        return []
    }
}

export function readGateResult(stored: string | null | undefined): GateResult | null {
    if (!stored) return null
    try {
        const parsed = JSON.parse(stored) as Partial<GateResult>
        if (!parsed || typeof parsed !== 'object') return null
        if (typeof parsed.draftHash !== 'string' || typeof parsed.datasetId !== 'string') return null
        if (typeof parsed.threshold !== 'number' || (parsed.verdict !== 'passed' && parsed.verdict !== 'failed')) return null
        if (!Array.isArray(parsed.evaluatorIds)) return null
        return {
            draftHash: parsed.draftHash,
            datasetId: parsed.datasetId,
            evaluatorIds: parsed.evaluatorIds.filter((id) => typeof id === 'string'),
            threshold: parsed.threshold,
            passRate: typeof parsed.passRate === 'number' ? parsed.passRate : null,
            passed: Number(parsed.passed) || 0,
            failed: Number(parsed.failed) || 0,
            errored: Number(parsed.errored) || 0,
            verdict: parsed.verdict,
            checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
            contentHash: typeof parsed.contentHash === 'string' ? parsed.contentHash : '',
            postProcessHash: typeof parsed.postProcessHash === 'string' ? parsed.postProcessHash : '',
            ...(typeof parsed.checkId === 'string' && parsed.checkId ? { checkId: parsed.checkId } : {})
        }
    } catch {
        return null
    }
}

// The columns this module writes. Answers, questions and expected outputs are not fields here.
export function gateResultRecord(input: Omit<GateResult, 'checkedAt'> & { checkedAt?: string }): string {
    const record: GateResult = {
        draftHash: input.draftHash,
        datasetId: input.datasetId,
        evaluatorIds: [...input.evaluatorIds].sort(),
        threshold: input.threshold,
        passRate: input.passRate,
        passed: input.passed,
        failed: input.failed,
        errored: input.errored,
        verdict: input.verdict,
        checkedAt: input.checkedAt || new Date().toISOString(),
        contentHash: input.contentHash || '',
        postProcessHash: input.postProcessHash || '',
        ...(input.checkId ? { checkId: input.checkId } : {})
    }
    return JSON.stringify(record)
}
