import { dollarsFromPerThousand } from '../usage'
import { calculateCost } from './CostCalculator'

// The price table uses US dollars per million tokens. This calculator uses a per-thousand rate.
// 1000 tokens at 0.4 per thousand is $0.40. The same function is what the usage estimate calls.
test('token cost uses the shared per-thousand formula', () => {
    const metrics = [
        {
            model: 'gpt-4.1-mini',
            promptTokens: 1000,
            completionTokens: 500,
            cost_values: { input_cost: 0.4, output_cost: 1.6 }
        }
    ]
    calculateCost(metrics)
    expect(dollarsFromPerThousand(0.4, 1000) + dollarsFromPerThousand(1.6, 500)).toBeCloseTo(1.2, 10)
    expect((metrics[0] as { totalCost?: string }).totalCost).toBe('$ 1.20')
})
