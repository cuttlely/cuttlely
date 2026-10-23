import { SSEEncoder, SSEFrame } from '../../utils/SSEStreamer'
import { JsonRpcId, jsonRpcResult } from './rpc'
import { makeAttachmentLinkFilter } from '../orchestrate/attachmentLinks'

export type A2aEncoderMeta = {
    rpcId: JsonRpcId
    taskId: string
    contextId: string
    artifactId: string
}

export function a2aSseData(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`
}

export type A2aEncoder = SSEEncoder & {
    /** Token text still held back by the `attachment:` filter (empty when nothing is held). */
    flush(): string
    /** Whether an answer chunk was sent, so the next one appends to it. */
    started(): boolean
}

/**
 * Token frames become answer chunks, with made-up `attachment:` links removed; an artifacts frame is passed to
 * `onArtifacts` and sends nothing (the links go in the last chunk).
 */
export function makeA2aEncoder(meta: A2aEncoderMeta, onArtifacts?: (artifacts: unknown) => void): A2aEncoder {
    let firstToken = true
    const filter = makeAttachmentLinkFilter()
    const chunk = (text: string): string => {
        const append = !firstToken
        firstToken = false
        return a2aSseData(
            jsonRpcResult(meta.rpcId, {
                kind: 'artifact-update',
                taskId: meta.taskId,
                contextId: meta.contextId,
                artifact: { artifactId: meta.artifactId, name: 'answer', parts: [{ kind: 'text', text }] },
                append,
                lastChunk: false
            })
        )
    }
    const encoder = (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        // Files are only noted here; their links go after the whole answer, in the last chunk.
        if (onArtifacts && frame.kind === 'event' && frame.payload.event === 'artifacts') {
            onArtifacts(frame.payload.data)
            return null
        }
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            const text = filter.push(String(frame.payload.data ?? ''))
            return text ? chunk(text) : null
        }
        return null
    }
    return Object.assign(encoder, { flush: () => filter.flush(), started: () => !firstToken })
}

export const silentA2aEncoder: SSEEncoder = () => null
