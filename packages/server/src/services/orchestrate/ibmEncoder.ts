import { SSEEncoder, SSEFrame } from '../../utils/SSEStreamer'
import { makeAttachmentLinkFilter } from './attachmentLinks'

export type IbmEncoderMeta = {
    responseId: string
    threadId: string
    model: string
    created: number
}

export function ibmDeltaFrame(meta: IbmEncoderMeta, content: string): string {
    const payload = {
        id: meta.responseId,
        object: 'thread.message.delta',
        thread_id: meta.threadId,
        model: meta.model,
        created: meta.created,
        choices: [{ delta: { role: 'assistant', content } }]
    }
    return `event: thread.message.delta\ndata: ${JSON.stringify(payload)}\n\n`
}

export type IbmEncoder = SSEEncoder & {
    /** Token text still held back by the `attachment:` filter (empty when nothing is held). */
    flush(): string
}

/**
 * Token frames become deltas, with made-up `attachment:` links removed. An artifacts frame (files the run stored) is
 * passed to `onArtifacts` and sends nothing; the caller links those files in the final delta.
 */
export function makeIbmEncoder(meta: IbmEncoderMeta, onArtifacts?: (artifacts: unknown) => void): IbmEncoder {
    const filter = makeAttachmentLinkFilter()
    const encoder = (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            const text = filter.push(String(frame.payload.data ?? ''))
            return text ? ibmDeltaFrame(meta, text) : null
        }
        // Files are only noted here: their links go after the whole answer, in the final delta, so they never land
        // inside a sentence or a half-streamed link.
        if (onArtifacts && frame.kind === 'event' && frame.payload.event === 'artifacts') onArtifacts(frame.payload.data)
        return null
    }
    return Object.assign(encoder, { flush: () => filter.flush() })
}

export function chatCompletionBody(meta: IbmEncoderMeta, content: string) {
    return {
        id: meta.responseId,
        object: 'chat.completion',
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    }
}
