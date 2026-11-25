import { existsSync } from 'node:fs'
import { database, immediate, queueDbPath } from './lock.mjs'
import { specialistSessionId } from './specialist-run.mjs'
import { sqlTraceFields } from './analyst-capture.mjs'

export const VERIFIED_QUERY_POLICY = 'verified-query-passthrough'
const EMPTY_SQL_HASH = sqlTraceFields('').sqlHash

export function guardedQueryLimit(env = process.env) {
    const raw = String(env.CUTTLELY_HARNESS_MAX_AD_HOC_SQL_ATTEMPTS ?? '').trim()
    return /^0*[1-6](?:\.0+)?$/.test(raw) ? Number(raw) : 2
}

// Retain completed turns for late calls. Active leases are never evicted by other traffic.
function pruneFinished(db) {
    db.prepare(
        'DELETE FROM guarded_query_turns WHERE rowid IN (SELECT rowid FROM guarded_query_turns WHERE session_key IS NULL ORDER BY rowid DESC LIMIT -1 OFFSET 2000)'
    ).run()
}

// The worker and tool gateway can be different processes. The existing chat lease protects
// this snapshot until the turn finishes or its owner is replaced after a crash.
export function beginGuardedQueryTurns(specialists, chatId, turnId, sessionKey, limit = guardedQueryLimit()) {
    const guarded = specialists.filter((item) => item.profileName && item.trustedOutputPolicy === VERIFIED_QUERY_POLICY)
    if (!guarded.length) return
    immediate((db) => {
        pruneFinished(db)
        const insert = db.prepare('INSERT INTO guarded_query_turns (profile, source_turn, session_key, attempt_limit) VALUES (?, ?, ?, ?)')
        for (const { profileName } of guarded) insert.run(profileName, specialistSessionId(profileName, chatId, turnId), sessionKey, limit)
    })
}

export function guardedQueryUsage(profileName, sourceTurn) {
    const row = database()
        .prepare('SELECT used, attempt_limit AS allowance FROM guarded_query_turns WHERE profile = ? AND source_turn = ?')
        .get(profileName, sourceTurn)
    return row ? { used: row.used, limit: row.allowance, exhausted: row.used >= row.allowance } : null
}

export function admitGuardedQueryAttempt(profileName, sourceTurn) {
    return immediate((db) => {
        // Standalone gateway callers have no managed turn. Their first call fixes the allowance.
        const inserted = db
            .prepare('INSERT OR IGNORE INTO guarded_query_turns (profile, source_turn, attempt_limit) VALUES (?, ?, ?)')
            .run(profileName, sourceTurn, guardedQueryLimit())
        if (inserted.changes) pruneFinished(db)
        const changed = db
            .prepare('UPDATE guarded_query_turns SET used = used + 1 WHERE profile = ? AND source_turn = ? AND used < attempt_limit')
            .run(profileName, sourceTurn)
        return { allowed: changed.changes === 1, ...guardedQueryUsage(profileName, sourceTurn) }
    })
}

// Preserve the boolean interface for existing direct harness callers.
export function reserveGuardedQueryAttempt(profileName, sourceTurn) {
    return admitGuardedQueryAttempt(profileName, sourceTurn).allowed
}

export function forgetGuardedQueryAttempts(profileName) {
    if (existsSync(queueDbPath())) database().prepare('DELETE FROM guarded_query_turns WHERE profile = ?').run(profileName)
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
