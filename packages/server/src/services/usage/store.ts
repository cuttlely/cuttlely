import { randomUUID } from 'crypto'
import { CostAccumulator, PriceBook, addModelCost, costView, emptyCost } from './cost'
import { UsageLine, eachUtcDay, usageLinesFromRun, utcDay } from './lines'

// Structural on purpose: recording must not import the server logger or the entity registry.
export interface UsageWriter {
    options?: { type?: string }
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>
}

export interface UsageQuery {
    workspaceId: string
    startDate: string
    endDate: string
    flowId?: string
    model?: string
}

export interface UsageCostFields {
    estimatedCostUsd: number | null
    price: 'known' | 'partial' | 'no price'
}

export interface UsageReport {
    startDate: string
    endDate: string
    estimates?: true
    days: Array<{ day: string; inputTokens: number; outputTokens: number } & Partial<UsageCostFields>>
    flows: Array<{ flowId: string; inputTokens: number; outputTokens: number } & Partial<UsageCostFields>>
    models: Array<{ model: string; inputTokens: number; outputTokens: number } & Partial<UsageCostFields>>
    totals: { inputTokens: number; outputTokens: number; unpricedModels?: string[] } & Partial<UsageCostFields>
}

interface BucketRow {
    day: string
    flowId: string
    model: string
    inputTokens: number
    outputTokens: number
}

function quote(type: string, name: string): string {
    if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '')}\``
    return `"${name.replace(/"/g, '')}"`
}

function placeholders(type: string, count: number): string[] {
    if (type === 'postgres') return Array.from({ length: count }, (_, index) => `$${index + 1}`)
    return Array.from({ length: count }, () => '?')
}

function driver(dataSource: UsageWriter): string {
    return dataSource.options?.type || 'sqlite'
}

function upsertSql(type: string): string {
    const table = quote(type, 'token_usage_day')
    const cols = ['id', 'workspaceId', 'flowId', 'model', 'day', 'inputTokens', 'outputTokens'].map((name) => quote(type, name))
    const values = placeholders(type, cols.length).join(', ')
    if (type === 'mysql' || type === 'mariadb') {
        return (
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) ` +
            `ON DUPLICATE KEY UPDATE ${quote(type, 'inputTokens')} = ${quote(type, 'inputTokens')} + VALUES(${quote(
                type,
                'inputTokens'
            )}), ` +
            `${quote(type, 'outputTokens')} = ${quote(type, 'outputTokens')} + VALUES(${quote(type, 'outputTokens')})`
        )
    }
    const input = quote(type, 'inputTokens')
    const output = quote(type, 'outputTokens')
    return (
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) ` +
        `ON CONFLICT (${quote(type, 'workspaceId')}, ${quote(type, 'flowId')}, ${quote(type, 'model')}, ${quote(type, 'day')}) ` +
        `DO UPDATE SET ${input} = ${table}.${input} + excluded.${input}, ${output} = ${table}.${output} + excluded.${output}`
    )
}

async function upsertBucket(
    dataSource: UsageWriter,
    row: { workspaceId: string; flowId: string; model: string; day: string; inputTokens: number; outputTokens: number }
) {
    const type = driver(dataSource)
    await dataSource.query(upsertSql(type), [
        randomUUID(),
        row.workspaceId,
        row.flowId,
        row.model,
        row.day,
        row.inputTokens,
        row.outputTokens
    ])
}

function field(record: Record<string, unknown>, name: string): unknown {
    if (name in record) return record[name]
    const lower = name.toLowerCase()
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === lower) return record[key]
    }
    return undefined
}

function asRows(value: unknown): BucketRow[] {
    const list = Array.isArray(value) ? value : []
    return list.map((row) => {
        const record = (row || {}) as Record<string, unknown>
        return {
            day: String(field(record, 'day') ?? ''),
            flowId: String(field(record, 'flowId') ?? ''),
            model: String(field(record, 'model') ?? ''),
            inputTokens: Number(field(record, 'inputTokens')) || 0,
            outputTokens: Number(field(record, 'outputTokens')) || 0
        }
    })
}

function bucket(): { inputTokens: number; outputTokens: number; cost: CostAccumulator } {
    return { inputTokens: 0, outputTokens: 0, cost: emptyCost() }
}

function priced<T extends { inputTokens: number; outputTokens: number }>(
    row: T,
    cost: CostAccumulator,
    book: PriceBook | null | undefined,
    extra?: { unpricedModels?: boolean }
): T & Partial<UsageCostFields & { unpricedModels: string[] }> {
    if (!book) return row
    const view = costView(cost)
    return {
        ...row,
        estimatedCostUsd: view.estimatedCostUsd,
        price: view.price,
        ...(extra?.unpricedModels ? { unpricedModels: view.unpricedModels } : {})
    }
}

