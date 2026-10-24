import { pbkdf2Sync } from 'crypto'

/**
 * Safe description of the LangSmith credential a tracer is built with.
 * Never contains the API key itself: only a short prefix, the length and a short fingerprint
 * (PBKDF2-SHA256 with the fixed salt below, so the same key can be compared from another machine).
 */
export interface LangSmithCredentialShape {
    credentialId: string
    credentialDataEmpty: boolean
    fieldNames: string[]
    apiKeyPrefix: string
    apiKeyLength: number
    apiKeyFingerprint: string
    endpoint: string
    project: string
}

const PREFIX_LENGTH = 5
export const FINGERPRINT_SALT = 'cuttlely-langsmith-fingerprint'
export const FINGERPRINT_ITERATIONS = 2000

/** Origin and path only: user info, query and fragment can carry secrets and are left out. */
export const endpointForLog = (endpoint: string): string => {
    try {
        const url = new URL(endpoint)
        return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`
    } catch {
        return '(unparsed)'
    }
}

export const apiKeyFingerprint = (key: string): string =>
    key ? pbkdf2Sync(key, FINGERPRINT_SALT, FINGERPRINT_ITERATIONS, 6, 'sha256').toString('hex') : ''

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
        apiKeyPrefix: key.slice(0, Math.min(PREFIX_LENGTH, Math.floor(key.length / 4))),
        apiKeyLength: key.length,
        apiKeyFingerprint: apiKeyFingerprint(key),
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
 * (id, field names, key prefix, length and fingerprint, endpoint origin and path, project), for an error status
 * and for a request that fails outright, which is rethrown as a plain error with only its name. The key, the
 * bodies and error messages are not logged or passed on.
 */
export const langSmithFailureLoggingFetch = (ids: { flowId?: string; shape?: LangSmithCredentialShape }): typeof fetch => {
    return (async (input: any, init?: any) => {
        let path = ''
        try {
            path = new URL(typeof input === 'string' ? input : input?.url ?? String(input)).pathname
        } catch {
            path = ''
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
        }
        return response
    }) as typeof fetch
}
