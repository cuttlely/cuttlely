import { SSEEncoder, SSEFrame } from '../../utils/SSEStreamer'

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

/**
 * Token frames become deltas. With `artifactMarkdown`, an artifacts frame (files the run stored) becomes one delta with
 * their signed links; without it, or when nothing is linkable, the frame is dropped as before.
 */
export function makeIbmEncoder(meta: IbmEncoderMeta, artifactMarkdown?: (artifacts: unknown) => string): SSEEncoder {
    return (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            return ibmDeltaFrame(meta, String(frame.payload.data ?? ''))
        }
        if (artifactMarkdown && frame.kind === 'event' && frame.payload.event === 'artifacts') {
            const markdown = artifactMarkdown(frame.payload.data)
            return markdown ? ibmDeltaFrame(meta, `\n\n${markdown}`) : null
        }
        return null
    }
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
