import axios from 'axios'

export const MAX_RETRIES = 3
export const RETRY_DELAYS = [300, 1000, 3000]

export const isCancel = (error) => Boolean(axios.isCancel(error) || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError')

export const isNoResponse = (error) => Boolean(error && error.response === undefined && !isCancel(error))

export const isRetryableStatus = (errorOrStatus) => {
    const status = typeof errorOrStatus === 'number' ? errorOrStatus : errorOrStatus?.response?.status
    return status === 502 || status === 503 || status === 504
}

// A write is never replayed automatically, but these outcomes are all ambiguous: the browser either received
// no response or received a gateway response that does not prove whether the application handled the write.
export const isConnectionUnavailable = (error) =>
    isRetryableStatus(error) || Boolean(isNoResponse(error) && (error?.isAxiosError || error?.request))

export const retryEnabled = (config = {}) => {
    if (config.retry === false) return false
    const method = String(config.method || 'get').toLowerCase()
    if (method === 'get' || method === 'head') return true
    return config.retry === true || config.retry?.network === true
}

export const retryLimit = (config = {}) => {
    const configured = typeof config.retry === 'object' ? config.retry.tries : undefined
    return Number.isInteger(configured) && configured >= 0 ? configured : MAX_RETRIES
}

export const shouldRetry = (config = {}, error) => {
    if (!retryEnabled(config) || isCancel(error) || config.signal?.aborted) return false
    if ((config._retryCount || 0) >= retryLimit(config)) return false
    return isNoResponse(error) || isRetryableStatus(error)
}

export const backoffDelay = (attempt, rand = Math.random) => {
    const base = RETRY_DELAYS[Math.max(0, Math.min(RETRY_DELAYS.length - 1, attempt - 1))]
    return Math.round(base * (0.75 + rand() * 0.5))
}

export const abortableSleep = (delay, signal) =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new axios.CanceledError())
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, delay)
        const onAbort = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            reject(new axios.CanceledError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })

const stableValue = (value) => {
    if (Array.isArray(value)) return value.map(stableValue)
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.keys(value)
            .sort()
            .reduce((result, key) => {
                if (value[key] !== undefined) result[key] = stableValue(value[key])
                return result
            }, {})
    }
    return value
}

export const stableStringify = (value) => JSON.stringify(stableValue(value ?? null))

const bodyHash = (value) => {
    const text = typeof value === 'string' ? value : stableStringify(value)
    let hash = 2166136261
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
}

export const dedupeKey = (config = {}) => {
    // dedupe: false asks for a fresh read, for example a status re-check that must not reuse a read started earlier.
    if (config.dedupe === false || config.signal || config._authRetried || (config._retryCount || 0) > 0) return null
    const method = String(config.method || 'get').toLowerCase()
    const isRead = method === 'get' || method === 'head'
    const isLoadPost = method === 'post' && retryEnabled(config)
    if (!isRead && !isLoadPost) return null
    let resolvedUrl
    try {
        const base = config.baseURL || window.location.origin
        resolvedUrl = new URL(String(config.url || '').replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`).toString()
    } catch {
        resolvedUrl = `${config.baseURL || ''}${config.url || ''}`
    }
    const parts = [method, resolvedUrl, stableStringify(config.params)]
    if (isLoadPost) parts.push(bodyHash(config.data))
    return parts.join('|')
}

export const inFlightRequests = new Map()

export const cloneResponse = (response) => {
    const cloneData = (value) => {
        if (Array.isArray(value)) return value.map(cloneData)
        if (value && Object.getPrototypeOf(value) === Object.prototype) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneData(item)]))
        }
        return value
    }
    return { ...response, headers: { ...response.headers }, data: cloneData(response.data) }
}
