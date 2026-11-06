// Reviewed single-row aggregate contracts. These fingerprints bind the exception
// to exact SQL+parameter definitions; a changed or edited query cannot inherit it.
// No SQL, credentials or business rows are stored here.
const queryName = (slug) => ['pq', slug].join('_')
const aggregates = new Map([
    [queryName('sales_ytd'), '4f85c1e0b2972bd51bfc61bbe2d171805d9ecd051122aa5fafc606fa04255818'],
    [queryName('realized_retention'), '26e29f6d73261b87557576b4ab471ef1dfd76ad9498f78db1f16295145387ab0'],
    [queryName('forecast_churn_year'), 'ca3dd750c86560eda3b54c980c63685463baf7f6329ecf8efa1b74fbf8be1e95'],
    [queryName('pipeline_window'), 'fab02ec5995ae0bdcdc4957457e07f1f09236181e92fe56871e5d49f31140597']
])
export function reviewedAggregate(name, hash, row, rowsPath) {
    if (aggregates.get(name) !== hash) return false
    if (name !== queryName('pipeline_window')) return !rowsPath
    // SQL totals and these two arrays aggregate the full cohort BEFORE pagination.
    // Deal details are deliberately excluded from this completeness exception.
    return row.input_state === 'valid' && (!rowsPath || ['full_cohort_type_summary', 'full_cohort_risk_summary'].includes(rowsPath))
}
