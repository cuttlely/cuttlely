import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'

export function asAbortSignal(value) {
    if (!value || typeof value !== 'object') return undefined
    if (typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function') return value
    if (value.signal && typeof value.signal.aborted === 'boolean' && typeof value.signal.addEventListener === 'function')
        return value.signal
    return undefined
}

// Explicit signal wins. Otherwise use the prediction run's LangChain abort (API-3).
export function readClientSignal(explicit) {
    const direct = asAbortSignal(explicit)
    if (direct) return direct
    try {
        return asAbortSignal(AsyncLocalStorageProviderSingleton.getRunnableConfig()?.signal)
    } catch {
        return undefined
    }
}
