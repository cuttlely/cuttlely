import { dashSourceName, supremeRiskTemplate, supremeCommandTemplate } from './supreme'

it('binds three risk cards to the actual catalog hash with explicit source completeness and no fabricated values', () => {
    global.crypto = { randomUUID: jest.fn().mockReturnValueOnce('one').mockReturnValueOnce('two').mockReturnValueOnce('three') }
    const template = supremeRiskTemplate([
        {
            name: dashSourceName('quarter_account_risk_patterns'),
            specialist: 'warehouse_sql_r25',
            key: 'actual-source',
            hash: 'a'.repeat(64)
        }
    ])
    expect(template.cards).toHaveLength(3)
    expect(template.cards.every((card) => card.hash === 'a'.repeat(64) && card.source === 'actual-source')).toBe(true)
    expect(template.cards.every((card) => card.completePath === 'risk_pattern_payload.complete')).toBe(true)
    expect(template.cards[2].rowsPath).toBe('risk_pattern_payload.patterns')
    expect(template.cards[2].scope).toContain('do not sum')
    expect(template.cards.every((card) => !card.rows && !card.value)).toBe(true)
})
it('does not invent a source when the required pin is missing', () => expect(supremeRiskTemplate([])).toBeNull())

it('adds the exact selected opportunity watchlist when its source is available', () => {
    global.crypto = { randomUUID: jest.fn(() => 'synthetic-id') }
    const template = supremeRiskTemplate([
        { name: dashSourceName('quarter_account_risk_patterns'), specialist: 'warehouse_sql_r25', key: 'risk', hash: 'a'.repeat(64) },
        { name: dashSourceName('renewals_at_risk_quarter'), specialist: 'warehouse_sql_r25', key: 'list', hash: 'b'.repeat(64) }
    ])
    expect(template.cards).toHaveLength(4)
    expect(template.cards[3].source).toBe('list')
    expect(template.cards[3].params.top_n).toBe(100)
    expect(template.cards[3].selectionTotalPath).toBe('risk_quarter_payload.total_eligible_renewal_opportunities')
})

it('builds a bounded command center from real source names and preserves separate period grains', () => {
    global.crypto = { randomUUID: jest.fn(() => String(Math.random())) }
    const names = [
        dashSourceName('pipeline_window'),
        dashSourceName('sales_ytd'),
        dashSourceName('realized_retention'),
        dashSourceName('forecast_churn_year'),
        dashSourceName('acv_quarter_series'),
        dashSourceName('quarter_account_risk_patterns'),
        dashSourceName('renewals_at_risk_quarter')
    ]
    const result = supremeCommandTemplate(
        names.map((name) => ({ name, key: name, hash: 'a'.repeat(64), specialist: 'warehouse_sql' })),
        new Date('2026-11-06T12:00:00Z')
    )
    expect(result.cards).toHaveLength(12)
    expect(new Set(result.cards.map((card) => card.id)).size).toBe(12)
    expect(result.cards.find((c) => c.title === 'Realized retention %').params).toEqual({
        start_date: '2026-01-01',
        end_date: '2026-11-07'
    })
    expect(result.cards.find((c) => c.kind === 'donut').rowsPath).toBe('full_cohort_type_summary')
    expect(result.cards.every((c) => !c.rows && !c.value)).toBe(true)
    expect(supremeCommandTemplate([])).toBeNull()
})
