// Optional output contracts consume only the server-captured result of a stamped pin.
// The model selects business parameters; it never supplies renderer code or source rows.
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { HarnessError } from './errors.mjs'
import { VERIFIED_QUERY_POLICY, verifiedQueryCapture } from './verified-query-output.mjs'
import { protectedInterpretationEvidence } from './protected-interpretation.mjs'
import { matchesTurnType, TURN_IMAGE_LIMITS, TURN_FILE_LIMITS } from './images.mjs'

const own = (value, key) => value != null && Object.hasOwn(value, key)
const fail = (message) => {
    throw new HarnessError('trusted_output', message)
}
const badPath = new Set(['__proto__', 'prototype', 'constructor'])
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
export const TRUSTED_OUTPUT_LIMIT = 200000

export function trustedOutputContracts(value) {
    if (value == null || value === '') return []
    let contracts = value
    if (typeof value === 'string') {
        try {
            contracts = JSON.parse(value)
        } catch {
            fail('Invalid trusted output contracts.')
        }
    }
    if (!Array.isArray(contracts) || contracts.length > 16) fail('At most 16 trusted output contracts are allowed.')
    const pins = new Set()
    return contracts.map((entry) => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            pins.has(entry.pin) ||
            !/^pq_[a-z0-9_]{1,77}$/.test(entry.pin || '') ||
            !/^[a-f0-9]{64}$/.test(entry.hash || '') ||
            !['markdown', 'monthly-utilization-png', 'table-payload-csv'].includes(entry.mode)
        )
            fail('A trusted output needs a unique pin, its tested hash and a supported mode.')
        pins.add(entry.pin)
        const contract = { pin: entry.pin, hash: entry.hash, mode: entry.mode }
        if (entry.mode === 'markdown') {
            if (
                entry.emptyText != null &&
                (typeof entry.emptyText !== 'string' || !entry.emptyText.trim() || entry.emptyText.length > 1000)
            )
                fail('Invalid trusted empty-result message.')
            if (entry.emptyText) contract.emptyText = entry.emptyText
            if (!Array.isArray(entry.fields) || !entry.fields.length || entry.fields.length > 32)
                fail('Trusted Markdown needs 1–32 field paths.')
            contract.fields = entry.fields.map((field) => {
                if (
                    !field ||
                    typeof field.path !== 'string' ||
                    field.path.length > 300 ||
                    !field.path.split('.').every((part) => /^(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|\*)$/.test(part) && !badPath.has(part))
                )
                    fail('Invalid trusted Markdown field path.')
                if (
                    field.heading != null &&
                    (typeof field.heading !== 'string' || field.heading.length > 160 || /[\r\n]/.test(field.heading))
                )
                    fail('Invalid trusted Markdown heading.')
                return { path: field.path, ...(field.heading ? { heading: field.heading } : {}) }
            })
        } else {
            if (entry.mode === 'table-payload-csv') {
                const payloadPath = entry.payloadPath || 'rows.0.table_payload'
                if (
                    typeof payloadPath !== 'string' ||
                    payloadPath.length > 300 ||
                    !payloadPath.split('.').every((part) => /^(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/.test(part) && !badPath.has(part))
                )
                    fail('Invalid trusted CSV payload path.')
                if (entry.payloadPath) contract.payloadPath = payloadPath
            }
            if (
                entry.sourceLabel != null &&
                (typeof entry.sourceLabel !== 'string' || entry.sourceLabel.length > 200 || /[\r\n]/.test(entry.sourceLabel))
            )
                fail('Invalid trusted chart source label.')
            if (entry.sourceLabel) contract.sourceLabel = entry.sourceLabel
        }
        return contract
    })
}

function check(signal) {
    if (signal?.aborted) throw new HarnessError('aborted', 'Run was cancelled.')
}

