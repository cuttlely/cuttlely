import { HarnessError } from './errors.mjs'

export const DEFAULT_EVIDENCE_BYTES = 40000
export const MIN_EVIDENCE_BYTES = 4096
export const MAX_EVIDENCE_BYTES = 262144

// Blank inherits the server default. Persist only explicit overrides, including on export/import.
export function normalizeEvidenceBytes(value) {
    if (value == null || value === '' || (typeof value === 'string' && !value.trim())) return undefined
    const number = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value) : NaN
    if (!Number.isInteger(number) || number < MIN_EVIDENCE_BYTES || number > MAX_EVIDENCE_BYTES)
        throw new HarnessError(
            'bad_evidence_budget',
            `Evidence budget must be an integer from ${MIN_EVIDENCE_BYTES} to ${MAX_EVIDENCE_BYTES} bytes.`
        )
    return number
}

export function defaultEvidenceBytes() {
    try {
        return normalizeEvidenceBytes(process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES) ?? DEFAULT_EVIDENCE_BYTES
    } catch {
        return DEFAULT_EVIDENCE_BYTES
    }
}

export function evidenceBudget(specialist) {
    const bytes = normalizeEvidenceBytes(specialist?.evidenceBytes) ?? defaultEvidenceBytes()
    const scale = Math.max(1, bytes / DEFAULT_EVIDENCE_BYTES)
    const receiptBytes = Math.ceil(bytes * 1.2)
    const mcpResultChars = Math.max(50000, receiptBytes + 2000)
    return {
        bytes,
        receiptBytes,
        overviewBytes: Math.floor(bytes * (32768 / DEFAULT_EVIDENCE_BYTES)),
        maxString: Math.ceil(12000 * scale),
        maxLeaves: Math.ceil(600 * scale),
        mcpResultChars,
        resultChars: Math.max(100000, mcpResultChars),
        turnChars: Math.max(200000, mcpResultChars * 2)
    }
}
