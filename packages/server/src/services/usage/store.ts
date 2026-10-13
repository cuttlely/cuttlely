import { randomUUID } from 'crypto'
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

export interface UsageReport {
    startDate: string
    endDate: string
    days: Array<{ day: string; inputTokens: number; outputTokens: number }>
    flows: Array<{ flowId: string; inputTokens: number; outputTokens: number }>
    models: Array<{ model: string; inputTokens: number; outputTokens: number }>
    totals: { inputTokens: number; outputTokens: number }
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

export async function queryTokenUsage(dataSource: UsageWriter, query: UsageQuery): Promise<UsageReport> {
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
    const byDay = new Map<string, { inputTokens: number; outputTokens: number }>()
    const byFlow = new Map<string, { inputTokens: number; outputTokens: number }>()
    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>()
    let inputTokens = 0
    let outputTokens = 0
    for (const row of rows) {
        inputTokens += row.inputTokens
        outputTokens += row.outputTokens
        const day = byDay.get(row.day) || { inputTokens: 0, outputTokens: 0 }
        day.inputTokens += row.inputTokens
        day.outputTokens += row.outputTokens
        byDay.set(row.day, day)
        const flow = byFlow.get(row.flowId) || { inputTokens: 0, outputTokens: 0 }
        flow.inputTokens += row.inputTokens
        flow.outputTokens += row.outputTokens
        byFlow.set(row.flowId, flow)
        const modelRow = byModel.get(row.model) || { inputTokens: 0, outputTokens: 0 }
        modelRow.inputTokens += row.inputTokens
        modelRow.outputTokens += row.outputTokens
        byModel.set(row.model, modelRow)
    }
    return {
        startDate: query.startDate,
        endDate: query.endDate,
        days: eachUtcDay(query.startDate, query.endDate).map((day) => ({
            day,
            inputTokens: byDay.get(day)?.inputTokens || 0,
            outputTokens: byDay.get(day)?.outputTokens || 0
        })),
        flows: [...byFlow.entries()].map(([id, totals]) => ({ flowId: id, ...totals })).sort((a, b) => a.flowId.localeCompare(b.flowId)),
        models: [...byModel.entries()].map(([name, totals]) => ({ model: name, ...totals })).sort((a, b) => a.model.localeCompare(b.model)),
        totals: { inputTokens, outputTokens }
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