function valuesAt(value, parts, budget) {
    if (++budget.visits > 10000) fail('Trusted Markdown expansion exceeds the traversal limit.')
    if (!parts.length) {
        if (typeof value !== 'string' || !value.trim()) fail('Trusted Markdown field must contain source text.')
        budget.leaves++
        budget.bytes += Buffer.byteLength(value) + (budget.leaves > 1 ? 2 : 0)
        if (budget.leaves > 1000 || budget.bytes > TRUSTED_OUTPUT_LIMIT) fail('Trusted Markdown exceeds the output limit.')
        return [value]
    }
    const [key, ...rest] = parts
    if (key === '*') {
        if (!Array.isArray(value) || !value.length || value.length > 1000) fail('Trusted Markdown rows are missing or over the row limit.')
        return value.flatMap((item) => valuesAt(item, rest, budget))
    }
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > TRUSTED_OUTPUT_LIMIT) fail('Trusted Markdown JSON container exceeds the input limit.')
        try {
            value = JSON.parse(value)
        } catch {
            fail('Trusted Markdown field is missing.')
        }
    }
    if (!own(value, key)) fail('Trusted Markdown field is missing.')
    return valuesAt(value[key], rest, budget)
}

function completeResult(body, { allowEmpty = false } = {}) {
    if (
        !body ||
        !Array.isArray(body.rows) ||
        (!body.rows.length && !allowEmpty) ||
        body.error ||
        body.status === 'error' ||
        body.columnsChanged ||
        body.truncated === true ||
        body.cursor ||
        body.hasMore === true ||
        body.moreRows === true ||
        body.nextPage === true
    )
        fail('Verified output requires a complete successful source result.')
}

export function sourceMarkdown(body, contract) {
    completeResult(body, { allowEmpty: Boolean(contract.emptyText) })
    if (!body.rows.length) {
        if ((body.rowCount != null && body.rowCount !== 0) || (body.pinned?.rowCount != null && body.pinned.rowCount !== 0))
            fail('Empty source row count is inconsistent.')
        return contract.emptyText
    }
    const budget = { visits: 0, leaves: 0, bytes: 0 }
    const sections = contract.fields.map((field) => {
        const values = valuesAt(body, field.path.split('.'), budget)
        if (values.some((value) => typeof value !== 'string' || !value.trim())) fail('Trusted Markdown field must contain source text.')
        const text = values.join('\n\n')
        return field.heading ? `## ${field.heading}\n\n${text}` : text
    })
    const text = sections.join('\n\n')
    if (Buffer.byteLength(text) > TRUSTED_OUTPUT_LIMIT) fail('Trusted Markdown exceeds the output limit.')
    return text // Preserve source bytes, including reference blocks and scope captions.
}

function monthsBetween(start, end) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(start || '') || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(end || '') || start >= end)
        fail('Verified utilization requires source calendar boundaries.')
    const [year, month] = start.split('-').map(Number)
    const months = []
    let cursor = year * 12 + month - 1
    const stop = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1
    if (stop - cursor > 120) fail('Verified utilization calendar exceeds 120 months.')
    while (cursor < stop) {
        months.push(
            `${Math.floor(cursor / 12)
                .toString()
                .padStart(4, '0')}-${((cursor % 12) + 1).toString().padStart(2, '0')}`
        )
        cursor++
    }
    return months
}

