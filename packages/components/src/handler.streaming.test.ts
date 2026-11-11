import { CustomStreamingHandler } from './handler'
import type { IServerSideEventStreamer } from './Interface'

it.each([
    [{ name: 'calculator' }, 'calculator'],
    [{ id: ['tools', 'mcp_database_query'] }, 'mcp_database_query'],
    [{ name: 'unknown-tool', kwargs: { name: 'query' }, id: ['tools', 'DynamicTool'] }, 'query'],
    [{ name: 'unknown-tool', id: ['tools', 'query'] }, 'query'],
    [{ name: '', kwargs: { name: 'calculator' } }, 'calculator'],
    [{ name: 'unknown-tool', kwargs: { name: 'unknown-tool' }, id: ['tools', 'unknown-tool'] }, 'tool'],
    [{}, 'tool']
])('resolves a real tool name from %j', async (tool, expected) => {
    const streamer = { streamCustomEvent: jest.fn() }
    const handler = new CustomStreamingHandler(streamer as unknown as IServerSideEventStreamer, 'chat', { showToolEvents: true })
    await handler.handleToolStart(tool as any, '{}', 'run', 'parent')
    expect(streamer.streamCustomEvent).toHaveBeenCalledWith(
        'chat',
        'agent_trace',
        expect.objectContaining({
            name: expected,
            input: '{}',
            runId: 'run',
            parentRunId: 'parent'
        })
    )
})

it('keeps detailed callback events off when the flow disables tool events', async () => {
    const streamer = { streamCustomEvent: jest.fn() }
    const handler = new CustomStreamingHandler(streamer as unknown as IServerSideEventStreamer, 'chat', { showToolEvents: false })
    await handler.handleToolStart({ name: 'query' } as any, '{}', 'run')
    await handler.handleToolEnd('rows', 'run')
    await handler.handleToolError(new Error('failed'), 'run')
    expect(streamer.streamCustomEvent).not.toHaveBeenCalled()
})
