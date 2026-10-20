import { defaultSSEEncoder, SSEStreamer } from './SSEStreamer'

function client() {
    const writes: string[] = []
    const box = {
        writes,
        ended: false,
        response: {
            write: (data: string) => writes.push(data),
            end: () => {
                box.ended = true
            }
        }
    }
    return box
}

const encode = (obj: Record<string, unknown>) => 'message:\ndata:' + JSON.stringify(obj) + '\n\n'

describe('SSEStreamer encoder', () => {
    it('keeps default bytes identical for every stream event, heartbeat, end, and TTS abort', () => {
        const streamer = new SSEStreamer()
        const c = client()
        streamer.addExternalClient('chat-1', c.response as any)

        streamer.streamCustomEvent('chat-1', 'custom', { a: 1 })
        streamer.streamStartEvent('chat-1', 'go')
        streamer.streamTokenEvent('chat-1', 'Hi')
        streamer.streamThinkingEvent('chat-1', 'hmm', 12)
        streamer.streamThinkingEvent('chat-1', 'no-duration')
        streamer.streamSourceDocumentsEvent('chat-1', [{ page: 1 }])
        streamer.streamArtifactsEvent('chat-1', [{ id: 'a' }])
        streamer.streamUsedToolsEvent('chat-1', ['search'])
        streamer.streamCalledToolsEvent('chat-1', ['search'])
        streamer.streamFileAnnotationsEvent('chat-1', [])
        streamer.streamToolEvent('chat-1', { name: 't' })
        streamer.streamAgentReasoningEvent('chat-1', 'why')
        streamer.streamNextAgentEvent('chat-1', 'next')
        streamer.streamAgentFlowEvent('chat-1', 'flow')
        streamer.streamAgentFlowExecutedDataEvent('chat-1', { x: 1 })
        streamer.streamNextAgentFlowEvent('chat-1', 'nf')
        streamer.streamActionEvent('chat-1', { type: 'approve' })
        streamer.streamAbortEvent('chat-1')
        streamer.streamErrorEvent('chat-1', 'nope', { status: 429, code: 'RATE_LIMITED', retryAfter: 30 })
        streamer.streamUsageMetadataEvent('chat-1', { tokens: 3 })
        streamer.streamTTSStartEvent('chat-1', 'm1', 'mp3')
        streamer.streamTTSDataEvent('chat-1', 'm1', 'aaa')
        streamer.streamTTSEndEvent('chat-1', 'm1')

        const expected = [
            encode({ event: 'custom', data: { a: 1 } }),
            encode({ event: 'start', data: 'go' }),
            encode({ event: 'token', data: 'Hi' }),
            encode({ event: 'thinking', data: 'hmm', duration: 12 }),
            encode({ event: 'thinking', data: 'no-duration', duration: undefined }),
            encode({ event: 'sourceDocuments', data: [{ page: 1 }] }),
            encode({ event: 'artifacts', data: [{ id: 'a' }] }),
            encode({ event: 'usedTools', data: ['search'] }),
            encode({ event: 'calledTools', data: ['search'] }),
            encode({ event: 'fileAnnotations', data: [] }),
            encode({ event: 'tool', data: { name: 't' } }),
            encode({ event: 'agentReasoning', data: 'why' }),
            encode({ event: 'nextAgent', data: 'next' }),
            encode({ event: 'agentFlowEvent', data: 'flow' }),
            encode({ event: 'agentFlowExecutedData', data: { x: 1 } }),
            encode({ event: 'nextAgentFlow', data: 'nf' }),
            encode({ event: 'action', data: { type: 'approve' } }),
            encode({ event: 'abort', data: '[DONE]' }),
            encode({ event: 'error', data: 'nope', status: 429, code: 'RATE_LIMITED', retryAfter: 30 }),
            encode({ event: 'usageMetadata', data: { tokens: 3 } }),
            encode({ event: 'tts_start', data: { chatMessageId: 'm1', format: 'mp3' } }),
            encode({ event: 'tts_data', data: { chatMessageId: 'm1', audioChunk: 'aaa' } }),
            encode({ event: 'tts_end', data: { chatMessageId: 'm1' } })
        ]
        expect(c.writes).toEqual(expected)

        const tts = client()
        streamer.addExternalClient('tts', tts.response as any)
        streamer.streamTTSAbortEvent('tts', 'm1')
        expect(tts.writes).toEqual([encode({ event: 'tts_abort', data: { chatMessageId: 'm1' } })])
        expect(tts.ended).toBe(true)

        const ender = client()
        streamer.addExternalClient('end', ender.response as any)
        streamer.removeClient('end')
        expect(ender.writes).toEqual([encode({ event: 'end', data: '[DONE]' })])
        expect(ender.ended).toBe(true)
        expect(defaultSSEEncoder({ kind: 'comment', text: 'heartbeat' })).toBe(':heartbeat\n\n')
    })

    it('sets client.started once when a start frame is written or suppressed', () => {
        const streamer = new SSEStreamer()
        const written = client()
        streamer.addExternalClient('w', written.response as any)
        streamer.streamStartEvent('w', 'a')
        streamer.streamStartEvent('w', 'b')
        expect(written.writes).toEqual([encode({ event: 'start', data: 'a' })])

        const suppressed = client()
        let n = 0
        streamer.addExternalClient('s', suppressed.response as any, () => {
            n += 1
            return n === 1 ? null : 'should-not-write'
        })
        streamer.streamStartEvent('s', 'a')
        streamer.streamStartEvent('s', 'b')
        expect(suppressed.writes).toEqual([])
        expect(n).toBe(1)
    })

    it('gives observers the default end frame and leaves their socket open', () => {
        const streamer = new SSEStreamer()
        const source = client()
        const observer = client()
        streamer.addExternalClient('source', source.response as any, () => null)
        streamer.addClient('observer', observer.response as any)
        streamer.addObserver('source', 'observer')
        streamer.streamTokenEvent('source', 'Hi')
        streamer.removeClient('source')

        expect(source.writes).toEqual([])
        expect(source.ended).toBe(true)
        expect(observer.writes).toEqual([
            encode({ event: 'token', data: 'Hi' }),
            encode({ event: 'executionEnd', data: { chatId: 'source' } })
        ])
        expect(observer.ended).toBe(false)
        expect(streamer.hasClient('source')).toBe(false)
        expect(streamer.hasClient('observer')).toBe(true)
    })
})
