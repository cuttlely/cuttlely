import { readFileSync } from 'fs'
import path from 'path'
import { defaultsFromModelList, dollarsFromPerMillion, estimateTokenLines, parseModelName, parseUsdPerMillion, priceBook } from './cost'

const mini = {
    chat: [
        {
            models: [
                { name: 'gpt-4.1-mini', input_cost: 0.0000004, output_cost: 0.0000016 },
                { name: 'mystery' },
                { name: 'gpt-4.1-mini', input_cost: 9, output_cost: 9 }
            ]
        }
    ],
    llm: [],
    embedding: []
}

describe('model prices', () => {
    it('loads defaults from the model list in US dollars per million tokens', () => {
        const file = JSON.parse(readFileSync(path.join(__dirname, '../../../../components/models.json'), 'utf8'))
        const fromFile = defaultsFromModelList(file).get('gpt-4.1-mini')
        // models.json stores 0.0000004 and 0.0000016 US dollars per token.
        expect(fromFile).toEqual({ inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 })
        const defaults = defaultsFromModelList(mini)
        expect(defaults.get('gpt-4.1-mini')).toEqual({ inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 })
        expect(defaults.has('mystery')).toBe(false)
    })

    it('lets an override win, and clearing it restores the default', () => {
        const defaults = defaultsFromModelList(mini)
        const overrides = new Map([['gpt-4.1-mini', { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]])
        const overridden = priceBook(defaults, overrides)
        const lines = [{ model: 'gpt-4.1-mini', inputTokens: 1000, outputTokens: 0 }]
        // 1000 tokens at $1 per million is $0.001, not the default $0.0004.
        expect(estimateTokenLines(lines, overridden)).toMatchObject({ estimatedCostUsd: 0.001, price: 'known', unpricedModels: [] })
        const cleared = priceBook(defaults, new Map())
        expect(estimateTokenLines(lines, cleared)).toMatchObject({ estimatedCostUsd: 0.0004, price: 'known' })
    })

    it('does not price an unknown model at zero', () => {
        const book = priceBook(defaultsFromModelList(mini), new Map())
        const estimate = estimateTokenLines([{ model: 'custom-bakery', inputTokens: 1000, outputTokens: 500 }], book)
        expect(estimate.estimatedCostUsd).toBeNull()
        expect(estimate.price).toBe('no price')
        expect(estimate.unpricedModels).toEqual(['custom-bakery'])
        expect(estimate.estimatedCostUsd).not.toBe(0)
    })

    it('matches a hand-computed cost and the evaluation calculator', () => {
        // 1000 input tokens at $0.40 per million and 500 output tokens at $1.60 per million.
        // 1000 * 0.40 / 1_000_000 + 500 * 1.60 / 1_000_000 = 0.0004 + 0.0008 = 0.0012
        expect(dollarsFromPerMillion(0.4, 1000) + dollarsFromPerMillion(1.6, 500)).toBeCloseTo(0.0012, 10)
        const book = priceBook(defaultsFromModelList(mini), new Map())
        expect(estimateTokenLines([{ model: 'gpt-4.1-mini', inputTokens: 1000, outputTokens: 500 }], book).estimatedCostUsd).toBe(0.0012)
    })

    it('refuses a secret-shaped model name and a price that is not a plain number', () => {
        expect(parseModelName('')).toMatchObject({ ok: false })
        expect(parseModelName('sk-abc')).toMatchObject({ ok: false })
        expect(parseModelName('gpt-4.1-mini')).toEqual({ ok: true, model: 'gpt-4.1-mini' })
        expect(parseUsdPerMillion(-1, 'input')).toMatchObject({ ok: false })
        expect(parseUsdPerMillion('1e-7', 'input')).toMatchObject({ ok: false })
        expect(parseUsdPerMillion(0.4, 'input')).toEqual({ ok: true, value: 0.4 })
        expect(parseUsdPerMillion(0, 'output')).toEqual({ ok: true, value: 0 })
    })
})
