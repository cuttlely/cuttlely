// Same or changed, totals, token counts and question picking for the publish check.
import {
    COMPARE_COUNT_DEFAULT,
    clampCompareCount,
    median,
    normalizeAnswer,
    parseCompareCount,
    pickQuestions,
    sameAnswer,
    stepTokens,
    summarize,
    totalTokens
} from './compare'

const side = (text: string | null, extra: any = {}) => ({ text, error: null, tokens: 10, ms: 100, ...extra })

test('answers match ignoring case and spacing', () => {
    expect(normalizeAnswer('  Hello\n  World ')).toBe('hello world')
    expect(sameAnswer(side('MANGO'), side('mango '))).toBe(true)
    expect(sameAnswer(side('MANGO'), side('PAPAYA'))).toBe(false)
    expect(sameAnswer(side(null, { error: 'boom' }), side('MANGO'))).toBe(false)
})

test('the summary counts same, changed and errors, sums tokens and takes the median time', () => {
    const summary = summarize([
        { question: 'a', live: side('x', { tokens: 10, ms: 100 }), draft: side('x', { tokens: 12, ms: 300 }), same: true },
        { question: 'b', live: side('x', { tokens: 20, ms: 200 }), draft: side('y', { tokens: 8, ms: 100 }), same: false },
        { question: 'c', live: side('x', { tokens: 5, ms: 50 }), draft: side(null, { error: 'boom', tokens: null, ms: 999 }), same: false },
        { question: 'd', live: null, draft: null, same: null }
    ])
    expect(summary).toEqual({
        ran: 3,
        same: 1,
        changed: 1,
        errors: 1,
        liveTokens: 35,
        draftTokens: 20,
        liveMedianMs: 100,
        draftMedianMs: 200,
        liveEstimatedCostUsd: null,
        draftEstimatedCostUsd: null,
        livePrice: null,
        draftPrice: null
    })
    expect(median([])).toBeNull()
})

test('estimated cost is summed per side, and a missing price stays missing', () => {
    const summary = summarize([
        {
            question: 'a',
            live: side('x', { tokens: 1500, estimatedCostUsd: 0.0012, price: 'known', unpricedModels: [] }),
            draft: side('y', { tokens: 150, estimatedCostUsd: null, price: 'no price', unpricedModels: ['custom-bakery'] }),
            same: false
        },
        {
            question: 'b',
            live: side('x', { tokens: 10, estimatedCostUsd: 0.0004, price: 'partial', unpricedModels: ['custom-bakery'] }),
            draft: side('y', { tokens: 10, estimatedCostUsd: 0.0004, price: 'known' }),
            same: true
        }
    ])
    expect(summary.liveEstimatedCostUsd).toBe(0.0016)
    expect(summary.livePrice).toBe('partial')
    expect(summary.draftEstimatedCostUsd).toBe(0.0004)
    expect(summary.draftPrice).toBe('partial')
    expect(summary.draftTokens).toBe(160)
})

test('token totals come from the tracer metrics, and nothing counted is null', () => {
    expect(
        totalTokens([
            JSON.stringify({ provider: 'ChatOpenAI' }),
            JSON.stringify({ totalTokens: 42 }),
            JSON.stringify({ promptTokens: 3, completionTokens: 4 })
        ])
    ).toBe(49)
    expect(totalTokens([JSON.stringify({ provider: 'ChatOpenAI' })])).toBeNull()
    expect(totalTokens(undefined)).toBeNull()
    expect(totalTokens(['not json', { totalTokens: 5 }])).toBe(5)
})

test('questions: newest first, one per wording, within the limits', () => {
    expect(pickQuestions(['Hi', 'hi ', '', 'x'.repeat(30), 'Where is my order?', 'Third'], 2, 20)).toEqual(['Hi', 'Where is my order?'])
})

test('a count is clamped into 1..100, and a missing count stays missing', () => {
    expect(COMPARE_COUNT_DEFAULT).toBe(4)
    expect(clampCompareCount(4)).toBe(4)
    expect(clampCompareCount(1)).toBe(1)
    expect(clampCompareCount(100)).toBe(100)
    expect(clampCompareCount(0)).toBe(1)
    expect(clampCompareCount(-8)).toBe(1)
    expect(clampCompareCount(101)).toBe(100)
    expect(clampCompareCount(250)).toBe(100)
    expect(clampCompareCount(Number.NaN)).toBe(4)
    expect(parseCompareCount(undefined)).toEqual({ ok: true, count: null })
    expect(parseCompareCount(null)).toEqual({ ok: true, count: null })
    expect(parseCompareCount(4)).toEqual({ ok: true, count: 4 })
    expect(parseCompareCount(0)).toEqual({ ok: true, count: 1 })
    expect(parseCompareCount(500)).toEqual({ ok: true, count: 100 })
    expect(parseCompareCount(4.5)).toEqual({ ok: false, message: 'count must be a whole number from 1 to 100.' })
    expect(parseCompareCount('4')).toMatchObject({ ok: false })
    expect(parseCompareCount(true)).toMatchObject({ ok: false })
})

test('the same newest wordings are chosen every time, and repeats are dropped', () => {
    const texts = ['  Hello ', 'hello', 'Second', 'second', 'Third', 'Hello']
    const once = pickQuestions(texts, 3, 100)
    expect(once).toEqual(['Hello', 'Second', 'Third'])
    expect(pickQuestions(texts, 3, 100)).toEqual(once)
    expect(pickQuestions(['a', 'b', 'a', 'c'], 100, 100)).toEqual(['a', 'b', 'c'])
    expect(pickQuestions(texts, 100, 100)).toHaveLength(3)
})

describe('stepTokens', () => {
    test('adds up the usage each agentflow step reports', () => {
        const steps = [
            { data: { output: { question: 'hi' } } },
            { data: { output: { usageMetadata: { total_tokens: 21 } } } },
            { data: { output: { usageMetadata: { input_tokens: 5, output_tokens: 4 } } } },
            { data: { output: { usageMetadata: { total_tokens: 0 } } } },
            { data: { error: 'failed' } }
        ]
        expect(stepTokens(steps)).toEqual([{ totalTokens: 21 }, { totalTokens: 9 }])
        expect(totalTokens(stepTokens(steps))).toBe(30)
    })

    test('an Agent step that called tools counts its final answer once', () => {
        // A 10-token tool request, then a 20-token answer: the Agent reports total_tokens 50 and tool_call_tokens 30.
        const steps = [{ data: { output: { usageMetadata: { total_tokens: 50, tool_call_tokens: 30 } } } }]
        expect(stepTokens(steps)).toEqual([{ totalTokens: 30 }])
        expect(stepTokens([{ data: { output: { usageMetadata: { total_tokens: 20, tool_call_tokens: 0 } } } }])).toEqual([
            { totalTokens: 20 }
        ])
    })

    test('nothing to count gives no tokens', () => {
        expect(stepTokens(undefined)).toEqual([])
        expect(totalTokens(stepTokens([{ data: {} }]))).toBeNull()
    })
})
