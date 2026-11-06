const labels = {
    account_name: 'Account',
    account_id: 'Account ID',
    opportunity_name: 'Opportunity',
    opportunity_id: 'Opportunity ID',
    renewal_date: 'Renewal date',
    close_date: 'Close date',
    renewal_acv: 'Renewal ACV',
    deal_acv: 'Deal ACV',
    current_account_acv: 'Current account ACV',
    risk_radar: 'Recorded risk',
    recorded_risk: 'Recorded risk',
    risk_drivers: 'Risk context',
    recorded_risk_drivers: 'Risk context',
    risk_signal_scope: 'Evidence scope',
    heuristic_risk_score: 'Recorded risk score',
    source_as_of: 'Source updated',
    quarter_start: 'Quarter starting',
    total_known_deal_acv: 'Known pipeline ACV',
    total_acv: 'Booked ACV',
    gross_racv: 'Gross renewal ACV',
    retention_pct: 'Retention (%)',
    forecast_churn: 'Forecast churn',
    deal_count: 'Deals',
    accounts: 'Accounts'
}
export const fieldLabel = (key) =>
    labels[key] ||
    String(key)
        .replaceAll('_', ' ')
        .replace(/\b(acv|racv|nacv|id|utc)\b/gi, (v) => v.toUpperCase())
        .replace(/^./, (v) => v.toUpperCase())
export function formatValue(value, field = '') {
    if (value === null || value === undefined || value === '') return 'Not provided'
    if (typeof value === 'object') return 'Structured evidence'
    const text = String(value)
    if (/date|quarter_start|window_start|window_end/.test(field) && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(text)) {
        const parsed = new Date(text.slice(0, 10) + 'T00:00:00Z')
        if (!Number.isNaN(parsed.getTime()))
            return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    }
    if (!/(^|_)id$/.test(field) && /^-?\d+(\.\d+)?$/.test(text)) {
        const [whole, fraction] = text.split('.')
        return (
            whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '') + (/_pct$|^percent_of_/.test(field) ? '%' : '')
        )
    }
    return text
}
export function rowLabel(row, field) {
    if (field === 'account_id') return row.account_name || 'Account name unavailable'
    if (field === 'opportunity_id' || field === 'opp_id') return row.opportunity_name || row.account_name || 'Opportunity name unavailable'
    return formatValue(row[field], field)
}
const preferred = [
    'account_name',
    'opportunity_name',
    'renewal_date',
    'close_date',
    'renewal_acv',
    'deal_acv',
    'current_account_acv',
    'risk_radar',
    'recorded_risk',
    'risk_signal_scope',
    'opportunity_id'
]
export function humanColumns(rows, selected) {
    const keys = [...new Set(rows.flatMap(Object.keys))]
    const cols = selected || [...preferred.filter((k) => keys.includes(k)), ...keys.filter((k) => !preferred.includes(k))]
    return [
        ...new Set(
            cols.map((k) =>
                k === 'account_id' && keys.includes('account_name')
                    ? 'account_name'
                    : k === 'opportunity_id' && keys.includes('opportunity_name') && selected
                    ? 'opportunity_name'
                    : k
            )
        )
    ]
        .filter(
            (k) =>
                k !== 'account_id' &&
                k !== 'original_record' &&
                !k.endsWith('_markdown') &&
                rows.some((r) => r[k] === null || (r[k] !== undefined && typeof r[k] !== 'object'))
        )
        .slice(0, 12)
}
const objectValue = (value) => {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}
export function sourceRecords(snapshot) {
    for (const row of snapshot.evidenceRows || snapshot.rows || []) {
        const packet = objectValue(row.risk_quarter_payload)
        const rows = objectValue(row.deal_details) || objectValue(packet?.inline_rows) || objectValue(row.inline_rows)
        if (Array.isArray(rows) && rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
            return {
                rows: rows.slice(0, 100),
                available: rows.length,
                total: row.deal_count ?? packet?.total_eligible_renewal_opportunities ?? null,
                paged: !!row.next_page
            }
        }
    }
    const rows = snapshot.rows || []
    const records = rows.some((r) => ['account_name', 'account_id', 'opportunity_name', 'opportunity_id'].some((k) => r[k] != null))
    return {
        rows: records ? rows.slice(0, 100) : [],
        available: records ? rows.length : 0,
        total: snapshot.source?.selection?.total ?? null,
        paged: false
    }
}
