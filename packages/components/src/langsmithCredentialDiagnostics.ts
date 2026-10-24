import { createHash } from 'crypto'

/**
 * Safe description of the LangSmith credential a tracer is built with.
 * Never contains the API key itself: only a short prefix, the length and a short sha256 hash.
 */
export interface LangSmithCredentialShape {
    credentialId: string
    credentialDataEmpty: boolean
    fieldNames: string[]
    apiKeyPrefix: string
    apiKeyLength: number
    apiKeySha256: string
    endpoint: string
    project: string
}

const PREFIX_LENGTH = 5

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
        apiKeySha256: key ? createHash('sha256').update(key).digest('hex').slice(0, 12) : '',
        endpoint: typeof endpoint === 'string' && endpoint ? endpoint : '(default)',
        project: typeof project === 'string' && project ? project : '(default)'
    }
}

export const logLangSmithCredentialShape = (where: string, shape: LangSmithCredentialShape): void => {
    console.info(`[langsmith-diag] ${where} ${JSON.stringify(shape)}`)
}

/**
 * fetch wrapper for the LangSmith client that reports failed uploads with the flow and credential ids.
 * The request and response bodies are not logged.
 */
export const langSmithFailureLoggingFetch = (ids: { flowId?: string; credentialId?: string }): typeof fetch => {
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
                `[langsmith-diag] upload failed status=${response.status} path=${path} flowId=${ids.flowId ?? ''} credentialId=${
                    ids.credentialId ?? ''
                }`
            )
        }
        return response
    }) as typeof fetch
}