export function utilizationPlan(body) {
    completeResult(body)
    if (body.rows.length !== 1) fail('Verified utilization requires one complete source envelope.')
    const envelope = body.rows[0]
    const encoded = envelope?.utilization_payload_base64
    const md5 = envelope?.utilization_payload_md5
    if (typeof encoded !== 'string' || encoded.length > 4000000 || typeof md5 !== 'string' || !/^[a-f0-9]{32}$/.test(md5))
        fail('Verified utilization envelope is missing.')
    const clean = encoded.replace(/[\r\n]/g, '')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) fail('Invalid utilization source encoding.')
    const bytes = Buffer.from(clean, 'base64')
    if (crypto.createHash('md5').update(bytes).digest('hex') !== md5) fail('Utilization source checksum mismatch.')
    let payload
    try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
        fail('Invalid utilization source JSON.')
    }
    if (payload?.schema !== 'monthly-utilization-chart/v1' || payload.complete !== true || payload.truncated !== false)
        fail('Incomplete utilization source.')
    const rows = payload.rows
    const n = rows?.length
    if (
        !Array.isArray(rows) ||
        !n ||
        n > 100 ||
        ![payload.row_count, payload.source_eligible_rows, payload.selected_rows_before_guard].every(
            (count) => Number.isInteger(count) && count === n
        )
    )
        fail('Utilization source counts are empty, capped or inconsistent.')
    const months = monthsBetween(payload.start_date, payload.end_date_exclusive)
    let calendarAsOf = null
    if (payload.calendar_as_of != null) {
        const value = payload.calendar_as_of
        if (
            typeof value !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
            new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
        )
            fail('Invalid source calendar as-of date.')
        calendarAsOf = value
    }
    const partialMonth = calendarAsOf && months.includes(calendarAsOf.slice(0, 7)) ? calendarAsOf.slice(0, 7) : null
    const fields = [
        'account_name',
        'candidate_count',
        'identity_state',
        'month',
        'product_family',
        'product_key',
        'product_unit',
        'utilization_pct'
    ].sort()
    const accounts = new Set()
    const candidates = new Set()
    const groups = new Map()
    let nulls = 0
    for (const row of rows) {
        if (
            !row ||
            JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(fields) ||
            row.identity_state !== 'resolved' ||
            !Number.isInteger(row.candidate_count) ||
            row.candidate_count < 1 ||
            row.candidate_count > 1000
        )
            fail('Unresolved utilization account or unexpected row schema.')
        if (typeof row.account_name !== 'string' || !row.account_name.trim() || row.account_name.length > 300)
            fail('Missing utilization account.')
        accounts.add(row.account_name)
        candidates.add(row.candidate_count)
        if (!months.includes(row.month)) fail('Utilization observation is outside its source calendar.')
        for (const key of ['product_family', 'product_unit'])
            if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 150)
                fail('Missing utilization product/unit identity.')
        if (
            !['string', 'number'].includes(typeof row.product_key) ||
            !String(row.product_key).trim() ||
            String(row.product_key).length > 150
        )
            fail('Missing utilization product key.')
        if (typeof row.product_key === 'number' && !Number.isSafeInteger(row.product_key))
            fail('Utilization product keys require exact identity.')
        const key = JSON.stringify([row.account_name, row.product_family, row.product_unit, String(row.product_key)])
        if (!groups.has(key))
            groups.set(key, {
                account_name: row.account_name,
                product_family: row.product_family,
                product_unit: row.product_unit,
                product_key: String(row.product_key),
                observations: new Map()
            })
        const group = groups.get(key)
        const raw = row.utilization_pct
        if (
            raw !== null &&
            !((typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) || typeof raw === 'number')
        )
            fail('Invalid utilization measurement.')
        const value = raw === null ? null : Number(raw)
        if (value !== null && !Number.isFinite(value)) fail('Non-finite utilization measurement.')
        if (group.observations.has(row.month)) fail('Duplicate utilization product/unit/month; do not aggregate source observations.')
        group.observations.set(row.month, value)
        if (value === null) nulls++
    }
    if (candidates.size !== 1 || accounts.size > [...candidates][0]) fail('Inconsistent resolved utilization account scope.')
    const series = [...groups.values()]
        .filter((group) => [...group.observations.values()].some((value) => value !== null))
        .sort((a, b) =>
            JSON.stringify([a.account_name, a.product_family, a.product_unit, a.product_key]).localeCompare(
                JSON.stringify([b.account_name, b.product_family, b.product_unit, b.product_key])
            )
        )
        .map((group) => ({
            ...group,
            values: months.map((month) => group.observations.get(month) ?? null),
            observations: [...group.observations.values()].filter((value) => value !== null).length
        }))
    if (!series.length) fail('No populated utilization observations; no chart was created.')
    if (payload.source_as_of != null && (typeof payload.source_as_of !== 'string' || payload.source_as_of.length > 200))
        fail('Invalid source refresh metadata.')
    return {
        account: [...accounts].join(', '),
        accounts: [...accounts],
        calendarAsOf,
        partialMonth,
        months,
        series,
        observations: series.reduce((sum, group) => sum + group.observations, 0),
        nulls,
        sourceRows: n,
        start: payload.start_date,
        end: payload.end_date_exclusive,
        sourceAsOf: payload.source_as_of ?? null,
        sourceHash: hash(bytes)
    }
}

