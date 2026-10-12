// Relative windows are a token the server expands in its own timezone.
// Custom keeps the hour stamps the person picked.

export const RELATIVE_RANGES = {
    'Last hour': '1h',
    'Last 4 hours': '4h',
    'Last 24 hours': '24h',
    'Last 2 days': '2d',
    'Last 7 days': '7d',
    'Last 14 days': '14d',
    'Last 1 month': '1m',
    'Last 2 months': '2m',
    'Last 3 months': '3m'
}

export function logsQuery({ selection, level, startDate, endDate }) {
    if (selection !== 'Custom') {
        const range = RELATIVE_RANGES[selection]
        if (range) return { level, range }
    }
    return { level, startDate, endDate }
}
