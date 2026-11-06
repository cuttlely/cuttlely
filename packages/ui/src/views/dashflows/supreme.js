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

// Broad GTM view. Each card remains a distinct, typed source measure.
export function supremeCommandTemplate(sources, now = new Date()) {
    const year = now.getUTCFullYear()
    const end = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10)
    const cards = []
    const add = (name, title, kind, valueField, scope, params = {}, extra = {}) => {
        const source =
            sources.find((s) => s.name === name && s.specialist.startsWith('warehouse_sql')) || sources.find((s) => s.name === name)
        if (!source) return
        cards.push({
            id: crypto.randomUUID(),
            source: source.key,
            hash: source.hash,
            title,
            kind,
            valueField,
            labelField: '',
            scope,
            params,
            x: (cards.length % 3) * 400,
            y: Math.floor(cards.length / 3) * 350,
            ...extra
        })
    }
    const pipeline = { window_days: 30, region: 'ALL', page_number: 1, page_size: 20 }
    const pipelineScope = 'Next 30 days · open/non-omitted · close-date cohort · unweighted source ACV'
    add('pq_pipeline_window', 'Open pipeline', 'metric', 'total_known_deal_acv', pipelineScope, pipeline)
    add('pq_sales_ytd', 'YTD booked ACV', 'metric', 'total_acv', 'UTC year to date · Closed/Won · source units · NACV + gross RACV', {
        region: 'ALL'
    })
    add(
        'pq_pipeline_window',
        'Deals in motion',
        'metric',
        'deal_count',
        'Next 30 days · all open deal types · full filtered cohort',
        pipeline
    )
    add(
        'pq_realized_retention',
        'Realized retention %',
        'metric',
        'retention_pct',
        'YTD closed renewal cohort · renewal-date basis · not forecast',
        { start_date: `${year}-01-01`, end_date: end }
    )
    add(
        'pq_forecast_churn_year',
        'Forecast churn',
        'metric',
        'forecast_churn',
        `${year} renewal year · open/non-omitted · recorded RAM forecast · source units`,
        { year }
    )
    add(
        'pq_pipeline_window',
        'Unknown deal values',
        'metric',
        'unknown_acv_count',
        'Open pipeline records with NULL ACV · unknown is not zero',
        pipeline
    )
    add(
        'pq_pipeline_window',
        'Pipeline composition',
        'donut',
        'deal_count',
        'Full cohort · distinct opportunity types · count of deals',
        pipeline,
        { rowsPath: 'full_cohort_type_summary', labelField: 'opportunity_type' }
    )
    add(
        'pq_acv_quarter_series',
        'Booked ACV trajectory',
        'trend',
        'total_acv',
        'Calendar quarters · current and first buckets may be partial · source units; inspect trend certificate',
        { start_date: `${year - 1}-01-01` },
        { labelField: 'quarter_start' }
    )
    add(
        'pq_pipeline_window',
        'Recorded pipeline risk',
        'bar',
        'deal_count',
        'Full cohort · recorded risk and signal scope · not probability',
        pipeline,
        { rowsPath: 'full_cohort_risk_summary', labelField: 'recorded_risk', sort: 'value-desc' }
    )
    const risk = supremeRiskTemplate(sources)
    if (risk) {
        const drivers = risk.cards.find((c) => c.kind === 'bar')
        const watchlist = risk.cards.find((c) => c.kind === 'table')
        if (drivers) cards.push(drivers)
        if (watchlist) cards.push(watchlist)
    }
    add(
        'pq_sales_ytd',
        'YTD gross renewal ACV',
        'metric',
        'gross_racv',
        'Closed/Won · includes marketplace · distinct from direct RACV · source units',
        { region: 'ALL' }
    )
    return cards.length ? { title: 'Supreme · GTM command center', cards } : null
}
