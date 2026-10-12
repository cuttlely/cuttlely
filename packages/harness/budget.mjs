// D37. Unset means 45s. `0` turns the wall clock off.
export const DEFAULT_TURN_BUDGET_MS = 45000

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
