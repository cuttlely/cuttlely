import { resolveShowToolEvents, streamChatflowSafe } from '@cuttlely/components'
import { SSEStreamer } from './SSEStreamer'

// Exercise the same execution wrapper as buildChatflow with the real SSE encoder.
describe('prediction SSE event policy', () => {
    it.each(
        [undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'].flatMap((type) =>
            [undefined, true, false].map((status) => [type, status])
        )
    )('%s setting=%s event delivery', (chatflowType, status) => {
        const showToolEvents = resolveShowToolEvents({ showToolEvents: { status } }, chatflowType as string | undefined)
        const response = { write: jest.fn(), end: jest.fn() }
        const target = new SSEStreamer()
        target.addExternalClient('chat', response as any)
        const stream = streamChatflowSafe(target, { showToolEvents })
        stream.streamStartEvent('chat', '')
        stream.streamTokenEvent('chat', 'answer')
        stream.streamUsedToolsEvent('chat', [{ tool: 'query' }])
        stream.streamCalledToolsEvent('chat', [{ tool: 'query' }])
        stream.streamAgentReasoningEvent('chat', [])
        stream.streamAgentFlowEvent('chat', [])
        stream.streamAgentFlowExecutedDataEvent('chat', [])
        stream.streamNextAgentEvent('chat', 'agent')
        stream.streamNextAgentFlowEvent('chat', 'agent')
        stream.streamToolEvent('chat', 'query')
        stream.streamCustomEvent('chat', 'agent_trace', { name: 'query' })
        stream.streamCustomEvent('chat', 'harness.route', { phase: 'start', harness: 'team' })
        stream.streamCustomEvent('chat', 'harness.tool', { name: 'query', phase: 'done' })
        stream.streamCustomEvent('chat', 'harness.final', { text: 'answer' })
        stream.streamMetadataEvent('chat', { chatId: 'chat', chatMessageId: 'message' })
        stream.removeClient('chat')
        const events = response.write.mock.calls.map(([frame]) => JSON.parse(frame.split('data:')[1]).event)
        const answerEvents = ['start', 'token', 'harness.route', 'harness.tool', 'harness.final', 'metadata', 'end']
        if (!showToolEvents) expect(events).toEqual(answerEvents)
        else
            expect(events).toEqual([
                'start',
                'token',
                'usedTools',
                'calledTools',
                'agentReasoning',
                'agentFlowEvent',
                'agentFlowExecutedData',
                'nextAgent',
                'nextAgentFlow',
                'tool',
                'agent_trace',
                ...answerEvents.slice(2)
            ])
    })
})
