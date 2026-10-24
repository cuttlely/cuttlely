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
        endpoint: typeof endpoint === 'string' && endpoint ? endpoint : '(default)',
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
 * (id, field names, key prefix, length and fingerprint, endpoint, project). The key and the bodies are not logged.
 */
export const langSmithFailureLoggingFetch = (ids: { flowId?: string; shape?: LangSmithCredentialShape }): typeof fetch => {
    return (async (input: any, init?: any) => {
        const response = await fetch(input, init)
        if (!response.ok) {
            let path = ''
            try {
                path = new URL(typeof input === 'string' ? input : input?.url ?? String(input)).pathname
            } catch {
                path = ''
            }
            console.warn(
                `[langsmith] upload failed status=${response.status} path=${path} flowId=${ids.flowId ?? ''} credential=${JSON.stringify(
                    ids.shape ?? {}
                )}`
            )
        }
        return response
    }) as typeof fetch
}
