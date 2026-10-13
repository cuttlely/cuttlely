// The optional rule that Publish waits for a passing dataset check. Pure: no database and no answers.
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'

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
}

export interface GateStatus extends GateSettings {
    result: GateResult | null
    // Why Publish is refused, or null when the gate is off or the latest result still passes.
    block: string | null
}

export function publishGateApplies(type?: string | null): boolean {
    return PUBLISH_GATE_TYPES.has(type || 'CHATFLOW')
}

export function emptyGateStatus(): GateStatus {
    return { enabled: false, datasetId: null, evaluatorIds: [], threshold: null, result: null, block: null }
}

export function normalizeEvaluatorIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'Choose at least one evaluator before requiring a passing test set.')
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
        throw new AppError(StatusCodes.BAD_REQUEST, 'publishGate is an object with enabled true or false.')
    }
    const body = value as Record<string, unknown>
    if (typeof body.enabled !== 'boolean') {
        throw new AppError(StatusCodes.BAD_REQUEST, 'publishGate.enabled is true or false.')
    }
    if (!body.enabled) return { enabled: false, datasetId: null, evaluatorIds: [], threshold: null }
    if (typeof body.datasetId !== 'string' || !body.datasetId.trim()) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'Choose a dataset before requiring a passing test set.')
    }
    const evaluatorIds = normalizeEvaluatorIds(body.evaluatorIds)
    const threshold = parseStoredThreshold(body.threshold)
    return { enabled: true, datasetId: body.datasetId.trim(), evaluatorIds, threshold }
}

function parseStoredThreshold(value: unknown): number {
    if (value === undefined || value === null) return 100
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'threshold is a whole number from 0 to 100.')
    }
    return value
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
            checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : ''
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
        checkedAt: input.checkedAt || new Date().toISOString()
    }
    return JSON.stringify(record)
}
