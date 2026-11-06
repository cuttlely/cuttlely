import { fieldLabel, formatValue, humanColumns, rowLabel, sourceRecords } from './presentation'

it('uses account and opportunity names for ID-based chart bindings without guessing missing names', () => {
    expect(rowLabel({ account_id: '001000000000000AAA', account_name: 'Example company' }, 'account_id')).toBe('Example company')
    expect(rowLabel({ opportunity_id: '006000000000000AAA', opportunity_name: 'Annual renewal' }, 'opportunity_id')).toBe('Annual renewal')
    expect(rowLabel({ account_id: '001000000000000AAA' }, 'account_id')).toBe('Account name unavailable')
    expect(
        humanColumns(
            [{ account_id: 'id', account_name: 'Example company', opportunity_id: 'opp', opportunity_name: 'Renewal' }],
            ['account_id', 'opportunity_id']
        )
    ).toEqual(['account_name', 'opportunity_name'])
})
it('formats exact decimal strings, dates and familiar labels without inventing currency or zeroes', () => {
    expect(formatValue('9007199254740993.12345', 'renewal_acv')).toBe('9,007,199,254,740,993.12345')
    expect(formatValue('2026-12-15', 'renewal_date')).toBe('Dec 15, 2026')
    expect(formatValue('77.96', 'retention_pct')).toBe('77.96%')
    expect(formatValue(null, 'renewal_acv')).toBe('Not provided')
    expect(formatValue('001000000000000123', 'opportunity_id')).toBe('001000000000000123')
    expect(fieldLabel('renewal_acv')).toBe('Renewal ACV')
})
it('reads cached pipeline details from a projected chart envelope and discloses page coverage', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ account_name: `Example ${i}`, account_id: String(i) }))
    const result = sourceRecords({
        rows: [{ opportunity_type: 'Renewal', deal_count: 250 }],
        evidenceRows: [{ deal_count: 250, next_page: 2, deal_details: rows }]
    })
    expect(result.rows).toHaveLength(100)
    expect(result.total).toBe(250)
    expect(result.available).toBe(120)
    expect(result.paged).toBe(true)
    expect(result.rows[99]).toBe(rows[99])
})
it('opens typed renewal envelopes and does not invent account records for aggregate-only pins', () => {
    const rows = [{ account_name: 'Example', account_id: '001000000000000AAA', renewal_acv: '123.45' }]
    expect(sourceRecords({ rows, source: { selection: { total: 55 } } }).total).toBe(55)
    expect(
        sourceRecords({
            rows: [],
            evidenceRows: [{ risk_quarter_payload: JSON.stringify({ inline_rows: rows, total_eligible_renewal_opportunities: 55 }) }]
        }).rows
    ).toEqual(rows)
    expect(sourceRecords({ rows: [{ retention_pct: '77.9' }] }).rows).toEqual([])
})
