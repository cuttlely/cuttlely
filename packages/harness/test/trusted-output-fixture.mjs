// Synthetic source data shared by runtime and native attachment integration tests.
import crypto from 'node:crypto'
export const months = [
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10'
]
const rows = [
    ['Infrastructure', 'workspace', 'sku-a', { 0: '31.25', 1: '35.1', 2: '37.5' }],
    ['Infrastructure', 'workspace', 'sku-b', { 4: '142.5', 5: '143.25' }],
    ['Secrets', 'client', 'sku-c', { 3: '81.1', 4: '82.2', 5: '83.3', 6: '84.4', 7: '85.5', 8: '86.6', 9: '87.7' }],
    ['Secrets', 'cluster', 'sku-c', { 10: '91.25' }]
].flatMap(([product_family, product_unit, product_key, observations]) =>
    months.map((month, index) => ({
        identity_state: 'resolved',
        candidate_count: 1,
        account_name: 'Example Co',
        month,
        product_key,
        product_family,
        product_unit,
        utilization_pct: observations[index] ?? null
    }))
)
export const originalPayload = {
    schema: 'monthly-utilization-chart/v1',
    rows,
    row_count: rows.length,
    source_eligible_rows: rows.length,
    selected_rows_before_guard: rows.length,
    complete: true,
    truncated: false,
    start_date: '2025-11-01',
    end_date_exclusive: '2026-11-01'
}
export function bodyFor(payload = originalPayload) {
    const raw = Buffer.from(JSON.stringify(payload))
    return {
        rows: [
            {
                utilization_payload_base64: raw
                    .toString('base64')
                    .match(/.{1,76}/g)
                    .join('\n'),
                utilization_payload_md5: crypto.createHash('md5').update(raw).digest('hex')
            }
        ],
        summary: 'returned 1 of 1 rows'
    }
}
export const body = bodyFor()
if (process.argv.includes('--artifact')) {
    const { utilizationPng } = await import('../trusted-output.mjs')
    const { artifact } = await utilizationPng(body, { sourceLabel: 'Example source' }, { specialist: 'data' })
    process.stdout.write(JSON.stringify(artifact))
}
