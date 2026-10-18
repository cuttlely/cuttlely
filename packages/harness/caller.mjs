import { HarnessError } from './errors.mjs'

export const CALLER_REQUIRED = 'caller_required'
export const KEY_NOT_ALLOWED = 'key_not_allowed'

// `session`: a signed-in person, already checked by role. `api_key`: a key and the harness names on its list.
// `flow`: a flow with no API key, so whoever has its id can call it. No list applies to its Harness cards when it runs:
// a key's list limits what that key may save into the flow, and a save by a signed-in person is checked by role only.
const KINDS = new Set(['session', 'api_key', 'flow'])

/**
 * Every harness run and canvas sync names who it acts for. A missing or unknown caller is refused, and an API key
 * runs only the harnesses on its list. `allow` narrows the kinds a call accepts.
 */
export function assertHarnessCaller(name, caller, { allow = KINDS } = {}) {
    const via = caller && typeof caller === 'object' ? caller.via : undefined
    if (typeof via !== 'string' || !KINDS.has(via) || !allow.has(via)) {
        throw new HarnessError(CALLER_REQUIRED, `Harness "${name || ''}" cannot run without a caller identity.`)
    }
    if (via !== 'api_key') return caller
    const keyId = caller.apiKeyId
    if (typeof keyId !== 'string' || !keyId || !Array.isArray(caller.harnesses)) {
        throw new HarnessError(CALLER_REQUIRED, `Harness "${name || ''}" cannot run without the API key's harness list.`)
    }
    if (!caller.harnesses.includes(name)) {
        throw new HarnessError(KEY_NOT_ALLOWED, `This API key may not run harness "${name}".`)
    }
    return caller
}

/** The caller as it rides on a queued job: plain fields only, so the worker sees the same list. */
export function serializableCaller(caller) {
    if (!caller || typeof caller !== 'object' || !KINDS.has(caller.via)) return null
    if (caller.via !== 'api_key') return { via: caller.via }
    return {
        via: 'api_key',
        apiKeyId: typeof caller.apiKeyId === 'string' ? caller.apiKeyId.slice(0, 128) : '',
        harnesses: Array.isArray(caller.harnesses) ? caller.harnesses.filter((item) => typeof item === 'string') : []
    }
}

export const SAVE_CALLERS = new Set(['session', 'api_key'])
