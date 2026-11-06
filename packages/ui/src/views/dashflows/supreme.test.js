import { supremeRiskTemplate } from './supreme'

it('binds three risk cards to the actual catalog hash with explicit source completeness and no fabricated values', () => {
    global.crypto = { randomUUID: jest.fn().mockReturnValueOnce('one').mockReturnValueOnce('two').mockReturnValueOnce('three') }
    const template = supremeRiskTemplate([
        { name: 'pq_quarter_account_risk_patterns', specialist: 'warehouse_sql_r25', key: 'actual-source', hash: 'a'.repeat(64) }
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
        { name: 'pq_quarter_account_risk_patterns', specialist: 'warehouse_sql_r25', key: 'risk', hash: 'a'.repeat(64) },
        { name: 'pq_renewals_at_risk_quarter', specialist: 'warehouse_sql_r25', key: 'list', hash: 'b'.repeat(64) }
    ])
    expect(template.cards).toHaveLength(4)
    expect(template.cards[3].source).toBe('list')
    expect(template.cards[3].params.top_n).toBe(10)
    expect(template.cards[3].selectionTotalPath).toBe('risk_quarter_payload.total_eligible_renewal_opportunities')
})
