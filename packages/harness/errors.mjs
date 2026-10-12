export const CHIEF_MODEL_REQUIRED = 'Connect a chat model to Harness Prime.'

export const STALE_RECORD = 'stale_record'
export const WRONG_WORKSPACE = 'wrong_workspace'
export const NO_FLOW_CONTEXT = 'no_flow_context'

export class HarnessError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'HarnessError'
        this.code = code
        this.harnessError = true
    }
}

export function asHarnessError(error) {
    if (error && error.harnessError) return error
    const wrapped = new HarnessError(error?.code || 'harness_failed', error?.message || String(error))
    return wrapped
}
