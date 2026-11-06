// A field contract from the exported Supreme query, not a copy of its SQL or data.
export function supremeRiskTemplate(sources) {
    const source =
        sources.find((s) => s.name === 'pq_quarter_account_risk_patterns' && s.specialist.startsWith('warehouse_sql')) ||
        sources.find((s) => s.name === 'pq_quarter_account_risk_patterns')
    if (!source) return null
    const common = {
        source: source.key,
        hash: source.hash,
        params: {},
        completePath: 'risk_pattern_payload.complete',
        scope: 'Current UTC quarter · open, non-omitted renewals · High, Moderate or Slight Risk'
    }
    const accountSource =
        sources.find((s) => s.name === 'pq_renewals_at_risk_quarter' && s.specialist.startsWith('warehouse_sql')) ||
        sources.find((s) => s.name === 'pq_renewals_at_risk_quarter')
    return {
        title: 'Supreme · Renewal intelligence',
        cards: [
            {
                ...common,
                id: crypto.randomUUID(),
                title: 'Accounts at risk',
                kind: 'metric',
                valueField: 'total_risk_accounts',
                labelField: '',
                x: 0,
                y: 0
            },
            {
                ...common,
                id: crypto.randomUUID(),
                title: 'Renewals in scope',
                kind: 'metric',
                valueField: 'total_risk_opportunities',
                labelField: '',
                x: 400,
                y: 0
            },
            {
                ...common,
                id: crypto.randomUUID(),
                title: 'Recorded risk signals',
                kind: 'bar',
                valueField: 'accounts',
                labelField: 'label',
                rowsPath: 'risk_pattern_payload.patterns',
                scope: 'Distinct accounts per recorded signal · overlapping categories; do not sum · not causal or probability scores',
                x: 0,
                y: 350
            },
            ...(accountSource
                ? [
                      {
                          id: crypto.randomUUID(),
                          title: 'Priority renewal watchlist',
                          kind: 'table',
                          source: accountSource.key,
                          hash: accountSource.hash,
                          params: { top_n: 10, quarter_offset: 0, period: 'quarter', window_days: 7 },
                          scope: 'Top 10 at-risk renewal opportunities by recorded risk score · selected records, not the full portfolio · click an account',
                          rowsPath: 'risk_quarter_payload.inline_rows',
                          selectionCountPath: 'risk_quarter_payload.returned_rows',
                          selectionTotalPath: 'risk_quarter_payload.total_eligible_renewal_opportunities',
                          columns: ['account_name', 'risk_radar', 'renewal_date', 'renewal_acv'],
                          valueField: '',
                          labelField: '',
                          x: 400,
                          y: 350
                      }
                  ]
                : [])
        ]
    }
}
