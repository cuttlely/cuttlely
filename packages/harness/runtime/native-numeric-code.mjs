import { dataRows, startsDataRows } from './native-data-rows.mjs'
import { HarnessError } from '../errors.mjs'

const sourceLimit = 8192
const itemLimit = 128
const digitsLimit = 64
const usage =
    'Use print(operation([integer, ...])), where operation is sum, len, min, max, or sorted. For ranked values use print(sorted([integer, ...], reverse=True)[:N]); reverse=True or False and the 0–128 item prefix are optional. Supply up to 128 signed decimal integers, 64 digits per integer, and 8192 source characters. For a table, start by assigning a literal list or dictionary, collect rows with for/append/extend, then print fields, counts or totals in the same call. Supports field lookup, filters, single-loop list comprehensions, per-key totals, zip, enumerate, items, scalar conversion and sorting. Example: rows = [{"amount": 12}, {"amount": 8}]\namounts = []\nfor row in rows:\n    amounts.append(row["amount"])\nprint(sum(amounts)). With import json, use json.loads or json.dumps on bounded in-cell data. Each call is stateless.'
// Match the literal list first. The two bounded suffixes cannot admit expressions as sort keys or slice bounds.
const csvOutputUsage =
    'With a verified CSV input and File Access, write one result of up to 8192 UTF-8 bytes under output/ using csv.writer or csv.DictWriter, writeheader, writerow and writerows.'
const collection = /^print[ \t]*\([ \t]*(sum|len|min|max|sorted)[ \t]*\([ \t]*\[([\d,+\- \t]*)\]([\s\S]*)$/
const plainEnd = /^[ \t]*\)[ \t]*\)[ \t]*(?:\r?\n)?$/
const rankedEnd =
    /^[ \t]*(?:,[ \t]*reverse[ \t]*=[ \t]*(True|False)[ \t]*)?\)[ \t]*(?:\[[ \t]*:[ \t]*(0|[1-9]\d{0,2})[ \t]*\][ \t]*)?\)[ \t]*(?:\r?\n)?$/
const integer = /^[+-]?(?:0|[1-9]\d*)$/

function unsupported() {
    throw new HarnessError('native_unsupported', 'The native numeric tool accepts bounded operations on a literal integer list. ' + usage)
}

// Parse one literal-list form. BigInt keeps the integer result exact at the documented size limit.
function parseCollection(name, args, sampler) {
    if (name !== 'execute_code' || !args || typeof args !== 'object' || Array.isArray(args)) unsupported()
    if (Object.keys(args).some((key) => key !== 'code' && key !== 'reset') || (Object.hasOwn(args, 'reset') && args.reset !== false))
        unsupported()
    if (typeof args.code !== 'string' || args.code.length > sourceLimit) unsupported()
    if (sampler?.accepts(args.code)) return { sample: args.code }
    if (startsDataRows(args.code)) return { rows: args.code }
    const match = collection.exec(args.code)
    if (!match || match[0] !== args.code) unsupported()
    const operation = match[1]
    const suffix = (operation === 'sorted' ? rankedEnd : plainEnd).exec(match[3])
    if (!suffix || suffix[0] !== match[3]) unsupported()
    const descending = suffix[1] === 'True'
    const limit = suffix[2] === undefined ? itemLimit : Number(suffix[2])
    if (limit > itemLimit) unsupported()
    const body = match[2].trim()
    const items = body.split(',')
    if (!items.at(-1).trim()) items.pop()
    if (items.length > itemLimit) unsupported()
    const values = []
    for (const item of items) {
        const literal = item.trim()
        if (!integer.test(literal) || literal.replace(/^[+-]/, '').length > digitsLimit) unsupported()
        values.push(BigInt(literal))
    }
    return { operation, values, descending, limit }
}

function calculate({ operation, values, descending, limit }) {
    if (!values.length && (operation === 'min' || operation === 'max'))
        return { error: `ValueError: ${operation}() iterable argument is empty` }
    switch (operation) {
        case 'sum':
            return { value: values.reduce((a, b) => a + b, 0n) }
        case 'len':
            return { value: values.length }
        case 'min':
            return { value: values.reduce((a, b) => (a < b ? a : b)) }
        case 'max':
            return { value: values.reduce((a, b) => (a > b ? a : b)) }
        case 'sorted':
            values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            if (descending) values.reverse()
            return { value: '[' + values.slice(0, limit).join(', ') + ']' }
    }
}

