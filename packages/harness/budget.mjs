// D37. Unset means 45s. `0` turns the wall clock off.
export const DEFAULT_TURN_BUDGET_MS = 45000

// Separate from the whole-turn budget. 0 leaves specialist runs without a deadline.
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 240000

export function agentRunTimeoutMs(env = process.env) {
    const raw = env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
    if (raw == null || String(raw).trim() === '') return DEFAULT_AGENT_RUN_TIMEOUT_MS
    const n = Number(raw)
    return Number.isSafeInteger(n) && n >= 0 && n <= 3600000 ? n : DEFAULT_AGENT_RUN_TIMEOUT_MS
}

export function turnBudgetMs(override) {
    if (override != null && override !== '') return normalizeBudget(override)
    const raw = process.env.CUTTLELY_HARNESS_TURN_BUDGET_MS
    if (raw == null || String(raw).trim() === '') return DEFAULT_TURN_BUDGET_MS
    return normalizeBudget(raw)
}

function normalizeBudget(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return DEFAULT_TURN_BUDGET_MS
    return Math.floor(n)
}
