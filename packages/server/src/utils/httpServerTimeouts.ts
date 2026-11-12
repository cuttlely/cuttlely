export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000
export const MAX_HTTP_KEEP_ALIVE_TIMEOUT_MS = 600_000
export const MAX_HTTP_HEADERS_TIMEOUT_MS = 601_000

export interface HttpServerTimeouts {
    keepAliveTimeout: number
    headersTimeout: number
}

type TimeoutEnvironment = Readonly<Record<string, string | undefined>>

export interface HttpServerTimeoutResolution extends HttpServerTimeouts {
    warnings: string[]
}

function parseInteger(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined
    const normalized = raw.trim()
    if (!/^-?\d+$/.test(normalized)) return Number.NaN
    const value = Number(normalized)
    return Number.isSafeInteger(value) ? value : Number.NaN
}

export function resolveHttpServerTimeouts(env: TimeoutEnvironment): HttpServerTimeoutResolution {
    const warnings: string[] = []
    const rawKeepAlive = env.HTTP_KEEP_ALIVE_TIMEOUT_MS
    const parsedKeepAlive = parseInteger(rawKeepAlive)
    let keepAliveTimeout = DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS

    if (parsedKeepAlive !== undefined) {
        if (parsedKeepAlive >= 1_000 && parsedKeepAlive <= MAX_HTTP_KEEP_ALIVE_TIMEOUT_MS) {
            keepAliveTimeout = parsedKeepAlive
        } else {
            warnings.push(
                `HTTP_KEEP_ALIVE_TIMEOUT_MS must be a whole number from 1000 to ${MAX_HTTP_KEEP_ALIVE_TIMEOUT_MS}; using ${DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS}.`
            )
        }
    }

    const defaultHeadersTimeout = keepAliveTimeout + 1_000
    const rawHeaders = env.HTTP_HEADERS_TIMEOUT_MS
    const parsedHeaders = parseInteger(rawHeaders)
    let headersTimeout = defaultHeadersTimeout

    if (parsedHeaders !== undefined) {
        if (parsedHeaders > keepAliveTimeout && parsedHeaders <= MAX_HTTP_HEADERS_TIMEOUT_MS) {
            headersTimeout = parsedHeaders
        } else {
            warnings.push(
                `HTTP_HEADERS_TIMEOUT_MS must be a whole number greater than HTTP_KEEP_ALIVE_TIMEOUT_MS and no more than ${MAX_HTTP_HEADERS_TIMEOUT_MS}; using ${defaultHeadersTimeout}.`
            )
        }
    }

    return { keepAliveTimeout, headersTimeout, warnings }
}

export function applyHttpServerTimeouts(
    server: Pick<import('node:http').Server, 'keepAliveTimeout' | 'headersTimeout'>,
    timeouts: HttpServerTimeouts
): void {
    server.keepAliveTimeout = timeouts.keepAliveTimeout
    server.headersTimeout = timeouts.headersTimeout
}
