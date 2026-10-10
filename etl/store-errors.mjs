// Classifies a vector store write error (spec 5.4): `record` (this batch holds a record the store refuses: bisect and
// reject it), `config` (credential, index or namespace: fail the run now, no retry), `transient` and `rate_limit`
// (retry with backoff), or `fatal` (fail the batch, no retry).
//
// Some SDKs throw errors without a status and name the class instead. The names below are the classes of the pinned
// Pinecone client (@pinecone-database/pinecone 4.0.0, packages/components/package.json). Any other name falls back to
// the HTTP status, read from the error or, for PineconeUnmappedHttpError, from its "Status: NNN." message.

export const STORE_ERROR_CLASSES = ['record', 'config', 'transient', 'rate_limit', 'fatal']

// Pinecone 4.0.0 maps 400 and 403 to PineconeBadRequestError, so a 403 is classed `record` and bisected; every record
// of the batch is then rejected and the reject-ratio gate fails the run (PR #41 notes this).
export const PINECONE_ERROR_CLASSES = {
    PineconeBadRequestError: 'record',
    PineconeArgumentError: 'record',
    PineconeAuthorizationError: 'config',
    PineconeNotFoundError: 'config',
    PineconeConfigurationError: 'config',
    PineconeEnvironmentVarsNotSupportedError: 'config',
    PineconeUnableToResolveHostError: 'config',
    PineconeNotImplementedError: 'config',
    PineconeConflictError: 'fatal',
    PineconeUnexpectedResponseError: 'fatal',
    PineconeInternalServerError: 'transient',
    PineconeConnectionError: 'transient'
}

// The HTTP status on the error, or quoted in its message the way Pinecone's unmapped and 404 errors quote it.
export function storeErrorStatus(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status)
    if (Number.isInteger(status) && status >= 100 && status < 600) return status
    const quoted = /\b(?:Status:|HTTP status|status code)\s*(\d{3})\b/i.exec(String(error?.message || ''))
    return quoted ? Number(quoted[1]) : null
}

// The status-code fallback for names this module doesn't know.
export function classOfStatus(status) {
    if (status === 400 || status === 413 || status === 422) return 'record'
    if (status === 401 || status === 403 || status === 404) return 'config'
    if (status === 429) return 'rate_limit'
    if (status === 408 || (status >= 500 && status < 600)) return 'transient'
    return null
}

const NETWORK =
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|timed? ?out|overloaded|unavailable|SQLITE_BUSY/i

export function classifyStoreError(error) {
    if (error?.etlError) return 'fatal'
    const byName = PINECONE_ERROR_CLASSES[String(error?.name || '')]
    if (byName) return byName
    const byStatus = classOfStatus(storeErrorStatus(error))
    if (byStatus) return byStatus
    const text = `${error?.code || ''} ${error?.message || error || ''}`
    if (/\b429\b|rate.?limit|too many requests|throttl/i.test(text)) return 'rate_limit'
    if (NETWORK.test(text)) return 'transient'
    return 'fatal'
}
