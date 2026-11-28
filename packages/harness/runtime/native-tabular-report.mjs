// Structured reports read only the bytes admitted by withManagedUploads for this turn.
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { setImmediate as yieldToTurn } from 'node:timers/promises'
import { parseRow } from '../../etl/readers.mjs'
import { HarnessError } from '../errors.mjs'
import { matchesTurnType, TURN_FILE_TYPES, TURN_IMAGE_LIMITS, TURN_FILE_LIMITS } from '../images.mjs'
import { escapeCsvFormula } from '../trusted-output.mjs'
import { nativeAnalystBinding } from './native-analyst.mjs'

import { renderFixedDocuments } from './native-files.mjs'

const documentTypes = ['pdf', 'docx', 'xlsx']
const operations = ['count', 'sum', 'mean', 'min', 'max']
const orders = ['group', 'ascending', 'descending']
const formats = ['table', 'table_and_bar_chart']
const scale = 100_000_000n
const inputLimit = 4 * 1024 * 1024
const require = createRequire(import.meta.url)

function invalid(message) {
    throw new HarnessError('invalid_report', message)
}

// The ETL parser validates quoting and UTF-8. Frame complete records first so quoted line breaks survive.
export function* csvRecords(bytes) {
    let start = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
    let quoted = false
    for (let i = start; i <= bytes.length; i++) {
        if (i - start > 65536) invalid('A CSV record exceeds 64 KiB.')
        const ch = bytes[i]
        if (ch === 0) invalid('CSV input must be UTF-8 text without NUL bytes.')
        if (ch === 34) {
            if (quoted && bytes[i + 1] === 34) i++
            else quoted = !quoted
        }
        if (i !== bytes.length && (quoted || (ch !== 10 && ch !== 13))) continue
        if (i !== bytes.length || i > start) {
            const row = parseRow(bytes, start, i, 44)
            if (row.error) invalid('Malformed CSV record (' + row.error.code + ').')
            yield row.fields
        }
        if (ch === 13 && bytes[i + 1] === 10) i++
        start = i + 1
    }
}

function decimal(text, row) {
    const match = /^([+-]?)(\d{1,18})(?:\.(\d{1,8}))?$/.exec(text.trim())
    if (!match) invalid('Row ' + row + ' needs a plain decimal, up to 18 integer and 8 fractional digits, or an empty cell.')
    const magnitude = BigInt(match[2]) * scale + BigInt((match[3] || '').padEnd(8, '0'))
    return match[1] === '-' ? -magnitude : magnitude
}

function formatDecimal(n) {
    if (n === null) return null
    const magnitude = n < 0n ? -n : n
    const fraction = (magnitude % scale).toString().padStart(8, '0').replace(/0+$/, '')
    return (n < 0n ? '-' : '') + (magnitude / scale).toString() + (fraction ? '.' + fraction : '')
}

function resultValue(bucket, operation) {
    if (operation === 'count') return BigInt(bucket.rows) * scale
    if (!bucket.observations) return null
    if (operation !== 'mean') return bucket[operation]
    const count = BigInt(bucket.observations)
    const absolute = bucket.sum < 0n ? -bucket.sum : bucket.sum
    const rounded = (absolute + count / 2n) / count
    return bucket.sum < 0n ? -rounded : rounded
}

