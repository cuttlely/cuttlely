/**
 * Safe description of the LangSmith credential a tracer is built with.
 * Nothing derived from the API key value is included, only its length. The credential id says which stored
 * credential was used; a hash of the value without a server-side secret could be checked against guesses
 * offline, and a keyed hash would need its own secret to manage, so the id and the length are enough.
 */
export interface LangSmithCredentialShape {
    credentialId: string
    credentialDataEmpty: boolean
    fieldNames: string[]
    apiKeyLength: number
    endpoint: string
    project: string
}

/** Headers of a failed response passed on to the SDK; everything else is dropped. */
export const FORWARDED_ERROR_HEADERS = ['retry-after', 'content-type'] as const

/** Origin only: user info, path, query and fragment can carry secrets (a proxy token in the path) and are left out. */
export const endpointForLog = (endpoint: string): string => {
    try {
        const url = new URL(endpoint)
        return `${url.protocol}//${url.host}`
    } catch {
        return '(unparsed)'
    }
}

const KNOWN_OPERATIONS: Array<[RegExp, string]> = [
    [/\/runs\/multipart$/, '/runs/multipart'],
    [/\/runs\/batch$/, '/runs/batch'],
    [/\/runs\/[0-9a-f-]{36}$/i, '/runs/:id'],
    [/\/runs$/, '/runs'],
    [/\/info$/, '/info']
]

/** A fixed name for the LangSmith operation a request path ends in, never the path itself. */
export const operationForLog = (pathname: string): string => {
    for (const [pattern, name] of KNOWN_OPERATIONS) if (pattern.test(pathname)) return name
    return '(other)'
}

/**
 * The key as the LangSmith SDK reads it (trimmed, then one pair of surrounding double and then single quotes
 * removed), repeated until nothing changes, so the SDK's own pass over the result leaves it as it is.
 */
export const normalizeLangSmithKey = (apiKey: string): string => {
    // One linear pass from both ends: whitespace (the set String.prototype.trim removes) and matching
    // surrounding quote pairs are dropped until neither end has any.
    let start = 0
    let end = apiKey.length
    for (;;) {
        while (start < end && /\s/.test(apiKey[start])) start++
        while (end > start && /\s/.test(apiKey[end - 1])) end--
        const first = apiKey[start]
        if (end - start >= 2 && (first === '"' || first === "'") && apiKey[end - 1] === first) {
            start++
            end--
            continue
        }
        return apiKey.slice(start, end)
    }
}

/**
 * The key and endpoint a flow's LangSmith client is built with, or undefined when the credential has no key
 * the SDK would keep. The SDK fills a missing key, or one that is blank once it trims spaces and quotes, from
 * the server's environment key or from a LangSmith profile on the server (API key or OAuth), and that would then
 * go to the endpoint of the flow's credential, so a flow credential without a usable key gets no client at all
 * and its tracing is turned off (and logged) instead. The key handed over is the normalized one.
 */
export const langSmithClientConfig = (apiKey: unknown, endpoint: unknown): { apiUrl: string; apiKey: string } | undefined => {
    if (typeof apiKey !== 'string') return undefined
    const key = normalizeLangSmithKey(apiKey)
    if (key.trim() === '') return undefined
    return {
        apiUrl: typeof endpoint === 'string' && endpoint ? endpoint : 'https://api.smith.langchain.com',
        apiKey: key
    }
}

/**
 * Second check on a built client: it must hold the flow credential's own key and no server profile
 * authentication. A client that does not is not used, whatever a later SDK version does with the key.
 */
export const langSmithClientUsesOwnKey = (client: unknown, expectedKey: string): boolean => {
    const c = client as { apiKey?: unknown; profileAuth?: unknown } | undefined
    return !!c && c.apiKey === expectedKey && c.profileAuth === undefined
}

