import { isAgentStyleEvent, resolveShowToolEvents, streamChatflowSafe } from './streaming'
import type { IServerSideEventStreamer } from './Interface'

describe('Show tool events defaults', () => {
    it.each([undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'])('resolves missing settings and overrides for %s', (type) => {
        const expected = ['AGENTFLOW', 'MULTIAGENT', 'HARNESS'].includes(type || '')
        for (const config of [undefined, null, '', '{}', '{', {}, { showToolEvents: {} }, { showToolEvents: { status: 'true' } }]) {
            expect(resolveShowToolEvents(config, type)).toBe(expected)
        }
        for (const status of [true, false]) {
            const config = { showToolEvents: { status } }
            expect(resolveShowToolEvents(config, type)).toBe(status)
            expect(resolveShowToolEvents(JSON.stringify(config), type)).toBe(status)
        }
    })
})

const blocked = [
    'streamUsedToolsEvent',
    'streamCalledToolsEvent',
    'streamAgentReasoningEvent',
    'streamAgentFlowEvent',
    'streamAgentFlowExecutedDataEvent',
    'streamNextAgentEvent',
    'streamNextAgentFlowEvent',
    'streamToolEvent'
]

describe('execution streamer', () => {
    function fixture() {
        const calls: unknown[][] = []
        const target = {
            calls,
            ...Object.fromEntries(blocked.map((method) => [method, jest.fn()])),
            streamCustomEvent(chatId: string, event: string, data: unknown) {
                this.calls.push([chatId, event, data])
            },
            streamTokenEvent(chatId: string, text: string) {
                this.calls.push([chatId, 'token', text])
            }
        }
        return { target: target as unknown as IServerSideEventStreamer, calls }
    }
    it('suppresses typed and custom status events while preserving answers, Harness events and attachments', () => {
        const { target, calls } = fixture()
        const stream = streamChatflowSafe(target, { showToolEvents: false })
        for (const method of blocked) (stream as any)[method]('chat', [])
        for (const method of blocked) expect((target as any)[method]).not.toHaveBeenCalled()
        for (const event of [
            'usedTools',
            'calledTools',
            'agentReasoning',
            'agent_trace',
            'agentFlowEvent',
            'agentFlowFuture',
            'nextAgent',
            'nextAgentFuture',
            'tool'
        ]) {
            expect(isAgentStyleEvent(event)).toBe(true)
            stream.streamCustomEvent('chat', event, {})
        }
        const allowed = [
            'harness.route',
            'harness.tool',
            'harness.final',
            'sourceDocuments',
            'artifacts',
            'fileAnnotations',
            'action',
            'metadata',
            'end'
        ]
        for (const event of allowed) stream.streamCustomEvent('chat', event, {})
        stream.streamTokenEvent('chat', 'answer')
        expect(calls).toEqual([...allowed.map((event) => ['chat', event, {}]), ['chat', 'token', 'answer']])
    })
    it('does not mutate a shared streamer or affect a concurrent flow with events enabled', () => {
        const { target } = fixture()
        const off = streamChatflowSafe(target, { showToolEvents: false })
        const on = streamChatflowSafe(target, { showToolEvents: true })
        expect(on).toBe(target)
        off.streamUsedToolsEvent('same-chat', [])
        on.streamUsedToolsEvent('same-chat', [])
        expect(target.streamUsedToolsEvent).toHaveBeenCalledTimes(1)
        expect(streamChatflowSafe(undefined, { showToolEvents: false })).toBeUndefined()
        expect(streamChatflowSafe(target, {}).streamUsedToolsEvent('chat', [])).toBeUndefined()
        expect(target.streamUsedToolsEvent).toHaveBeenCalledTimes(1)
    })
})
