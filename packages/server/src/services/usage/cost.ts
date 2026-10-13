// CostCalculator multiplies a per-thousand-token rate by tokens / 1000. That helper stays for those rates.
// Model-list prices are US dollars per token. The price table stores US dollars per million tokens.
// An estimate from a per-million price is an integer count of hundred-millionths of a dollar, so a
// half unit rounds up. Dividing the rate in floating point first drops that half unit.

export const PRICE_UNIT = 'usd_per_million_tokens'
export const PRICE_MAX_PER_MILLION = 1_000_000

export type PriceStatus = 'known' | 'partial' | 'no price'

export interface TokenRates {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
}

export interface CostEstimate {
    estimatedCostUsd: number | null
    price: PriceStatus
    unpricedModels: string[]
}

export interface CostAccumulator {
    units: number
    pricedTokens: number
    unpricedTokens: number
    unpricedModels: Set<string>
}

export interface PriceBook {
    unit: typeof PRICE_UNIT
    rateFor(model: string): TokenRates | null
}

/** US dollars. `ratePerThousand` is the unit CostCalculator already stores on a metric. */
export function dollarsFromPerThousand(ratePerThousand: number, tokens: number): number {
    if (!Number.isFinite(ratePerThousand) || !Number.isFinite(tokens)) return 0
    return ratePerThousand * (tokens / 1000)
}

/** US dollars. `ratePerMillion` is the unit the price table stores. */
export function dollarsFromPerMillion(ratePerMillion: number, tokens: number): number {
    return unitsToUsd(costUnits(tokens, ratePerMillion))
}

// Hundred-millionths of a dollar. `usdPerMillion * 1e8` is that rate per million tokens.
// The product is divided by 1,000,000 with half-up rounding, in integers, so a remainder of
// 500,000 hundred-millionths rounds up instead of falling to the unit below.
export function costUnits(tokens: number, usdPerMillion: number): number {
    if (!Number.isFinite(tokens) || !Number.isFinite(usdPerMillion) || tokens <= 0 || usdPerMillion <= 0) return 0
    const tokenCount = Math.round(tokens)
    const scaled = Math.round(usdPerMillion * 1e8)
    if (tokenCount <= 0 || scaled <= 0) return 0
    const units = (BigInt(scaled) * BigInt(tokenCount) + 500_000n) / 1_000_000n
    return Number(units)
}

export function unitsToUsd(units: number): number {
    return Math.round(units) / 1e8
}

/** models.json stores US dollars per token. The price table stores US dollars per million tokens. */
export function perTokenToPerMillion(perToken: number): number | null {
    if (!Number.isFinite(perToken) || perToken < 0 || perToken > PRICE_MAX_PER_MILLION / 1_000_000) return null
    return unitsToUsd(Math.round(perToken * 1_000_000 * 1e8))
}

export function defaultsFromModelList(list: unknown): Map<string, TokenRates> {
    const rates = new Map<string, TokenRates>()
    if (!list || typeof list !== 'object') return rates
    const file = list as Record<string, unknown>
    for (const category of ['chat', 'llm', 'embedding']) {
        const entries = file[category]
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
            const models = entry && typeof entry === 'object' ? (entry as { models?: unknown }).models : undefined
            if (!Array.isArray(models)) continue
            for (const model of models) {
                if (!model || typeof model !== 'object') continue
                const row = model as { name?: unknown; input_cost?: unknown; output_cost?: unknown }
                const name = typeof row.name === 'string' ? row.name.trim() : ''
                if (!name || name.length > 255 || rates.has(name)) continue
                if (typeof row.input_cost !== 'number' || typeof row.output_cost !== 'number') continue
                const inputUsdPerMillion = perTokenToPerMillion(row.input_cost)
                const outputUsdPerMillion = perTokenToPerMillion(row.output_cost)
                if (inputUsdPerMillion == null || outputUsdPerMillion == null) continue
                rates.set(name, { inputUsdPerMillion, outputUsdPerMillion })
            }
        }
    }
    return rates
}

export function priceBook(defaults: Map<string, TokenRates>, overrides: Map<string, TokenRates>): PriceBook {
    return {
        unit: PRICE_UNIT,
        rateFor(model: string) {
            return overrides.get(model) ?? defaults.get(model) ?? null
        }
    }
}

export function emptyCost(): CostAccumulator {
    return { units: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: new Set() }
}

export function addModelCost(acc: CostAccumulator, model: string, inputTokens: number, outputTokens: number, rate: TokenRates | null) {
    const tokens = inputTokens + outputTokens
    if (tokens <= 0) return
    if (!rate) {
        acc.unpricedTokens += tokens
        acc.unpricedModels.add(model)
        return
    }
    acc.units += costUnits(inputTokens, rate.inputUsdPerMillion) + costUnits(outputTokens, rate.outputUsdPerMillion)
    acc.pricedTokens += tokens
}

export function costView(acc: CostAccumulator): CostEstimate {
    const unpricedModels = [...acc.unpricedModels].sort()
    if (acc.unpricedTokens === 0) return { estimatedCostUsd: unitsToUsd(acc.units), price: 'known', unpricedModels }
    if (acc.pricedTokens === 0) return { estimatedCostUsd: null, price: 'no price', unpricedModels }
    return { estimatedCostUsd: unitsToUsd(acc.units), price: 'partial', unpricedModels }
}

export function estimateTokenLines(
    lines: Array<{ model: string; inputTokens: number; outputTokens: number }>,
    book: PriceBook | null
): CostEstimate {
    const acc = emptyCost()
    for (const line of lines) {
        addModelCost(acc, line.model, line.inputTokens, line.outputTokens, book ? book.rateFor(line.model) : null)
    }
    if (acc.pricedTokens === 0 && acc.unpricedTokens === 0) return { estimatedCostUsd: null, price: 'no price', unpricedModels: [] }
    return costView(acc)
}

const MODEL_SECRET = /sk-|api[_-]?key|bearer\s|secret|password/i

export function parseModelName(value: unknown): { ok: true; model: string } | { ok: false; message: string } {
    const model = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!model) return { ok: false, message: 'model is required.' }
    if (model.length > 255) return { ok: false, message: 'model is too long.' }
    if (MODEL_SECRET.test(model)) return { ok: false, message: 'model looks like a secret. Use the model name.' }
    return { ok: true, model }
}

export function parseUsdPerMillion(value: unknown, label: string): { ok: true; value: number } | { ok: false; message: string } {
    if (typeof value === 'string' && /[eE]/.test(value)) {
        return { ok: false, message: `${label} must be a plain number of US dollars per million tokens.` }
    }
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > PRICE_MAX_PER_MILLION) {
        return { ok: false, message: `${label} must be a number from 0 to ${PRICE_MAX_PER_MILLION}.` }
    }
    const rounded = unitsToUsd(Math.round(parsed * 1e8))
    if (Math.abs(parsed - rounded) > 1e-9) {
        return { ok: false, message: `${label} can have at most 8 decimal places.` }
    }
    return { ok: true, value: rounded }
}

export function formatRate(value: number): string {
    if (!Number.isFinite(value)) return '0'
    const text = value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    return text || '0'
}

export function quoteRate(value: string): number | null {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return unitsToUsd(Math.round(parsed * 1e8))
}