/** Logged when a flow's LangSmith tracing is off because its credential has no key. */
export const warnLangSmithKeyMissing = (flowId: string | undefined, shape: LangSmithCredentialShape): void => {
    console.warn(`[langsmith] tracing off: credential has no API key flowId=${flowId ?? ''} credential=${JSON.stringify(shape)}`)
}

export const describeLangSmithCredential = (
    credentialId: string | undefined,
    credentialData: Record<string, unknown> | undefined,
    apiKey: unknown,
    endpoint: unknown,
    project: unknown
): LangSmithCredentialShape => {
    const data = credentialData ?? {}
    const key = typeof apiKey === 'string' ? apiKey : ''
    return {
        credentialId: credentialId ?? '',
        credentialDataEmpty: Object.keys(data).length === 0,
        fieldNames: Object.keys(data).sort(),
        apiKeyLength: key.length,
        endpoint: typeof endpoint === 'string' && endpoint ? endpointForLog(endpoint) : '(default)',
        project: typeof project === 'string' && project ? project : '(default)'
    }
}

/**
 * LangChainTracer's constructor adopts the client and project of the run tree in the async-local store
 * (updateFromRunTree). A flow run inside runWithAbortSignal stores a placeholder run tree whose client is the
 * environment default (no key on a server without LangSmith env vars) and whose project is 'default', so the
 * configured credential and project were replaced and uploads went out without a key (403). Put them back.
 */
export const keepConfiguredLangSmithTarget = (
    tracer: { client: unknown; projectName?: string },
    fields: { client?: unknown; projectName?: string }
): void => {
    if (fields.client) tracer.client = fields.client
    tracer.projectName = fields.projectName ?? 'default'
}

/**
 * fetch wrapper for the LangSmith client that reports failed uploads with the flow id and the credential shape
 * (id, field names, key length, endpoint origin, project) and a fixed operation name, for an error status
 * and for a request that fails outright, which is rethrown as a plain error with only its name. The key, the
 * bodies and error messages are not logged or passed on.
 */
export const langSmithFailureLoggingFetch = (ids: { flowId?: string; shape?: LangSmithCredentialShape }): typeof fetch => {
    return (async (input: any, init?: any) => {
        let path = '(other)'
        try {
            path = operationForLog(new URL(typeof input === 'string' ? input : input?.url ?? String(input)).pathname)
        } catch {
            path = '(other)'
        }
        let response: Response
        try {
            response = await fetch(input, init)
        } catch (error) {
            // Only the error name: messages and causes can carry the URL or headers.
            const name = error instanceof Error ? error.name : typeof error
            console.warn(
                `[langsmith] upload failed error=${name} path=${path} flowId=${ids.flowId ?? ''} credential=${JSON.stringify(
                    ids.shape ?? {}
                )}`
            )
            // The SDK logs the message of what it gets, so pass on a plain error that keeps only the name
            // (AbortError and TimeoutError stay recognizable for retries and aborts).
            const plain = new Error(`LangSmith request failed (${name})`)
            plain.name = name
            throw plain
        }
        if (!response.ok) {
            console.warn(
                `[langsmith] upload failed status=${response.status} path=${path} flowId=${ids.flowId ?? ''} credential=${JSON.stringify(
                    ids.shape ?? {}
                )}`
            )
            // The SDK puts the response body in the error it logs, and a server or proxy can echo request details
            // or in the status text or headers. Hand it the same status with a short body, no status text and only
            // the headers it needs (retry-after for backoff, content-type for parsing).
            try {
                await response.body?.cancel()
            } catch {
                // the body is not needed
            }
            const headers = new Headers()
            for (const name of FORWARDED_ERROR_HEADERS) {
                const value = response.headers?.get?.(name)
                if (value !== null && value !== undefined) headers.set(name, value)
            }
            return new Response(`LangSmith request failed with status ${response.status}`, {
                status: response.status,
                headers
            })
        }
        return response
    }) as typeof fetch
}