async function summarize(bytes, options, check) {
    const rows = csvRecords(bytes)
    const headers = rows.next().value
    if (
        !headers?.length ||
        headers.length > 128 ||
        headers.some((h) => !h.trim() || h.length > 120) ||
        new Set(headers).size !== headers.length
    )
        invalid('CSV needs a header with 1 to 128 unique, nonempty column names of at most 120 characters.')
    const groupIndex = headers.indexOf(options.groupBy)
    const valueIndex = headers.indexOf(options.valueColumn)
    if ((options.groupBy !== undefined && groupIndex < 0) || (options.operation !== 'count' && valueIndex < 0))
        invalid('A selected column is missing. Inspect the CSV header for the exact column names.')
    const groups = new Map()
    let sourceRows = 0
    for (const fields of rows) {
        sourceRows++
        if (sourceRows > 50000) invalid('CSV reports support up to 50,000 rows.')
        if (sourceRows % 512 === 0) {
            await yieldToTurn()
            check()
        }
        if (fields.length !== headers.length) invalid('Row ' + (sourceRows + 1) + ' has a different column count than the header.')
        const group = groupIndex < 0 ? 'All rows' : fields[groupIndex]
        if (group.length > 120) invalid('Group labels must fit in 120 characters.')
        let bucket = groups.get(group)
        if (!bucket) {
            if (groups.size >= 250) invalid('The grouping produces more than 250 distinct groups.')
            bucket = { group, rows: 0, observations: 0, sum: 0n, min: null, max: null }
            groups.set(group, bucket)
        }
        bucket.rows++
        if (options.operation === 'count') {
            bucket.observations++
        } else if (fields[valueIndex].trim()) {
            const n = decimal(fields[valueIndex], sourceRows + 1)
            bucket.observations++
            bucket.sum += n
            if (bucket.min === null || n < bucket.min) bucket.min = n
            if (bucket.max === null || n > bucket.max) bucket.max = n
        }
    }
    if (!sourceRows) invalid('The CSV has headers but contains no data rows.')
    const summary = Array.from(groups.values(), (bucket) => ({
        group: bucket.group,
        sourceRows: bucket.rows,
        observations: bucket.observations,
        value: resultValue(bucket, options.operation)
    }))
    summary.sort((a, b) => {
        if (options.order !== 'group' && a.value !== b.value) {
            if (a.value === null) return 1
            if (b.value === null) return -1
            return (a.value < b.value ? -1 : 1) * (options.order === 'descending' ? -1 : 1)
        }
        return a.group < b.group ? -1 : a.group > b.group ? 1 : 0
    })
    return { sourceRows, rows: summary.map((row) => ({ ...row, value: formatDecimal(row.value) })) }
}

function csvCell(s) {
    const value = String(s ?? '')
    // Spreadsheet apps may ignore leading whitespace before a formula introducer.
    const guardedPrefix = /^\s+[=+@-]|^\s*[＝＋－＠]|^[\n]/u.test(value)
    const safe = guardedPrefix ? "'" + value : escapeCsvFormula(value)
    return '"' + safe.replaceAll('"', '""') + '"'
}

function csv(rows, metric) {
    const data = [['group', 'source_rows', 'observations', metric], ...rows.map((r) => [r.group, r.sourceRows, r.observations, r.value])]
    return Buffer.from(data.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n')
}

async function barChart(rows, metric, groupBy) {
    if (rows.length > 40) invalid('Bar charts support up to 40 groups. Request a table for larger summaries.')
    const { createCanvas } = require('@napi-rs/canvas')
    const canvas = createCanvas(1100, 112 + rows.length * 36)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#172b4d'
    ctx.font = 'bold 22px sans-serif'
    ctx.fillText(visibleLabel(metric + (groupBy ? ' by ' + groupBy : '')), 18, 35, canvas.width - 36)
    ctx.font = '15px sans-serif'
    ctx.fillText('Group', 18, 72)
    ctx.fillText('Value', 847, 72)
    const positive = Math.max(0, ...rows.map((r) => Number(r.value)))
    const negative = Math.min(0, ...rows.map((r) => Number(r.value)))
    const axis = (v) => 250 + ((v - negative) / (positive - negative || 1)) * 560
    const zero = axis(0)
    ctx.fillStyle = '#526174'
    ctx.fillRect(zero, 76, 1, rows.length * 36)
    rows.forEach((row, i) => {
        const y = 92 + i * 36
        ctx.fillStyle = '#253b57'
        ctx.fillText(visibleLabel(row.group) || '(empty)', 18, y + 6, 215)
        ctx.fillText(row.value ?? 'No observations', 847, y + 6, 233)
        if (row.value === null) return
        const n = Number(row.value)
        const x = axis(n)
        ctx.fillStyle = n < 0 ? '#a95020' : '#237497'
        ctx.fillRect(Math.min(zero, x), y - 8, Math.max(1, Math.abs(x - zero)), 16)
    })
    return canvas.encode('png')
}

function optionsFor(args, uploads) {
    const keys = ['source', 'operation', 'groupBy', 'valueColumn', 'order', 'format', 'documentFormats']
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((k) => !keys.includes(k)))
        invalid('Only the declared report options are accepted.')
    if (
        !['source', 'operation', 'format'].every((k) => Object.hasOwn(args, k)) ||
        !uploads.has(args.source) ||
        !operations.includes(args.operation) ||
        !formats.includes(args.format)
    )
        invalid('Choose an available CSV upload, supported operation and output format.')
    if (Object.hasOwn(args, 'documentFormats')) {
        const docs = args.documentFormats
        if (
            !Array.isArray(docs) ||
            !docs.length ||
            docs.length > documentTypes.length ||
            docs.some((format) => !documentTypes.includes(format)) ||
            new Set(docs).size !== docs.length
        )
            invalid('Choose one or more distinct supported document formats.')
    }
    if (Object.hasOwn(args, 'order') && !orders.includes(args.order)) invalid('Choose a supported sort order.')
    for (const key of ['groupBy', 'valueColumn'])
        if (Object.hasOwn(args, key) && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 120))
            invalid('Select columns by their exact nonempty CSV header.')
    if ((args.operation === 'count') === Object.hasOwn(args, 'valueColumn'))
        invalid('Count takes no value column. Other operations require a value column.')
    return { ...args, order: args.order ?? 'group' }
}

