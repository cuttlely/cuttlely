import { stepTokens } from '../flow-check/compare'
import { ChatflowTokenUsage, usageFromLlmEnd, usageLinesFromRun, usageRange } from './lines'

const NOW = new Date('2026-10-12T18:00:00.000Z')

describe('usageRange', () => {
    it('defaults to the last 7 UTC days, including today', () => {
        const parsed = usageRange({}, NOW)
        expect(parsed).toEqual({ ok: true, range: { startDate: '2026-10-06', endDate: '2026-10-12' } })
    })

    it('accepts 30 and 90 days', () => {
        expect(usageRange({ days: '30' }, NOW)).toEqual({ ok: true, range: { startDate: '2026-09-13', endDate: '2026-10-12' } })
        expect(usageRange({ days: 90 }, NOW)).toEqual({ ok: true, range: { startDate: '2026-07-15', endDate: '2026-10-12' } })
    })

    it('uses an inclusive custom range and ignores days when both dates are set', () => {
        expect(usageRange({ days: '7', startDate: '2026-10-01', endDate: '2026-10-03' }, NOW)).toEqual({
            ok: true,
            range: { startDate: '2026-10-01', endDate: '2026-10-03' }
        })
    })

    it('refuses a window that is not 7, 30, or 90, a half range, and a range over a year', () => {
        expect(usageRange({ days: '14' }, NOW).ok).toBe(false)
        expect(usageRange({ startDate: '2026-10-01' }, NOW).ok).toBe(false)
        expect(usageRange({ startDate: '2026-10-03', endDate: '2026-10-01' }, NOW).ok).toBe(false)
        expect(usageRange({ startDate: '2025-01-01', endDate: '2026-10-12' }, NOW).ok).toBe(false)
        expect(usageRange({ startDate: '2026-02-31', endDate: '2026-03-01' }, NOW).ok).toBe(false)
    })
})

describe('usageLinesFromRun', () => {
    it('splits a harness trace into route, specialists, and handoff without double counting the report', () => {
        const lines = usageLinesFromRun({
            report: { tokens: { prompt: 999, completion: 999 } },
            harnessPayload: {
                trace: {
                    route: { model: 'ChatOpenAI · gpt-4.1-mini', tokens: { prompt: 20, completion: 8 } },
                    specialists: [
                        { model: 'ChatOpenAI · gpt-4.1-mini', tokens: { prompt: 40, completion: 12 } },
                        { model: 'ChatAnthropic · claude', tokens: { prompt: 30, completion: 9 } }
                    ],
                    handoff: { status: 'done', model: 'ChatOpenAI · gpt-4.1-mini', tokens: { prompt: 15, completion: 6 } }
                }
            }
        })
        expect(lines).toEqual([
            { model: 'ChatOpenAI · gpt-4.1-mini', inputTokens: 75, outputTokens: 26 },
            { model: 'ChatAnthropic · claude', inputTokens: 30, outputTokens: 9 }
        ])
    })

    it('reads agentflow steps and keeps models apart', () => {
        const lines = usageLinesFromRun({
            agentFlowExecutedData: [
                {
                    data: {
                        input: { llmModelConfig: { modelName: 'gpt-4.1-mini' } },
                        output: { usageMetadata: { input_tokens: 5, output_tokens: 3 } }
                    }
                },
                {
                    data: {
                        input: { llmModelConfig: { modelName: 'claude' } },
                        output: { usageMetadata: { input_tokens: 1, output_tokens: 1 } }
                    }
                }
            ]
        })
        expect(lines).toEqual([
            { model: 'gpt-4.1-mini', inputTokens: 5, outputTokens: 3 },
            { model: 'claude', inputTokens: 1, outputTokens: 1 }
        ])
    })

    it('counts an Agent tool step once, using tool_call_tokens as the step total', () => {
        // The final response is 12 in and 8 out (20). tool_call_tokens is 30: that final response plus the earlier call.
        // total_tokens is 50 because it adds the final response again.
        const step = {
            data: {
                input: { agentModelConfig: { modelName: 'gpt-4.1-mini' } },
                output: {
                    usageMetadata: {
                        input_tokens: 12,
                        output_tokens: 8,
                        total_tokens: 50,
                        tool_call_tokens: 30
                    }
                }
            }
        }
        expect(stepTokens([step])).toEqual([{ totalTokens: 30 }])
        const lines = usageLinesFromRun({ agentFlowExecutedData: [step] })
        expect(lines).toEqual([{ model: 'gpt-4.1-mini', inputTokens: 12, outputTokens: 18 }])
        expect(lines[0].inputTokens + lines[0].outputTokens).toBe(30)
    })

    it('records a normal chatflow model end that reports usage_metadata', async () => {
        const usage = new ChatflowTokenUsage()
        usage.handleChatModelStart({ kwargs: { modelName: 'gpt-4.1-mini' } }, [], 'run-1')
        await usage.handleLLMEnd(
            {
                generations: [
                    [
                        {
                            message: {
                                usage_metadata: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
                                response_metadata: { model_name: 'fake-chat' }
                            }
                        }
                    ]
                ]
            },
            'run-1'
        )
        await usage.handleLLMEnd(
            {
                generations: [[{ message: { usage_metadata: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } } }]]
            },
            'run-1'
        )
        expect(usage.sink).toEqual([{ model: 'gpt-4.1-mini', promptTokens: 11, completionTokens: 4 }])
        expect(
            usageFromLlmEnd({ llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 } } }, 'fake-chat')
        ).toEqual({
            model: 'fake-chat',
            promptTokens: 11,
            completionTokens: 4
        })
        expect(
            usageLinesFromRun({
                text: 'Fresh bread at 7.',
                metrics: usage.sink.map((row) => ({
                    model: row.model,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens
                }))
            })
        ).toEqual([{ model: 'gpt-4.1-mini', inputTokens: 11, outputTokens: 4 }])
    })

    it('reads evaluation metrics and skips a run that reported no tokens', () => {
        expect(
            usageLinesFromRun({
                metrics: [
                    JSON.stringify({ model: 'gpt-4.1-mini', promptTokens: 3, completionTokens: 4 }),
                    { cost_values: { input_cost: 1 } }
                ]
            })
        ).toEqual([{ model: 'gpt-4.1-mini', inputTokens: 3, outputTokens: 4 }])
        expect(usageLinesFromRun({ text: 'ok' })).toEqual([])
    })
})
