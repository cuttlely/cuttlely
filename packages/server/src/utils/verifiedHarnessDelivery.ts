import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'
import { chatImages } from '../services/harnesses/chatImages'

export function isVerifiedAnswerEvent(event: { type: string; phase?: string; trustedOutput?: boolean }) {
    return event.trustedOutput === true && (event.type === 'final' || (event.type === 'partial' && event.phase === 'answer'))
}

// Both transports deliver the same verified run. JSON retains its original inline artifacts, while SSE publishes projected data URLs.
export function assertVerifiedHarnessDelivery(payload: unknown, available?: number, signal?: AbortSignal) {
    const result = payload as {
        trustedOutput?: boolean
        trustedOutputDeadlineAt?: number
        artifacts?: unknown
        trace?: { handoff?: { reason?: string } }
    }
    if (!result?.trustedOutput && result?.trace?.handoff?.reason !== 'trustedOutput') return
    if (signal?.aborted) throw new AppError(StatusCodes.BAD_REQUEST, 'Run was cancelled.')
    if (typeof result.trustedOutputDeadlineAt === 'number' && Date.now() >= result.trustedOutputDeadlineAt)
        throw new AppError(StatusCodes.BAD_REQUEST, 'The turn budget expired before verified output could be delivered.')
    const artifacts = result.artifacts ?? []
    if (!Array.isArray(artifacts) || (available ?? chatImages(artifacts).length) !== artifacts.length)
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Verified attachments could not be delivered.')
}
