import { selectPipelineView } from './cachedViews'
it('swaps only prepared pipeline cards and hydrates shared evidence without mutating the frozen snapshot', () => {
    const rows = [{ account_name: 'Synthetic account', amount: 42 }]
    const other = { cardId: 'ytd', rows: [{ amount: 900 }] }
    const original = {
        cards: [{ cardId: 'pipeline', rows: [{ amount: 1 }] }, other],
        pipelineViews: {
            views: {
                'EMEA:90': {
                    evidenceRows: rows,
                    cards: [
                        { cardId: 'pipeline', rowsFromEvidence: true, source: { scope: 'EMEA / next 90 days' }, fetchedAt: '2026-11-06' }
                    ]
                }
            }
        }
    }
    const selected = selectPipelineView(original, 'EMEA:90')
    expect(selected.cards[0].rows).toBe(rows)
    expect(selected.cards[0].evidenceRows).toBe(rows)
    expect(selected.cards[0].fetchedAt).toBe('2026-11-06')
    expect(selected.cards[1]).toBe(other)
    expect(original.cards[0].rows[0].amount).toBe(1)
    expect(selectPipelineView(original, 'missing')).toBe(original)
})
