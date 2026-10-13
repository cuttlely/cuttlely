// Same or changed, and the totals the Publish dialog shows. Pure functions, no I/O.
import { addModelCost, costView, emptyCost } from '../usage/cost'
import type { TokenRates } from '../usage/cost'

export type PriceStatus = 'known' | 'partial' | 'no price'

export interface SideTokenLine {
    model: string
    inputTokens: number
    outputTokens: number
    inputUsdPerMillion: number | null
    outputUsdPerMillion: number | null
}

export interface CheckScore {
    // Omitted on a read when the caller cannot view evaluators.
    id?: string
    name?: string
    result: 'Pass' | 'Fail' | 'Error'
    // Why a model score is Error, when the grading model could not be started or did not finish.
    message?: string
}

export interface SideResult {
    text: string | null
    error: string | null
    // Total tokens the model reported, or estimated by the token counter. Null when nothing was counted.
    tokens: number | null
    // Wall-clock time for this one run, in milliseconds.
    ms: number
    // US dollars from the current model prices. Null when a price is missing or this side did not run.
    // A missing price is `no price`, never zero.
    estimatedCostUsd?: number | null
    price?: PriceStatus | null
    unpricedModels?: string[]
    // Tokens the model grader reported for this side. Counted toward the check's token cap. Not shown on the answer.
    graderTokens?: number | null
    // Token lines for this answer, with the price used. The summary groups them by model.
    // Left off the check response. Absent on a side that was built without them.
    usageLines?: SideTokenLine[]
    // One entry per evaluator, in the order the check was given. Absent when no evaluators were sent.
    scores?: CheckScore[]
}

export interface CheckCase {
    question: string
    // The dataset row's expected answer. Null when the question did not come from a dataset.
    expected?: string | null
    // Compact line for a recorded input. Set when the row is a form, webhook or schedule replay.
    preview?: string
    // Where a recorded input came from, and when that run was stored. Chat questions leave both unset.
    source?: 'form' | 'webhook' | 'schedule'
    date?: string
    live: SideResult | null
    draft: SideResult | null
    // True when both answers match after ignoring case and spacing. Null until both sides ran.
    same: boolean | null
}

export interface SideScores {
    passed: number
    failed: number
    errored: number
    // Passed divided by passed + failed + errored, as a percentage from 0 to 100 with one decimal.
    // Null when this side has no scores.
    passRate: number | null
}

export interface CheckSummary {
    ran: number
    same: number
    changed: number
    errors: number
    liveTokens: number
    draftTokens: number
    liveMedianMs: number | null
    draftMedianMs: number | null
    // Estimated US dollars for the sides that ran, with each model priced once across those answers.
    // Null when that side did not run or no model had a price. A per-answer figure can differ by one hundred-millionth.
    liveEstimatedCostUsd: number | null
    draftEstimatedCostUsd: number | null
    livePrice: PriceStatus | null
    draftPrice: PriceStatus | null
    // Present only when the check was started with evaluators.
    scores?: {
        live?: SideScores
        draft?: SideScores
    }
}

function costRollup(sides: Array<SideResult | null | undefined>): {
    estimatedCostUsd: number | null
    price: PriceStatus | null
} {
    const priced = sides.filter((side): side is SideResult => !!side && side.price != null)
    if (!priced.length) return { estimatedCostUsd: null, price: null }
    // Answers that carry token lines are priced once per model, the same way a daily usage row is.
    // Older sides have only the rounded per-answer figure.
    if (priced.every((side) => Array.isArray(side.usageLines))) return groupedCost(priced)
    return summedCost(priced)
}

function summedCost(sides: SideResult[]): { estimatedCostUsd: number | null; price: PriceStatus | null } {
    let units = 0
    let known = false
    let missing = false
    for (const side of sides) {
        if (side.price === 'no price') missing = true
        else if (side.price === 'partial') {
            missing = true
            if (side.estimatedCostUsd != null) {
                units += Math.round(side.estimatedCostUsd * 1e8)
                known = true
            }
        } else if (side.price === 'known' && side.estimatedCostUsd != null) {
            units += Math.round(side.estimatedCostUsd * 1e8)
            known = true
        }
    }
    if (!known) return { estimatedCostUsd: null, price: 'no price' }
    if (missing) return { estimatedCostUsd: units / 1e8, price: 'partial' }
    return { estimatedCostUsd: units / 1e8, price: 'known' }
}