export async function utilizationPng(body, contract, { specialist = '', signal, preview = false } = {}) {
    check(signal)
    const plan = utilizationPlan(body)
    // An explicit server dependency supplies prebuilt binaries; no runtime package installation or shell.
    const require = createRequire(import.meta.url)
    const { createCanvas } = require('@napi-rs/canvas')
    const canvas = createCanvas(1600, 1000)
    const ctx = canvas.getContext('2d')
    const left = 100,
        right = 1540,
        top = 110,
        bottom = 690
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#172033'
    ctx.font = 'bold 27px sans-serif'
    ctx.fillText(
        plan.accounts.length === 1
            ? `${plan.account} — monthly utilization`
            : `Monthly utilization — ${plan.accounts.length} source accounts`,
        left,
        55,
        right - left
    )
    const populated = plan.series.flatMap((group) => group.values.filter((value) => value !== null))
    const low = Math.min(0, ...populated),
        high = Math.max(10, ...populated)
    const padding = Math.max(5, (high - low) * 0.1)
    const min = low < 0 ? low - padding : 0,
        max = high + padding
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(max - min))
        fail('Utilization values exceed the rendering range.')
    const x = (index) => left + (index * (right - left)) / Math.max(1, plan.months.length - 1)
    const y = (value) => bottom - ((value - min) / (max - min)) * (bottom - top)
    ctx.font = '16px sans-serif'
    ctx.lineWidth = 1
    for (let tick = 0; tick <= 5; tick++) {
        const value = min + (max - min) * (tick / 5)
        const yy = y(value)
        ctx.strokeStyle = '#e2e6ed'
        ctx.beginPath()
        ctx.moveTo(left, yy)
        ctx.lineTo(right, yy)
        ctx.stroke()
        ctx.fillStyle = '#354052'
        ctx.fillText(`${Number(value.toFixed(1))}%`, 10, yy + 5)
    }
    const tickStride = Math.max(1, Math.ceil((plan.months.length - 1) / 14))
    plan.months.forEach((month, index) => {
        if (index % tickStride && index !== plan.months.length - 1 && month !== plan.partialMonth) return
        ctx.save()
        ctx.translate(x(index), bottom + 22)
        ctx.rotate(-0.6)
        ctx.textAlign = index === 0 ? 'left' : index === plan.months.length - 1 ? 'right' : 'center'
        ctx.fillText(month + (month === plan.partialMonth ? '*' : ''), 0, 0)
        ctx.restore()
    })
    const colors = ['#6a3df2', '#1e8e5a', '#d97706', '#2563eb', '#be185d', '#0891b2', '#7c3e16', '#455a64', '#4d7c0f', '#c026d3']
    plan.series.forEach((group, index) => {
        check(signal)
        ctx.strokeStyle = colors[index % colors.length]
        ctx.fillStyle = ctx.strokeStyle
        ctx.lineWidth = 3
        let previous = false
        ctx.beginPath()
        group.values.forEach((value, month) => {
            if (value === null) {
                previous = false
                return
            }
            if (previous) ctx.lineTo(x(month), y(value))
            else ctx.moveTo(x(month), y(value))
            previous = true
        })
        ctx.stroke()
        group.values.forEach((value, month) => {
            if (value !== null) {
                ctx.beginPath()
                ctx.arc(x(month), y(value), 5, 0, Math.PI * 2)
                ctx.fill()
            }
        })
        ctx.font = '16px sans-serif'
        ctx.fillText(
            `${plan.accounts.length > 1 ? group.account_name + ' / ' : ''}${group.product_family} / ${group.product_unit} / product ${
                group.product_key
            }`,
            left + (index % 2) * 710,
            785 + Math.floor(index / 2) * 25,
            690
        )
    })
    if (plan.series.length > 10) fail('Utilization legend exceeds the supported series limit.')
    ctx.fillStyle = '#354052'
    ctx.font = '16px sans-serif'
    ctx.fillText(
        `Window: [${plan.start}, ${plan.end}) UTC.${
            plan.partialMonth ? ' ' + plan.partialMonth + ' is partial (source calendar as of ' + plan.calendarAsOf + ').' : ''
        } NULLs are gaps; no interpolation.`,
        left,
        950,
        right - left
    )
    ctx.fillText(
        `Source: ${contract.sourceLabel || 'verified monthly utilization query'}. Refresh: ${plan.sourceAsOf || 'unavailable'}.`,
        left,
        978,
        right - left
    )
    const bytes = await canvas.encode('png')
    check(signal)
    if (!matchesTurnType('png', bytes) || bytes.length > TURN_IMAGE_LIMITS.bytes) fail('Verified PNG exceeds native attachment limits.')
    const name = `monthly-utilization-${plan.sourceHash.slice(0, 12)}.png`
    const artifact = { name, type: 'png', mime: 'image/png', base64: bytes.toString('base64'), specialist, mtime: Date.now() }
    const text = `${preview ? `Preview file: ${name} (not saved to chat)` : `Attached file: ${name}`}\n\n${plan.account}: ${
        plan.observations
    } source observations across ${plan.series.length} product/unit series over ${plan.months.length} source calendar months. ${
        plan.nulls
    } NULL measurements among ${plan.sourceRows} source rows; gaps are not interpolated.${
        plan.partialMonth ? ' ' + plan.partialMonth + ' is partial; source calendar as of ' + plan.calendarAsOf + '.' : ''
    } Source: ${contract.sourceLabel || 'verified monthly utilization query'}. Source refresh: ${plan.sourceAsOf || 'unavailable'}.`
    return { text, artifact, plan }
}

