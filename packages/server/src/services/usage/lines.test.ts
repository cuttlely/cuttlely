import { usageLinesFromRun, usageRange } from './lines'

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

    it('reads agentflow steps, including tool-call tokens, and keeps models apart', () => {
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
                        input: { agentModelConfig: { modelName: 'gpt-4.1-mini' } },
                        output: { usageMetadata: { input_tokens: 7, output_tokens: 2, tool_call_tokens: 4, total_tokens: 13 } }
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
            { model: 'gpt-4.1-mini', inputTokens: 12, outputTokens: 9 },
            { model: 'claude', inputTokens: 1, outputTokens: 1 }
        ])
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