function groupedCost(sides: SideResult[]): { estimatedCostUsd: number | null; price: PriceStatus | null } {
    const groups = new Map<
        string,
        { inputTokens: number; outputTokens: number; inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }
    >()
    let bareMissing = false
    for (const side of sides) {
        const lines = side.usageLines || []
        if (!lines.length) bareMissing = true
        for (const line of lines) {
            const prev = groups.get(line.model)
            if (!prev) {
                groups.set(line.model, {
                    inputTokens: line.inputTokens,
                    outputTokens: line.outputTokens,
                    inputUsdPerMillion: line.inputUsdPerMillion,
                    outputUsdPerMillion: line.outputUsdPerMillion
                })
                continue
            }
            prev.inputTokens += line.inputTokens
            prev.outputTokens += line.outputTokens
            if (prev.inputUsdPerMillion == null) prev.inputUsdPerMillion = line.inputUsdPerMillion
            if (prev.outputUsdPerMillion == null) prev.outputUsdPerMillion = line.outputUsdPerMillion
        }
    }
    const acc = emptyCost()
    for (const [model, group] of groups) {
        const rate: TokenRates | null =
            group.inputUsdPerMillion == null && group.outputUsdPerMillion == null
                ? null
                : {
                      inputUsdPerMillion: group.inputUsdPerMillion ?? 0,
                      outputUsdPerMillion: group.outputUsdPerMillion ?? 0
                  }
        addModelCost(acc, model, group.inputTokens, group.outputTokens, rate)
    }
    if (acc.pricedTokens === 0 && acc.unpricedTokens === 0) return { estimatedCostUsd: null, price: 'no price' }
    const view = costView(acc)
    if (bareMissing && view.price === 'known') return { estimatedCostUsd: view.estimatedCostUsd, price: 'partial' }
    return { estimatedCostUsd: view.estimatedCostUsd, price: view.price }
}

