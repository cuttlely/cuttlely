import { DynamicTool } from '@langchain/core/tools'
import { RunnableLambda } from '@langchain/core/runnables'
import { AgentExecutor } from '../../../src/agents'
import * as handlers from '../../../src/handler'
import { resolveShowToolEvents } from '../../../src/streaming'
const { nodeClass: ToolAgent } = require('./ToolAgent')

describe('Tool Agent chatflow MCP streaming', () => {
    afterEach(() => jest.restoreAllMocks())

    it.each(
        [
            ['CHATFLOW', undefined, true, false],
            [undefined, undefined, true, false],
            ['CHATFLOW', true, true, true],
            ['CHATFLOW', true, false, false],
            ['AGENTFLOW', undefined, true, true],
            ['AGENTFLOW', false, true, false],
            ['MULTIAGENT', undefined, true, true],
            ['MULTIAGENT', false, true, false],
            ['HARNESS', undefined, true, true],
            ['HARNESS', false, true, false]
        ].flatMap((row) => ['calculator', 'mcp_database_query'].map((name) => [...row, name]))
    )(
        '%s setting=%s streaming=%s cards=%s preserves results and gates live events for %s',
        async (chatflowType, status, streaming, cards, toolName) => {
            const showToolEvents = resolveShowToolEvents({ showToolEvents: { status } }, chatflowType as string | undefined)
            const query = new DynamicTool({ name: toolName as string, description: 'Read database rows', func: async () => 'rows' })
            const queryCall = jest.spyOn(query, 'invoke')
            const sseStreamer = {
                streamUsedToolsEvent: jest.fn(),
                streamCustomEvent: jest.fn(),
                streamSourceDocumentsEvent: jest.fn(),
                streamArtifactsEvent: jest.fn(),
                streamStartEvent: jest.fn(),
                streamTokenEvent: jest.fn(),
                streamEndEvent: jest.fn()
            }
            const result = {
                output: 'answer',
                usedTools: [{ tool: toolName, toolOutput: 'rows' }],
                sourceDocuments: [{ pageContent: 'source' }],
                artifacts: [{ type: 'png', data: 'chart' }]
            }
            jest.spyOn(handlers, 'additionalCallbacks').mockResolvedValue([])
            jest.spyOn(AgentExecutor, 'fromAgentAndTools').mockReturnValue({
                invoke: async (_: unknown, { callbacks }: any) => {
                    const toolOutput = await query.invoke('SELECT 1')
                    for (const handler of callbacks) {
                        if (handler.name === 'custom_streaming_handler') {
                            await handler.handleToolStart({ id: ['tools', query.name] }, '{}', 'run')
                            await handler.handleToolEnd(toolOutput, 'run')
                        }
                    }
                    return result
                }
            } as any)
            const memory = { memoryKey: 'history', inputKey: 'input', getChatMessages: jest.fn(async () => []), addChatMessages: jest.fn() }
            const node = new ToolAgent()
            const output = await node.run(
                {
                    inputs: {
                        model: { bindTools: () => RunnableLambda.from(async () => 'answer') },
                        memory,
                        tools: [query],
                        enableDetailedStreaming: true,
                        systemMessage: 'Answer the question'
                    }
                },
                'question',
                {
                    chatId: 'chat',
                    showToolEvents,
                    chatflowType,
                    shouldStreamResponse: streaming,
                    sseStreamer,
                    logger: { verbose: jest.fn() }
                }
            )
            expect(output).toEqual({
                text: result.output,
                usedTools: result.usedTools,
                sourceDocuments: result.sourceDocuments,
                artifacts: result.artifacts
            })
            expect(memory.addChatMessages).toHaveBeenCalled()
            expect(queryCall).toHaveBeenCalledTimes(1)
            expect(sseStreamer.streamUsedToolsEvent).toHaveBeenCalledTimes(cards ? 1 : 0)
            expect(sseStreamer.streamCustomEvent).toHaveBeenCalledTimes(cards ? 2 : 0)
            if (cards)
                expect(sseStreamer.streamCustomEvent).toHaveBeenCalledWith(
                    'chat',
                    'agent_trace',
                    expect.objectContaining({ name: toolName })
                )
        }
    )
})
