// Query and labels for the Usage page. A custom range sends startDate and endDate
// and leaves days off, because the server treats a pair of dates as the window.
export const PRESET_DAYS = [7, 30, 90]
export const MAX_CUSTOM_DAYS = 366
export const PRICE_MAX_PER_MILLION = 1000000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function usageRequest({ preset = 7, startDate = '', endDate = '', flowId = '', model = '' } = {}) {
    const params = {}
    if (preset === 'custom') {
        params.startDate = startDate
        params.endDate = endDate
    } else {
        params.days = preset
    }
    if (flowId) params.flowId = flowId
    if (model) params.model = model
    return params
}

export function inclusiveDayCount(startDate, endDate) {
    const start = Date.parse(`${startDate}T00:00:00.000Z`)
    const end = Date.parse(`${endDate}T00:00:00.000Z`)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return NaN
    return Math.round((end - start) / 86400000) + 1
}

export function customRangeError(startDate, endDate) {
    if (!startDate || !endDate) return 'Choose a start date and an end date.'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return 'Use dates in the form YYYY-MM-DD.'
    }
    if (endDate < startDate) return 'The end date must be on or after the start date.'
    if (inclusiveDayCount(startDate, endDate) > MAX_CUSTOM_DAYS) {
        return `A custom range can cover at most ${MAX_CUSTOM_DAYS} days.`
    }
    return ''
}

export function usageIsEmpty(payload) {
    const input = Number(payload?.totals?.inputTokens || 0)
    const output = Number(payload?.totals?.outputTokens || 0)
    return input === 0 && output === 0
}

export function choicesFrom(payload) {
    const flows = (payload?.flows || []).map((row) => row.flowId).filter(Boolean)
    const models = (payload?.models || []).map((row) => row.model).filter(Boolean)
    return {
        flows: [...new Set(flows)].sort(),
        models: [...new Set(models)].sort()
    }
}

export function chartRows(days) {
    return (days || []).map((row) => ({
        day: row.day,
        Input: Number(row.inputTokens || 0),
        Output: Number(row.outputTokens || 0)
    }))
}

export function formatTokens(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '0'
    const sign = n < 0 ? '-' : ''
    const digits = Math.abs(Math.trunc(n)).toString()
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Small estimates keep enough digits to tell a fraction of a cent from zero.
export function formatUsd(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    if (n === 0) return '$0'
    const abs = Math.abs(n)
    if (abs >= 0.01) return `$${n.toFixed(2)}`
    return `$${n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`
}

export function costLabel(row) {
    if (!row || row.price === 'no price' || (row.estimatedCostUsd == null && row.price !== 'known')) return 'no price'
    const money = formatUsd(row.estimatedCostUsd)
    if (row.price === 'partial') return money ? `${money} (some models have no price)` : 'no price'
    if (row.price === 'known') return money || '$0'
    return money || 'no price'
}

export function formatDay(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
    if (!match) return iso || ''
    const month = MONTHS[Number(match[2]) - 1]
    if (!month) return iso
    return `${month} ${Number(match[3])}, ${match[1]}`
}

export function formatRate(value) {
    if (value == null || value === '') return 'none'
    const n = Number(value)
    if (!Number.isFinite(n)) return 'none'
    const text = n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    return text || '0'
}

export function priceInputError(label, raw) {
    const text = String(raw ?? '').trim()
    if (text === '') return `${label} is required.`
    if (/[eE]/.test(text)) return `${label} must be a plain number of US dollars per million tokens.`
    const fraction = (text.split('.')[1] || '').replace(/0+$/, '')
    if (fraction.length > 8) return `${label} can have at most 8 decimal places.`
    const parsed = Number(text)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > PRICE_MAX_PER_MILLION) {
        return `${label} must be a number from 0 to ${PRICE_MAX_PER_MILLION}.`
    }
    return ''
}

export function priceRows(catalogModels, unpricedModels) {
    const rows = (catalogModels || []).map((row) => ({ ...row }))
    const known = new Set(rows.map((row) => row.model))
    for (const model of unpricedModels || []) {
        if (!model || known.has(model)) continue
        known.add(model)
        rows.push({ model, default: null, override: null, effective: null })
    }
    rows.sort((a, b) => String(a.model).localeCompare(String(b.model)))
    return rows
}

export function joinNames(names) {
    const list = (names || []).filter(Boolean)
    if (list.length <= 1) return list[0] || ''
    if (list.length === 2) return `${list[0]} and ${list[1]}`
    return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}

export function apiErrorMessage(err, fallback) {
    const message = err?.response?.data?.message || err?.message
    return typeof message === 'string' && message.trim() ? message : fallback
}