export function openNativeNumericCode(specialist, rolePolicy, sampler, signal, inlineTotal, files) {
    if (rolePolicy !== 'on-demand' || specialist?.codeExecution !== true || specialist.shell || specialist.browser) return null
    let confirmedInlineTotal
    const validatedSources = new WeakMap()
    async function rowSource(args) {
        const known = validatedSources.get(args)
        if (known?.code === args.code) return known
        const { source, outputPath } = await dataRows('validate', args.code, signal)
        if (source !== undefined) {
            if (!sampler?.csvRows) unsupported()
            sampler.csvRows(source, false)
        }
        if (outputPath && (!files || specialist.fileAccess !== true || !source)) unsupported()
        const cell = { code: args.code, source, outputPath }
        validatedSources.set(args, cell)
        return cell
    }
    return {
        confirmedInlineTotal: () => confirmedInlineTotal,
        tools: [
            {
                type: 'function',
                function: {
                    name: 'execute_code',
                    description: [usage, sampler?.note, files && sampler && csvOutputUsage].filter(Boolean).join(' '),
                    parameters: {
                        type: 'object',
                        properties: {
                            code: {
                                type: 'string',
                                maxLength: sourceLimit,
                                description: 'A bounded integer operation or a row transformation that prints its result.'
                            },
                            reset: {
                                type: 'boolean',
                                enum: [false],
                                description: 'Optional. The numeric tool has no persistent kernel.'
                            }
                        },
                        additionalProperties: false,
                        required: ['code']
                    }
                }
            }
        ],
        validate(name, args) {
            const parsed = parseCollection(name, args, sampler)
            if (parsed.rows !== undefined) return rowSource(args)
        },
        execute(name, args) {
            const start = performance.now()
            const parsed = parseCollection(name, args, sampler)
            if (parsed.rows !== undefined)
                return (async () => {
                    // A plain literal table never needs to resolve an upload.
                    const { source, outputPath } = /\bimport[ \t]+(?:json[ \t]*,[ \t]*)?csv\b/.test(parsed.rows)
                        ? await rowSource(args)
                        : {}
                    const input = source === undefined ? undefined : sampler.csvRows(source, true)
                    const proof =
                        source === undefined && inlineTotal
                            ? { inlineTotal: { field: inlineTotal.field, values: inlineTotal.values } }
                            : input
                    const {
                        output,
                        error,
                        confirmedInlineTotal: confirmed,
                        csvFile
                    } = await dataRows('run', parsed.rows, signal, outputPath ? { ...input, outputPath } : proof)
                    if (confirmed && !error) {
                        const [sum, count] = inlineTotal.output.trimEnd().split(' ')
                        if (output === inlineTotal.output || output === count + ' ' + sum + '\n') confirmedInlineTotal = inlineTotal.summary
                    }
                    if (source !== undefined) sampler.csvRows(source, false)
                    if (csvFile && !error) {
                        if (
                            !outputPath ||
                            csvFile.path !== outputPath ||
                            typeof csvFile.base64 !== 'string' ||
                            csvFile.base64.length > 10924
                        )
                            unsupported()
                        const bytes = Buffer.from(csvFile.base64, 'base64')
                        if (bytes.length > 8192 || bytes.toString('base64') !== csvFile.base64) unsupported()
                        const written = await files.execute('write_csv_output', { path: outputPath, content: bytes.toString('utf8') })
                        if (written.error)
                            throw new HarnessError('workspace_changed', 'The CSV output could not be saved in the current workspace.', 409)
                        sampler.csvRows(source, false)
                    }
                    return resultPacket(start, output, error)
                })()
            if (parsed.sample !== undefined) return sampler.execute(parsed.sample).then((output) => resultPacket(start, output))
            const { value, error } = calculate(parsed)
            return resultPacket(start, error ? '' : String(value) + '\n', error)
        }
    }
}

export function resultPacket(start, output, error) {
    const bytes = Buffer.byteLength(output)
    return JSON.stringify({
        status: error ? 'error' : 'success',
        ...(error && { error }),
        output: output + (error ? '\n--- stderr ---\n' + error + '\n' : ''),
        exit_code: error ? 1 : 0,
        tool_calls_made: 0,
        duration_seconds: Math.round((performance.now() - start) / 10) / 100,
        kernel: {
            mode: 'stateless',
            reused: false,
            execution_count: 1,
            state_reset: false
        },
        stdout_truncated: false,
        stdout_bytes_captured: bytes,
        stdout_bytes_total: bytes,
        stdout_bytes_omitted: 0
    })
}
