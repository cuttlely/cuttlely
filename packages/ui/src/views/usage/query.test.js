import {
    chartRows,
    choicesFrom,
    costLabel,
    customRangeError,
    formatTokens,
    formatUsd,
    priceInputError,
    priceRows,
    usageIsEmpty,
    usageRequest
} from './query'

describe('usage request', () => {
    it('sends 7, 30, and 90 days without a custom date', () => {
        expect(usageRequest({ preset: 7 })).toEqual({ days: 7 })
        expect(usageRequest({ preset: 30, flowId: 'flow-bakery' })).toEqual({ days: 30, flowId: 'flow-bakery' })
        expect(usageRequest({ preset: 90, model: 'gpt-4.1-mini' })).toEqual({ days: 90, model: 'gpt-4.1-mini' })
    })

    it('sends a custom range as dates and leaves days off', () => {
        expect(usageRequest({ preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-12', flowId: 'flow-orders' })).toEqual({
            startDate: '2026-10-01',
            endDate: '2026-10-12',
            flowId: 'flow-orders'
        })
        expect(usageRequest({ preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-12' }).days).toBeUndefined()
    })

    it('refuses an incomplete, reversed, or year-long custom range', () => {
        expect(customRangeError('', '2026-10-12')).toMatch(/start date/)
        expect(customRangeError('2026-10-12', '2026-10-01')).toMatch(/on or after/)
        expect(customRangeError('2025-01-01', '2026-10-12')).toMatch(/366/)
        expect(customRangeError('2026-10-01', '2026-10-12')).toBe('')
    })
})

describe('usage labels', () => {
    const payload = {
        days: [{ day: '2026-10-11', inputTokens: 105, outputTokens: 35 }],
        flows: [{ flowId: 'flow-bakery' }],
        models: [{ model: 'claude' }, { model: 'gpt-4.1-mini' }],
        totals: { inputTokens: 0, outputTokens: 0 }
    }

    it('formats tokens, chart rows, and an estimate that is not zero when the price is missing', () => {
        expect(formatTokens(2210)).toBe('2,210')
        expect(chartRows(payload.days)).toEqual([{ day: '2026-10-11', Input: 105, Output: 35 }])
        expect(choicesFrom(payload)).toEqual({ flows: ['flow-bakery'], models: ['claude', 'gpt-4.1-mini'] })
        expect(formatUsd(0.0001432)).toBe('$0.0001432')
        expect(costLabel({ estimatedCostUsd: null, price: 'no price' })).toBe('no price')
        expect(costLabel({ estimatedCostUsd: 0.0001432, price: 'partial' })).toBe('$0.0001432 (some models have no price)')
        expect(costLabel({ estimatedCostUsd: 0, price: 'known' })).toBe('$0')
        expect(usageIsEmpty({ totals: { inputTokens: 0, outputTokens: 0 } })).toBe(true)
        expect(usageIsEmpty({ totals: { inputTokens: 1, outputTokens: 0 } })).toBe(false)
    })

    it('lists a default and an override, and keeps an unpriced model that the catalog omits', () => {
        const rows = priceRows(
            [
                { model: 'gpt-4.1-mini', default: { input: 0.4, output: 1.6 }, override: null, effective: { input: 0.4, output: 1.6 } },
                { model: 'claude', default: null, override: { input: 1, output: 2 }, effective: { input: 1, output: 2 } }
            ],
            ['local-embed', 'claude']
        )
        expect(rows.map((row) => row.model)).toEqual(['claude', 'gpt-4.1-mini', 'local-embed'])
        expect(rows.find((row) => row.model === 'local-embed').default).toBeNull()
        expect(priceInputError('Input', '')).toMatch(/required/)
        expect(priceInputError('Input', '1e2')).toMatch(/plain number/)
        expect(priceInputError('Output', '-1')).toMatch(/from 0 to/)
        expect(priceInputError('Output', '0.123456789')).toMatch(/8 decimal/)
        expect(priceInputError('Input', '0.4')).toBe('')
    })
})
