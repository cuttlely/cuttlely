import { randomUUID } from 'crypto'
import { PRICE_UNIT, PriceBook, TokenRates, defaultsFromModelList, formatRate, priceBook, quoteRate } from './cost'
import { UsageWriter } from './store'

export interface PriceQuote {
    input: number
    output: number
}

export interface ModelPriceRow {
    model: string
    default: PriceQuote | null
    override: PriceQuote | null
    effective: PriceQuote | null
}

export interface PriceCatalog {
    unit: typeof PRICE_UNIT
    estimates: true
    models: ModelPriceRow[]
}

function driver(dataSource: UsageWriter): string {
    return dataSource.options?.type || 'sqlite'
}

function quote(type: string, name: string): string {
    if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '')}\``
    return `"${name.replace(/"/g, '')}"`
}

function placeholders(type: string, count: number, start = 0): string[] {
    if (type === 'postgres') return Array.from({ length: count }, (_, index) => `$${start + index + 1}`)
    return Array.from({ length: count }, () => '?')
}

function field(record: Record<string, unknown>, name: string): unknown {
    if (name in record) return record[name]
    const lower = name.toLowerCase()
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === lower) return record[key]
    }
    return undefined
}

function asList(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map((row) => (row || {}) as Record<string, unknown>) : []
}

function toQuote(rate: TokenRates | null | undefined): PriceQuote | null {
    if (!rate) return null
    return { input: rate.inputUsdPerMillion, output: rate.outputUsdPerMillion }
}

export function listPriceRows(defaults: Map<string, TokenRates>, overrides: Map<string, TokenRates>): ModelPriceRow[] {
    const names = new Set<string>([...defaults.keys(), ...overrides.keys()])
    return [...names].sort().map((model) => {
        const base = defaults.get(model) ?? null
        const override = overrides.get(model) ?? null
        const effective = override ?? base
        return { model, default: toQuote(base), override: toQuote(override), effective: toQuote(effective) }
    })
}

export function priceRowFor(model: string, defaults: Map<string, TokenRates>, overrides: Map<string, TokenRates>): ModelPriceRow {
    return (
        listPriceRows(defaults, overrides).find((row) => row.model === model) || {
            model,
            default: toQuote(defaults.get(model)),
            override: null,
            effective: toQuote(defaults.get(model))
        }
    )
}

export async function organizationIdForWorkspace(dataSource: UsageWriter, workspaceId: string): Promise<string | null> {
    const type = driver(dataSource)
    const marks = placeholders(type, 1)
    const sql = `SELECT ${quote(type, 'organizationId')} FROM ${quote(type, 'workspace')} ` + `WHERE ${quote(type, 'id')} = ${marks[0]}`
    const rows = asList(await dataSource.query(sql, [workspaceId]))
    const id = rows[0] ? String(field(rows[0], 'organizationId') ?? '').trim() : ''
    return id || null
}

export async function loadOverrides(dataSource: UsageWriter, organizationId: string): Promise<Map<string, TokenRates>> {
    const type = driver(dataSource)
    const table = quote(type, 'model_price_override')
    const marks = placeholders(type, 1)
    const sql =
        `SELECT ${quote(type, 'model')}, ${quote(type, 'inputUsdPerMillion')}, ${quote(type, 'outputUsdPerMillion')} ` +
        `FROM ${table} WHERE ${quote(type, 'organizationId')} = ${marks[0]}`
    const rates = new Map<string, TokenRates>()
    for (const row of asList(await dataSource.query(sql, [organizationId]))) {
        const model = String(field(row, 'model') ?? '').trim()
        const inputUsdPerMillion = quoteRate(String(field(row, 'inputUsdPerMillion') ?? ''))
        const outputUsdPerMillion = quoteRate(String(field(row, 'outputUsdPerMillion') ?? ''))
        if (!model || inputUsdPerMillion == null || outputUsdPerMillion == null) continue
        rates.set(model, { inputUsdPerMillion, outputUsdPerMillion })
    }
    return rates
}

function upsertSql(type: string): string {
    const table = quote(type, 'model_price_override')
    const cols = ['id', 'organizationId', 'model', 'inputUsdPerMillion', 'outputUsdPerMillion'].map((name) => quote(type, name))
    const values = placeholders(type, cols.length).join(', ')
    const input = quote(type, 'inputUsdPerMillion')
    const output = quote(type, 'outputUsdPerMillion')
    if (type === 'mysql' || type === 'mariadb') {
        return (
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) ` +
            `ON DUPLICATE KEY UPDATE ${input} = VALUES(${input}), ${output} = VALUES(${output})`
        )
    }
    return (
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) ` +
        `ON CONFLICT (${quote(type, 'organizationId')}, ${quote(type, 'model')}) ` +
        `DO UPDATE SET ${input} = excluded.${input}, ${output} = excluded.${output}`
    )
}

export async function writeOverride(
    dataSource: UsageWriter,
    organizationId: string,
    model: string,
    inputUsdPerMillion: number,
    outputUsdPerMillion: number
) {
    const type = driver(dataSource)
    await dataSource.query(upsertSql(type), [
        randomUUID(),
        organizationId,
        model,
        formatRate(inputUsdPerMillion),
        formatRate(outputUsdPerMillion)
    ])
}

export async function deleteOverride(dataSource: UsageWriter, organizationId: string, model: string) {
    const type = driver(dataSource)
    const marks = placeholders(type, 2)
    const sql =
        `DELETE FROM ${quote(type, 'model_price_override')} ` +
        `WHERE ${quote(type, 'organizationId')} = ${marks[0]} AND ${quote(type, 'model')} = ${marks[1]}`
    await dataSource.query(sql, [organizationId, model])
}

export async function priceBookForWorkspace(dataSource: UsageWriter, workspaceId: string, modelList: unknown): Promise<PriceBook> {
    const defaults = defaultsFromModelList(modelList)
    let overrides = new Map<string, TokenRates>()
    try {
        const organizationId = await organizationIdForWorkspace(dataSource, workspaceId)
        if (organizationId) overrides = await loadOverrides(dataSource, organizationId)
    } catch {
        overrides = new Map()
    }
    return priceBook(defaults, overrides)
}

export async function catalogForOrganization(dataSource: UsageWriter, organizationId: string, modelList: unknown): Promise<PriceCatalog> {
    const defaults = defaultsFromModelList(modelList)
    const overrides = await loadOverrides(dataSource, organizationId)
    return { unit: PRICE_UNIT, estimates: true, models: listPriceRows(defaults, overrides) }
}
