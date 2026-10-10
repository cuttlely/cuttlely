// How long a chat model keeps retrying a provider that refuses (429 rate limit, 5xx). LangChain's default is six
// retries with exponential backoff, which kept a prediction waiting about 95 seconds before it failed. With this
// budget a call makes at most 3 tries and starts no new try once 20 seconds have passed since the first one, so a
// provider that keeps saying 429 is reported to the caller (as HTTP 429 with Retry-After) within that time.

export const MODEL_RETRY_BUDGET = { maxRetries: 2, totalMs: 20000 }

const APPLIED = Symbol.for('cuttlely.modelRetryBudget')
const SPENT = Symbol.for('cuttlely.modelRetryBudgetSpent')

interface CallerLike {
    maxRetries: number
    call: (callable: (...args: any[]) => Promise<unknown>, ...args: any[]) => Promise<unknown>
    onFailedAttempt?: (error: unknown) => unknown
    [APPLIED]?: boolean
}

const isCaller = (value: unknown): value is CallerLike =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as CallerLike).call === 'function' &&
    typeof (value as CallerLike).maxRetries === 'number'

/**
 * Bounds the retries of a chat model or LLM instance (anything with a LangChain AsyncCaller in `caller`): never more
 * than budget.maxRetries, and no new try after budget.totalMs. Safe to call more than once. Returns the same instance.
 */
export function applyModelRetryBudget<T>(model: T, budget: { maxRetries: number; totalMs: number } = MODEL_RETRY_BUDGET): T {
    const caller = (model as { caller?: unknown } | null | undefined)?.caller
    if (!isCaller(caller) || caller[APPLIED]) return model
    caller[APPLIED] = true
    caller.maxRetries = Math.min(caller.maxRetries, budget.maxRetries)

    // A failure after the time is up is marked, and the marked failure stops the retries.
    const onFailedAttempt = caller.onFailedAttempt
    caller.onFailedAttempt = (error: unknown) => {
        if (error && typeof error === 'object' && (error as Record<symbol, unknown>)[SPENT]) throw error
        return onFailedAttempt?.(error)
    }
    const call = caller.call.bind(caller)
    caller.call = (callable, ...args) => {
        const started = Date.now()
        return call(async (...inner: any[]) => {
            try {
                return await callable(...inner)
            } catch (error) {
                if (Date.now() - started >= budget.totalMs && error && typeof error === 'object') {
                    try {
                        ;(error as Record<symbol, unknown>)[SPENT] = true
                    } catch {
                        // A frozen error object keeps retrying up to maxRetries.
                    }
                }
                throw error
            }
        }, ...args)
    }
    return model
}
