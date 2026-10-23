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
 * Token frames become deltas, with made-up `attachment:` links removed. With `artifactMarkdown`, an artifacts frame
 * (files the run stored) becomes one delta with their signed links; without it, or when nothing is linkable, the
 * frame is dropped as before.
 */
export function makeIbmEncoder(meta: IbmEncoderMeta, artifactMarkdown?: (artifacts: unknown) => string): IbmEncoder {
    const filter = makeAttachmentLinkFilter()
    const encoder = (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            const text = filter.push(String(frame.payload.data ?? ''))
            return text ? ibmDeltaFrame(meta, text) : null
        }
        if (artifactMarkdown && frame.kind === 'event' && frame.payload.event === 'artifacts') {
            const markdown = artifactMarkdown(frame.payload.data)
            if (!markdown) return null
            return ibmDeltaFrame(meta, `${filter.flush()}\n\n${markdown}`)
        }
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