// CSV consumes an author-owned complete table payload, never model arguments or renderer code.
export function tablePayloadCsv(body, contract = {}, { specialist = '', signal, preview = false } = {}) {
    check(signal)
    completeResult(body)
    let payload = body
    for (const key of (contract.payloadPath || 'rows.0.table_payload').split('.')) {
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload)
            } catch {
                fail('Verified CSV source payload is invalid.')
            }
        }
        if (!own(payload, key) || badPath.has(key)) fail('Verified CSV source payload is missing.')
        payload = payload[key]
    }
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload)
        } catch {
            fail('Verified CSV source payload is invalid.')
        }
    }
    const headers = payload?.headers,
        rows = payload?.complete_rows
    if (
        payload?.complete !== true ||
        payload?.truncated !== false ||
        !Number.isInteger(payload?.total_rows) ||
        payload.total_rows < 0 ||
        payload.total_rows > 100 ||
        !Array.isArray(rows) ||
        rows.length !== payload.total_rows ||
        !Array.isArray(headers) ||
        !headers.length ||
        headers.length > 100 ||
        headers.some((header) => typeof header !== 'string' || !header.length || header.length > 500) ||
        new Set(headers).size !== headers.length
    )
        fail('Verified CSV requires a complete table with exact headers and at most 100 rows.')
    let bytesUsed = 0
    const encode = (value) => {
        if (value === null) {
            bytesUsed++
            return ''
        }
        if (typeof value !== 'string' || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value)
            fail('Verified CSV cells must be exact UTF-8 strings or NULL; numeric coercion is refused.')
        bytesUsed += Buffer.byteLength(value) + 2
        if (bytesUsed > TURN_FILE_LIMITS.bytes) fail('Verified CSV exceeds native attachment limits.')
        return '"' + value.replaceAll('"', '""') + '"'
    }
    const lines = [headers.map(encode).join(',')]
    for (const row of rows) {
        check(signal)
        if (!Array.isArray(row) || row.length !== headers.length) fail('Verified CSV row does not match its source headers.')
        lines.push(row.map(encode).join(','))
    }
    const bytes = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
    if (bytes.length > TURN_FILE_LIMITS.bytes || !matchesTurnType('csv', bytes)) fail('Verified CSV exceeds native attachment limits.')
    check(signal)
    const name = `verified-table-${hash(bytes).slice(0, 12)}.csv`
    const sourceFields = {
        metric_label: 'Metric',
        metric_definition: 'Metric definition',
        date_basis: 'Date basis',
        calendar_start_inclusive: 'Calendar start (inclusive)',
        calendar_end_exclusive: 'Calendar end (exclusive)',
        source: 'Source',
        source_as_of: 'Source as of',
        source_freshness: 'Source freshness'
    }
    const captions = []
    for (const [key, label] of Object.entries(sourceFields)) {
        if (!own(payload, key)) continue
        const value = payload[key]
        if (
            value !== null &&
            (typeof value !== 'string' || value.length > 4000 || value.includes('\0') || Buffer.from(value).toString('utf8') !== value)
        )
            fail('Verified CSV source metadata must be bounded exact UTF-8 text or NULL.')
        captions.push(`${label}: ${value === null ? 'unavailable' : value}`)
    }
    if (!own(payload, 'source_as_of') && !own(payload, 'source_freshness')) captions.push('Source freshness: unavailable')
    if (contract.sourceLabel) captions.push('Source label: ' + contract.sourceLabel)
    return {
        text: `${preview ? `Preview file: ${name} (not saved to chat)` : `Attached file: ${name}`}\n\n${
            rows.length
        } source rows exported in source order with exact string values. NULL values are empty CSV fields.\n\n${captions.join('\n')}`,
        artifact: { name, type: 'csv', mime: 'text/csv', base64: bytes.toString('base64'), specialist, mtime: Date.now() }
    }
}

