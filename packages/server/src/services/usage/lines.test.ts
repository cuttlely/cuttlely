import { stepTokens } from '../flow-check/compare'
import { ChatflowTokenUsage, usageFromLlmEnd, usageLinesFromMetrics, usageLinesFromRun, usageRange } from './lines'
import { estimateTokenLines } from './cost'

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

    it('accepts range as an alias for 7, 30, and 90 days', () => {
        expect(usageRange({ range: '7d' }, NOW)).toEqual({ ok: true, range: { startDate: '2026-10-06', endDate: '2026-10-12' } })
        expect(usageRange({ range: '30d' }, NOW)).toEqual({ ok: true, range: { startDate: '2026-09-13', endDate: '2026-10-12' } })
        expect(usageRange({ range: '90d' }, NOW)).toEqual({ ok: true, range: { startDate: '2026-07-15', endDate: '2026-10-12' } })
    })

    it('refuses a range that is not 7d, 30d, or 90d', () => {
        const parsed = usageRange({ range: 'nope' }, NOW)
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) expect(parsed.message).toBe('range must be 7d, 30d, or 90d.')
        const bare = usageRange({ range: '7' }, NOW)
        expect(bare.ok).toBe(false)
        if (!bare.ok) expect(bare.message).toBe('range must be 7d, 30d, or 90d.')
    })

    it('refuses range combined with days or a start or end date', () => {
        const withDays = usageRange({ range: '7d', days: '30' }, NOW)
        const withStart = usageRange({ range: '7d', startDate: '2026-10-01', endDate: '2026-10-03' }, NOW)
        const withEndOnly = usageRange({ range: '30d', endDate: '2026-10-12' }, NOW)
        for (const parsed of [withDays, withStart, withEndOnly]) {
            expect(parsed.ok).toBe(false)
            if (!parsed.ok) expect(parsed.message).toBe('range cannot be combined with days, startDate, or endDate.')
        }
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

    it('keeps the summed input and output when they add up to tool_call_tokens', () => {
        // Three model calls, 50+20+10 in and 50+20+10 out. tool_call_tokens is 160. total_tokens still adds the last call again.
        const step = {
            data: {
                input: { agentModelConfig: { modelName: 'gpt-4.1-mini' } },
                output: {
                    usageMetadata: {
                        input_tokens: 80,
                        output_tokens: 80,
                        total_tokens: 180,
                        tool_call_tokens: 160
                    }
                }
            }
        }
        const lines = usageLinesFromRun({ agentFlowExecutedData: [step] })
        expect(lines).toEqual([{ model: 'gpt-4.1-mini', inputTokens: 80, outputTokens: 80 }])
        expect(lines[0].inputTokens + lines[0].outputTokens).toBe(160)
    })

    it('finds no tokens in a harness tool answer string, and finds them on the payload', () => {
        expect(usageLinesFromRun('Loaf is ready.')).toEqual([])
        const lines = usageLinesFromRun({
            text: 'Loaf is ready.',
            trace: {
                route: { model: 'gpt-4.1-mini', tokens: { input_tokens: 4, output_tokens: 2 } },
                specialists: [{ model: 'claude', tokens: { input_tokens: 6, output_tokens: 3 } }],
                handoff: { model: 'gpt-4.1-mini', tokens: { input_tokens: 2, output_tokens: 1 } }
            }
        })
        expect(lines).toEqual([
            { model: 'gpt-4.1-mini', inputTokens: 6, outputTokens: 3 },
            { model: 'claude', inputTokens: 6, outputTokens: 3 }
        ])
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

    it('drops a tracer metric that has token counts and no model name', () => {
        const lines = usageLinesFromMetrics([
            { model: 'gpt-4.1-mini', promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
            { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }
        ])
        expect(lines).toEqual([{ model: 'gpt-4.1-mini', inputTokens: 1000, outputTokens: 500 }])
        expect(
            estimateTokenLines(lines, {
                unit: 'usd_per_million_tokens',
                rateFor(model: string) {
                    return model === 'gpt-4.1-mini' ? { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 } : null
                }
            })
        ).toEqual({ estimatedCostUsd: 0.0012, price: 'known', unpricedModels: [] })
        expect(usageLinesFromMetrics([{ promptTokens: 1000, completionTokens: 500 }])).toEqual([])
    })
})