export function normalizeAnswer(text: string | null | undefined): string {
    return String(text ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

export function sameAnswer(live: SideResult, draft: SideResult): boolean {
    if (live.error || draft.error) return false
    return normalizeAnswer(live.text) === normalizeAnswer(draft.text)
}

export function median(values: number[]): number | null {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function tally(results: Array<CheckScore['result']>): SideScores {
    const passed = results.filter((result) => result === 'Pass').length
    const failed = results.filter((result) => result === 'Fail').length
    const errored = results.filter((result) => result === 'Error').length
    const total = passed + failed + errored
    return {
        passed,
        failed,
        errored,
        passRate: total ? Math.round((passed / total) * 1000) / 10 : null
    }
}

function sideScoreSummary(cases: CheckCase[], side: 'live' | 'draft'): SideScores | null {
    const results: Array<CheckScore['result']> = []
    let seen = false
    for (const item of cases) {
        const scores = item[side]?.scores
        if (!scores) continue
        seen = true
        for (const score of scores) results.push(score.result)
    }
    return seen ? tally(results) : null
}

// Scores are added only when an evaluator ran. A check with none keeps the summary shape it had before.
function withScores(summary: CheckSummary, cases: CheckCase[]): CheckSummary {
    const live = sideScoreSummary(cases, 'live')
    const draft = sideScoreSummary(cases, 'draft')
    if (!live && !draft) return summary
    return { ...summary, scores: { ...(live ? { live } : {}), ...(draft ? { draft } : {}) } }
}

// With an empty Live (a flow never published) only the draft runs, so a question counts once its draft answered.
export function summarize(cases: CheckCase[], liveEmpty = false): CheckSummary {
    if (liveEmpty) {
        const answered = cases.filter((c) => c.draft) as Array<CheckCase & { draft: SideResult }>
        const draftCost = costRollup(answered.map((c) => c.draft))
        return withScores(
            {
                ran: answered.length,
                same: 0,
                changed: 0,
                errors: answered.filter((c) => c.draft.error).length,
                liveTokens: 0,
                draftTokens: answered.reduce((sum, c) => sum + (c.draft.tokens || 0), 0),
                liveMedianMs: null,
                draftMedianMs: median(answered.filter((c) => !c.draft.error).map((c) => c.draft.ms)),
                liveEstimatedCostUsd: null,
                draftEstimatedCostUsd: draftCost.estimatedCostUsd,
                livePrice: null,
                draftPrice: draftCost.price
            },
            cases
        )
    }
    const done = cases.filter((c) => c.live && c.draft) as Array<CheckCase & { live: SideResult; draft: SideResult }>
    const liveCost = costRollup(done.map((c) => c.live))
    const draftCost = costRollup(done.map((c) => c.draft))
    return withScores(
        {
            ran: done.length,
            same: done.filter((c) => c.same === true).length,
            changed: done.filter((c) => c.same === false && !c.live.error && !c.draft.error).length,
            errors: done.filter((c) => c.live.error || c.draft.error).length,
            liveTokens: done.reduce((sum, c) => sum + (c.live.tokens || 0), 0),
            draftTokens: done.reduce((sum, c) => sum + (c.draft.tokens || 0), 0),
            liveMedianMs: median(done.filter((c) => !c.live.error).map((c) => c.live.ms)),
            draftMedianMs: median(done.filter((c) => !c.draft.error).map((c) => c.draft.ms)),
            liveEstimatedCostUsd: liveCost.estimatedCostUsd,
            draftEstimatedCostUsd: draftCost.estimatedCostUsd,
            livePrice: liveCost.price,
            draftPrice: draftCost.price
        },
        cases
    )
}

// Token metrics the evaluation tracer recorded for one run: JSON strings, some with totalTokens.
export function totalTokens(metrics: unknown[] | undefined): number | null {
    if (!metrics?.length) return null
    let total = 0
    let counted = false
    for (const entry of metrics) {
        let metric: any = entry
        if (typeof entry === 'string') {
            try {
                metric = JSON.parse(entry)
            } catch {
                continue
            }
        }
        const value = Number(metric?.totalTokens ?? (Number(metric?.promptTokens || 0) + Number(metric?.completionTokens || 0) || NaN))
        if (Number.isFinite(value) && value > 0) {
            total += value
            counted = true
        }
    }
    return counted ? total : null
}

// How many past questions a compare may ask. The dialog offers 4, 10, 25, 50 and 100.
// Any whole number from 1 to 100 is accepted; the server clamps it into that range.
// Omitting the count is a different path: the caller sends the question list, still capped at 10.
export const COMPARE_COUNT_MIN = 1
export const COMPARE_COUNT_MAX = 100
export const COMPARE_COUNT_DEFAULT = 4

export function clampCompareCount(value: number): number {
    if (!Number.isFinite(value)) return COMPARE_COUNT_DEFAULT
    const rounded = Math.round(value)
    if (rounded < COMPARE_COUNT_MIN) return COMPARE_COUNT_MIN
    if (rounded > COMPARE_COUNT_MAX) return COMPARE_COUNT_MAX
    return rounded
}

// `undefined` and `null` mean the caller did not send a count, so the check keeps the question list.
// Anything that is not a whole number is refused. A whole number outside 1..100 is clamped.
export function parseCompareCount(input: unknown): { ok: true; count: number | null } | { ok: false; message: string } {
    if (input === undefined || input === null) return { ok: true, count: null }
    if (typeof input !== 'number' || !Number.isInteger(input)) {
        return { ok: false, message: 'count must be a whole number from 1 to 100.' }
    }
    return { ok: true, count: clampCompareCount(input) }
}

// Past questions, newest first, one per wording.
// `texts` is already newest-first (message time, then message id). Case and extra spaces are ignored,
// and the newest copy of a wording is kept. The same input always returns the same list: this is not a random sample.
export function pickQuestions(texts: string[], max: number, maxChars: number): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of texts) {
        const text = String(raw ?? '').trim()
        if (!text || text.length > maxChars) continue
        const key = normalizeAnswer(text)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(text)
        if (out.length >= max) break
    }
    return out
}

// Token metrics for an agentflow run: each model step reports its own usage. Steps that report none add nothing.
export function stepTokens(steps: unknown): Array<{ totalTokens: number }> {
    if (!Array.isArray(steps)) return []
    const metrics: Array<{ totalTokens: number }> = []
    for (const step of steps) {
        const usage = (step as any)?.data?.output?.usageMetadata
        if (!usage || typeof usage !== 'object') continue
        // An Agent step that called tools reports tool_call_tokens: every model call in the step, the final answer
        // included. Its total_tokens adds the final answer again, so tool_call_tokens is the step's real total.
        const toolCallTokens = Number(usage.tool_call_tokens || 0)
        const value =
            toolCallTokens > 0
                ? toolCallTokens
                : Number(usage.total_tokens ?? Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
        if (Number.isFinite(value) && value > 0) metrics.push({ totalTokens: value })
    }
    return metrics
}
