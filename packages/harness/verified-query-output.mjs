import { sqlTraceFields } from './analyst-capture.mjs'

export const VERIFIED_QUERY_POLICY = 'verified-query-passthrough'
const EMPTY_SQL_HASH = sqlTraceFields('').sqlHash
const attempts = new Map()

// Native fallback work is bounded independently of the model's instructions.
// Profile revocation clears its counters; the bounded map also drops old turns.
export function reserveGuardedQueryAttempt(profileName, sourceTurn) {
    const key = `${profileName}\0${sourceTurn}`
    const count = attempts.get(key) || 0
    if (count >= 2) return false
    attempts.set(key, count + 1)
    if (attempts.size > 2000) attempts.delete(attempts.keys().next().value)
    return true
}

export function forgetGuardedQueryAttempts(profileName) {
    const prefix = `${profileName}\0`
    for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key)
}

export function verifiedSourceTurn(profileName, sourceTurn) {
    return (
        typeof sourceTurn === 'string' &&
        sourceTurn.length <= 4096 &&
        Boolean(profileName) &&
        sourceTurn.startsWith(`${profileName}:`) &&
        /#turn-[A-Za-z0-9_-]{1,80}$/.test(sourceTurn)
    )
}

// Called only with a server-selected binding and the private envelope emitted by
// the native URL query tool after its read-only guard succeeds. This establishes
// execution provenance, not that the model's SQL has the right business meaning.
export function guardedQueryEvidence({ specialist, binding, toolName, profileName, sourceTurn, receipt, result, sqlHash }) {
    if (specialist?.trustedOutputPolicy !== VERIFIED_QUERY_POLICY) return null
    if (binding?.nodeName !== 'postgreSQLMCP' || binding?.inputs?.allowPinDefinitions !== true) return null
    let actions = binding.inputs.mcpActions
    if (typeof actions === 'string') {
        try {
            actions = JSON.parse(actions)
        } catch {
            return null
        }
    }
    if (!Array.isArray(actions) || !actions.includes('query') || toolName !== 'query') return null
    if (!verifiedSourceTurn(profileName, sourceTurn)) return null
    const configuredCap = Number(binding.inputs.analystRowCap)
    const configuredTimeout = Number(binding.inputs.analystTimeoutSeconds) * 1000
    if (Number.isFinite(configuredCap) && configuredCap > 0 && receipt?.rowCap > configuredCap) return null
    if (Number.isFinite(configuredTimeout) && configuredTimeout > 0 && receipt?.statementTimeoutMs > configuredTimeout) return null
    if (
        receipt?.readOnly !== true ||
        !Number.isInteger(receipt.rowCap) ||
        receipt.rowCap < 1 ||
        receipt.rowCap > 10000 ||
        !Number.isInteger(receipt.statementTimeoutMs) ||
        receipt.statementTimeoutMs < 1 ||
        receipt.statementTimeoutMs > 600000 ||
        !/^[a-f0-9]{64}$/.test(sqlHash || '') ||
        sqlHash === EMPTY_SQL_HASH ||
        !Array.isArray(result?.rows) ||
        result.rows.length > receipt.rowCap ||
        result.error ||
        result.status === 'error' ||
        result.cuttlelyOutcome ||
        result.columnsChanged
    )
        return null
    return { kind: 'native-read-only-query', sqlHash, rowCap: receipt.rowCap, statementTimeoutMs: receipt.statementTimeoutMs }
}

export function verifiedQueryCapture(item) {
    const evidence = item?.queryEvidence
    return Boolean(
        item.callId &&
            item.sourceTurn &&
            item.toolName === 'query' &&
            evidence?.kind === 'native-read-only-query' &&
            /^[a-f0-9]{64}$/.test(evidence.sqlHash || '') &&
            evidence.sqlHash !== EMPTY_SQL_HASH &&
            item.traceFields?.sqlHash === evidence.sqlHash &&
            Number.isInteger(evidence.rowCap) &&
            evidence.rowCap > 0 &&
            Number.isInteger(evidence.statementTimeoutMs) &&
            evidence.statementTimeoutMs > 0 &&
            Array.isArray(item.result?.rows) &&
            item.result.rows.length <= evidence.rowCap &&
            !item.result.error &&
            item.result.status !== 'error' &&
            !item.result.cuttlelyOutcome &&
            !item.result.columnsChanged
    )
}
