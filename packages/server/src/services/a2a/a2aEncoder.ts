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

export function makeA2aEncoder(meta: A2aEncoderMeta): SSEEncoder {
    let firstToken = true
    return (frame: SSEFrame) => {
        if (frame.kind === 'comment') return `:${frame.text}\n\n`
        if (frame.kind === 'event' && frame.payload.event === 'token') {
            const append = !firstToken
            firstToken = false
            return a2aSseData(
                jsonRpcResult(meta.rpcId, {
                    kind: 'artifact-update',
                    taskId: meta.taskId,
                    contextId: meta.contextId,
                    artifact: {
                        artifactId: meta.artifactId,
                        name: 'answer',
                        parts: [{ kind: 'text', text: String(frame.payload.data ?? '') }]
                    },
                    append,
                    lastChunk: false
                })
            )
        }
        return null
    }
}

export const silentA2aEncoder: SSEEncoder = () => null