export async function renderTrustedOutputs(specialist, captured, { signal, preview = false } = {}) {
    const contracts = specialist.trustedOutputs || []
    if (!contracts.length) return null
    const matched = contracts.flatMap((contract) =>
        captured.filter((item) => contract.pin === (item.toolName || item.pinned?.name)).map((item) => ({ item, contract }))
    )
    if (!matched.length) return null
    const sections = [],
        artifacts = [],
        seen = new Set()
    for (const { item, contract } of matched) {
        check(signal)
        if (
            !item.callId ||
            item.pinned?.name !== contract.pin ||
            item.pinned?.hash !== contract.hash ||
            !Number.isInteger(item.pinned?.version)
        )
            fail('Verified output pin identity changed or its test stamp is missing.')
        const id = hash(JSON.stringify([contract.pin, item.result]))
        if (seen.has(id)) continue
        seen.add(id)
        if (contract.mode === 'markdown') sections.push(sourceMarkdown(item.result, contract))
        else {
            const rendered =
                contract.mode === 'table-payload-csv'
                    ? tablePayloadCsv(item.result, contract, { specialist: specialist.name, signal, preview })
                    : await utilizationPng(item.result, contract, { specialist: specialist.name, signal, preview })
            sections.push(rendered.text)
            artifacts.push(rendered.artifact)
        }
    }
    check(signal)
    const text = sections.join('\n\n')
    if (
        Buffer.byteLength(text) > TRUSTED_OUTPUT_LIMIT ||
        artifacts.filter((item) => item.type === 'png').length > TURN_IMAGE_LIMITS.count ||
        artifacts.filter((item) => item.type === 'csv').length > TURN_FILE_LIMITS.count
    )
        fail('Verified output exceeds turn limits.')
    return { text, artifacts }
}