// Show untrusted column names and categories as literal table cells, including line breaks and bidi controls.
export function visibleLabel(value) {
    return String(value).replace(
        /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    )
}

function literal(value) {
    return visibleLabel(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\\|`*_\[\]~!#]/g, '\\$&')
}

export function renderTabularEvidence(records) {
    return records
        .map((r) => {
            const operation = { count: 'Row count', sum: 'Sum', mean: 'Mean', min: 'Minimum', max: 'Maximum' }[r.operation]
            const measure = operation + (r.valueColumn ? ' of ' + literal(r.valueColumn) : '')
            const grouping = r.groupBy ? ' by ' + literal(r.groupBy) : ''
            const lines = [
                'Uploaded CSV ' + literal(r.source.slice('uploads/'.length)),
                `${measure}${grouping}. Included ${r.observations} observations from ${r.sourceRows} source rows.`,
                '',
                `| Group | ${measure} | Source rows | Included |`,
                '|---|---:|---:|---:|',
                ...r.preview.map((row) => {
                    const group = literal(row.group) || '(empty)'
                    return `| ${group} | ${row.value ?? 'No observations'} | ${row.sourceRows} | ${row.observations} |`
                })
            ]
            if (r.previewTruncated) lines.push('', `Showing ${r.preview.length} of ${r.groupCount} groups. The CSV includes all groups.`)
            if (r.operation === 'mean') lines.push('', 'Means are rounded to eight decimal places.')
            lines.push('', 'Download ' + r.files.join(' and ') + '.')
            return lines.join('\n')
        })
        .join('\n\n')
}

// Model-written delegation text and data prepended by file extraction cannot choose this capability.
export function originalUploadQuestion(proof, input) {
    if (!Number.isSafeInteger(proof?.length) || proof.length < 1 || proof.length > 2048 || typeof input !== 'string') return
    const raw = input.slice(-proof.length)
    if (raw.length !== proof.length || createHash('sha256').update(raw).digest('hex') !== proof.hash) return
    return raw.trim()
}

export function confirmedReportQuestion(proof, input, source) {
    const question = originalUploadQuestion(proof, input)
    if (!question) return
    let args
    try {
        const command = /^\/analyze_csv_report\s+([\s\S]+)$/.exec(question)
        if (command) args = JSON.parse(command[1])
        else {
            // This entire sentence must request one operation. A mention in a browser or terminal assignment is insufficient.
            const ask =
                /^(?:create|generate|make) a report from (?:the |my |this )?(?:attached |uploaded )?CSV(?: file)?,? (counting rows|(?:summing|averaging|minimizing|maximizing) "([^"\r\n]{1,120})")(?: by "([^"\r\n]{1,120})")?( with a bar chart)?[.!]?$/i.exec(
                    question
                )
            if (!ask) return
            const operations = { counting: 'count', summing: 'sum', averaging: 'mean', minimizing: 'min', maximizing: 'max' }
            args = { source, operation: operations[ask[1].split(' ')[0].toLowerCase()], format: ask[4] ? 'table_and_bar_chart' : 'table' }
            if (ask[2]) args.valueColumn = ask[2]
            if (ask[3]) args.groupBy = ask[3]
        }
        return optionsFor(args, new Set([source]))
    } catch {
        return
    }
}

export function requestedMixedReport(context, role) {
    if (
        !context.checkRole ||
        context.replay ||
        !context.managedFileOwner ||
        !context.reportUpload?.proof ||
        !context.sampleInputs?.has(context.reportUpload.source) ||
        ![role.fileAccess, role.codeExecution, role.shell, role.browser].every((grant) => grant === true) ||
        role.modules?.length ||
        role.mcpServers?.length ||
        role.pinFirst ||
        role.trustedOutputs?.length
    )
        return
    return confirmedReportQuestion(
        context.reportUpload.proof,
        context.moduleOptions.nativeSourceTurn?.question,
        context.reportUpload.source
    )
}

export function openNativeTabularReport(context, specialist, requested) {
    if (specialist.fileAccess !== true || !context.managedFileOwner || context.replay) return null
    if (specialist.trustedOutputs?.length) return null
    const hasQueryGrant = [...(specialist.modules || []), ...(specialist.mcpServers || [])].some((binding) => {
        if (!nativeAnalystBinding(binding)) return false
        const actions = binding.inputs?.mcpActions
        return (typeof actions === 'string' ? JSON.parse(actions) : actions)?.includes('query')
    })
    if (specialist.codeExecution !== true && !hasQueryGrant) return null
    const uploads = new Map(Object.entries(context.managedUploads || {}).filter(([name]) => /^uploads\/[^/]+\.csv$/i.test(name)))
    if (!uploads.size || (requested && !uploads.has(requested.source))) return null
    const pending = new Map()
    const check = () => {
        context.workSignal?.throwIfAborted()
        context.assertNativeAuthority()
    }
    function validate(args) {
        if (!requested) return
        try {
            if (isDeepStrictEqual(optionsFor(args, uploads), requested)) return
        } catch {
            // A malformed tool argument has the same outcome as a different operation.
        }
        throw new HarnessError('native_unsupported', 'This role can only run the exact CSV report requested with the current upload.')
    }
    return {
        validate,
        tool: {
            type: 'function',
            function: {
                name: 'analyze_csv_report',
                description: requested
                    ? 'Run exactly the caller-approved CSV report using these arguments: ' + JSON.stringify(requested)
                    : 'Group a verified CSV upload, calculate exact decimal aggregates and return a downloadable table with an optional horizontal bar chart and PDF, Word, or Excel documents. Empty numeric cells are excluded. Mean rounds to 8 decimal places. Count counts rows, including duplicates. Use read_file to inspect the header.',
                parameters: {
                    type: 'object',
                    properties: {
                        source: { type: 'string', enum: requested ? [requested.source] : [...uploads.keys()] },
                        operation: { type: 'string', enum: operations },
                        groupBy: { type: 'string', description: 'Optional grouping column. Omit for a single total.' },
                        valueColumn: { type: 'string', description: 'Numeric column, required except for count.' },
                        order: { type: 'string', enum: orders },
                        format: { type: 'string', enum: formats },
                        documentFormats: {
                            type: 'array',
                            items: { type: 'string', enum: documentTypes },
                            minItems: 1,
                            maxItems: 3,
                            uniqueItems: true,
                            description: 'Optional additional downloads of the same verified aggregate table.'
                        }
                    },
                    additionalProperties: false,
                    required: ['source', 'operation', 'format']
                }
            }
        },
        async execute(args) {
            check()
            validate(args)
            try {
                const o = optionsFor(args, uploads)
                const docs = documentTypes.filter((format) => o.documentFormats?.includes(format))
                const signature = JSON.stringify([o.source, o.operation, o.groupBy, o.valueColumn, o.order, o.format, ...docs])
                if (pending.has(signature)) return pending.get(signature).response
                const priorFiles = Array.from(pending.values()).reduce(
                    (count, r) => count + r.artifacts.filter((a) => a.type !== 'png').length,
                    0
                )
                if (priorFiles + 1 + docs.length > TURN_FILE_LIMITS.count)
                    invalid('This specialist has reached the report attachment limit.')
                const input = uploads.get(o.source)
                if (input.length > Math.ceil(inputLimit / 3) * 4) invalid('CSV reports support uploads up to 4 MiB.')
                const bytes = Buffer.from(input, 'base64')
                if (bytes.length > inputLimit) invalid('CSV reports support uploads up to 4 MiB.')
                const { sourceRows, rows } = await summarize(bytes, o, check)
                const metric = o.valueColumn ? o.operation + '(' + o.valueColumn + ')' : 'count'
                const table = csv(rows, metric)
                const chart = o.format === 'table_and_bar_chart' ? await barChart(rows, metric, o.groupBy) : null
                check()
                if (table.length > TURN_FILE_LIMITS.bytes || (chart && chart.length > TURN_IMAGE_LIMITS.bytes))
                    invalid('The resulting report exceeds attachment limits.')
                const id = createHash('sha256').update(signature).update(bytes).digest('hex').slice(0, 16)
                const artifact = (type, mime, data) => ({
                    name: 'report-' + id + '.' + type,
                    type,
                    mime,
                    base64: data.toString('base64'),
                    specialist: specialist.name,
                    mtime: Date.now()
                })
                const artifacts = [artifact('csv', 'text/csv', table)]
                if (docs.length) {
                    const record = {
                        formats: docs,
                        metric: visibleLabel(metric),
                        rows: rows.map((r) => [visibleLabel(r.group), r.sourceRows, r.observations, r.value])
                    }
                    const rendered = await renderFixedDocuments(record, context.workSignal)
                    check()
                    if (rendered.error) invalid(rendered.error)
                    for (const type of docs) {
                        const encoded = rendered.documents?.[type]
                        if (typeof encoded !== 'string' || encoded.length > Math.ceil(TURN_FILE_LIMITS.bytes / 3) * 4)
                            invalid('The document renderer returned an invalid attachment.')
                        const data = Buffer.from(encoded, 'base64')
                        if (data.length > TURN_FILE_LIMITS.bytes || !matchesTurnType(type, data))
                            invalid('The document renderer returned an invalid attachment.')
                        artifacts.push(artifact(type, TURN_FILE_TYPES['.' + type].mime, data))
                    }
                }
                if (chart) artifacts.push(artifact('png', 'image/png', chart))
                const evidence = {
                    source: o.source,
                    operation: o.operation,
                    groupBy: o.groupBy ?? null,
                    valueColumn: o.valueColumn ?? null,
                    sourceRows,
                    observations: rows.reduce((n, r) => n + r.observations, 0),
                    groupCount: rows.length,
                    preview: rows.slice(0, 12),
                    previewTruncated: rows.length > 12,
                    files: artifacts.map((a) => a.name)
                }
                const response = { content: JSON.stringify(evidence), error: false }
                pending.set(signature, { artifacts, response, evidence })
                return response
            } catch (e) {
                if (e.code !== 'invalid_report') throw e
                return { content: JSON.stringify({ error: e.message }), error: true }
            }
        },
        evidence() {
            check()
            return Array.from(pending.values(), (entry) => structuredClone(entry.evidence))
        },
        finish() {
            check()
            return Array.from(pending.values()).flatMap((entry) => entry.artifacts)
        }
    }
}
