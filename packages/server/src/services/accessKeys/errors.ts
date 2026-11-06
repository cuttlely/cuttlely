import { AppError } from '../../errors/appError'

/** Distinguishes caller/resource policy refusals from a flow's embed Origin rule in external adapters. */
export class AccessKeyPolicyError extends AppError {
    constructor(message: string) {
        super(403, message)
    }
}

/** Retains prediction's existing plain-text streaming Origin refusal without confusing it with key scope errors. */
export class FlowOriginPolicyError extends AppError {
    constructor(message: string) {
        super(403, message)
    }
}