// Model-facing only: the full result has already been retained on the server.
// This is a capture receipt, not a claim that rendering/validation has succeeded.
export function trustedOutputReceipt(specialist, pin, raw, callId) {
    const contract = specialist?.trustedOutputs?.find((entry) => entry.pin === pin)
    if (!contract || !callId) return null
    let body
    try {
        body = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
        return null
    }
    if (
        body?.pinned?.name !== pin ||
        (body.pinned.hash || body.pinned.statementHash) !== contract.hash ||
        !Number.isInteger(body.pinned.version)
    )
        return null
    try {
        completeResult(body, { allowEmpty: contract.mode === 'markdown' && Boolean(contract.emptyText) })
    } catch {
        return null
    }
    return JSON.stringify({
        status: 'source_captured',
        pin,
        hash: contract.hash,
        callId,
        outputMode: contract.mode,
        ...(specialist.trustedInterpretation === true
            ? { interpretationEvidence: protectedInterpretationEvidence(body, specialist.trustedInterpretationPaths) }
            : {}),
        message:
            specialist.trustedInterpretation === true
                ? 'The server captured the exact source for factual delivery. Read the bounded interpretationEvidence and write the requested business interpretation; do not copy or reconstruct source tables. The server presents your qualified interpretation before the unchanged factual sections.'
                : 'The server captured the exact source for verified output. Finish without copying rows, rewriting source sections or creating files. Rendering is validated before delivery.'
    })
}

function validateReferenceDefinitions(text) {
    const definitions = new Map()
    const pending = [fromMarkdown(text)]
    while (pending.length) {
        const node = pending.pop()
        if (node.type === 'definition') {
            const key = node.identifier.toUpperCase().toLowerCase()
            const target = JSON.stringify([node.url, node.title])
            if (definitions.has(key) && definitions.get(key) !== target)
                fail('Conflicting source reference definitions; use unique source labels.')
            definitions.set(key, target)
        }
        if (node.children) pending.push(...node.children)
    }
}

export function normalizeTrustedPolicy(value) {
    if (value == null || value === '' || value === 'strict') return 'strict'
    if (value === 'verified-passthrough' || value === VERIFIED_QUERY_POLICY) return value
    fail('Invalid trusted output policy.')
}

export function verifiedUnmappedOutput(specialist, captured, { dataTask, hasArtifacts, clarification } = {}) {
    if (!['verified-passthrough', VERIFIED_QUERY_POLICY].includes(specialist.trustedOutputPolicy)) return false
    if (!captured.length) return !dataTask && !hasArtifacts && clarification === true
    return captured.every(
        (item) =>
            (specialist.trustedOutputPolicy === VERIFIED_QUERY_POLICY && verifiedQueryCapture(item)) ||
            (item.callId &&
                item.sourceTurn &&
                item.toolName === item.pinned?.name &&
                /^pq_[a-z0-9_]+$/.test(item.toolName || '') &&
                /^[a-f0-9]{64}$/.test(item.pinned?.hash || '') &&
                Number.isInteger(item.pinned?.version) &&
                item.pinned.version > 0 &&
                Array.isArray(item.result?.rows) &&
                !item.result.error &&
                item.result.status !== 'error' &&
                !item.result.columnsChanged)
    )
}

export function composeTrustedOutputs(results) {
    if (!results.some((result) => result.trustedOutput)) return null
    const text = results
        .map((result) =>
            result.status !== 'completed'
                ? /No populated utilization observations/.test(result.error || '')
                    ? 'No reported utilization observations were available; no chart was created.'
                    : 'A requested section could not be completed because its source output could not be validated.'
                : result.trustedOutput
                ? result.text
                : result.trustedPassthrough
                ? `Additional requested information:\n\n${result.text}`
                : 'An additional requested section could not be completed because its source output could not be validated.'
        )
        .join('\n\n')
    if (Buffer.byteLength(text) > TRUSTED_OUTPUT_LIMIT) fail('Verified report exceeds the composed output limit.')
    validateReferenceDefinitions(text)
    return text
}