export async function queryTokenUsage(dataSource: UsageWriter, query: UsageQuery, book?: PriceBook | null): Promise<UsageReport> {
    const type = driver(dataSource)
    const table = quote(type, 'token_usage_day')
    const params: unknown[] = [query.workspaceId, query.startDate, query.endDate]
    const marks = placeholders(type, 3)
    let sql =
        `SELECT ${quote(type, 'day')}, ${quote(type, 'flowId')}, ${quote(type, 'model')}, ` +
        `${quote(type, 'inputTokens')}, ${quote(type, 'outputTokens')} ` +
        `FROM ${table} WHERE ${quote(type, 'workspaceId')} = ${marks[0]} ` +
        `AND ${quote(type, 'day')} >= ${marks[1]} AND ${quote(type, 'day')} <= ${marks[2]}`
    const flowId = query.flowId?.trim()
    const model = query.model?.trim()
    if (flowId) {
        params.push(flowId)
        sql += ` AND ${quote(type, 'flowId')} = ${placeholders(type, params.length).at(-1)}`
    }
    if (model) {
        params.push(model)
        sql += ` AND ${quote(type, 'model')} = ${placeholders(type, params.length).at(-1)}`
    }
    const rows = asRows(await dataSource.query(sql, params))
    const byDay = new Map<string, { inputTokens: number; outputTokens: number; cost: CostAccumulator }>()
    const byFlow = new Map<string, { inputTokens: number; outputTokens: number; cost: CostAccumulator }>()
    const byModel = new Map<string, { inputTokens: number; outputTokens: number; cost: CostAccumulator }>()
    const totals = bucket()
    for (const row of rows) {
        totals.inputTokens += row.inputTokens
        totals.outputTokens += row.outputTokens
        const day = byDay.get(row.day) || bucket()
        day.inputTokens += row.inputTokens
        day.outputTokens += row.outputTokens
        byDay.set(row.day, day)
        const flow = byFlow.get(row.flowId) || bucket()
        flow.inputTokens += row.inputTokens
        flow.outputTokens += row.outputTokens
        byFlow.set(row.flowId, flow)
        const modelRow = byModel.get(row.model) || bucket()
        modelRow.inputTokens += row.inputTokens
        modelRow.outputTokens += row.outputTokens
        byModel.set(row.model, modelRow)
        if (book) {
            const rate = book.rateFor(row.model)
            addModelCost(totals.cost, row.model, row.inputTokens, row.outputTokens, rate)
            addModelCost(day.cost, row.model, row.inputTokens, row.outputTokens, rate)
            addModelCost(flow.cost, row.model, row.inputTokens, row.outputTokens, rate)
            addModelCost(modelRow.cost, row.model, row.inputTokens, row.outputTokens, rate)
        }
    }
    return {
        startDate: query.startDate,
        endDate: query.endDate,
        ...(book ? { estimates: true as const } : {}),
        days: eachUtcDay(query.startDate, query.endDate).map((day) => {
            const found = byDay.get(day) || bucket()
            return priced({ day, inputTokens: found.inputTokens, outputTokens: found.outputTokens }, found.cost, book)
        }),
        flows: [...byFlow.entries()]
            .map(([id, found]) =>
                priced({ flowId: id, inputTokens: found.inputTokens, outputTokens: found.outputTokens }, found.cost, book)
            )
            .sort((a, b) => a.flowId.localeCompare(b.flowId)),
        models: [...byModel.entries()]
            .map(([name, found]) =>
                priced({ model: name, inputTokens: found.inputTokens, outputTokens: found.outputTokens }, found.cost, book)
            )
            .sort((a, b) => a.model.localeCompare(b.model)),
        totals: priced({ inputTokens: totals.inputTokens, outputTokens: totals.outputTokens }, totals.cost, book, { unpricedModels: true })
    }
}

// Fire-and-forget from a finished run. The returned promise resolves even when the write fails,
// so awaiting it cannot fail the run, and not awaiting it cannot leave a rejection.
export function recordCompletedRun(
    dataSource: UsageWriter | null | undefined,
    input: { workspaceId?: string | null; flowId?: string | null; result: unknown; at?: Date }
): Promise<void> {
    const write = (async () => {
        if (!dataSource || typeof dataSource.query !== 'function') return
        const workspaceId = String(input.workspaceId || '')
            .trim()
            .slice(0, 36)
        const flowId = String(input.flowId || '')
            .trim()
            .slice(0, 64)
        if (!workspaceId || !flowId) return
        const lines: UsageLine[] = usageLinesFromRun(input.result)
        if (!lines.length) return
        const day = utcDay(input.at)
        for (const line of lines) {
            await upsertBucket(dataSource, { workspaceId, flowId, day, ...line })
        }
    })()
    return write.catch((error: unknown) => {
        const name = error instanceof Error ? error.name : 'Error'
        console.error(`[usage] token totals were not saved (${name})`)
    })
}
