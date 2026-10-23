import { SSEEncoder, SSEFrame } from '../../utils/SSEStreamer'
import { JsonRpcId, jsonRpcResult } from './rpc'

export type A2aEncoderMeta = {
    rpcId: JsonRpcId
    taskId: string
    contextId: string
    artifactId: string
}

export function a2aSseData(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`
}

/** Token frames become answer chunks; with `artifactMarkdown`, an artifacts frame becomes one chunk of signed links. */
export function makeA2aEncoder(meta: A2aEncoderMeta, artifactMarkdown?: (artifacts: unknown) => string): SSEEncoder {
    let firstToken = true
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
    return (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        if (artifactMarkdown && frame.kind === 'event' && frame.payload.event === 'artifacts') {
            const markdown = artifactMarkdown(frame.payload.data)
            return markdown ? chunk(`\n\n${markdown}`) : null
        }
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            return chunk(String(frame.payload.data ?? ''))
        }
        return null
    }
}

export const silentA2aEncoder: SSEEncoder = () => null
